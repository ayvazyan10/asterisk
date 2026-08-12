import { describe, expect, it } from 'vitest';

import type { HookConfig } from '../src/config/schema.ts';
import { fireHooks } from '../src/hooks/runner.ts';

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
});
