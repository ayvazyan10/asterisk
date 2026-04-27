// Telegram adapter — long-polls Telegram via grammy.
// Reference: https://grammy.dev/

import { Bot, type Context } from 'grammy';

import type { BotAdapter, Handler, IncomingMessage } from '../adapter.ts';

const MAX_TELEGRAM_CHARS = 4096;

export interface TelegramAdapterOptions {
  token: string;
  allowedUserIds: readonly number[];
}

export function createTelegramAdapter(opts: TelegramAdapterOptions): BotAdapter {
  if (!opts.token) {
    throw new Error('Telegram adapter requires ASTERISK_TELEGRAM_BOT_TOKEN');
  }
  const allowed = new Set(opts.allowedUserIds);
  const bot = new Bot(opts.token);
  let started = false;

  return {
    name: 'telegram',
    async start(handler: Handler): Promise<void> {
      bot.on('message:text', async (ctx: Context) => {
        const userId = ctx.from?.id;
        if (userId === undefined || !allowed.has(userId)) {
          await ctx.reply('This Asterisk bot is restricted. Your user id is not on the allowlist.');
          return;
        }
        const text = ctx.message?.text ?? '';
        if (!text) return;

        const msg: IncomingMessage = {
          chatId: String(ctx.chat?.id ?? userId),
          userId: String(userId),
          text,
          timestamp: Date.now(),
        };
        try {
          const reply = await handler(msg);
          for (const chunk of chunkText(reply, MAX_TELEGRAM_CHARS)) {
            await ctx.reply(chunk);
          }
        } catch (e) {
          await ctx.reply(`asterisk error: ${(e as Error).message}`);
        }
      });

      // start() resolves once long-polling is established. Use the runner
      // mode that does not block (await would never return).
      void bot.start({ drop_pending_updates: true });
      started = true;
    },
    async stop(): Promise<void> {
      if (!started) return;
      await bot.stop();
    },
  };
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text || '(empty)'];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}
