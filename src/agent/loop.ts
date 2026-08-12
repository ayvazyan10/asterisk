// Agent loop — drives a Provider through tool-use turns until end_turn.
// Reference: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use
//
// Includes a retry wrapper around provider.send (exponential backoff with
// jitter, Retry-After honouring, classified by ProviderError.kind), per-tool
// timeout enforcement, and AbortSignal threading from the REPL down to the
// shell-level tools.

import type {
  ContentBlock,
  Message,
  Provider,
  TextBlock,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock,
} from '../types/messages.ts';
import type { HookConfig } from '../config/schema.ts';
import { fireHooks, type HookResult } from '../hooks/runner.ts';
import { ProviderError, isAbort, isRetryable, retryAfterMs } from '../providers/errors.ts';
import { rulesToPromptSection, type Rule } from '../rules/loader.ts';
import { soulsToPromptSection, type Soul } from '../soul/loader.ts';
import { outputStyleToPromptSection, type OutputStyle } from '../output-styles/styles.ts';
import { getTool, toolDefinitions } from '../tools/registry.ts';
import { retry } from '../utils/retry.ts';
import { type AgentSession, runWithSession } from './context.ts';
import { shouldPersistOutput, persistOutput } from './output-store.ts';
import { compactHistory } from './compaction.ts';
import { completeToolResults, repairHistory } from './history.ts';
import { getDb } from '../db/index.ts';
import { isEmptyUsage, recordUsage } from '../db/usage.ts';
import { isConcurrencySafe } from '../tools/concurrency.ts';

