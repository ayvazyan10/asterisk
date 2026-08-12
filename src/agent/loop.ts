// Agent loop — drives a Provider through tool-use turns until end_turn.
// Reference: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use
//
// Includes a retry wrapper around provider.send (exponential backoff with
// jitter, Retry-After honouring, classified by ProviderError.kind), per-tool
// timeout enforcement, and AbortSignal threading from the REPL down to the
// shell-level tools.

import type { HookConfig } from '../config/schema.ts';
import { getDb } from '../db/index.ts';
import { type HookResult, fireHooks } from '../hooks/runner.ts';
import { type OutputStyle, outputStyleToPromptSection } from '../output-styles/styles.ts';
import { firePluginEvent } from '../plugins/runtime.ts';
import { ProviderError, isAbort, isRetryable, retryAfterMs } from '../providers/errors.ts';
import { recoverToolCallsFromText } from '../providers/text-tool-calls.ts';
import {
  canonicalToolName,
  coerceToolInput,
  malformedArgumentsMessage,
  missingArgumentsMessage,
  missingRequired,
  readMalformedArguments,
  suggestToolNames,
} from '../providers/tool-repair.ts';
import { type Rule, rulesToPromptSection } from '../rules/loader.ts';
import { type Soul, soulsToPromptSection } from '../soul/loader.ts';
import { isConcurrencySafe } from '../tools/concurrency.ts';
import { getTool, toolDefinitions } from '../tools/registry.ts';
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types/messages.ts';
import { retry } from '../utils/retry.ts';
import { compactHistory, compactHistoryWithSummary } from './compaction.ts';
import { type AgentSession, runWithSession } from './context.ts';
import { completeToolResults, repairHistory } from './history.ts';
import { collectImageBlocks, evictOldImages, imageLimits } from './images.ts';
import { persistOutput, shouldPersistOutput } from './output-store.ts';
import { summariseMessages } from './summarise.ts';

const SYSTEM_PROMPT = `You are Asterisk, a personal AI assistant running on the user's machine.

Tools you have:
- Filesystem: Read, Write, Edit, Grep, Glob
- Shell: Bash
- Browser (real Chromium): BrowserNavigate, BrowserClick, BrowserType,
  BrowserPress, BrowserSnapshot, BrowserScreenshot, BrowserWait, BrowserClose
- Web: WebFetch (load a URL as text), WebSearch (Brave / Tavily / SearXNG /
  DDG instant-answer; the first one with a configured key wins)
- Sharing: Attach — send a file (image / video / audio / document) to the
  user out-of-band. In the Telegram daemon this becomes a real
  media message; in the REPL, images render inline on supporting terminals
  and everything else is shown as "📎 path".
- Planning: TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop — your own
  todo list. Use it for any non-trivial multi-step work.
- Delegation: Agent — spawn a sub-agent in an isolated conversation for
  research or focused sub-tasks. The sub-agent has the same tools but its
  history doesn't pollute yours.

When working on the web:
- Start with BrowserNavigate, then BrowserSnapshot to read the page (title,
  URL, visible text, and a numbered list of interactive elements).
- Click and type using selectors from the snapshot, "text=Some Label",
  "role=button[name='Submit']", or plain CSS.

When researching, use this fallback chain — never give up after one tool:
1. WebSearch first for general lookups.
2. If WebSearch returns "(no results)" or an availability error, do not
   stop. Pick a different path:
   - Hit a direct plain-text endpoint via WebFetch when one exists. Useful
     ones to remember: weather → https://wttr.in/<place>?format=4&lang=<bcp47>
     (or ?format=j1 for JSON); facts/people/places → en.wikipedia.org or
     the user's preferred locale wiki; FX rates → open.er-api.com; IP geo
     → ipapi.co/json.
   - For everything else, BrowserNavigate to the most likely site (the
     authoritative one or a Google/DuckDuckGo results page) and read it
     with BrowserSnapshot. The browser handles JS-heavy pages WebFetch
     can't.
3. For deep parallel investigations, dispatch sub-agents via Agent.

When something fails, diagnose before switching tactics — read the error,
check your assumptions, try a focused fix. Don't retry the identical action
blindly, but don't abandon a viable approach after one failure either. If a
tool reports it's unavailable (missing API key, offline backend), that
tool is unavailable for this turn — pick a different one rather than
telling the user the task is impossible.

Background servers: when you start a server with Bash (e.g.
\`php artisan serve &\`, \`python -m http.server &\`), it takes a moment to
bind the port. Don't curl/fetch immediately — use a short retry loop:
\`for i in $(seq 1 20); do curl -sf http://localhost:PORT/ && break || sleep 0.5; done\`
or chain with \`sleep 1 &&\` before the first request.

Working in parallel: when several tool calls don't depend on each other,
emit them all in the same turn — they execute in order but cost just one
model round-trip. Examples: editing several distinct strings in the same
file (Edit … Edit … Edit), reading a few sibling files at once
(Read … Read), researching by spawning multiple sub-agents in parallel,
hitting WebFetch on more than one URL when you need them both. Sequential
turns are only needed when a later call depends on the result of an
earlier one. For find/replace work that touches many occurrences of the
same string, use Edit's replaceAll:true flag instead of one Edit per
match — far cheaper than scanning for each occurrence.

For changes to existing files, prefer Edit over Write. Targeted edits
are cheaper than a full Write — for adding a feature, fixing a bug, or
swapping a value, several Edits in the same turn are usually the right
move. Write is fine for new files or for ground-up rewrites of small
files (under ~200 lines). Use replaceAll:true when the same change
repeats.

Be concise. Prefer doing work directly with tools over describing what you
would do. After running tools, reply with one or two sentences saying
what changed — the user can see the tool trace, you don't need to
enumerate every edit. "done" is fine for trivial work.`;

