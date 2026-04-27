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
  ToolResultBlock,
  ToolUseBlock,
} from '../types/messages.ts';
import type { HookConfig } from '../config/schema.ts';
import { fireHooks, type HookResult } from '../hooks/runner.ts';
import { ProviderError, isAbort, isRetryable, retryAfterMs } from '../providers/errors.ts';
import { rulesToPromptSection, type Rule } from '../rules/loader.ts';
import { soulsToPromptSection, type Soul } from '../soul/loader.ts';
import { getTool, toolDefinitions } from '../tools/registry.ts';
import { retry } from '../utils/retry.ts';
import { type AgentSession, runWithSession } from './context.ts';

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

Be concise. Prefer doing work directly with tools over describing what you
would do. When a task is complete, respond with a short summary.`;

const DEFAULT_MAX_TURNS = 12;
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
  const systemPrompt = [SYSTEM_PROMPT, soulSection, rulesSection]
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
  let reason: TerminalReason = 'unknown-error';

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        reason = 'aborted';
        break;
      }

      let response;
      try {
        response = await retry(
          () => {
            const sendOpts: { signal?: AbortSignal; onText?: (delta: string) => void } = {};
            if (signal) sendOpts.signal = signal;
            if (opts.onAssistantDelta) sendOpts.onText = opts.onAssistantDelta;
            return provider.send({
              system: systemPrompt,
              messages: state.history,
              tools: toolDefinitions(),
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

      state.history.push({ role: 'assistant', content: response.content });

      const textBlocks = response.content.filter((b): b is TextBlock => b.type === 'text');
      for (const t of textBlocks) {
        if (t.text) opts.onAssistantText?.(t.text);
      }

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      if (toolUses.length === 0 || response.stopReason === 'end_turn') {
        finalText = textBlocks.map((b) => b.text).join('\n');
        reason = 'end-turn';
        break;
      }

      // Run all tool calls (sequentially, in the order the model emitted them)
      // and collect results into a single user message — mirrors the standard
      // tool-use loop documented at docs.anthropic.com.
      const toolResults: ContentBlock[] = [];
      for (const use of toolUses) {
        if (signal?.aborted) {
          reason = 'aborted';
          break;
        }
        opts.onToolUse?.(use.name, use.input);
        if (hooks.length > 0) {
          const before = await fireHooks(
            hooks,
            { event: 'before_tool', tool: use.name, toolInput: use.input },
            signal,
          );
          for (const r of before) opts.onHook?.(r);
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
            use.input,
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
        opts.onToolResult?.(use.name, output, isError);
        if (hooks.length > 0) {
          const after = await fireHooks(
            hooks,
            {
              event: 'after_tool',
              tool: use.name,
              toolInput: use.input,
              toolOutput: output,
              toolError: isError,
            },
            signal,
          );
          for (const r of after) opts.onHook?.(r);
        }
        const tr: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: output,
          is_error: isError,
        };
        toolResults.push(tr);
      }

      if ((reason as TerminalReason) === 'aborted') break;
      state.history.push({ role: 'user', content: toolResults });

      if (turn === maxTurns - 1) {
        reason = 'max-turns';
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
  const timer = setTimeout(
    () => ctrl.abort(new Error(`tool timeout after ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  try {
    return await tool.execute(input, { signal: ctrl.signal });
  } catch (e) {
    return {
      output: `tool execution error: ${(e as Error).message}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onParentAbort);
  }
}
