// AskUserQuestion must not leak its 5-minute timeout timer (or its abort
// listener) once the user answers well before the timeout — see
// bots/telegram/approval.ts's prompt() for the sibling implementation this
// one is now brought in line with.

import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerAskQuestion, askUserQuestionTool, onAskQuestion } from '../src/tools/ask.ts';

describe('AskUserQuestion timer cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clears its timeout timer once answered quickly, instead of leaking it', async () => {
    const off = onAskQuestion((q) => {
      queueMicrotask(() => answerAskQuestion(q.id, 'quick answer'));
    });
    try {
      const result = await askUserQuestionTool.execute({ question: 'fast?' });
      expect(result.output).toBe('quick answer');
      // Old code never called clearTimeout, so the 5-minute timer would
      // still be registered here even though the tool already returned.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      off();
    }
  });

  it('removes its abort listener once answered quickly, instead of leaking it', async () => {
    const controller = new AbortController();
    const off = onAskQuestion((q) => {
      queueMicrotask(() => answerAskQuestion(q.id, 'ok'));
    });
    try {
      await askUserQuestionTool.execute({ question: 'fast?' }, { signal: controller.signal });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('still resolves via the timeout when nobody answers (regression)', async () => {
    const off = onAskQuestion(() => {
      // Nobody answers — let it time out.
    });
    try {
      const resultPromise = askUserQuestionTool.execute({ question: 'slow?' });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const result = await resultPromise;
      expect(result.output).toBe('(cancelled)');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      off();
    }
  });
});