// 48 gives agents room for multi-step agentic tasks without hitting the
// safety cap prematurely. Override via opts.maxTurns when you want a
// tighter or looser bound (sub-agents typically pass a smaller cap).
const DEFAULT_MAX_TURNS = 48;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
// Backstop for tools that wait on a person. It is not their real bound —
// AskUserQuestion times out at 5 minutes and Bash caps its command at 600s
// plus a 90s approval window — it only stops a wedged prompt hanging the turn
// forever. Anything under the tools' own limits would kill them mid-wait,
// which is what used to happen: a 5-minute Ask under a 2-minute deadline
// could never receive an answer.
const INTERACTIVE_TOOL_TIMEOUT_MS = 15 * 60_000;

// Stand-in pushed to history when a model returns nothing at all. The turn
// still has to continue — we are about to ask it to try again — and both the
// Anthropic API and the tool_use pairing rules need a well-formed assistant
// message with content in it. An empty content array is a 400.
const EMPTY_ASSISTANT_PLACEHOLDER = '(no reply)';

// A quantised model that loses the thread re-issues the same call forever.
// The cap is per turn and counts *identical* arguments, so a legitimate
// re-read of a changed file or a second TaskList is untouched; only a call
// that provably cannot produce a new answer is refused. Set well above any
// plausible deliberate repeat, because the cost of a false positive is a
// blocked real call and the cost of a miss is only the turn cap.
const MAX_IDENTICAL_TOOL_CALLS = 5;

export type TerminalReason =
  | 'end-turn'
  | 'max-turns'
  | 'aborted'
  | 'context-overflow'
  | 'auth-error'
  | 'bad-request'
  | 'unknown-error';

export interface AgentState {
  history: Message[];
}

export function createAgentState(): AgentState {
  return { history: [] };
}

