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
import { ProviderError, isAbort, isRetryable, retryAfterMs } from '../providers/errors.ts';
import { getTool, toolDefinitions } from '../tools/registry.ts';
import { retry } from '../utils/retry.ts';

const SYSTEM_PROMPT = `You are Asterisk, a personal AI assistant running on the user's machine.
You can use tools (Bash, Read, Write, Edit, Grep, Glob) to inspect and modify the filesystem.
Be concise. Prefer doing work directly with tools over describing what you would do.
When a task is complete, respond with a short summary.`;

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
  onAssistantText?(text: string): void;
  onToolUse?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, output: string, isError: boolean): void;
  onRetry?(attempt: number, delayMs: number, reason: string): void;
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
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const signal = opts.signal;

  state.history.push({
    role: 'user',
    content: [{ type: 'text', text: userInput }],
  });

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
            const sendOpts: { signal?: AbortSignal } = {};
            if (signal) sendOpts.signal = signal;
            return provider.send({
              system: SYSTEM_PROMPT,
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
        }
        opts.onToolResult?.(use.name, output, isError);
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
    if (isAbort(error)) {
      reason = 'aborted';
    } else if (reason === 'unknown-error') {
      // unhandled — re-throw so the caller can see the stack
      throw error;
    } else {
      throw error;
    }
  }

  return { finalText, reason };
}

async function runToolWithTimeout(
  tool: { execute: (input: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{ output: string; isError: boolean }> },
  input: Record<string, unknown>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
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
