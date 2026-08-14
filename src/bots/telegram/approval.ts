// Permission prompts inside a Telegram chat.
//
// Without this the daemon was structurally unattended: `permissions.mode` is
// `ask`, nothing in a bot turn could ask, and every command outside the
// allowlist came back as "no one was available to approve it" — a policy the
// user had configured to prompt them, silently degraded to a refusal.
//
// The prompt is an inline keyboard on a message sent into the same chat that
// raised the request. Two boundaries matter here:
//
//   * Only an allowlisted user may answer. The chat is not the credential —
//     a group can contain anyone, and a button is pressable by all of them.
//     The presser's id is checked against the same allowlist that gates
//     messages, so a bystander cannot approve a shell command.
//   * The answer must arrive before the caller stops waiting. The timeout
//     resolves to a denial and the message is rewritten to say so, rather
//     than leaving live buttons under a question nobody is listening to.

import type { Bot, Context } from 'grammy';

import type { ApprovalOutcome } from '../../tools/approval.ts';
import type { ApprovalPrompt } from '../adapter.ts';
import { escapeHtml } from './format.ts';

const CALLBACK_PREFIX = 'ap';

/** Telegram caps callback_data at 64 bytes, so ids stay short and local. */
let nextId = 0;

/** id → the resolver of the prompt() call that is still waiting on it. */
type Pending = Map<string, (outcome: ApprovalOutcome) => void>;

export interface ApprovalController {
  /** Wires the callback-query handler. Call once, from the adapter's start(). */
  register(bot: Bot): void;
  /** Poses the question and resolves with the answer. Never rejects. */
  prompt(bot: Bot, chatId: string, req: ApprovalPrompt): Promise<ApprovalOutcome>;
  /** Denies everything still open — used when the transport shuts down. */
  cancelAll(): void;
}

const ANSWER_LABEL: Record<ApprovalOutcome, string> = {
  'allow-once': '✅ allowed once',
  'allow-always': '♾ allowed from now on',
  deny: '⛔ denied',
};

function outcomeFromData(data: string, id: string): ApprovalOutcome | null {
  if (data === `${CALLBACK_PREFIX}:${id}:once`) return 'allow-once';
  if (data === `${CALLBACK_PREFIX}:${id}:always`) return 'allow-always';
  if (data === `${CALLBACK_PREFIX}:${id}:deny`) return 'deny';
  return null;
}

function questionHtml(req: ApprovalPrompt, seconds: number): string {
  const lines = [
    '🔐 <b>Permission needed</b>',
    `<pre><code>${escapeHtml(req.command)}</code></pre>`,
    escapeHtml(`${req.reason}.`),
  ];
  if (req.rules.length > 0) {
    const quoted = req.rules.map((r) => `"${r}"`).join(', ');
    lines.push(`<i>${escapeHtml(`"Always" remembers: ${quoted}`)}</i>`);
  }
  lines.push(`<i>${escapeHtml(`Answer within ${seconds}s or it is refused.`)}</i>`);
  return lines.join('\n');
}

export function createApprovalController(allowedUserIds: Iterable<number>): ApprovalController {
  const allowed = new Set(allowedUserIds);
  const pending: Pending = new Map();

  const finish = (id: string, outcome: ApprovalOutcome): void => {
    const settle = pending.get(id);
    if (!settle) return;
    pending.delete(id);
    settle(outcome);
  };

  return {
    register(bot: Bot): void {
      bot.on('callback_query:data', async (ctx: Context) => {
        const data = ctx.callbackQuery?.data ?? '';
        if (!data.startsWith(`${CALLBACK_PREFIX}:`)) return;
        const id = data.split(':')[1] ?? '';

        if (!pending.has(id)) {
          await ctx.answerCallbackQuery({ text: 'This request has already been answered.' });
          return;
        }

        const userId = ctx.from?.id;
        if (userId === undefined || !allowed.has(userId)) {
          // Answering is a privileged act; being in the chat is not enough.
          await ctx.answerCallbackQuery({
            text: 'You are not on this bot’s allowlist.',
            show_alert: true,
          });
          return;
        }

        const outcome = outcomeFromData(data, id);
        if (outcome === null) {
          await ctx.answerCallbackQuery({ text: 'Unrecognised choice.' });
          return;
        }

        finish(id, outcome);
        // The prompt() call rewrites the message with the verdict once it
        // wakes; here we only acknowledge, so Telegram stops the spinner.
        await ctx.answerCallbackQuery({ text: ANSWER_LABEL[outcome] });
      });
    },

    async prompt(bot: Bot, chatId: string, req: ApprovalPrompt): Promise<ApprovalOutcome> {
      nextId = (nextId + 1) % 100_000;
      const id = `${nextId}`;
      const seconds = Math.max(1, Math.round(req.timeoutMs / 1000));

      let message: { message_id: number };
      try {
        message = await bot.api.sendMessage(chatId, questionHtml(req, seconds), {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Allow once', callback_data: `${CALLBACK_PREFIX}:${id}:once` },
                { text: '♾ Always', callback_data: `${CALLBACK_PREFIX}:${id}:always` },
              ],
              [{ text: '⛔ Deny', callback_data: `${CALLBACK_PREFIX}:${id}:deny` }],
            ],
          },
        });
      } catch {
        // Couldn't even ask — that is a denial, not a crash.
        return 'deny';
      }

      const answered = new Promise<ApprovalOutcome>((resolve) => {
        pending.set(id, resolve);
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<ApprovalOutcome>((resolve) => {
        timer = setTimeout(() => {
          pending.delete(id);
          resolve('deny');
        }, req.timeoutMs);
      });

      const outcome = await Promise.race([answered, timedOut]);
      if (timer) clearTimeout(timer);
      pending.delete(id);

      // Replace the keyboard with the verdict, so a stale question can never be
      // answered later and nothing in the chat implies it is still open.
      try {
        await bot.api.editMessageText(
          chatId,
          message.message_id,
          `${questionHtml(req, seconds)}\n\n<b>${escapeHtml(ANSWER_LABEL[outcome])}</b>`,
          { parse_mode: 'HTML' },
        );
      } catch {
        // Cosmetic; the outcome already went back to the policy.
      }
      return outcome;
    },

    cancelAll(): void {
      for (const id of [...pending.keys()]) finish(id, 'deny');
    },
  };
}