export interface RunOptions {
  maxTurns?: number;
  maxRetries?: number;
  toolTimeoutMs?: number;
  /** Replace dropped history with a model-written summary. Defaults to true;
   *  set false to keep the cheap "N messages dropped" notice, which costs no
   *  model call. Sub-agents and tests generally want false. */
  summariseDropped?: boolean;
  signal?: AbortSignal;
  rules?: readonly Rule[];
  /** SOUL.md content — persona + user-context block prepended to the
   *  system prompt so the agent knows who it is and who it's talking to. */
  souls?: readonly Soul[];
  hooks?: readonly HookConfig[];
  /** Optional output-style modifier (concise / explanatory / learning).
   *  Spliced into the system prompt so the model adjusts its reply shape. */
  outputStyle?: OutputStyle;
  /** Optional allow-list of tool names. When set, the model only sees
   *  these tools; the rest are hidden. Used by specialised sub-agent
   *  types (e.g. read-only research roles). */
  allowedTools?: readonly string[];
  /** Session that owns this turn's tool state. Tasks, plan mode, worktrees,
   *  browser pages, and monitors are keyed by session.id so Telegram /
   *  Telegram users never see each other's stuff. The REPL passes
   *  { id: 'repl', scope: 'repl' }; the daemon passes the chatId. */
  session?: AgentSession;
  /** Fired once per text block at the end of a model turn. Always set, but
   *  use `onAssistantDelta` if you want per-token streaming. */
  onAssistantText?(text: string): void;
  /** Fired per text delta as the model streams its response. Only fires when
   *  the underlying provider supports streaming (Anthropic, Ollama). If unset,
   *  no streaming is requested from the provider. */
  onAssistantDelta?(delta: string): void;
  /** Fired with chain-of-thought tokens emitted inside <think>…</think>
   *  blocks (qwen3-thinking, deepseek-r1, …). Hidden from the assistant
   *  text and from history; surfaced here so the UI can show "thinking ·
   *  N chars" progress while the model reasons. */
  onAssistantThinking?(delta: string): void;
  onToolUse?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, output: string, isError: boolean): void;
  onRetry?(attempt: number, delayMs: number, reason: string): void;
  onHook?(result: HookResult): void;
  /** Called for every attachment a tool emitted during the turn. The bot
   *  daemon collects these and ships them via Telegram media
   *  APIs; the REPL renders inline when the terminal supports it. */
  onAttachment?(attachment: { kind: string; path: string; caption?: string }): void;
}

export interface AgentTurnResult {
  finalText: string;
  reason: TerminalReason;
}

export async function runAgentTurn(
  provider: Provider,
  state: AgentState,
  userInput: string,
  opts: RunOptions = {},
): Promise<AgentTurnResult> {
  const session: AgentSession = opts.session ?? { id: 'default', scope: 'unknown' };
  return runWithSession(session, () => runAgentTurnInner(provider, state, userInput, opts));
}

