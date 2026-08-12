// Hook runner — fires user-defined shell commands at agent lifecycle events.
// The event payload is piped to the hook on stdin as JSON; stdout is captured
// and surfaced as a system note. before_tool hooks may return a JSON decision:
//   {"action":"block","reason":"..."}
//   {"action":"rewrite","input":{...}}
// Any other stdout remains informational.

import { spawn } from 'node:child_process';
import type { HookConfig, HookEvent } from '../config/schema.ts';

export interface HookContext {
  event: HookEvent;
  /** For tool events: the tool's name. */
  tool?: string;
  /** For tool events: the tool's input (stringified before being sent). */
  toolInput?: Record<string, unknown>;
  /** For after_tool: the tool's textual result. */
  toolOutput?: string;
  /** For after_tool: whether the tool returned an error. */
  toolError?: boolean;
  /** For before_turn: the user's input text. */
  userText?: string;
  /** For after_turn: the agent's final reply. */
  finalText?: string;
  /** For on_error: the error class / kind / message. */
  error?: { kind: string; message: string };
}

export interface HookResult {
  hook: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  decision?: HookDecision;
}

export type HookDecision =
  | { action: 'block'; reason: string }
  | { action: 'rewrite'; input: Record<string, unknown>; reason?: string };

export async function fireHooks(
  hooks: readonly HookConfig[],
  ctx: HookContext,
  signal?: AbortSignal,
): Promise<HookResult[]> {
  const matching = hooks.filter((h) => h.enabled && h.event === ctx.event && matches(h, ctx));
  const results: HookResult[] = [];
  for (const hook of matching) {
    if (signal?.aborted) break;
    const start = Date.now();
    const stdin = JSON.stringify(ctx);
    try {
      const r = await runShellHook(hook.command, stdin, (hook.timeoutSeconds ?? 30) * 1000, signal);
      const result: HookResult = {
        hook: hook.name,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: Date.now() - start,
      };
      const decision = parseDecision(r.stdout, ctx);
      if (decision) result.decision = decision;
      results.push(result);
    } catch (e) {
      results.push({
        hook: hook.name,
        exitCode: 1,
        stdout: '',
        stderr: (e as Error).message,
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

function parseDecision(stdout: string, ctx: HookContext): HookDecision | undefined {
  if (ctx.event !== 'before_tool') return undefined;
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const firstJson = trimmed
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!firstJson) return undefined;
  try {
    const parsed = JSON.parse(firstJson) as {
      action?: unknown;
      reason?: unknown;
      input?: unknown;
    };
    if (parsed.action === 'block') {
      return {
        action: 'block',
        reason:
          typeof parsed.reason === 'string' && parsed.reason.trim()
            ? parsed.reason.trim()
            : 'blocked by hook',
      };
    }
    if (
      parsed.action === 'rewrite' &&
      typeof parsed.input === 'object' &&
      parsed.input !== null &&
      !Array.isArray(parsed.input)
    ) {
      const decision: HookDecision = {
        action: 'rewrite',
        input: parsed.input as Record<string, unknown>,
      };
      if (typeof parsed.reason === 'string' && parsed.reason.trim()) {
        decision.reason = parsed.reason.trim();
      }
      return decision;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function runShellHook(
  command: string,
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const finish = (result: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      proc.kill('SIGTERM');
      finish({ exitCode: 1, stdout: '', stderr: 'hook aborted' });
    };
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish({
        exitCode: 1,
        stdout: '',
        stderr: `hook timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.stdin!.write(stdin);
    proc.stdin!.end();

    proc.on('close', (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      });
    });
    proc.on('error', (err) => {
      finish({ exitCode: 1, stdout: '', stderr: err.message });
    });
  });
}

function matches(hook: HookConfig, ctx: HookContext): boolean {
  if (!hook.matcher) return true;
  let target = '';
  if (ctx.event === 'before_tool' || ctx.event === 'after_tool') target = ctx.tool ?? '';
  else if (ctx.event === 'before_turn') target = ctx.userText ?? '';
  else if (ctx.event === 'after_turn') target = ctx.finalText ?? '';
  else if (ctx.event === 'on_error') target = ctx.error?.message ?? '';
  try {
    return new RegExp(hook.matcher).test(target);
  } catch {
    return false;
  }
}

export type { HookConfig, HookEvent };
