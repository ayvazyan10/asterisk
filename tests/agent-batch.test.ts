// Dispatching several sub-agents for one parent turn.
//
// The property worth protecting is the concurrency decision. Sub-agents share
// the parent's tool state and worktrees are process-global, so two agents
// editing files at once have no isolation from each other. The batch works
// that out from the agent types it was given rather than trusting the caller
// to remember — so these tests are mostly about when it refuses to parallelise.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentBatchTool } from '../src/tools/agent-batch.ts';
import * as subagent from '../src/tools/subagent.ts';

/** Records overlap so a claim of parallelism can be checked, not assumed. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  return {
    peak: () => peak,
    order,
    async run(label: string, ms: number): Promise<void> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(label);
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentBatch input validation', () => {
  it.each([
    ['not an array', { tasks: 'nope' }, /must be an array/],
    ['empty', { tasks: [] }, /must not be empty/],
    ['too many', { tasks: Array.from({ length: 11 }, () => ({ prompt: 'x' })) }, /too many/],
    ['non-object task', { tasks: ['x'] }, /not an object/],
    ['task with no prompt', { tasks: [{ subagent_type: 'explore' }] }, /no prompt/],
    ['task with blank prompt', { tasks: [{ prompt: '   ' }] }, /no prompt/],
  ])('rejects %s', async (_name, input, message) => {
    const result = await agentBatchTool.execute(input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(message);
  });

  it('refuses to start an already-cancelled batch', async () => {
    const result = await agentBatchTool.execute(
      { tasks: [{ prompt: 'anything' }] },
      { signal: AbortSignal.abort() },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/cancelled/);
  });
});

describe('AgentBatch concurrency', () => {
  it('runs read-only agent types at the same time', async () => {
    const t = tracker();
    vi.spyOn(subagent, 'runSubAgent').mockImplementation(async (req) => {
      await t.run(req.prompt, 30);
      return { output: `done: ${req.prompt}`, isError: false };
    });

    // `explore` ships with allowedTools that exclude Edit and Write.
    const result = await agentBatchTool.execute({
      tasks: [
        { prompt: 'a', subagent_type: 'explore' },
        { prompt: 'b', subagent_type: 'explore' },
        { prompt: 'c', subagent_type: 'explore' },
      ],
    });

    expect(t.peak()).toBeGreaterThan(1);
    expect(result.output).toContain('at a time');
    for (const p of ['a', 'b', 'c']) expect(result.output).toContain(`done: ${p}`);
  });

  it('serialises when any task uses a type that can write', async () => {
    const t = tracker();
    vi.spyOn(subagent, 'runSubAgent').mockImplementation(async (req) => {
      await t.run(req.prompt, 20);
      return { output: `done: ${req.prompt}`, isError: false };
    });

    const result = await agentBatchTool.execute({
      tasks: [
        { prompt: 'read', subagent_type: 'explore' },
        // general-purpose has no allowedTools restriction, so it can Edit.
        { prompt: 'write', subagent_type: 'general-purpose' },
      ],
    });

    // Two agents editing files share one filesystem view and one worktree.
    expect(t.peak()).toBe(1);
    expect(result.output).toContain('one at a time');
  });

  it('treats an unrestricted type as able to write', async () => {
    const t = tracker();
    vi.spyOn(subagent, 'runSubAgent').mockImplementation(async (req) => {
      await t.run(req.prompt, 20);
      return { output: 'ok', isError: false };
    });

    // No subagent_type at all means general-purpose, which is unrestricted —
    // absence of a restriction must read as "can write", not "safe".
    await agentBatchTool.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] });
    expect(t.peak()).toBe(1);
  });

  it('never exceeds its own parallelism ceiling', async () => {
    const t = tracker();
    vi.spyOn(subagent, 'runSubAgent').mockImplementation(async (req) => {
      await t.run(req.prompt, 25);
      return { output: 'ok', isError: false };
    });

    await agentBatchTool.execute({
      tasks: Array.from({ length: 10 }, (_, i) => ({
        prompt: `t${i}`,
        subagent_type: 'explore',
      })),
    });

    expect(t.peak()).toBeLessThanOrEqual(4);
  });
});

describe('AgentBatch results', () => {
  it('keeps going when one task fails, and says which', async () => {
    vi.spyOn(subagent, 'runSubAgent').mockImplementation(async (req) => {
      if (req.prompt === 'boom') throw new Error('provider exploded');
      return { output: `done: ${req.prompt}`, isError: false };
    });

    const result = await agentBatchTool.execute({
      tasks: [
        { prompt: 'fine', subagent_type: 'explore' },
        { prompt: 'boom', subagent_type: 'explore' },
      ],
    });

    // Losing three good answers because a fourth failed would be the wrong
    // trade every time.
    expect(result.isError).toBe(false);
    expect(result.output).toContain('done: fine');
    expect(result.output).toContain('provider exploded');
  });

  it('returns results in the order the tasks were given', async () => {
    vi.spyOn(subagent, 'runSubAgent').mockImplementation(async (req) => {
      // Reverse the completion order relative to the input order.
      await new Promise((r) => setTimeout(r, req.prompt === 'first' ? 40 : 5));
      return { output: `done: ${req.prompt}`, isError: false };
    });

    const result = await agentBatchTool.execute({
      tasks: [
        { prompt: 'first', subagent_type: 'explore' },
        { prompt: 'second', subagent_type: 'explore' },
      ],
    });

    expect(result.output.indexOf('done: first')).toBeLessThan(
      result.output.indexOf('done: second'),
    );
  });
});