async function runAgentTurnInner(
  provider: Provider,
  state: AgentState,
  userInput: string,
  opts: RunOptions = {},
): Promise<AgentTurnResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const signal = opts.signal;
  const hooks = opts.hooks ?? [];
  const rules = opts.rules ?? [];
  const souls = opts.souls ?? [];

  const soulSection = soulsToPromptSection(souls);
  const rulesSection = rulesToPromptSection(rules);
  const styleSection = outputStyleToPromptSection(opts.outputStyle);
  const systemPrompt = [SYSTEM_PROMPT, soulSection, rulesSection, styleSection]
    .filter((s) => s && s.length > 0)
    .join('\n\n');

  state.history.push({
    role: 'user',
    content: [{ type: 'text', text: userInput }],
  });

  // before_turn hooks fire-and-log; failures don't abort the turn.
  if (hooks.length > 0) {
    const before = await fireHooks(hooks, { event: 'before_turn', userText: userInput }, signal);
    for (const r of before) opts.onHook?.(r);
  }

  let finalText = '';
  // Tracks the most recent non-empty assistant text across the whole turn
  // loop. Smaller models (qwen3.5:9b, deepseek-r1, …) sometimes return
  // stop_reason: end_turn with EMPTY text after a successful tool batch —
  // they think they're done but never emit a closing summary. When the
  // terminal turn has no text, fall back to whatever the model said last.
  let lastNonEmptyText = '';
  // Tally of tool calls — used to synthesise a stub final reply when the
  // model emitted no text at all across the whole turn.
  const toolTally: Record<string, number> = {};
  // Forced-summary state. When the model returns an empty response after
  // a tool batch, we push a synthetic user message asking for a summary
  // and re-invoke the model. This matches what claude-code-main does to
  // get small Ollama models (qwen3.5, deepseek-r1) to reliably summarise.
  // Capped at one prod per turn to avoid loops if the model never
  // cooperates.
  let summaryProdsUsed = 0;
  const MAX_SUMMARY_PRODS = 1;
  // Same idea for a model that returns nothing before doing any work at all —
  // observed on llama.cpp when a reasoning model spends its whole token budget
  // in reasoning_content and finishes with finish_reason "length" and empty
  // content. Without a prod the user gets a blank reply and no explanation.
  let emptyProdsUsed = 0;
  const MAX_EMPTY_PRODS = 1;
  // How many times each (tool, arguments) pair has been dispatched this turn.
  const callCounts = new Map<string, number>();
  let reason: TerminalReason = 'unknown-error';

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        reason = 'aborted';
        break;
      }

      // Compact old tool results when history gets too long, then re-establish
      // the tool_use/tool_result pairing invariant. Repair is a no-op copy on a
      // well-formed history; it earns its place on the first turn after a
      // conversation is restored from disk, which is where an unanswered
      // tool_use written by an older build would otherwise fail every turn.
      // Summarising costs one model call, so it only runs when compaction is
      // actually about to discard messages; compactHistoryWithSummary decides
      // that internally and skips the callback otherwise. A summariser that
      // fails returns null and the plain drop notice is used instead.
      // Before budgeting: an old screenshot is almost never what the model
      // needs, and two of them can outweigh the entire text history. Guarded so
      // a text-only conversation never reads configuration for this.
      if (state.history.some((m) => m.content.some((b) => b.type === 'image'))) {
        state.history = evictOldImages(state.history, imageLimits().keepInHistory);
      }
      state.history = repairHistory(
        opts.summariseDropped === false
          ? compactHistory(state.history, provider.contextWindow)
          : await compactHistoryWithSummary(state.history, provider.contextWindow, (dropped) =>
              summariseMessages(dropped, provider, signal),
            ),
      );

      let response: ProviderResponse;
      try {
        response = await retry(
          () => {
            const sendOpts: {
              signal?: AbortSignal;
              onText?: (delta: string) => void;
              onThinking?: (delta: string) => void;
            } = {};
            if (signal) sendOpts.signal = signal;
            if (opts.onAssistantDelta) sendOpts.onText = opts.onAssistantDelta;
            if (opts.onAssistantThinking) sendOpts.onThinking = opts.onAssistantThinking;
            const allTools = toolDefinitions();
            const tools =
              opts.allowedTools && opts.allowedTools.length > 0
                ? allTools.filter((t) => opts.allowedTools?.includes(t.name))
                : allTools;
            return provider.send({
              system: systemPrompt,
              messages: state.history,
              tools,
              ...sendOpts,
            });
          },
          {
            maxAttempts: maxRetries,
            ...(signal !== undefined ? { signal } : {}),
            classifier: (error) => {
              const result: { retry: boolean; retryAfterMs?: number } = {
                retry: isRetryable(error),
              };
              const after = retryAfterMs(error);
              if (after !== undefined) result.retryAfterMs = after;
              return result;
            },
            onRetry: (attempt, delayMs, error) => {
              const kind = error instanceof ProviderError ? error.kind : 'transient';
              opts.onRetry?.(
                attempt,
                delayMs,
                `${kind}: ${(error as Error).message?.split('\n')[0] ?? 'unknown'}`,
              );
            },
          },
        );
      } catch (error) {
        if (isAbort(error)) {
          reason = 'aborted';
          break;
        }
        if (error instanceof ProviderError) {
          if (error.kind === 'context-overflow') reason = 'context-overflow';
          else if (error.kind === 'auth') reason = 'auth-error';
          else if (error.kind === 'bad-request') reason = 'bad-request';
          else reason = 'unknown-error';
        }
        throw error;
      }

      const available = visibleToolNames(opts.allowedTools);
      const content = normaliseResponseContent(response.content, available);

      // Never push an empty assistant message: the turn may continue below
      // with a prod, and a message with no content blocks is rejected outright
      // by the Anthropic API and strands the pairing invariant elsewhere.
      state.history.push({
        role: 'assistant',
        content:
          content.length > 0 ? content : [{ type: 'text', text: EMPTY_ASSISTANT_PLACEHOLDER }],
      });

      const textBlocks = content.filter((b): b is TextBlock => b.type === 'text');
      for (const t of textBlocks) {
        if (t.text) opts.onAssistantText?.(t.text);
      }
      const turnText = textBlocks
        .map((b) => b.text)
        .filter((s) => s)
        .join('\n')
        .trim();
      if (turnText) lastNonEmptyText = turnText;

      const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      if (toolUses.length === 0) {
        // No tool calls this turn — model is done. Three sub-cases:
        //   a) text was emitted → use it (happy path)
        //   b) empty AND no tools have ever run this turn → use stub
        //   c) empty BUT we've run tools earlier → force a summary turn.
        //      This is the architectural fix that gets small Ollama models
        //      (qwen3.5, deepseek-r1) to actually emit closing summaries.
        if (turnText) {
          finalText = turnText;
          reason = 'end-turn';
          break;
        }
        const ranToolsThisTurn = Object.values(toolTally).some((n) => n > 0);
        if (!ranToolsThisTurn && emptyProdsUsed < MAX_EMPTY_PRODS) {
          // Nothing happened at all: no text, no tools, nothing to fall back
          // on. One re-ask costs a round trip and usually lands, where the
          // alternative is handing the user a blank turn.
          emptyProdsUsed++;
          state.history.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  response.stopReason === 'max_tokens'
                    ? 'Your reply was cut off by the token limit before any visible text — the whole budget went into reasoning. Answer now, briefly and directly, with no preamble.'
                    : 'Your reply was empty. Answer my last message now, in plain text.',
              },
            ],
          });
          continue;
        }
        if (ranToolsThisTurn && summaryProdsUsed < MAX_SUMMARY_PRODS) {
          // Force one more turn with an explicit "now summarise" hint.
          summaryProdsUsed++;
          const toolList = Object.entries(toolTally)
            .sort(([, a], [, b]) => b - a)
            .map(([name, n]) => `${n}× ${name}`)
            .join(', ');
          state.history.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You ran ${toolList} but haven't sent a closing reply yet. Now respond — in one or two sentences — with a short summary of what changed. Do NOT call more tools; text only.`,
              },
            ],
          });
          continue;
        }
        // No text, no more prods left. Fall back through last non-empty
        // text from earlier in the turn, then a synthesised stub.
        finalText = lastNonEmptyText || synthesiseStub(toolTally);
        reason = 'end-turn';
        break;
      }

      // Run tool calls in batches — consecutive concurrency-safe tools run
      // in parallel via Promise.all; everything else runs sequentially.
      const toolResults: ContentBlock[] = [];
      // Paths of images produced this turn, fed back to the model below so it
      // can look at its own screenshots instead of only knowing where they are.
      const imagePaths: string[] = [];
      const batches = partitionTools(toolUses);

      for (const batch of batches) {
        if (signal?.aborted) {
          reason = 'aborted';
          break;
        }

        const executeSingle = async (use: ToolUseBlock): Promise<ToolResultBlock> => {
          // Already canonical: normaliseResponseContent folded any casing or
          // namespace slip onto the registered name before the block got here.
          const name = use.name;
          toolTally[name] = (toolTally[name] ?? 0) + 1;
          let toolInput = { ...use.input };
          opts.onToolUse?.(name, toolInput);

          const fail = (why: string): ToolResultBlock => {
            opts.onToolResult?.(name, why, true);
            return { type: 'tool_result', tool_use_id: use.id, content: why, is_error: true };
          };

          // Arguments the provider could not parse never reached a tool. The
          // tool would have answered "path is required", which says nothing
          // about the actual fault and gets the same broken JSON back next
          // turn; the model needs to be told its JSON was the problem.
          const malformed = readMalformedArguments(toolInput);
          if (malformed) {
            return fail(
              malformedArgumentsMessage(name, malformed.raw, getTool(name)?.input_schema),
            );
          }

          // Plugin handlers run alongside the shell hooks and can block the same
          // way. Same vocabulary on purpose — two ways of hooking the loop with
          // one decision type, rather than two that drift apart.
          const pluginBefore = await firePluginEvent({
            event: 'before_tool',
            tool: name,
            toolInput,
          });
          for (const e of pluginBefore.errors) opts.onToolResult?.(name, e, true);
          if (pluginBefore.decision?.action === 'block') {
            const why = pluginBefore.decision.reason;
            opts.onToolResult?.(name, why, true);
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `tool blocked by plugin: ${why}`,
              is_error: true,
            };
          }

          if (hooks.length > 0) {
            const before = await fireHooks(
              hooks,
              { event: 'before_tool', tool: name, toolInput },
              signal,
            );
            for (const r of before) {
              opts.onHook?.(r);
              // Hooks fail closed, by one rule: a hook denies the call if it
              // says `block`, or if it exits non-zero.
              //
              // Both halves matter. The conventional deny idiom is
              // `echo '{"action":"block"}'; exit 2`, and the old code skipped
              // every non-zero exit before looking at the decision — so the one
              // idiom people actually write failed *open*. And a hook that
              // crashed cannot be read as approval: it may have died before
              // reaching its own check, or after deciding the input needed
              // rewriting, in which case running the original input is the
              // thing it was trying to prevent.
              //
              // A hook whose last command exits non-zero benignly (`grep -q`
              // finding nothing is the usual one) should end with `|| true`.
              const denied = r.decision?.action === 'block' || r.exitCode !== 0;
              if (denied) {
                const why =
                  r.decision?.reason ||
                  (r.exitCode !== 0 ? `hook exited ${r.exitCode}` : 'blocked by hook');
                opts.onToolResult?.(name, why, true);
                return {
                  type: 'tool_result',
                  tool_use_id: use.id,
                  content: `tool blocked by hook "${r.hook}": ${why}`,
                  is_error: true,
                };
              }
              // A rewrite from a hook that failed is not trustworthy input.
              if (r.exitCode === 0 && r.decision?.action === 'rewrite') {
                toolInput = { ...r.decision.input };
              }
            }
          }
          // allowedTools filters the definitions sent to the model, but a model
          // will happily emit a tool it saw earlier in the conversation, so the
          // list has to be enforced here too. Without this a read-only
          // sub-agent — explore, planner, code-reviewer — whose allowedTools
          // excludes Write could still write to disk.
          if (opts.allowedTools?.length && !opts.allowedTools.includes(name)) {
            return fail(`tool "${name}" is not available to this agent`);
          }
          const tool = getTool(name);
          let output: string;
          let isError: boolean;
          if (!tool) {
            // A bare "tool not found" gives an inventive model nothing to
            // correct towards, and it invents the same name again next turn.
            output = unknownToolMessage(name, available);
            isError = true;
          } else {
            // Repair the shape before validating it — a double-wrapped or
            // stringified argument is the model's formatting, not a missing
            // parameter, and reporting it as one would be a lie.
            toolInput = coerceToolInput(toolInput, tool.input_schema);
            const missing = missingRequired(toolInput, tool.input_schema);
            if (missing.length > 0) {
              return fail(missingArgumentsMessage(name, missing, toolInput, tool.input_schema));
            }
            const repeats = countCall(callCounts, name, toolInput);
            if (repeats > MAX_IDENTICAL_TOOL_CALLS) {
              return fail(
                `${name} has already run ${MAX_IDENTICAL_TOOL_CALLS} times this turn with exactly these arguments and returned the same thing each time. Running it again cannot help — change the arguments, use a different tool, or reply to the user with what you have.`,
              );
            }
            const deadlineMs = tool.interactive
              ? Math.max(toolTimeoutMs, INTERACTIVE_TOOL_TIMEOUT_MS)
              : toolTimeoutMs;
            const exec = await runToolWithTimeout(tool, toolInput, deadlineMs, signal);
            output = exec.output;
            isError = exec.isError;
            for (const a of exec.attachments ?? []) {
              if (a.kind === 'image') imagePaths.push(a.path);
              if (!opts.onAttachment) continue;
              const forwarded: { kind: string; path: string; caption?: string } = {
                kind: a.kind,
                path: a.path,
              };
              if (a.caption !== undefined) forwarded.caption = a.caption;
              opts.onAttachment(forwarded);
            }
          }
          // Callback receives the ORIGINAL output, not the persisted version.
          opts.onToolResult?.(name, output, isError);
          if (hooks.length > 0) {
            const after = await fireHooks(
              hooks,
              {
                event: 'after_tool',
                tool: name,
                toolInput,
                toolOutput: output,
                toolError: isError,
              },
              signal,
            );
            for (const r of after) opts.onHook?.(r);
          }
          // Persist large non-error outputs to disk and replace content
          // with a summary + preview for the model's context window.
          const persistedOutput =
            !isError && shouldPersistOutput(output) ? persistOutput(name, output) : output;
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: persistedOutput,
            is_error: isError,
          };
        };

        if (batch.parallel && batch.uses.length > 1) {
          const results = await Promise.all(batch.uses.map(executeSingle));
          toolResults.push(...results);
        } else {
          for (const use of batch.uses) {
            if (signal?.aborted) {
              reason = 'aborted';
              break;
            }
            const result = await executeSingle(use);
            toolResults.push(result);
          }
        }
      }

      // Answer the tool_use blocks pushed above unconditionally — including on
      // the abort path, which used to break out first and strand them. An
      // unanswered tool_use makes every later request fail with a 400 that is
      // classified non-retryable, and the caller persists this history, so the
      // conversation stays broken across restarts and /resume.
      // Images ride in the SAME user message as the tool results. A separate
      // message would put two user turns back to back, which the Anthropic API
      // rejects outright.
      const answered: ContentBlock[] = completeToolResults(response.content, toolResults);
      if (imagePaths.length > 0) {
        const { blocks, notes } = await collectImageBlocks(imagePaths);
        for (const note of notes) answered.push({ type: 'text', text: note });
        answered.push(...blocks);
      }
      state.history.push({ role: 'user', content: answered });

      if ((reason as TerminalReason) === 'aborted') break;

      if (turn === maxTurns - 1) {
        reason = 'max-turns';
        break;
      }
    }
  } catch (error) {
    if (hooks.length > 0) {
      const errResults = await fireHooks(
        hooks,
        {
          event: 'on_error',
          error: {
            kind: error instanceof ProviderError ? error.kind : 'exception',
            message: (error as Error)?.message ?? String(error),
          },
        },
        signal,
      );
      for (const r of errResults) opts.onHook?.(r);
    }
    if (isAbort(error)) {
      reason = 'aborted';
    } else if (reason === 'unknown-error') {
      // unhandled — re-throw so the caller can see the stack
      throw error;
    } else {
      throw error;
    }
  }

  if (hooks.length > 0 && reason === 'end-turn') {
    const after = await fireHooks(hooks, { event: 'after_turn', finalText }, signal);
    for (const r of after) opts.onHook?.(r);
  }

  return { finalText, reason };
}

