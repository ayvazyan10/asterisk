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
        content: [{ type: 'tool_use', id: 'x', name: 'NotATool', input: {} }],
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
    expect(onToolResult).toHaveBeenCalledWith(
      'NotATool',
      expect.stringContaining('not found'),
      true,
    );
  });

  it('lets before_tool hooks block tool execution', async () => {
    const provider = fakeProvider([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo should-not-run' } },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'blocked' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const onToolResult = vi.fn();
    const result = await runAgentTurn(provider, state, 'run', {
      hooks: [
        {
          name: 'block',
          event: 'before_tool',
          command: 'echo \'{"action":"block","reason":"policy"}\'',
          timeoutSeconds: 5,
          enabled: true,
        },
      ],
      onToolResult,
    });
    expect(result.reason).toBe('end-turn');
    expect(onToolResult).toHaveBeenCalledWith('Bash', 'policy', true);
    const toolResult = state.history[2]?.content[0];
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toContain('blocked by hook');
    }
  });

  it('lets before_tool hooks rewrite tool input', async () => {
    const provider = fakeProvider([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo original' } },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'rewritten' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const onToolResult = vi.fn();
    await runAgentTurn(provider, state, 'run', {
      hooks: [
        {
          name: 'rewrite',
          event: 'before_tool',
          command: 'echo \'{"action":"rewrite","input":{"command":"echo rewritten"}}\'',
          timeoutSeconds: 5,
          enabled: true,
        },
      ],
      onToolResult,
    });
    expect(onToolResult).toHaveBeenCalledWith('Bash', expect.stringContaining('rewritten'), false);
  });

  it('falls back to the most recent non-empty text when even the forced summary turn is silent', async () => {
    // Simulates uncooperative qwen3.5: emits text + tool in turn 1, runs
    // tool, then emits empty in turn 2. The loop forces a summary prod →
    // turn 3, which the model also returns empty. Fallback then uses the
    // last non-empty text from turn 1 so the user sees something.
    const provider = fakeProvider([
      {
        content: [
          { type: 'text', text: 'let me edit the file' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [], stopReason: 'end_turn' }, // empty post-tool
      { content: [], stopReason: 'end_turn' }, // empty even after prod
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'edit it');
    expect(result.reason).toBe('end-turn');
    expect(result.finalText).toBe('let me edit the file');
  });

  it('forces a summary turn when the post-tool response is empty', async () => {
    // Repro of the user's qwen3.5 symptom: model emits tool, results
    // come back, model returns empty content, end_turn. Without the
    // forced-summary turn we'd give up with a stub. With it, we push
    // a synthetic "now summarise" message and the model gets another
    // shot — which it takes, producing the expected text.
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } }],
        stopReason: 'tool_use',
      },
      {
        // Empty post-tool response — the bug condition.
        content: [],
        stopReason: 'end_turn',
      },
      {
        // After our forced "now summarise" prod, the model produces text.
        content: [{ type: 'text', text: 'Ran the echo command successfully.' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'do it');
    expect(result.reason).toBe('end-turn');
    expect(result.finalText).toBe('Ran the echo command successfully.');
    // The synthetic prod should be in history.
    const userMessages = state.history.filter((m) => m.role === 'user');
    const promptedSummary = userMessages.some((m) =>
      m.content.some((b) => b.type === 'text' && /short summary/i.test(b.text)),
    );
    expect(promptedSummary).toBe(true);
  });

  it('falls back to stub if even the forced summary turn comes back empty', async () => {
    // The model is uncooperative — both the original post-tool turn
    // and the forced-summary turn return empty. Cap kicks in; we give
    // up with the synthesised stub rather than looping forever.
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } }],
        stopReason: 'tool_use',
      },
      { content: [], stopReason: 'end_turn' }, // empty post-tool
      { content: [], stopReason: 'end_turn' }, // empty even after prod
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'do it');
    expect(result.reason).toBe('end-turn');
    expect(result.finalText).toMatch(/done/);
    expect(result.finalText).toMatch(/1× Bash/);
  });

  it('synthesises a stub from tool tally when even the forced summary turn is silent', async () => {
    const provider = fakeProvider([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo b' } },
          { type: 'tool_use', id: 't3', name: 'Read', input: { path: '/etc/hostname' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [], stopReason: 'end_turn' }, // empty post-tool
      { content: [], stopReason: 'end_turn' }, // empty even after prod
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

  it('returns reason=aborted when signal fires mid-turn during tool execution', async () => {
    const ctrl = new AbortController();
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 10' } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'never reached' }],
        stopReason: 'end_turn',
      },
    ]);
    const state = createAgentState();
    setTimeout(() => ctrl.abort(), 50);
    const result = await runAgentTurn(provider, state, 'wait', {
      signal: ctrl.signal,
      toolTimeoutMs: 30_000,
    });
    expect(result.reason).toBe('aborted');
  });

  it('caps the loop at maxTurns and returns max-turns', async () => {
    // Provider always asks for a tool call → infinite loop without a cap.
    const provider: Provider = {
      name: 'loop',
      async send() {
        return {
          content: [{ type: 'tool_use', id: 'i', name: 'Bash', input: { command: 'echo x' } }],
          stopReason: 'tool_use',
        };
      },
    };
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'go', { maxTurns: 3 });
    expect(result.reason).toBe('max-turns');
  });

  it('still says something when it runs out of turns', async () => {
    // Hitting the cap broke out of the loop without ever assigning finalText.
    // The daemon hands `text: ''` to the Telegram bridge, whose `if (out.text)`
    // then sends nothing: the user wrote to the bot, the agent worked through
    // all 48 turns, and the reply was silence. The REPL hid it, because the
    // text was already on screen from the stream.
    const provider: Provider = {
      name: 'loop',
      async send() {
        return {
          content: [{ type: 'tool_use', id: 'i', name: 'Bash', input: { command: 'echo x' } }],
          stopReason: 'tool_use',
        };
      },
    };
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'go', { maxTurns: 3 });

    expect(result.reason).toBe('max-turns');
    expect(result.finalText).not.toBe('');
    expect(result.finalText).toMatch(/3× Bash/);
  });

  it('prefers what the model actually said when it runs out of turns', async () => {
    let turn = 0;
    const provider: Provider = {
      name: 'loop',
      async send() {
        turn++;
        return {
          content: [
            ...(turn === 1 ? [{ type: 'text' as const, text: 'looking at the config now' }] : []),
            {
              type: 'tool_use' as const,
              id: `i${turn}`,
              name: 'Bash',
              input: { command: 'echo x' },
            },
          ],
          stopReason: 'tool_use',
        };
      },
    };
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'go', { maxTurns: 2 });

    expect(result.reason).toBe('max-turns');
    expect(result.finalText).toBe('looking at the config now');
  });
});
