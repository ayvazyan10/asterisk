// End-to-end proof that aborting a multi-tool turn leaves a usable history.
//
// tests/agent.test.ts already covers "abort returns reason=aborted", but only
// with a single tool call — the one shape that cannot corrupt, because the
// abort is noticed before any tool_use has been answered. With two or more
// tool calls the loop used to break out of the turn before pushing the
// accumulated tool_results, so the assistant's tool_use blocks were stranded
// and every subsequent request failed with a non-retryable 400.

import { describe, expect, it } from 'vitest';

import { findUnpaired, isPaired } from '../src/agent/history.ts';
import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import type { Message, Provider, ProviderResponse } from '../src/types/messages.ts';

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

/** Pairs of neighbouring messages that share a role, as "i/j: role". */
function consecutiveSameRole(history: readonly Message[]): string[] {
  const hits: string[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const current = history[i];
    if (prev && current && prev.role === current.role) hits.push(`${i - 1}/${i}: ${current.role}`);
  }
  return hits;
}

describe('role alternation across turns', () => {
  // A turn that ends on `aborted` or `max-turns` leaves the tool results — a
  // user message — as the last thing in the history, and the next turn pushed
  // the user's new message straight after it. The loop declares that invariant
  // itself, one comment above the line that folds image blocks into the
  // tool-result message rather than sending a second user turn: "the Anthropic
  // API rejects it outright". Two other paths broke it.
  //
  // openai-compatible survives it (tool results are hoisted into role:"tool"
  // messages), which is why this went unnoticed on the default provider.
  const oneToolCall = (): ProviderResponse => ({
    content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'echo x' } }],
    stopReason: 'tool_use',
  });

  it('does not stack two user turns after a max-turns cap', async () => {
    const state = createAgentState();

    const first = await runAgentTurn(fakeProvider([oneToolCall()]), state, 'go', { maxTurns: 1 });

    expect(first.reason).toBe('max-turns');
    expect(state.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    const second = await runAgentTurn(
      fakeProvider([{ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }]),
      state,
      'anything there?',
    );

    expect(second.reason).toBe('end-turn');
    expect(consecutiveSameRole(state.history)).toEqual([]);
    // The message was folded in, not dropped.
    const merged = state.history[2];
    expect(merged?.role).toBe('user');
    expect(merged?.content.some((b) => b.type === 'text' && b.text === 'anything there?')).toBe(
      true,
    );
  });

  it('does not stack two user turns after an aborted batch', async () => {
    const ctrl = new AbortController();
    const state = createAgentState();
    setTimeout(() => ctrl.abort(), 50);

    await runAgentTurn(fakeProvider(slowBatch(2)), state, 'go', {
      signal: ctrl.signal,
      toolTimeoutMs: 30_000,
    });
    await runAgentTurn(
      fakeProvider([{ content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' }]),
      state,
      'are you ok?',
    );

    expect(consecutiveSameRole(state.history)).toEqual([]);
    expect(isPaired(state.history)).toBe(true);
  });
});

describe('tool calls the model wrote as prose', () => {
  // A server started without a tool-aware chat template makes the model write
  // its calls into the text; `normaliseResponseContent` recovers them, and the
  // recovered blocks are what goes into the history. Completion was computed
  // against the RAW response instead, which holds no tool_use blocks at all —
  // so nothing was ever missing, nothing was ever completed, and an aborted
  // turn wrote unanswered calls to disk. repairHistory patches it on the next
  // turn; the transcript on disk stays broken.
  const spoken = (commands: string[]): ProviderResponse => ({
    content: [
      {
        type: 'text',
        text: commands
          .map((c) => `<tool_call>{"name": "Bash", "arguments": {"command": "${c}"}}</tool_call>`)
          .join('\n'),
      },
    ],
    stopReason: 'end_turn',
  });

  it('answers every recovered call when the turn is aborted part-way', async () => {
    const ctrl = new AbortController();
    const state = createAgentState();
    setTimeout(() => ctrl.abort(), 50);

    const result = await runAgentTurn(
      fakeProvider([spoken(['sleep 10', 'sleep 10', 'sleep 10'])]),
      state,
      'go',
      { signal: ctrl.signal, toolTimeoutMs: 30_000 },
    );

    expect(result.reason).toBe('aborted');
    const assistant = state.history.find((m) => m.role === 'assistant');
    expect(assistant?.content.filter((b) => b.type === 'tool_use')).toHaveLength(3);
    expect(findUnpaired(state.history)).toEqual([]);
    expect(isPaired(state.history)).toBe(true);
  });
});
