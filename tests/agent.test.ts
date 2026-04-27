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
    const text = await runAgentTurn(provider, state, 'hello');
    expect(text).toBe('hi there');
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
    const text = await runAgentTurn(provider, state, 'run echo', { onToolUse });
    expect(text).toBe('done');
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
    await runAgentTurn(provider, state, 'q', { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith('NotATool', expect.stringContaining('not found'), true);
  });
});
