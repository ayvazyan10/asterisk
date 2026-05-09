import { describe, expect, it } from 'vitest';

import { stripThinkTags } from '../src/providers/ollama.ts';

describe('stripThinkTags', () => {
  it('passes plain content through unchanged', () => {
    expect(stripThinkTags('hello world')).toBe('hello world');
  });

  it('removes a well-formed <think>…</think> block', () => {
    const raw = '<think>I should be polite</think>\nHello!';
    expect(stripThinkTags(raw)).toBe('Hello!');
  });

  it('removes multiple consecutive blocks non-greedily', () => {
    const raw = '<think>a</think>x<think>b</think>y';
    expect(stripThinkTags(raw)).toBe('xy');
  });

  it('drops everything before an orphan </think>', () => {
    // Qwen3 sometimes emits the closing tag without the opening one.
    const raw =
      "I'm doing well, thanks! How about you?\n</think>\n\nI'm doing well, thanks! How about you?";
    expect(stripThinkTags(raw)).toBe("I'm doing well, thanks! How about you?");
  });

  it('strips an orphan opening <think> while keeping the rest visible', () => {
    const raw = '<think>partial reasoning that never closed';
    expect(stripThinkTags(raw)).toBe('partial reasoning that never closed');
  });

  it('returns an empty string when the entire response was a think block', () => {
    expect(stripThinkTags('<think>only thoughts</think>')).toBe('');
  });

  it('handles multiline blocks across newlines', () => {
    const raw = '<think>\nline 1\nline 2\n</think>\nfinal';
    expect(stripThinkTags(raw)).toBe('final');
  });

  it('is case-insensitive on the tag itself', () => {
    expect(stripThinkTags('<THINK>x</THINK>after')).toBe('after');
  });

});
