// Regression tests for the tool_use/tool_result pairing invariant.
//
// The bug: pressing ESC while a batch of two or more tool calls was running
// broke out of the turn before the accumulated tool_results were pushed. The
// assistant message with the tool_use blocks stayed in history unanswered, so
// every later request failed with Anthropic 400 "tool_use ids found without
// tool_result" — classified `bad-request`, which is not retryable. The loop's
// caller persists history, so /resume restored the corruption.
//
// The one pre-existing abort test used a single tool call, which happens to be
// the only shape that never corrupts: the abort is noticed before the batch
// starts, so no tool_use is ever pushed.

import { describe, expect, it } from 'vitest';

import {
  ABORTED_RESULT,
  completeToolResults,
  findUnpaired,
  isPaired,
  repairHistory,
} from '../src/agent/history.ts';
import type { ContentBlock, Message } from '../src/types/messages.ts';

const use = (id: string, name = 'Read'): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});

const result = (id: string, content = 'ok'): ContentBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});

const text = (s: string): ContentBlock => ({ type: 'text', text: s });

describe('completeToolResults', () => {
  it('leaves a fully answered batch untouched', () => {
    const assistant = [use('a'), use('b')];
    const results = [result('a'), result('b')];
    expect(completeToolResults(assistant, results)).toEqual(results);
  });

  it('synthesises an error result for each unanswered tool_use', () => {
    const assistant = [use('a'), use('b'), use('c')];
    const completed = completeToolResults(assistant, [result('a')]);

    expect(completed).toHaveLength(3);
    expect(completed.slice(1)).toEqual([
      { type: 'tool_result', tool_use_id: 'b', content: ABORTED_RESULT, is_error: true },
      { type: 'tool_result', tool_use_id: 'c', content: ABORTED_RESULT, is_error: true },
    ]);
  });

  it('answers every tool_use when nothing ran at all', () => {
    const assistant = [text('working on it'), use('a'), use('b')];
    const completed = completeToolResults(assistant, []);
    expect(completed.map((b) => (b.type === 'tool_result' ? b.tool_use_id : null))).toEqual([
      'a',
      'b',
    ]);
  });

  it('does not mutate the arrays it is given', () => {
    const results = [result('a')];
    completeToolResults([use('a'), use('b')], results);
    expect(results).toHaveLength(1);
  });
});

describe('findUnpaired / isPaired', () => {
  it('accepts a well-formed exchange', () => {
    const history: Message[] = [
      { role: 'user', content: [text('hi')] },
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [result('a'), result('b')] },
      { role: 'assistant', content: [text('done')] },
    ];
    expect(isPaired(history)).toBe(true);
    expect(findUnpaired(history)).toEqual([]);
  });

  it('reports a tool_use answered by nothing at the end of history', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a'), use('b')] },
    ];
    expect(findUnpaired(history)).toEqual(['a', 'b']);
  });

  it('reports a partially answered batch', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [result('a')] },
    ];
    expect(findUnpaired(history)).toEqual(['b']);
  });

  it('reports a tool_use followed by a plain user message', () => {
    // What the REPL produced next: the user typed another prompt on top of a
    // stranded tool_use.
    const history: Message[] = [
      { role: 'assistant', content: [use('a')] },
      { role: 'user', content: [text('what happened?')] },
    ];
    expect(findUnpaired(history)).toEqual(['a']);
  });
});

describe('repairHistory', () => {
  it('returns a well-formed history unchanged', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a')] },
      { role: 'user', content: [result('a')] },
    ];
    expect(repairHistory(history)).toEqual(history);
  });

  it('appends the missing results to an existing user message', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [result('a')] },
    ];
    const repaired = repairHistory(history);

    expect(repaired).toHaveLength(2);
    expect(repaired[1]?.content).toHaveLength(2);
    expect(isPaired(repaired)).toBe(true);
  });

  it('inserts a user message when the results are missing entirely', () => {
    const history: Message[] = [
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [use('a'), use('b')] },
    ];
    const repaired = repairHistory(history);

    expect(repaired).toHaveLength(3);
    expect(repaired[2]?.role).toBe('user');
    expect(isPaired(repaired)).toBe(true);
  });

  it('inserts before a following user prompt rather than swallowing it', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a')] },
      { role: 'user', content: [text('what happened?')] },
    ];
    const repaired = repairHistory(history);

    expect(isPaired(repaired)).toBe(true);
    // The user's actual question must survive the repair.
    const texts = repaired.flatMap((m) =>
      m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
    );
    expect(texts).toContain('what happened?');
  });

  it('heals several corrupted turns in one pass', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [result('a')] },
      { role: 'assistant', content: [use('c')] },
      { role: 'user', content: [text('again')] },
      { role: 'assistant', content: [use('d'), use('e')] },
    ];
    const repaired = repairHistory(history);

    expect(isPaired(repaired)).toBe(true);
    expect(findUnpaired(repaired)).toEqual([]);
  });

  it('is idempotent', () => {
    const history: Message[] = [
      { role: 'assistant', content: [use('a'), use('b')] },
    ];
    const once = repairHistory(history);
    expect(repairHistory(once)).toEqual(once);
  });
});
