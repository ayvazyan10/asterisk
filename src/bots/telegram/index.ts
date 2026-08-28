// Telegram adapter — long-polls Telegram via grammy.
// Reference: https://grammy.dev/  ·  https://core.telegram.org/bots/api
//
// Streaming: Telegram has no server-sent stream for bots, so "streaming"
// here means editing a placeholder message progressively via editMessageText.
// Telegram's Bot API enforces ~1 edit/sec per chat (bursts up to ~30/min);
// we respect that with a configurable throttle.

import { Bot, type Context, GrammyError, InputFile } from 'grammy';

import type { ApprovalOutcome } from '../../tools/approval.ts';
import {
  type ApprovalPrompt,
  type Attachment,
  type BotAdapter,
  type Handler,
  type IncomingMessage,
  type StreamEvent,
  asOutgoingMessage,
} from '../adapter.ts';
import { BOT_COMMAND_LIST } from '../commands.ts';
import { createApprovalController } from './approval.ts';
import { balanceOpenTags, chunkHtml, escapeHtml, markdownToTelegramHtml } from './format.ts';
import { downloadVoice } from './voice.ts';

const MAX_TELEGRAM_CHARS = 4096;
// 10-frame braille spinner — same glyphs CLIs like cargo / yarn use. Looks
// like a real "rotating" indicator across one cell, no emoji-rendering quirks.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Token replaced with the current spinner frame at render time.
const SPIN = '{{spin}}';
// Bump frame slightly slower than the rate-limit so we never starve the
// schedule of a real-content edit. Telegram allows ~1 edit/sec/chat.
const TICK_INTERVAL_MS = 1200;

export type TelegramStreamMode = 'final' | 'status' | 'stream';
export type TelegramParseMode = 'plain' | 'html';

export interface TelegramAdapterOptions {
  token: string;
  allowedUserIds: readonly number[];
  /** How replies are delivered. Default 'final' = current behaviour. */
  streamMode?: TelegramStreamMode;
  /** Minimum gap between editMessageText calls per placeholder. Default 1000ms. */
  streamThrottleMs?: number;
  /** plain | html — render markdown emphasis / code / links / etc. */
  parseMode?: TelegramParseMode;
}

export interface TelegramAdapter extends BotAdapter {
  /**
   * Resolves once no turn started by this adapter is still running.
   *
   * Turns are handled off the update stream (see the message handler), so
   * "the handler returned" no longer means "the turn finished" — this is how
   * a caller that needs the latter waits for it.
   */
  whenIdle(): Promise<void>;
}