/** Tool names this turn is allowed to dispatch, in registry order. */
function visibleToolNames(allowed?: readonly string[]): string[] {
  const all = toolDefinitions().map((t) => t.name);
  if (!allowed || allowed.length === 0) return all;
  return all.filter((n) => allowed.includes(n));
}

/**
 * Cleans up the two things small local models get wrong about *how* they ask
 * for a tool, before anything in the loop reads the response.
 *
 * 1. Names that differ from a real tool only in casing or punctuation are
 *    folded onto the real one. Doing it here rather than at dispatch means
 *    concurrency classification, history and the provider echo all see the
 *    canonical name.
 * 2. A model with no native tool support writes its calls into the text. Those
 *    are recovered — but only when the response carried no tool calls on the
 *    proper channel, so a model that used the channel correctly never has its
 *    prose re-read as a call.
 */
function normaliseResponseContent(
  content: readonly ContentBlock[],
  available: readonly string[],
): ContentBlock[] {
  const canonical = content.map((block) =>
    block.type === 'tool_use'
      ? { ...block, name: canonicalToolName(block.name, available) ?? block.name }
      : block,
  );
  if (canonical.some((b) => b.type === 'tool_use')) return canonical;

  const spoken = canonical
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const recovered = recoverToolCallsFromText(spoken, available);
  if (!recovered) return canonical;

  const blocks: ContentBlock[] = [];
  if (recovered.text) blocks.push({ type: 'text', text: recovered.text });
  blocks.push(...recovered.calls);
  return blocks;
}

