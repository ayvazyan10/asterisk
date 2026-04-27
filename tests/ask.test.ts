import { describe, expect, it } from 'vitest';

import {
  answerAskQuestion,
  askUserQuestionTool,
  cancelAskQuestion,
  onAskQuestion,
} from '../src/tools/ask.ts';

describe('AskUserQuestion', () => {
  it('rejects when no UI is listening', async () => {
    const r = await askUserQuestionTool.execute({ question: 'test?' });
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/no UI is listening/);
  });

  it('round-trips a free-text question through the answer channel', async () => {
    const off = onAskQuestion((q) => {
      // Simulate UI: answer with the question's id reversed.
      setTimeout(() => answerAskQuestion(q.id, 'forty-two'), 5);
    });
    try {
      const r = await askUserQuestionTool.execute({ question: 'meaning?' });
      expect(r.isError).toBe(false);
      expect(r.output).toBe('forty-two');
    } finally {
      off();
    }
  });

  it('returns "(cancelled)" when cancelled', async () => {
    const off = onAskQuestion((q) => {
      setTimeout(() => cancelAskQuestion(q.id), 5);
    });
    try {
      const r = await askUserQuestionTool.execute({ question: 'pick?' });
      expect(r.isError).toBe(false);
      expect(r.output).toBe('(cancelled)');
    } finally {
      off();
    }
  });

  it('emits options array when provided', async () => {
    let captured: { options?: string[] } | null = null;
    const off = onAskQuestion((q) => {
      captured = q;
      answerAskQuestion(q.id, q.options?.[0] ?? '');
    });
    try {
      await askUserQuestionTool.execute({
        question: 'colour?',
        options: ['red', 'blue', 'green'],
      });
      expect(captured).not.toBeNull();
      expect(captured!.options).toEqual(['red', 'blue', 'green']);
    } finally {
      off();
    }
  });
});
