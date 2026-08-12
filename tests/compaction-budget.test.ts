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
