// The token estimate drives the compaction budget, so its failure mode is a
// context-overflow error from the provider rather than a wrong number on a
// screen. These tests pin the properties that matter — chiefly that nothing is
// under-counted by a multiple — rather than exact counts, which would only
// pin the constants to themselves.

import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../src/agent/compaction.ts';
import { estimateTextTokens } from '../src/agent/tokens.ts';
import type { Message } from '../src/types/messages.ts';

/** What the previous implementation would have said. */
function charsOverFour(text: string): number {
  return Math.ceil(text.length / 4);
}

const CHINESE = '你好世界，这是一个测试。我们正在检查分词器的准确性。';
const JAPANESE = 'こんにちは世界、これはトークナイザーのテストです。';
const KOREAN = '안녕하세요 세계, 이것은 토크나이저 테스트입니다.';
const TYPESCRIPT =
  'export function compactHistory(messages: Message[], contextWindow?: number): Message[] {';
const JSON_BODY = '{"model":"gemma-4-26b","stream":true,"options":{"num_ctx":65536}}';

describe('estimateTextTokens', () => {
  it('is zero for empty input', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('grows with length', () => {
    expect(estimateTextTokens('word word')).toBeGreaterThan(estimateTextTokens('word'));
  });

  it('keeps English prose in a sane band', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running.';
    const tokens = estimateTextTokens(text);
    // 62 characters, ~13 real tokens. Anything outside this band means the
    // model drifted badly for the most common input there is.
    expect(tokens).toBeGreaterThan(text.length / 8);
    expect(tokens).toBeLessThan(text.length / 2);
  });

  it.each([
    ['chinese', CHINESE],
    ['japanese', JAPANESE],
    ['korean', KOREAN],
  ])('counts %s at roughly one token per character', (_name, text) => {
    const tokens = estimateTextTokens(text);
    // The old estimate said a quarter of this and let CJK conversations
    // overflow the window with compaction never firing.
    expect(tokens).toBeGreaterThan(text.length * 0.8);
    expect(tokens).toBeGreaterThan(charsOverFour(text) * 3);
  });

  it.each([
    ['typescript', TYPESCRIPT],
    ['json', JSON_BODY],
  ])('counts punctuation-dense %s above the prose rate', (_name, text) => {
    expect(estimateTextTokens(text)).toBeGreaterThan(charsOverFour(text));
  });

  it('counts an emoji as more than one token', () => {
    // Astral code points are two UTF-16 units; counting by unit would have
    // said one token for two halves of one character.
    expect(estimateTextTokens('🚀')).toBeGreaterThanOrEqual(2);
  });

  it('treats a long identifier as several tokens but a short word as one', () => {
    expect(estimateTextTokens('cat')).toBe(1);
    expect(estimateTextTokens('internationalization')).toBeGreaterThan(3);
  });

  it('never under-counts any sample by a multiple', () => {
    // The whole point of the change: the old model was 0.27x on Chinese.
    for (const text of [CHINESE, JAPANESE, KOREAN, TYPESCRIPT, JSON_BODY, 'ship it 🚀🔥']) {
      expect(estimateTextTokens(text)).toBeGreaterThanOrEqual(charsOverFour(text) * 0.9);
    }
  });
});

describe('estimateTokens over messages', () => {
  const msg = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

  it('charges per-message framing so many small messages are not free', () => {
    const one = estimateTokens([msg('hello world hello world')]);
    const many = estimateTokens([msg('hello'), msg('world'), msg('hello'), msg('world')]);
    expect(many).toBeGreaterThan(one);
  });

  it('counts tool_use name and input', () => {
    const withTool = estimateTokens([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'rg --json pattern src/' },
          },
        ],
      },
    ]);
    expect(withTool).toBeGreaterThan(estimateTokens([msg('')]));
  });

  it('counts tool_result content', () => {
    const short = estimateTokens([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]);
    const long = estimateTokens([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }],
      },
    ]);
    expect(long).toBeGreaterThan(short * 10);
  });

  it('returns a whole number', () => {
    expect(Number.isInteger(estimateTokens([msg(CHINESE)]))).toBe(true);
  });
});
