// Hook runner — fires user-defined shell commands at agent lifecycle events.
// The event payload is piped to the hook on stdin as JSON; stdout is captured
// and surfaced as a system note. Hooks are side-effect only in v1: their
// output is informational, not authoritative (no blocking, no input
// rewriting). Adding those is straightforward — wire returned JSON back into
// the loop's decision points — but the value is mostly captured here.

import { execa } from 'execa';

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
}

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
      const baseOpts = {
        timeout: (hook.timeoutSeconds ?? 30) * 1000,
        input: stdin,
        reject: false as const,
        encoding: 'utf8' as const,
      };
      const execOpts = signal ? { ...baseOpts, cancelSignal: signal } : baseOpts;
      const r = await execa('bash', ['-lc', hook.command], execOpts);
      results.push({
        hook: hook.name,
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0,
        stdout: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : '',
        durationMs: Date.now() - start,
      });
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