/** Message for a tool name that matched nothing, with the candidates a model
 *  needs in order to fix it rather than invent again. */
function unknownToolMessage(name: string, available: readonly string[]): string {
  const suggestions = suggestToolNames(name, available);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
  return `tool not found: ${name}.${hint} Available tools: ${available.join(', ')}`;
}

/** Bumps and returns the count of dispatches of this exact call this turn. */
function countCall(
  counts: Map<string, number>,
  name: string,
  input: Record<string, unknown>,
): number {
  let signature: string;
  try {
    signature = `${name}:${JSON.stringify(input)}`;
  } catch {
    // Unserialisable input cannot be compared, so it is never "identical".
    return 1;
  }
  const next = (counts.get(signature) ?? 0) + 1;
  counts.set(signature, next);
  return next;
}

// Partition tool_use blocks into sequential/parallel batches.
// Consecutive concurrency-safe tools form a parallel batch; any
// non-safe tool breaks the sequence and runs alone.
interface ToolBatch {
  uses: ToolUseBlock[];
  parallel: boolean;
}

function partitionTools(uses: ToolUseBlock[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  let currentParallel: ToolUseBlock[] = [];

  for (const use of uses) {
    if (isConcurrencySafe(use.name)) {
      currentParallel.push(use);
    } else {
      if (currentParallel.length > 0) {
        batches.push({ uses: currentParallel, parallel: true });
        currentParallel = [];
      }
      batches.push({ uses: [use], parallel: false });
    }
  }
  if (currentParallel.length > 0) {
    batches.push({ uses: currentParallel, parallel: true });
  }
  return batches;
}

interface ToolExecResult {
  output: string;
  isError: boolean;
  attachments?: Array<{ kind: string; path: string; caption?: string }>;
}

async function runToolWithTimeout(
  tool: {
    execute: (
      input: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<ToolExecResult>;
  },
  input: Record<string, unknown>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<ToolExecResult> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  // Hard deadline via Promise.race — guarantees we return within timeoutMs
  // even if the tool ignores the AbortSignal (e.g. execa + Bun edge cases
  // where cancelSignal doesn't kill the child process tree).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ToolExecResult>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error(`tool timeout after ${Math.round(timeoutMs / 1000)}s`));
      resolve({
        output: `tool timed out after ${Math.round(timeoutMs / 1000)}s`,
        isError: true,
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      tool.execute(input, { signal: ctrl.signal }).catch((e) => ({
        output: `tool execution error: ${(e as Error).message}`,
        isError: true,
      })),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onParentAbort);
  }
}

/** Build a stub final reply when the model finished a turn without
 *  emitting any closing text. Lists what tools ran so the user at least
 *  sees that work happened. Empty string when no tools were called either
 *  (the loop will fall back to "(no reply)" downstream). */
function synthesiseStub(tally: Record<string, number>): string {
  const entries = Object.entries(tally).filter(([, n]) => n > 0);
  if (entries.length === 0) return '';
  const summary = entries
    .sort(([, a], [, b]) => b - a)
    .map(([name, n]) => `${n}× ${name}`)
    .join(', ');
  return `(done — ran ${summary}; the model didn't return a closing summary)`;
}
