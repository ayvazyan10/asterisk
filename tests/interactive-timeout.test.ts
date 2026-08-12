// Tools that wait on a person must outlive the loop's runaway-work deadline.
//
// AskUserQuestion allows 5 minutes for an answer while the loop killed every
// tool at 120s, so the user's answer arrived to a tool that no longer existed
// and the agent saw "tool timed out" instead. The Bash permission gate has the
// same shape: up to 90s of approval wait ahead of a command that then needs
// time of its own.

import { describe, expect, it } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { setExtraTools } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
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

/** A tool that takes longer than the caller's deadline to answer. */
function slowTool(name: string, ms: number, interactive: boolean): Tool {
  return {
    name,
    description: 'test',
    ...(interactive ? { interactive: true } : {}),
    input_schema: { type: 'object', properties: {} },
    async execute() {
      await new Promise((r) => setTimeout(r, ms));
      return { output: 'answered', isError: false };
    },
  };
}

function callThen(name: string): ProviderResponse[] {
  return [
    {
      content: [{ type: 'tool_use', id: 't1', name, input: {} }],
      stopReason: 'tool_use',
    },
    { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
  ];
}

describe('interactive tools and the loop deadline', () => {
  it('kills an ordinary tool that overruns the deadline', async () => {
    setExtraTools([slowTool('SlowPlain', 200, false)]);
    const state = createAgentState();

    await runAgentTurn(fakeProvider(callThen('SlowPlain')), state, 'go', {
      toolTimeoutMs: 50,
    });

    const results = JSON.stringify(state.history);
    expect(results).toContain('timed out');
    expect(results).not.toContain('answered');
    setExtraTools([]);
  });

  it('lets an interactive tool run past the same deadline', async () => {
    setExtraTools([slowTool('SlowInteractive', 200, true)]);
    const state = createAgentState();

    await runAgentTurn(fakeProvider(callThen('SlowInteractive')), state, 'go', {
      toolTimeoutMs: 50,
    });

    const results = JSON.stringify(state.history);
    expect(results).toContain('answered');
    expect(results).not.toContain('timed out');
    setExtraTools([]);
  });

  it('flags the two tools that actually wait on a person', async () => {
    const { askUserQuestionTool } = await import('../src/tools/ask.ts');
    const { bashTool } = await import('../src/tools/bash.ts');
    expect(askUserQuestionTool.interactive).toBe(true);
    expect(bashTool.interactive).toBe(true);
  });
});
