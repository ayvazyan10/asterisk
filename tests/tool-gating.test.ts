// Enforcement tests for the two gates that used to be advisory only.
//
// 1. `allowedTools` filtered the tool *definitions* sent to the model but was
//    never checked at execution, so a read-only sub-agent that emitted Write
//    (models routinely recall tools from earlier context) still wrote.
// 2. A before_tool hook's `block` decision was discarded whenever the hook
//    exited non-zero — which is precisely the conventional deny idiom
//    `echo '{"action":"block"}'; exit 2`. Deny hooks failed open.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { _resetWorkspaceForTesting } from '../src/tools/workspace.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';

/**
 * Points the workspace guard at a throwaway directory so Write is genuinely
 * permitted there. Without this the guard refuses every write to a temp path
 * and the gate under test is never reached — the tests would pass for the
 * wrong reason.
 */
function useTempWorkspace(): () => string {
  let dir = '';
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asterisk-gate-'));
    saved = process.env['ASTERISK_WORKSPACE'];
    process.env['ASTERISK_WORKSPACE'] = dir;
    _resetWorkspaceForTesting();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['ASTERISK_WORKSPACE'];
    else process.env['ASTERISK_WORKSPACE'] = saved;
    _resetWorkspaceForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  return () => dir;
}

function fakeProvider(responses: ProviderResponse[]): Provider {
  let i = 0;
  return {
    name: 'fake',
    async send() {
      const r = responses[i++];
      if (!r) throw new Error('fake provider exhausted');
      return r;
    },
  };
}

function writeAttempt(path: string): ProviderResponse[] {
  return [
    {
      content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { path, content: 'pwned' } }],
      stopReason: 'tool_use',
    },
    { content: [{ type: 'text', text: 'finished' }], stopReason: 'end_turn' },
  ];
}

describe('allowedTools is enforced at execution', () => {
  const workspace = useTempWorkspace();
  const targetIn = (dir: string): string => join(dir, 'should-not-exist.txt');

  it('refuses a tool outside allowedTools and never touches the filesystem', async () => {
    const target = targetIn(workspace());
    const state = createAgentState();
    const onToolResult = vi.fn();

    await runAgentTurn(fakeProvider(writeAttempt(target)), state, 'write it', {
      allowedTools: ['Read', 'Grep'],
      onToolResult,
    });

    expect(existsSync(target)).toBe(false);
    expect(onToolResult).toHaveBeenCalledWith(
      'Write',
      expect.stringContaining('not available'),
      true,
    );
  });

  it('reports the refusal back to the model as an error tool_result', async () => {
    const target = targetIn(workspace());
    const state = createAgentState();
    await runAgentTurn(fakeProvider(writeAttempt(target)), state, 'write it', {
      allowedTools: ['Read'],
    });

    const results = state.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: 'w1', is_error: true });
  });

  it('still allows a tool that is on the list', async () => {
    const state = createAgentState();
    const onToolUse = vi.fn();

    await runAgentTurn(
      fakeProvider([
        {
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo ok' } }],
          stopReason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
      ]),
      state,
      'run it',
      { allowedTools: ['Bash'], onToolUse },
    );

    expect(onToolUse).toHaveBeenCalledWith('Bash', { command: 'echo ok' });
  });

  it('imposes no restriction when allowedTools is absent', async () => {
    const state = createAgentState();
    const onToolUse = vi.fn();

    await runAgentTurn(
      fakeProvider([
        {
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo ok' } }],
          stopReason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
      ]),
      state,
      'run it',
      { onToolUse },
    );

    expect(onToolUse).toHaveBeenCalled();
  });
});

describe('before_tool hooks fail closed', () => {
  const workspace = useTempWorkspace();
  const targetIn = (dir: string): string => join(dir, 'should-not-exist.txt');

  it('honours a block decision even when the hook exits non-zero', async () => {
    const target = targetIn(workspace());
    const state = createAgentState();

    await runAgentTurn(fakeProvider(writeAttempt(target)), state, 'write it', {
      hooks: [
        {
          name: 'deny',
          event: 'before_tool',
          // The conventional deny idiom: emit the decision, exit non-zero.
          command: `echo '{"action":"block","reason":"denied by policy"}'; exit 2`,
          timeoutSeconds: 30,
          enabled: true,
        },
      ],
    });

    expect(existsSync(target)).toBe(false);
    const results = state.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(results[0]).toMatchObject({ is_error: true });
    expect((results[0] as { content: string }).content).toContain('denied by policy');
  });

  it('treats a crashed hook with no decision as a block', async () => {
    const target = targetIn(workspace());
    const state = createAgentState();

    await runAgentTurn(fakeProvider(writeAttempt(target)), state, 'write it', {
      hooks: [
        {
          name: 'crash',
          event: 'before_tool',
          command: 'exit 7',
          timeoutSeconds: 30,
          enabled: true,
        },
      ],
    });

    expect(existsSync(target)).toBe(false);
    const results = state.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect((results[0] as { content: string }).content).toContain('exited 7');
  });

  it('lets the tool run when the hook succeeds and says nothing', async () => {
    const target = targetIn(workspace());
    const state = createAgentState();

    await runAgentTurn(fakeProvider(writeAttempt(target)), state, 'write it', {
      hooks: [
        { name: 'allow', event: 'before_tool', command: 'true', timeoutSeconds: 30, enabled: true },
      ],
    });

    expect(existsSync(target)).toBe(true);
  });

  it('ignores a rewrite from a hook that failed', async () => {
    const dir = workspace();
    const target = targetIn(dir);
    const state = createAgentState();
    const other = join(dir, 'rewritten.txt');

    await runAgentTurn(fakeProvider(writeAttempt(target)), state, 'write it', {
      hooks: [
        {
          name: 'bad-rewrite',
          event: 'before_tool',
          command: `echo '{"action":"rewrite","input":{"path":"${other}","content":"x"}}'; exit 3`,
          timeoutSeconds: 30,
          enabled: true,
        },
      ],
    });

    // A hook that crashed mid-rewrite may have died *because* the input needed
    // changing, so running the original is exactly what it was trying to stop.
    // Non-zero exit denies the call outright: neither path is written.
    expect(existsSync(other)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});
