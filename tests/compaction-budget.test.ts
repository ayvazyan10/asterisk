// Compaction has to fit the window the *active provider* reports.
//
// The threshold was a hardcoded 80 000 while the default ollama.contextWindow
// is 65 536, so on a default install the window overflowed roughly 19% before
// compaction was ever attempted. And because compaction only shortened blocks
// and never dropped messages, a history of many small messages could sit above
// the threshold forever, rebuilding the whole array every turn and shrinking
// nothing.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTEXT_WINDOW,
  compactHistory,
  compactionThreshold,
  estimateTokens,
} from '../src/agent/compaction.ts';
import { findUnpaired } from '../src/agent/history.ts';
import type { Message } from '../src/types/messages.ts';

/** Mirrors KEEP_RECENT in compaction.ts — the tail that is never dropped. */
const KEEP_RECENT = 6;

const say = (role: 'user' | 'assistant', text: string): Message => ({
  role,
  content: [{ type: 'text', text }],
});

/** n turns of chatter, each small on its own. */
function chatter(n: number, size: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    say(i % 2 === 0 ? 'user' : 'assistant', `${i}:${'x'.repeat(size)}`),
  );
}

describe('compactionThreshold', () => {
  it('scales with the provider window', () => {
    expect(compactionThreshold(65_536)).toBeLessThan(65_536);
    expect(compactionThreshold(200_000)).toBeGreaterThan(compactionThreshold(65_536));
  });

  it('never budgets more history than the window holds', () => {
    for (const window of [8_192, 32_768, 65_536, 128_000, 200_000]) {
      expect(compactionThreshold(window)).toBeLessThan(window);
    }
  });

  it('falls back to a conservative default', () => {
    expect(compactionThreshold()).toBe(compactionThreshold(DEFAULT_CONTEXT_WINDOW));
  });
});

describe('compactHistory', () => {
  it('leaves a small history untouched', () => {
    const history = chatter(4, 10);
    expect(compactHistory(history, 65_536)).toBe(history);
  });

  it('fires below the default Ollama window, which it never used to', () => {
    // Sized to land between the old hardcoded 80k threshold and the 65 536
    // window: the exact band where the old code did nothing and the model
    // then overflowed.
    const history = [...chatter(20, 14_000), ...chatter(6, 10)];
    const before = estimateTokens(history);
    expect(before).toBeGreaterThan(compactionThreshold(65_536));
    expect(before).toBeLessThan(80_000);

    const after = compactHistory(history, 65_536);
    expect(estimateTokens(after)).toBeLessThanOrEqual(compactionThreshold(65_536));
  });

  it('gets a history of many small messages under budget', () => {
    // Shortening alone cannot help here — every block is already short. The old
    // implementation returned this unchanged, forever.
    const history = chatter(4000, 40);
    expect(estimateTokens(history)).toBeGreaterThan(compactionThreshold(32_768));

    const after = compactHistory(history, 32_768);
    expect(estimateTokens(after)).toBeLessThanOrEqual(compactionThreshold(32_768));
    expect(after.length).toBeLessThan(history.length);
  });

  it('keeps the most recent messages verbatim', () => {
    const history = [...chatter(500, 200), say('user', 'THE LAST THING I SAID')];
    const after = compactHistory(history, 16_384);
    const tail = after[after.length - 1];
    expect(tail?.content[0]).toMatchObject({ text: 'THE LAST THING I SAID' });
  });

  it('says so when it drops messages instead of losing them silently', () => {
    const after = compactHistory(chatter(4000, 40), 16_384);
    const text = after
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join(' ');
    expect(text).toMatch(/earlier message\(s\) dropped/);
  });

  it('never separates a tool_use from its tool_result', () => {
    const history: Message[] = [];
    for (let i = 0; i < 300; i++) {
      history.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { path: 'x'.repeat(80) } }],
      });
      history.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'y'.repeat(300) }],
      });
    }

    const after = compactHistory(history, 16_384);
    expect(findUnpaired(after)).toEqual([]);
    expect(estimateTokens(after)).toBeLessThanOrEqual(compactionThreshold(16_384));
  });

  it('is stable — a second pass over compacted output changes nothing', () => {
    const once = compactHistory(chatter(4000, 40), 32_768);
    expect(compactHistory(once, 32_768)).toBe(once);
  });

  it('respects a larger window by compacting less', () => {
    const history = chatter(2000, 60);
    const tight = compactHistory(history, 16_384);
    const roomy = compactHistory(history, 200_000);
    expect(estimateTokens(roomy)).toBeGreaterThan(estimateTokens(tight));
  });
});

// ─── convergence ───────────────────────────────────────────────────────
//
// "The 6 most recent messages are never touched" quietly meant "the 6 most
// recent messages may be any size at all". Once one of them was bigger than
// the budget, compaction had nothing left to do: shortening skipped the tail,
// dropping could not go below it, and every call returned the same
// over-budget history. The next request overflowed, the daemon had already
// written the transcript to disk, and /resume brought the same dead
// conversation back. These tests pin the property that was missing — every
// input reaches the budget in a finite number of passes.

/** The estimate after each of `n` successive compactions. */
function passes(history: Message[], window: number, n: number): number[] {
  const seen: number[] = [];
  let current = history;
  for (let i = 0; i < n; i++) {
    current = compactHistory(current, window);
    seen.push(estimateTokens(current));
  }
  return seen;
}