const SYSTEM_PROMPT = `You are Asterisk, a personal AI assistant running on the user's machine.

Tools you have:
- Filesystem: Read, Write, Edit, Grep, Glob
- Shell: Bash
- Browser (real Chromium): BrowserNavigate, BrowserClick, BrowserType,
  BrowserPress, BrowserSnapshot, BrowserScreenshot, BrowserWait, BrowserClose
- Web: WebFetch (load a URL as text), WebSearch (Brave / Tavily / SearXNG /
  DDG instant-answer; the first one with a configured key wins)
- Sharing: Attach — send a file (image / video / audio / document) to the
  user out-of-band. In the Telegram / WhatsApp daemon this becomes a real
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
   *  WhatsApp users never see each other's stuff. The REPL passes
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
   *  daemon collects these and ships them via Telegram / WhatsApp media
   *  APIs; the REPL renders inline when the terminal supports it. */
  onAttachment?(attachment: { kind: string; path: string; caption?: string }): void;
}

export interface AgentTurnResult {
  finalText: string;
  reason: TerminalReason;
  /** Tokens consumed across every model call made during the turn. */
  usage: TokenUsage;
  /** How many times the provider was called — one per tool round trip plus one. */
  modelCalls: number;
}

/**
 * Writes the turn's usage to the database.
 *
 * Deliberately a no-op when the providers reported no counters: that keeps
 * turns driven by stub providers (every agent-loop test) from touching the
 * filesystem at all. Failures are swallowed — accounting must never break a
 * turn that already produced an answer for the user.
 */
function persistUsage(
  providerName: string,
  session: AgentSession,
  usage: TokenUsage,
  modelCalls: number,
): void {
  if (isEmptyUsage(usage)) return;

  // Provider names are `<provider>:<model>`; the model itself may contain
  // colons (`qwen3.5:9b-q8-max`), so split on the first one only.
  const separator = providerName.indexOf(':');
  const provider = separator > 0 ? providerName.slice(0, separator) : providerName;
  const model = separator > 0 ? providerName.slice(separator + 1) : '';

  try {
    recordUsage(getDb(), {
      sessionScope: session.scope,
      sessionId: session.id,
      provider,
      model,
      tokens: usage,
      modelCalls,
    });
  } catch {
    // A read-only or missing database must not fail the turn.
  }
}

/** Folds one response's usage into a running total. Mutates `into` in place. */
function addUsage(into: TokenUsage, from: TokenUsage | undefined): void {
  if (!from) return;
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
  ] as const) {
    const value = from[key];
    if (typeof value === 'number') into[key] = (into[key] ?? 0) + value;
  }
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
    const before = await fireHooks(
      hooks,
      { event: 'before_turn', userText: userInput },
      signal,
    );
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
  let reason: TerminalReason = 'unknown-error';
  // Usage accumulates across every model call in the turn — a turn that fires
  // tools makes several, and the caller wants the total, not the last one.
  const usage: TokenUsage = {};
  let modelCalls = 0;

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
      state.history = repairHistory(compactHistory(state.history));

      let response;
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
            const tools = opts.allowedTools && opts.allowedTools.length > 0
              ? allTools.filter((t) => opts.allowedTools!.includes(t.name))
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

      modelCalls++;
      addUsage(usage, response.usage);

      state.history.push({ role: 'assistant', content: response.content });

      const textBlocks = response.content.filter((b): b is TextBlock => b.type === 'text');
      for (const t of textBlocks) {
        if (t.text) opts.onAssistantText?.(t.text);
      }
      const turnText = textBlocks
        .map((b) => b.text)
        .filter((s) => s)
        .join('\n')
        .trim();
      if (turnText) lastNonEmptyText = turnText;

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

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
                text:
                  `You ran ${toolList} but haven't sent a closing reply yet. ` +
                  `Now respond — in one or two sentences — with a short summary of what changed. ` +
                  `Do NOT call more tools; text only.`,
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
      const batches = partitionTools(toolUses);

      for (const batch of batches) {
        if (signal?.aborted) {
          reason = 'aborted';
          break;
        }

        const executeSingle = async (use: ToolUseBlock): Promise<ToolResultBlock> => {
          toolTally[use.name] = (toolTally[use.name] ?? 0) + 1;
          let toolInput = { ...use.input };
          opts.onToolUse?.(use.name, toolInput);
          if (hooks.length > 0) {
            const before = await fireHooks(
              hooks,
              { event: 'before_tool', tool: use.name, toolInput },
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
                opts.onToolResult?.(use.name, why, true);
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
          if (opts.allowedTools?.length && !opts.allowedTools.includes(use.name)) {
            const why = `tool "${use.name}" is not available to this agent`;
            opts.onToolResult?.(use.name, why, true);
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              content: why,
              is_error: true,
            };
          }
          const tool = getTool(use.name);
          let output: string;
          let isError: boolean;
          if (!tool) {
            output = `tool not found: ${use.name}`;
            isError = true;
          } else {
            const exec = await runToolWithTimeout(
              tool,
              toolInput,
              toolTimeoutMs,
              signal,
            );
            output = exec.output;
            isError = exec.isError;
            if (exec.attachments && opts.onAttachment) {
              for (const a of exec.attachments) {
                const forwarded: { kind: string; path: string; caption?: string } = {
                  kind: a.kind,
                  path: a.path,
                };
                if (a.caption !== undefined) forwarded.caption = a.caption;
                opts.onAttachment(forwarded);
              }
            }
          }
          // Callback receives the ORIGINAL output, not the persisted version.
          opts.onToolResult?.(use.name, output, isError);
          if (hooks.length > 0) {
            const after = await fireHooks(
              hooks,
              {
                event: 'after_tool',
                tool: use.name,
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
          const persistedOutput = !isError && shouldPersistOutput(output)
            ? persistOutput(use.name, output)
            : output;
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
      state.history.push({
        role: 'user',
        content: completeToolResults(response.content, toolResults),
      });

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

  persistUsage(
    provider.name,
    opts.session ?? { id: 'default', scope: 'unknown' },
    usage,
    modelCalls,
  );

  return { finalText, reason, usage, modelCalls };
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
  let timer: ReturnType<typeof setTimeout>;
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
    clearTimeout(timer!);
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
