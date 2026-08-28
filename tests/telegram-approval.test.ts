// Permission prompts in a Telegram chat.
//
// The controller takes the bot as a parameter, so the whole flow — question,
// button press, verdict — can be driven through a duck-typed stand-in with no
// network and no grammy runner.

import { describe, expect, it, vi } from 'vitest';

import type { Bot, Context } from 'grammy';

import { createApprovalController } from '../src/bots/telegram/approval.ts';
import type { ApprovalOutcome } from '../src/tools/approval.ts';

interface SentMessage {
  chatId: string;
  text: string;
  extra: {
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  };
}

interface EditedMessage {
  chatId: string;
  messageId: number;
  text: string;
  /** What the fake was actually given for `reply_markup` — `undefined` means
   *  the call omitted the option entirely, which is exactly the bug: a
   *  real edit that omits it does NOT reliably clear an existing keyboard. */
  replyMarkup: { inline_keyboard: unknown[] } | undefined;
}

function fakeBot() {
  const sent: SentMessage[] = [];
  const edits: EditedMessage[] = [];
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
      async editMessageText(
        chatId: string,
        messageId: number,
        text: string,
        opts?: { reply_markup?: { inline_keyboard: unknown[] } },
      ) {
        edits.push({ chatId, messageId, text, replyMarkup: opts?.reply_markup });
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
    const verdictEdit = f.edits.at(-1);
    expect(verdictEdit?.text).toContain('allowed from now on');
    // And the keyboard itself is explicitly cleared — an omitted
    // reply_markup is not good enough; nothing in the chat may stay
    // pressable once the request is settled.
    expect(verdictEdit?.replyMarkup).toEqual({ inline_keyboard: [] });
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
    const timeoutEdit = f.edits.at(-1);
    expect(timeoutEdit?.text).toContain('denied');
    expect(timeoutEdit?.replyMarkup).toEqual({ inline_keyboard: [] });
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

  it('denies only the asking chat’s prompts when that chat says /stop', async () => {
    // /stop is scoped to the sender's own chat. Aborting the turn frees the
    // tool side at once, but this question is a separate object and would keep
    // live buttons under it until its own timer expired minutes later.
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    const mine = approvals.prompt(f.bot, '11', REQUEST);
    const theirs = approvals.prompt(f.bot, '22', REQUEST);
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));

    expect(approvals.cancelChat('11')).toBe(1);
    await expect(mine).resolves.toBe('deny');

    // The other chat is untouched — one chat may only stop itself.
    let settled = false;
    void theirs.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    // And the withdrawn question is rewritten with its verdict, so nothing in
    // the chat stays pressable.
    const verdict = f.edits.at(-1);
    expect(verdict?.chatId).toBe('11');
    expect(verdict?.text).toContain('denied');
    expect(verdict?.replyMarkup).toEqual({ inline_keyboard: [] });

    approvals.cancelAll();
    await theirs;
  });

  it('reports nothing to withdraw when the chat has no open prompt', () => {
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);
    expect(approvals.cancelChat('11')).toBe(0);
  });

  it('does not let one chat withdraw another whose id it prefixes', async () => {
    // Ids are `${chatId}.${seq}`, so chat "1" must not claim chat "12"'s
    // pending requests — the dot is what keeps that true.
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    const other = approvals.prompt(f.bot, '12', REQUEST);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));

    expect(approvals.cancelChat('1')).toBe(0);

    approvals.cancelAll();
    await expect(other).resolves.toBe('deny');
  });

  it('never repeats an id in one chat, even past the old 100,000-request wraparound point', async () => {
    // The id used to be `nextId = (nextId + 1) % 100_000`, a single counter
    // shared by every chat. Past 100,000 outstanding requests in one chat it
    // wrapped back to values an old (still-rendered, e.g. its clear-keyboard
    // edit failed) button could carry, so a very-late press could resolve
    // the wrong pending request. Drive well past that boundary and check
    // every generated id is still distinct and the sequence never resets.
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    const total = 100_010;

    const inFlight: Promise<ApprovalOutcome>[] = [];
    for (let i = 0; i < total; i++) {
      inFlight.push(approvals.prompt(f.bot, 'stress-chat', { ...REQUEST, timeoutMs: 5 }));
    }
    await Promise.all(inFlight);

    expect(f.sent).toHaveLength(total);
    const ids = f.sent.map((m) => {
      const button = (m.extra.reply_markup?.inline_keyboard ?? []).flat()[0];
      return button?.callback_data.split(':')[1] ?? '';
    });
    expect(new Set(ids).size).toBe(total);
    expect(ids.at(-1)).toBe(`stress-chat.${total}`);
  }, 20_000);

  it('tells a late presser the request is closed instead of resolving it', async () => {
    const f = fakeBot();
    const approvals = createApprovalController([1]);
    approvals.register(f.bot);

    const { answers } = await f.pressUnknown(1);
    expect(answers).toEqual([{ text: 'This request has already been answered.' }]);
  });
});