describe('compactHistory convergence', () => {
  const WINDOW = 8_192; // llama-server started with -c 8192
  const budget = compactionThreshold(WINDOW);

  /** An MCP tool that failed with kilobytes of text. `mcp/client.ts` returns
   *  err(text) untruncated, and the loop used to skip persistence for errors,
   *  so the whole thing landed in history. */
  function failedCall(id: string, size: number): Message[] {
    return [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'notion-query', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content: 'E'.repeat(size), is_error: true },
        ],
      },
    ];
  }

  it('gets under budget when a huge error result sits in the protected tail', () => {
    const history: Message[] = [
      say('user', 'query the meeting notes'),
      ...failedCall('t1', 60_000),
      say('assistant', 'that failed, trying again'),
      ...failedCall('t2', 200),
      say('user', 'what happened?'),
    ];
    expect(history).toHaveLength(7);
    expect(estimateTokens(history)).toBeGreaterThan(budget);

    const after = compactHistory(history, WINDOW);
    expect(estimateTokens(after)).toBeLessThanOrEqual(budget);
    expect(findUnpaired(after)).toEqual([]);
  });

  it('reaches a fixed point that is under budget, not one that is over it', () => {
    const history: Message[] = [
      say('user', 'query the meeting notes'),
      ...failedCall('t1', 60_000),
      say('assistant', 'that failed, trying again'),
      ...failedCall('t2', 200),
      say('user', 'what happened?'),
    ];

    const estimates = passes(history, WINDOW, 5);
    // Before the fix this was [15073, 15073, 15073, 15073, 15073] — stable,
    // and stably over the window.
    expect(estimates.every((e) => e <= budget)).toBe(true);
    // Still a fixed point: further passes change nothing at all.
    const once = compactHistory(history, WINDOW);
    expect(compactHistory(once, WINDOW)).toBe(once);
  });

  it('gets under budget when a single message is larger than the window', () => {
    // A user pasting a file into the prompt. The history is shorter than
    // KEEP_RECENT, which used to return it untouched with nothing said.
    const history = [say('user', 'x'.repeat(200_000))];
    expect(estimateTokens(history)).toBeGreaterThan(WINDOW);

    const after = compactHistory(history, WINDOW);
    expect(estimateTokens(after)).toBeLessThanOrEqual(budget);
    expect(after).toHaveLength(1);
    expect(compactHistory(after, WINDOW)).toBe(after);
  });

  it('gets under budget when every message is oversized and none may be dropped', () => {
    const history = Array.from({ length: KEEP_RECENT }, (_, i) =>
      say(i % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(100_000)),
    );
    const after = compactHistory(history, WINDOW);
    expect(estimateTokens(after)).toBeLessThanOrEqual(budget);
    expect(after).toHaveLength(KEEP_RECENT);
  });

  it('converges for an oversized tool_use input too', () => {
    // Write with a large body: shortenMessage never looked at tool_use input.
    const history: Message[] = [
      say('user', 'write it'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'w1', name: 'Write', input: { body: 'z'.repeat(120_000) } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] },
    ];

    const after = compactHistory(history, WINDOW);
    expect(estimateTokens(after)).toBeLessThanOrEqual(budget);
    expect(findUnpaired(after)).toEqual([]);
  });

  it('keeps every history it is given inside the budget it was given', () => {
    for (const window of [4_096, 8_192, 16_384, 32_768]) {
      for (const history of [
        [say('user', 'q'.repeat(500_000))],
        chatter(4000, 40),
        [...chatter(20, 14_000), say('user', 'w'.repeat(300_000))],
      ]) {
        const after = compactHistory(history, window);
        expect(estimateTokens(after)).toBeLessThanOrEqual(compactionThreshold(window));
      }
    }
  });
});

// ─── role alternation ──────────────────────────────────────────────────

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

describe('the drop notice', () => {
  // The notice is a user message and the seam it lands on is very often a user
  // message too, so compaction was pushing two user turns back to back — the
  // shape the Anthropic API rejects outright, and the one the agent loop folds
  // image blocks into the tool-result message specifically to avoid.
  it('never leaves two user messages back to back', () => {
    for (const window of [8_192, 16_384, 32_768]) {
      const after = compactHistory(chatter(4000, 40), window);
      expect(consecutiveSameRole(after)).toEqual([]);
    }
  });

  it('is still said out loud when it merges into the message after it', () => {
    const after = compactHistory(chatter(4000, 40), 8_192);
    const text = after
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join(' ');
    expect(text).toMatch(/earlier message\(s\) dropped/);
  });

  it('alternates roles on a tool-call transcript too, and keeps results first', () => {
    // The merge only ever lands on a message the drop point chose, and pairs
    // are dropped two at a time — so a merge into a message carrying tool
    // results is defensive rather than routine. What must hold either way:
    // roles alternate, pairs survive, and results stay ahead of text, which is
    // the order every provider here is fed.
    const history: Message[] = [];
    for (let i = 0; i < 200; i++) {
      history.push(say('user', `question ${i} ${'x'.repeat(400)}`));
      history.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { path: '/x' } }],
      });
      history.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t${i}`, content: 'y'.repeat(300) },
          { type: 'text', text: 'and now this' },
        ],
      });
      history.push(say('assistant', `answer ${i}`));
    }

    const after = compactHistory(history, 8_192);
    expect(consecutiveSameRole(after)).toEqual([]);
    expect(findUnpaired(after)).toEqual([]);
    for (const message of after) {
      const kinds = message.content.map((b) => b.type);
      const lastResult = kinds.lastIndexOf('tool_result');
      const firstOther = kinds.findIndex((k) => k !== 'tool_result');
      if (lastResult !== -1 && firstOther !== -1) expect(lastResult).toBeLessThan(firstOther);
    }
  });
});
