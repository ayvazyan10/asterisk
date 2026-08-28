import { describe, expect, it } from 'vitest';

import type { HookConfig } from '../src/config/schema.ts';
import { MAX_HOOK_OUTPUT_BYTES, fireHooks } from '../src/hooks/runner.ts';

const baseHook: HookConfig = {
  name: 'test',
  event: 'after_tool',
  command: 'cat',
  timeoutSeconds: 5,
  enabled: true,
};

describe('fireHooks', () => {
  it('fires no hooks when none match the event', async () => {
    const results = await fireHooks([{ ...baseHook, event: 'before_turn' }], {
      event: 'after_turn',
      finalText: 'done',
    });
    expect(results).toEqual([]);
  });

  it('skips disabled hooks', async () => {
    const results = await fireHooks([{ ...baseHook, enabled: false }], {
      event: 'after_tool',
      tool: 'Bash',
    });
    expect(results).toEqual([]);
  });

  it('runs an after_tool hook and captures stdout via JSON-on-stdin', async () => {
    const hook: HookConfig = {
      name: 'echo-tool',
      event: 'after_tool',
      command: 'cat',
      timeoutSeconds: 5,
      enabled: true,
    };
    const results = await fireHooks([hook], {
      event: 'after_tool',
      tool: 'Write',
      toolOutput: 'wrote 5 bytes',
      toolError: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).toBe(0);
    const payload = JSON.parse(results[0]?.stdout ?? '{}');
    expect(payload.event).toBe('after_tool');
    expect(payload.tool).toBe('Write');
    expect(payload.toolOutput).toBe('wrote 5 bytes');
  });

  it('parses a before_tool block decision from stdout JSON', async () => {
    const hook: HookConfig = {
      name: 'block-rm',
      event: 'before_tool',
      command: 'echo \'{"action":"block","reason":"no rm"}\'',
      timeoutSeconds: 5,
      enabled: true,
    };
    const results = await fireHooks([hook], {
      event: 'before_tool',
      tool: 'Bash',
      toolInput: { command: 'rm -rf tmp' },
    });
    expect(results[0]?.decision).toEqual({ action: 'block', reason: 'no rm' });
  });

  it('parses a before_tool rewrite decision from stdout JSON', async () => {
    const hook: HookConfig = {
      name: 'rewrite',
      event: 'before_tool',
      command: 'echo \'{"action":"rewrite","input":{"command":"echo rewritten"}}\'',
      timeoutSeconds: 5,
      enabled: true,
    };
    const results = await fireHooks([hook], {
      event: 'before_tool',
      tool: 'Bash',
      toolInput: { command: 'echo original' },
    });
    expect(results[0]?.decision).toEqual({
      action: 'rewrite',
      input: { command: 'echo rewritten' },
    });
  });

  it('respects the matcher regex against tool name', async () => {
    const hookForWrite: HookConfig = {
      ...baseHook,
      name: 'only-write',
      command: 'echo matched',
      matcher: '^Write$',
    };
    const triggered = await fireHooks([hookForWrite], {
      event: 'after_tool',
      tool: 'Write',
    });
    expect(triggered[0]?.stdout.trim()).toBe('matched');

    const skipped = await fireHooks([hookForWrite], {
      event: 'after_tool',
      tool: 'Bash',
    });
    expect(skipped).toEqual([]);
  });

  it('captures non-zero exit code and stderr', async () => {
    const hook: HookConfig = {
      ...baseHook,
      name: 'fail',
      command: 'echo whoops >&2; exit 7',
    };
    const results = await fireHooks([hook], { event: 'after_tool', tool: 'Bash' });
    expect(results[0]?.exitCode).toBe(7);
    expect(results[0]?.stderr.trim()).toBe('whoops');
  });

  it('safely skips a hook with an invalid regex matcher', async () => {
    const hook: HookConfig = {
      ...baseHook,
      name: 'bad-regex',
      matcher: '(',
    };
    const results = await fireHooks([hook], { event: 'after_tool', tool: 'Bash' });
    expect(results).toEqual([]);
  });

  it('caps captured stdout at MAX_HOOK_OUTPUT_BYTES and notes the truncation, instead of buffering without limit', async () => {
    // A hook piping well past the cap at high speed — this is the OOM risk:
    // the daemon process that also holds the Telegram bridge and the
    // scheduler would otherwise grow its own heap without bound for as long
    // as the hook keeps writing, up to the full timeout window.
    const overflowBytes = MAX_HOOK_OUTPUT_BYTES + 500_000;
    const hook: HookConfig = {
      ...baseHook,
      name: 'firehose',
      command: `yes | head -c ${overflowBytes}`,
      timeoutSeconds: 15,
    };
    const results = await fireHooks([hook], { event: 'after_tool', tool: 'Bash' });
    expect(results).toHaveLength(1);
    // Capped, not merely "smaller than what was written" — allow a little
    // slack for the truncation note appended to the captured text.
    expect(results[0]?.stdout.length).toBeLessThan(MAX_HOOK_OUTPUT_BYTES + 200);
    expect(results[0]?.stdout).toContain('truncated');
  }, 15_000);

  it('does not truncate output comfortably under the cap', async () => {
    const results = await fireHooks([{ ...baseHook, command: 'echo small output' }], {
      event: 'after_tool',
      tool: 'Bash',
    });
    expect(results[0]?.stdout.trim()).toBe('small output');
    expect(results[0]?.stdout).not.toContain('truncated');
  });
});
