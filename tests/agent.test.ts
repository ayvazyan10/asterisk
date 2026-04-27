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

  it('falls back to the most recent non-empty text when the terminal turn is silent', async () => {
    // Simulates qwen3.5-style behaviour: model emits text in turn 1, calls
    // tools, then turn 3 is end_turn with NO text. finalText should be the
    // earlier text rather than '' so the user sees something.
    const provider = fakeProvider([
      {
        content: [
          { type: 'text', text: 'let me edit the file' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } },
        ],
        stopReason: 'tool_use',
      },
      {
        // Empty terminal response — this is the bug condition.
        content: [],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'edit it');
    expect(result.reason).toBe('end-turn');
    expect(result.finalText).toBe('let me edit the file');
  });

  it('synthesises a stub from tool tally when no text was emitted at all', async () => {
    const provider = fakeProvider([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo b' } },
          { type: 'tool_use', id: 't3', name: 'Read', input: { path: '/etc/hostname' } },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'do stuff');
    expect(result.reason).toBe('end-turn');
    // The stub names the tools by frequency and tells the user the model
    // didn't summarise.
    expect(result.finalText).toMatch(/done/);
    expect(result.finalText).toMatch(/2× Bash/);
    expect(result.finalText).toMatch(/1× Read/);
    expect(result.finalText).toMatch(/no closing summary|didn't return/i);
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