export function createTelegramAdapter(opts: TelegramAdapterOptions): TelegramAdapter {
  if (!opts.token) {
    throw new Error('Telegram adapter requires ASTERISK_TELEGRAM_BOT_TOKEN');
  }
  const allowed = new Set(opts.allowedUserIds);
  const streamMode: TelegramStreamMode = opts.streamMode ?? 'final';
  const throttleMs = Math.max(opts.streamThrottleMs ?? 1000, 250);
  const parseMode: TelegramParseMode = opts.parseMode ?? 'html';
  const bot = new Bot(opts.token);
  const approvals = createApprovalController(allowed);
  /** Turns running outside the update stream — see the handler below. */
  const inFlight = new Set<Promise<void>>();
  let started = false;

  return {
    name: 'telegram',
    async start(handler: Handler): Promise<void> {
      approvals.register(bot);

      const startTurn = (ctx: Context, msg: IncomingMessage): void => {
        // Deliberately not awaited. grammy's built-in polling handles updates
        // one at a time — `handleUpdates` in bot.js says "handle updates
        // sequentially (!)" — so awaiting the turn here holds the whole update
        // stream for as long as the turn runs. That is fatal for a turn that is
        // *waiting on an update*: a permission prompt asks the chat, the user
        // presses the button, and the callback_query cannot be processed
        // because the message that raised it is still being awaited. The turn
        // then times out and denies a command the user had just approved.
        //
        // Ordering is not lost by letting go: the daemon runs turns through a
        // per-chat queue, so a second message still waits for the first.
        const task = handleTurn(ctx, msg, handler, streamMode, throttleMs, parseMode)
          .catch(async (e: unknown) => {
            await ctx.reply(`asterisk error: ${(e as Error).message}`).catch(() => {});
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      };

      /** Shared gate: only allowlisted users reach the agent at all. */
      const authorise = async (ctx: Context): Promise<number | null> => {
        const userId = ctx.from?.id;
        if (userId === undefined || !allowed.has(userId)) {
          await ctx.reply('This Asterisk bot is restricted. Your user id is not on the allowlist.');
          return null;
        }
        return userId;
      };

      bot.on('message:text', async (ctx: Context) => {
        const userId = await authorise(ctx);
        if (userId === null) return;

        const text = ctx.message?.text ?? '';
        if (!text) return;

        startTurn(ctx, {
          chatId: String(ctx.chat?.id ?? userId),
          userId: String(userId),
          text,
          timestamp: Date.now(),
        });
      });

      // Voice messages. The download happens here because it is transport
      // work; transcription does not, because which backend runs and what
      // happens when it fails is policy — see bots/adapter.ts.
      bot.on('message:voice', async (ctx: Context) => {
        const userId = await authorise(ctx);
        if (userId === null) return;

        const downloaded = await downloadVoice(ctx, opts.token);
        if (!downloaded.ok) {
          await ctx.reply(`Could not read that voice message: ${downloaded.error}`);
          return;
        }

        startTurn(ctx, {
          chatId: String(ctx.chat?.id ?? userId),
          userId: String(userId),
          // A voice note may carry a caption; the transcript joins it later.
          text: ctx.message?.caption ?? '',
          timestamp: Date.now(),
          voice: downloaded.voice,
        });
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
      // Anything still waiting on a button press is denied: the process is
      // going away, and a question nobody can answer must not read as consent.
      approvals.cancelAll();
      if (!started) return;
      await bot.stop();
    },
    promptApproval(chatId: string, prompt: ApprovalPrompt): Promise<ApprovalOutcome> {
      return approvals.prompt(bot, chatId, prompt);
    },
    async whenIdle(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

async function handleTurn(
  ctx: Context,
  msg: IncomingMessage,
  handler: Handler,
  mode: TelegramStreamMode,
  throttleMs: number,
  parseMode: TelegramParseMode,
): Promise<void> {
  if (mode === 'final') {
    const result = await handler(msg);
    await deliverFinal(ctx, asOutgoingMessage(result), parseMode);
    return;
  }

  // status + stream both maintain a single editable placeholder.
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    // No chat to attach edits to — degrade to final mode.
    const result = await handler(msg);
    await deliverFinal(ctx, asOutgoingMessage(result), parseMode);
    return;
  }

  // Initial placeholder — the writer's tick interval will animate from here.
  const placeholder = await ctx.reply(`${SPINNER_FRAMES[0]} thinking…`);
  const writer = createPlaceholderWriter(
    ctx,
    chatId,
    placeholder.message_id,
    throttleMs,
    parseMode,
  );

  let assistantText = '';
  let lastStatus = '';
  let sawDelta = false;

  const sink = (e: StreamEvent): void => {
    if (mode === 'status') {
      if (e.type === 'status') {
        lastStatus = e.text;
        const txt = truncate(lastStatus, 200);
        writer.schedule(
          parseMode === 'html' ? `${SPIN} <i>${escapeHtml(txt)}</i>` : `${SPIN} ${txt}`,
        );
      }
      // ignore text events in status mode — final reply replaces placeholder
      return;
    }
    // stream mode
    if (e.type === 'text') {
      sawDelta = true;
      assistantText += e.text;
      writer.schedule(streamView(assistantText, parseMode));
    } else if (e.type === 'text-final' && !sawDelta) {
      // Provider didn't stream — fall back to showing the whole block once.
      assistantText = e.text;
      writer.schedule(streamView(assistantText, parseMode));
    } else if (e.type === 'status') {
      const tail = truncate(e.text, 120);
      const view = assistantText
        ? `${streamView(assistantText, parseMode)}\n\n${
            parseMode === 'html' ? `<i>${escapeHtml(tail)}</i>` : `_${tail}_`
          }`
        : parseMode === 'html'
          ? `${SPIN} <i>${escapeHtml(truncate(e.text, 200))}</i>`
          : `${SPIN} ${truncate(e.text, 200)}`;
      writer.schedule(view);
    }
  };

  const result = await handler(msg, { sink });
  const out = asOutgoingMessage(result);

  // Final delivery: replace placeholder with the canonical final text.
  await writer.flush();
  if (out.text) {
    const rendered = parseMode === 'html' ? markdownToTelegramHtml(out.text) : out.text;
    const chunks = chunkText(rendered, MAX_TELEGRAM_CHARS, parseMode);
    const head = chunks[0] ?? '(empty)';
    await safeEdit(ctx, chatId, placeholder.message_id, head, parseMode);
    for (let i = 1; i < chunks.length; i++) {
      const c = chunks[i];
      if (c) await replyText(ctx, c, parseMode);
    }
  } else {
    await safeEdit(ctx, chatId, placeholder.message_id, '(no reply)', parseMode);
  }

  await sendAttachments(ctx, out.attachments);
}

async function deliverFinal(
  ctx: Context,
  out: ReturnType<typeof asOutgoingMessage>,
  parseMode: TelegramParseMode,
): Promise<void> {
  if (out.text) {
    const rendered = parseMode === 'html' ? markdownToTelegramHtml(out.text) : out.text;
    for (const chunk of chunkText(rendered, MAX_TELEGRAM_CHARS, parseMode)) {
      await replyText(ctx, chunk, parseMode);
    }
  }
  await sendAttachments(ctx, out.attachments);
}

/**
 * Sends each attachment, reporting a failure instead of aborting the rest.
 *
 * One function rather than the copy this used to be in both delivery paths:
 * a test covering the copy in `deliverFinal` said nothing about the one in
 * `handleTurn`, which is exactly the blind spot eight duplicated lines
 * produce. Confirmed by breaking it — with the duplicate, the regression went
 * unnoticed; with this, two tests fail.
 *
 * A missing file is ordinary — a screenshot the agent has since cleaned up —
 * and should cost that one attachment, not the four after it.
 */
async function sendAttachments(ctx: Context, attachments: Attachment[] | undefined): Promise<void> {
  for (const a of attachments ?? []) {
    try {
      await sendAttachment(ctx, a);
    } catch (sendErr) {
      await ctx.reply(`(failed to send ${a.kind} ${a.path}: ${(sendErr as Error).message})`);
    }
  }
}

async function replyText(ctx: Context, text: string, parseMode: TelegramParseMode): Promise<void> {
  if (parseMode === 'html') {
    try {
      await ctx.reply(text, { parse_mode: 'HTML' });
      return;
    } catch (e) {
      // Telegram rejected the markup (e.g. an unbalanced tag we missed).
      // Fall back to plain text so the user still gets the reply.
      if (e instanceof GrammyError) {
        await ctx.reply(stripTags(text));
        return;
      }
      throw e;
    }
  }
  await ctx.reply(text);
}

/** Exported for tests — this is Telegram's own fallback path (see
 *  `replyText`/`safeEdit` below), so a chunking regression that leaves a
 *  broken tag fragment behind is verified through the exact function that
 *  would show it to a real user. */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

interface PlaceholderWriter {
  /** Set the current message template. Use the `{{spin}}` token where the
   *  rotating spinner glyph should render — the writer ticks it every
   *  ~TICK_INTERVAL_MS so the user always sees motion. */
  schedule(template: string): void;
  flush(): Promise<void>;
}

/** Throttled editor for a single Telegram message with a self-ticking
 *  spinner. Coalesces rapid updates so we never violate the API's
 *  "1 edit per second per chat" guidance. */
function createPlaceholderWriter(
  ctx: Context,
  chatId: number,
  messageId: number,
  throttleMs: number,
  parseMode: TelegramParseMode,
): PlaceholderWriter {
  const startedAt = Date.now();
  let template = `${SPIN} thinking…`;
  let spinnerIdx = 0;
  let lastSent = '';
  let lastEditAt = 0;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const renderNow = (): string => {
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length] ?? '·';
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const elapsed = elapsedSec >= 1 ? ` · ${elapsedSec}s` : '';
    let text = template.replaceAll(SPIN, frame);
    // Append elapsed only on the spinner's "anchor" line — heuristic: if the
    // template has no newline, suffix; if multi-line, append to the last line.
    if (!text.includes('\n')) {
      text = `${text}${elapsed}`;
    } else {
      const idx = text.lastIndexOf('\n');
      text = `${text.slice(0, idx)}\n${text.slice(idx + 1)}${elapsed}`;
    }
    if (text.length > MAX_TELEGRAM_CHARS - 16) {
      text = `${text.slice(0, MAX_TELEGRAM_CHARS - 16)}\n…(truncated)`;
    }
    return text;
  };

  const doEdit = async (text: string): Promise<void> => {
    if (text === lastSent) return;
    lastSent = text;
    lastEditAt = Date.now();
    await safeEdit(ctx, chatId, messageId, text, parseMode);
  };

  const drain = (): void => {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (stopped) return;
    inFlight = doEdit(renderNow()).catch(() => undefined);
  };

  const requestEdit = (): void => {
    const sinceLast = Date.now() - lastEditAt;
    if (sinceLast >= throttleMs) {
      drain();
    } else if (!drainTimer) {
      drainTimer = setTimeout(drain, throttleMs - sinceLast);
    }
  };

  // Animate the spinner even when no other event arrives so the placeholder
  // never goes stale-looking. unref'd so it doesn't keep the daemon alive.
  const tick = setInterval(() => {
    if (stopped) return;
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    requestEdit();
  }, TICK_INTERVAL_MS);
  if (typeof (tick as { unref?: () => void }).unref === 'function') {
    (tick as { unref?: () => void }).unref?.();
  }

  return {
    schedule(next: string): void {
      template = next;
      requestEdit();
    },
    async flush(): Promise<void> {
      stopped = true;
      clearInterval(tick);
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // ignore
        }
      }
    },
  };
}

function streamView(text: string, parseMode: TelegramParseMode): string {
  // Show the streaming text with a small "still typing" tail so the user
  // sees the message is live rather than thinking the bot stalled. The
  // {{spin}} token is replaced with the current spinner frame on each tick
  // so the cursor visibly rotates while the model produces tokens. In
  // HTML mode we render the markdown then re-balance any tag we may have
  // left half-open by truncating mid-formatter — Telegram rejects
  // unbalanced edits otherwise.
  if (parseMode === 'html') {
    const rendered = markdownToTelegramHtml(text);
    return `${balanceOpenTags(rendered)} ${SPIN}`;
  }
  return `${text} ${SPIN}`;
}

async function safeEdit(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  parseMode: TelegramParseMode,
): Promise<void> {
  const opts = parseMode === 'html' ? { parse_mode: 'HTML' as const } : undefined;
  try {
    if (opts) {
      await ctx.api.editMessageText(chatId, messageId, text, opts);
    } else {
      await ctx.api.editMessageText(chatId, messageId, text);
    }
  } catch (e) {
    if (e instanceof GrammyError) {
      // Benign — coalesced to identical content.
      if (/not modified|MESSAGE_NOT_MODIFIED/i.test(e.description)) return;
      // Markup rejected — retry as plain text so the user still sees an update.
      if (parseMode === 'html' && /can't parse|unsupported start tag|entity/i.test(e.description)) {
        try {
          await ctx.api.editMessageText(chatId, messageId, stripTags(text));
        } catch {
          // give up silently
        }
        return;
      }
    }
    // Don't propagate — failed edits shouldn't break the turn.
  }
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
    default:
      await ctx.replyWithDocument(file, captionOpts);
      return;
  }
}

/**
 * Splits a rendered reply into Telegram-sized pieces. In HTML mode this
 * defers to `chunkHtml`, which never cuts through a tag — a blind
 * `slice(i, i + max)` over rendered markup can land inside one (e.g.
 * `<pre><code class="langua` | `ge-ts">…`), which Telegram rejects and whose
 * plain-text fallback then leaves the broken fragment visible as literal
 * text. Plain mode has no tags to protect, so it keeps the direct slice.
 */
function chunkText(text: string, max: number, parseMode: TelegramParseMode): string[] {
  if (text.length <= max) return [text || '(empty)'];
  if (parseMode === 'html') return chunkHtml(text, max);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
