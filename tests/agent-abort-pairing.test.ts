// End-to-end proof that aborting a multi-tool turn leaves a usable history.
//
// tests/agent.test.ts already covers "abort returns reason=aborted", but only
// with a single tool call — the one shape that cannot corrupt, because the
// abort is noticed before any tool_use has been answered. With two or more
// tool calls the loop used to break out of the turn before pushing the
// accumulated tool_results, so the assistant's tool_use blocks were stranded
// and every subsequent request failed with a non-retryable 400.

import { describe, expect, it } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { findUnpaired, isPaired } from '../src/agent/history.ts';
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

/** A turn that asks for `n` slow Bash calls, then would reply. */
function slowBatch(n: number): ProviderResponse[] {
  return [
    {
      content: Array.from({ length: n }, (_, k) => ({
        type: 'tool_use' as const,
        id: `t${k + 1}`,
        name: 'Bash',
        input: { command: 'sleep 10' },
      })),
      stopReason: 'tool_use',
    },
    { content: [{ type: 'text', text: 'never reached' }], stopReason: 'end_turn' },
  ];
}

describe('abort during a multi-tool batch', () => {
  for (const n of [2, 3]) {
    it(`leaves a paired history when aborting ${n} tool calls`, async () => {
      const ctrl = new AbortController();
      const state = createAgentState();
      setTimeout(() => ctrl.abort(), 50);

      const result = await runAgentTurn(fakeProvider(slowBatch(n)), state, 'go', {
        signal: ctrl.signal,
        toolTimeoutMs: 30_000,
      });

      expect(result.reason).toBe('aborted');
      expect(findUnpaired(state.history)).toEqual([]);
      expect(isPaired(state.history)).toBe(true);
    });
  }

  it('answers every requested tool_use id exactly once', async () => {
    const ctrl = new AbortController();
    const state = createAgentState();
    setTimeout(() => ctrl.abort(), 50);

    await runAgentTurn(fakeProvider(slowBatch(3)), state, 'go', {
      signal: ctrl.signal,
      toolTimeoutMs: 30_000,
    });

    const answered = state.history
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id);

    expect([...answered].sort()).toEqual(['t1', 't2', 't3']);
    expect(new Set(answered).size).toBe(answered.length);
  });

  it('lets the conversation continue after an aborted batch', async () => {
    // The real symptom was that the *next* message failed. Drive a second turn
    // over the same state and assert it completes normally.
    const ctrl = new AbortController();
    const state = createAgentState();
    setTimeout(() => ctrl.abort(), 50);

    await runAgentTurn(fakeProvider(slowBatch(2)), state, 'go', {
      signal: ctrl.signal,
      toolTimeoutMs: 30_000,
    });

    const second = await runAgentTurn(
      fakeProvider([{ content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' }]),
      state,
      'are you ok?',
    );

    expect(second.reason).toBe('end-turn');
    expect(second.finalText).toBe('recovered');
    expect(isPaired(state.history)).toBe(true);
  });

  it('repairs a history corrupted by an older build before the first call', async () => {
    const state = createAgentState();
    // Exactly what the old abort path wrote to disk.
    state.history = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'stranded1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 'stranded2', name: 'Read', input: {} },
        ],
      },
    ];

    const result = await runAgentTurn(
      fakeProvider([{ content: [{ type: 'text', text: 'ok now' }], stopReason: 'end_turn' }]),
      state,
      'still there?',
    );

    expect(result.reason).toBe('end-turn');
    expect(findUnpaired(state.history)).toEqual([]);
  });
});
