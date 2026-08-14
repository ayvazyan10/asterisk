// Permission prompts in a Telegram chat.
//
// The controller takes the bot as a parameter, so the whole flow — question,
// button press, verdict — can be driven through a duck-typed stand-in with no
// network and no grammy runner.

import { describe, expect, it, vi } from 'vitest';

import type { Bot, Context } from 'grammy';

import { createApprovalController } from '../src/bots/telegram/approval.ts';

interface SentMessage {
  chatId: string;
  text: string;
  extra: {
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  };
}

function fakeBot() {
  const sent: SentMessage[] = [];
  const edits: Array<{ chatId: string; messageId: number; text: string }> = [];
  let onCallback: ((ctx: Context) => Promise<void>) | null = null;
  let sendError: Error | null = null;

  const bot = {
    on(event: string, handler: (ctx: Context) => Promise<void>) {
      if (event === 'callback_query:data') onCallback = handler;
    },
    api: {
      async sendMessage(chatId: string, text: string, extra: SentMessage['extra']) {
        if (sendError) throw sendError;
        sent.push({ chatId, text, extra });
        return { message_id: 100 + sent.length };
      },
      async editMessageText(chatId: string, messageId: number, text: string) {
        edits.push({ chatId, messageId, text });
      },
    },
  };

  return {
    bot: bot as unknown as Bot,
    sent,
    edits,
    failSend(e: Error) {
      sendError = e;
    },
    /** Simulates a button press by `userId` on the keyboard's `row`/`col`. */
    async press(userId: number, index: number): Promise<{ answers: unknown[] }> {
      const keyboard = sent.at(-1)?.extra.reply_markup?.inline_keyboard ?? [];
      const buttons = keyboard.flat();
      const button = buttons[index];
      const answers: unknown[] = [];
      const ctx = {
        callbackQuery: { data: button?.callback_data ?? '' },
        from: { id: userId },
        answerCallbackQuery: async (arg: unknown) => {
          answers.push(arg);
        },
      } as unknown as Context;
      await onCallback?.(ctx);
      return { answers };
    },
    /** Presses a stale id that no pending request matches. */
    async pressUnknown(userId: number): Promise<{ answers: unknown[] }> {
      const answers: unknown[] = [];
      const ctx = {
        callbackQuery: { data: 'ap:999999:once' },
        from: { id: userId },
        answerCallbackQuery: async (arg: unknown) => {
          answers.push(arg);
        },
      } as unknown as Context;
      await onCallback?.(ctx);
      return { answers };
    },
  };
}

const REQUEST = {
  command: 'rm -rf build && npm ci',
  reason: 'npm ci is not on the allowlist',
  rules: ['npm ci'],
  timeoutMs: 5_000,
};

describe('telegram approval prompts', () => {
  it('asks in the chat and returns the pressed answer', async () => {
    const f = fakeBot();
    const approvals = createApprovalController([275805082]);
    approvals.register(f.bot);

    const answer = approvals.prompt(f.bot, '275805082', REQUEST);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));

    const question = f.sent[0];
    expect(question?.chatId).toBe('275805082');
    expect(question?.text).toContain('rm -rf build');
    expect(question?.text).toContain('npm ci is not on the allowlist');
    // The scope of "always" is visible before it is chosen.
    expect(question?.text).toContain('"npm ci"');

    const buttons = (question?.extra.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.map((b) => b.text)).toEqual(['✅ Allow once', '♾ Always', '⛔ Deny']);

    const { answers } = await f.press(275805082, 1);
    expect(answers).toEqual([{ text: '♾ allowed from now on' }]);
    await expect(answer).resolves.toBe('allow-always');

    // The question is rewritten with the verdict, so no live buttons remain.
    expect(f.edits.at(-1)?.text).toContain('allowed from now on');
  });

  it('refuses a press from someone who is not on the allowlist', async () => {
    const f = fakeBot();
    const approvals = createApprovalController([275805082]);
    approvals.register(f.bot);

    const answer = approvals.prompt(f.bot, '-100999', { ...REQUEST, timeoutMs: 300 });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));

    // A group chat contains anyone; being able to see the buttons is not consent.
    const { answers } = await f.press(11111, 0);
    expect(answers).toEqual([{ text: 'You are not on this bot’s allowlist.', show_alert: true }]);

    // Unanswered, so the timeout is what settles it — as a refusal.
    await expect(answer).resolves.toBe('deny');
  });

  it('denies when nobody answers in time', async () => {
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    await expect(approvals.prompt(f.bot, '1', { ...REQUEST, timeoutMs: 50 })).resolves.toBe('deny');
    expect(f.edits.at(-1)?.text).toContain('denied');
  });

  it('denies when the question cannot be delivered at all', async () => {
    const f = fakeBot();
    f.failSend(new Error('chat not found'));
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    await expect(approvals.prompt(f.bot, '1', REQUEST)).resolves.toBe('deny');
    expect(f.sent).toHaveLength(0);
  });

  it('denies everything still open when the transport shuts down', async () => {
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    const answer = approvals.prompt(f.bot, '1', REQUEST);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));

    approvals.cancelAll();
    await expect(answer).resolves.toBe('deny');
  });

  it('tells a late presser the request is closed instead of resolving it', async () => {
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    const { answers } = await f.pressUnknown(1);
    expect(answers).toEqual([{ text: 'This request has already been answered.' }]);
  });
});
