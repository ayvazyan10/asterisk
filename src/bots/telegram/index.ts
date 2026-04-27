// Telegram adapter — long-polls Telegram via grammy.
// Reference: https://grammy.dev/

import { Bot, type Context, InputFile } from 'grammy';

import {
  asOutgoingMessage,
  type Attachment,
  type BotAdapter,
  type Handler,
  type IncomingMessage,
} from '../adapter.ts';
import { BOT_COMMAND_LIST } from '../commands.ts';

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
          const result = await handler(msg);
          const out = asOutgoingMessage(result);
          if (out.text) {
            for (const chunk of chunkText(out.text, MAX_TELEGRAM_CHARS)) {
              await ctx.reply(chunk);
            }
          }
          for (const a of out.attachments ?? []) {
            try {
              await sendAttachment(ctx, a);
            } catch (sendErr) {
              await ctx.reply(`(failed to send ${a.kind} ${a.path}: ${(sendErr as Error).message})`);
            }
          }
        } catch (e) {
          await ctx.reply(`asterisk error: ${(e as Error).message}`);
        }
      });

      // Register slash commands with Telegram so users see autocomplete
      // suggestions when they type "/". Best-effort — failure here doesn't
      // prevent the bot from working.
      try {
        await bot.api.setMyCommands(
          BOT_COMMAND_LIST.map((c) => ({
            command: c.command,
            description: c.description,
          })),
        );
      } catch {
        // ignore — Telegram occasionally rejects this when bot privacy
        // mode hasn't synced yet; commands still work via the prefix
        // handler.
      }

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

async function sendAttachment(ctx: Context, a: Attachment): Promise<void> {
  const file = new InputFile(a.path);
  const captionOpts = a.caption ? { caption: a.caption } : {};
  switch (a.kind) {
    case 'image':
      await ctx.replyWithPhoto(file, captionOpts);
      return;
    case 'video':
      await ctx.replyWithVideo(file, captionOpts);
      return;
    case 'audio':
      await ctx.replyWithAudio(file, captionOpts);
      return;
    case 'document':
    default:
      await ctx.replyWithDocument(file, captionOpts);
      return;
  }
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
