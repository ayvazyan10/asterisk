import { describe, expect, it, vi } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';

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

describe('agent loop', () => {
  it('returns final text on a single end_turn response', async () => {
    const provider = fakeProvider([
      {
        content: [{ type: 'text', text: 'hi there' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'hello');
    expect(result.finalText).toBe('hi there');
    expect(result.reason).toBe('end-turn');
    expect(state.history).toHaveLength(2);
  });

  it('dispatches a tool call and feeds the result back', async () => {
    const provider = fakeProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'echo loop-ok' },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const onToolUse = vi.fn();
    const result = await runAgentTurn(provider, state, 'run echo', { onToolUse });
    expect(result.finalText).toBe('done');
    expect(result.reason).toBe('end-turn');
    expect(onToolUse).toHaveBeenCalledWith('Bash', { command: 'echo loop-ok' });
    // user, assistant(tool_use), user(tool_result), assistant(text) = 4 entries
    expect(state.history).toHaveLength(4);
  });

  it('reports unknown-tool gracefully', async () => {
    const provider = fakeProvider([
      {
        content: [
          { type: 'tool_use', id: 'x', name: 'NotATool', input: {} },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const onToolResult = vi.fn();
    const result = await runAgentTurn(provider, state, 'q', { onToolResult });
    expect(result.reason).toBe('end-turn');
    expect(onToolResult).toHaveBeenCalledWith('NotATool', expect.stringContaining('not found'), true);
  });

  it('returns reason=aborted when the signal fires before send', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = fakeProvider([]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'hello', { signal: ctrl.signal });
    expect(result.reason).toBe('aborted');
  });

  it('caps the loop at maxTurns and returns max-turns', async () => {
    // Provider always asks for a tool call → infinite loop without a cap.
    const provider: Provider = {
      name: 'loop',
      async send() {
        return {
          content: [
            { type: 'tool_use', id: 'i', name: 'Bash', input: { command: 'echo x' } },
          ],
          stopReason: 'tool_use',
        };
      },
    };
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'go', { maxTurns: 3 });
    expect(result.reason).toBe('max-turns');
  });
});
