// The Telegram adapter, driven through a fake grammy.
//
// `Bot` and `InputFile` are faked; `GrammyError` is the real class, because
// most of what is worth testing here is how the adapter reacts to Telegram
// *rejecting* something, and that reaction is an `instanceof GrammyError`
// check. A hand-rolled stand-in would make every one of those branches pass
// for the wrong reason.
//
// What the fake gives us is the registered `message:text` handler. Driving it
// with a synthetic context exercises the whole path — allowlist, mode
// selection, placeholder editing, chunking, attachments — without a network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeBot, fakeBotInstances, FakeInputFile } = vi.hoisted(() => {
  type Handler = (ctx: unknown) => Promise<void>;

  class FakeInputFile {
    constructor(readonly path: string) {}
  }

  class FakeBot {
    handler: Handler | null = null;
    /** The approval controller's callback_query listener. */
    callbackHandler: Handler | null = null;
    startCalls = 0;
    stopCalls = 0;
    setMyCommandsCalls: unknown[][] = [];
    /** Messages sent through bot.api rather than a reply — the permission prompt. */
    sent: Array<{ chatId: string; text: string; extra: Record<string, unknown> }> = [];
    apiEdits: Array<{ chatId: string; messageId: number; text: string }> = [];
    /** Set to make setMyCommands reject, as Telegram sometimes does. */
    setMyCommandsError: Error | null = null;
    /** Set to make stop() reject — grammy does when the runner already died. */
    stopError: Error | null = null;

    readonly api = {
      setMyCommands: async (...args: unknown[]): Promise<void> => {
        this.setMyCommandsCalls.push(args);
        if (this.setMyCommandsError) throw this.setMyCommandsError;
      },
      sendMessage: async (
        chatId: string,
        text: string,
        extra: Record<string, unknown>,
      ): Promise<{ message_id: number }> => {
        this.sent.push({ chatId, text, extra });
        return { message_id: 500 + this.sent.length };
      },
      editMessageText: async (chatId: string, messageId: number, text: string): Promise<void> => {
        this.apiEdits.push({ chatId, messageId, text });
      },
    };

    constructor(readonly token: string) {
      fakeBotInstances.push(this);
    }

    on(event: string, handler: Handler): void {
      if (event === 'message:text') this.handler = handler;
      if (event === 'callback_query:data') this.callbackHandler = handler;
    }

    async start(): Promise<void> {
      this.startCalls += 1;
    }

    async stop(): Promise<void> {
      this.stopCalls += 1;
      if (this.stopError) throw this.stopError;
    }
  }

  return { FakeBot, fakeBotInstances: [] as FakeBot[], FakeInputFile };
});

vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
  return { ...actual, Bot: FakeBot, InputFile: FakeInputFile };
});

const { GrammyError } = await import('grammy');
const { createTelegramAdapter } = await import('../src/bots/telegram/index.ts');
const { createBotManager } = await import('../src/bots/manager.ts');
const { ConfigSchema } = await import('../src/config/schema.ts');
import type { Handler, StreamEvent } from '../src/bots/adapter.ts';
import type { TelegramAdapterOptions } from '../src/bots/telegram/index.ts';

/** A Telegram rejection, shaped the way grammy delivers one. */
function telegramError(description: string, code = 400): Error {
  return new GrammyError(
    `Call to method failed: ${description}`,
    { ok: false, error_code: code, description },
    'sendMessage',
    {},
  );
}

interface Call {
  method: string;
  text: string;
  opts: Record<string, unknown> | undefined;
}

/** A synthetic grammy Context that records what the adapter sent. */
class FakeCtx {
  readonly calls: Call[] = [];
  /** method name → error thrown on every call. */
  private readonly always = new Map<string, Error>();
  /** method name → errors thrown on the first N calls. */
  private readonly once = new Map<string, Error[]>();
  private nextMessageId = 100;

  from: { id: number } | undefined = { id: 7 };
  chat: { id: number } | undefined = { id: 42 };
  message: { text: string } | undefined = { text: 'hello' };

  readonly api = {
    editMessageText: async (
      _chatId: number,
      _messageId: number,
      text: string,
      opts?: Record<string, unknown>,
    ): Promise<void> => {
      this.record('editMessageText', text, opts);
    },
  };

  failAlways(method: string, error: Error): this {
    this.always.set(method, error);
    return this;
  }

  failOnce(method: string, error: Error): this {
    const queued = this.once.get(method) ?? [];
    queued.push(error);
    this.once.set(method, queued);
    return this;
  }

  private record(method: string, text: string, opts?: Record<string, unknown>): void {
    const queued = this.once.get(method);
    const pending = queued?.shift();
    this.calls.push({ method, text, opts });
    if (pending) throw pending;
    const always = this.always.get(method);
    if (always) throw always;
  }

  reply = async (text: string, opts?: Record<string, unknown>): Promise<{ message_id: number }> => {
    this.record('reply', text, opts);
    this.nextMessageId += 1;
    return { message_id: this.nextMessageId };
  };

  replyWithPhoto = async (file: { path: string }, opts?: Record<string, unknown>): Promise<void> =>
    this.record('replyWithPhoto', file.path, opts);
  replyWithVideo = async (file: { path: string }, opts?: Record<string, unknown>): Promise<void> =>
    this.record('replyWithVideo', file.path, opts);
  replyWithAudio = async (file: { path: string }, opts?: Record<string, unknown>): Promise<void> =>
    this.record('replyWithAudio', file.path, opts);
  replyWithDocument = async (
    file: { path: string },
    opts?: Record<string, unknown>,
  ): Promise<void> => this.record('replyWithDocument', file.path, opts);

  /** Everything sent by one method, in order. */
  texts(method: string): string[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.text);
  }
}

/** Starts an adapter and returns the handler grammy would have called. */
async function start(
  opts: Partial<TelegramAdapterOptions>,
  handler: Handler,
): Promise<(ctx: unknown) => Promise<void>> {
  const adapter = createTelegramAdapter({
    token: 'test-token',
    allowedUserIds: [7],
    ...opts,
  });
  await adapter.start(handler);
  const bot = fakeBotInstances.at(-1);
  if (!bot?.handler) throw new Error('adapter never registered a message handler');
  const registered = bot.handler;
  // The adapter no longer awaits the turn inside the handler — grammy's
  // polling is sequential, and holding it there deadlocks a turn that is
  // waiting on a later update (a permission button press). Tests still want
  // "the turn is done", so they wait for it explicitly.
  return async (ctx: unknown) => {
    await registered(ctx);
    await adapter.whenIdle();
  };
}

beforeEach(() => {
  fakeBotInstances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lifecycle', () => {
  it('refuses to construct without a token', () => {
    expect(() => createTelegramAdapter({ token: '', allowedUserIds: [] })).toThrow(
      /ASTERISK_TELEGRAM_BOT_TOKEN/,
    );
  });

  it('registers the bot command list so Telegram offers autocomplete', async () => {
    await start({}, async () => 'ok');
    const bot = fakeBotInstances.at(-1);
    expect(bot?.setMyCommandsCalls).toHaveLength(1);
    const registered = bot?.setMyCommandsCalls[0]?.[0] as { command: string }[];
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.every((c) => typeof c.command === 'string')).toBe(true);
  });

  it('still starts when Telegram rejects the command list', async () => {
    // Telegram rejects setMyCommands while privacy mode syncs. Losing
    // autocomplete is not losing the bot.
    const adapter = createTelegramAdapter({ token: 't', allowedUserIds: [7] });
    const bot = fakeBotInstances.at(-1);
    if (bot) bot.setMyCommandsError = telegramError('too many requests', 429);
    await expect(adapter.start(async () => 'ok')).resolves.toBeUndefined();
    expect(bot?.startCalls).toBe(1);
  });

  it('does not stop a bot it never started', async () => {
    const adapter = createTelegramAdapter({ token: 't', allowedUserIds: [] });
    await adapter.stop();
    expect(fakeBotInstances.at(-1)?.stopCalls).toBe(0);
  });

  it('stops the bot once started', async () => {
    const adapter = createTelegramAdapter({ token: 't', allowedUserIds: [] });
    await adapter.start(async () => 'ok');
    await adapter.stop();
    expect(fakeBotInstances.at(-1)?.stopCalls).toBe(1);
  });
});

describe('the allowlist', () => {
  it('refuses a user who is not on it, without running the agent', async () => {
    const handler = vi.fn(async () => 'should never run');
    const onMessage = await start({ allowedUserIds: [7] }, handler);
    const ctx = new FakeCtx();
    ctx.from = { id: 999 };

    await onMessage(ctx);

    expect(handler).not.toHaveBeenCalled();
    expect(ctx.texts('reply')[0]).toMatch(/restricted/i);
  });

  it('refuses an update carrying no sender', async () => {
    // `from` is optional in the Bot API. An absent id must not be read as
    // "allowed" — it is the one case where a bug would open the bot to
    // anyone.
    const handler = vi.fn(async () => 'nope');
    const onMessage = await start({ allowedUserIds: [7] }, handler);
    const ctx = new FakeCtx();
    ctx.from = undefined;

    await onMessage(ctx);

    expect(handler).not.toHaveBeenCalled();
    expect(ctx.texts('reply')[0]).toMatch(/restricted/i);
  });

  it('ignores an empty message rather than running an empty turn', async () => {
    const handler = vi.fn(async () => 'ok');
    const onMessage = await start({}, handler);
    const ctx = new FakeCtx();
    ctx.message = { text: '' };

    await onMessage(ctx);

    expect(handler).not.toHaveBeenCalled();
    expect(ctx.calls).toHaveLength(0);
  });

  it('ignores an allowed sender whose update carries no message', async () => {
    // `message` is optional on Context even for a message:text filter, and an
    // absent one must read as "nothing to answer" rather than as an empty
    // prompt handed to the model.
    const handler = vi.fn(async () => 'ok');
    const onMessage = await start({}, handler);
    const ctx = new FakeCtx();
    ctx.message = undefined;

    await onMessage(ctx);

    expect(handler).not.toHaveBeenCalled();
    expect(ctx.calls).toHaveLength(0);
  });

  it('passes the chat id and user id through to the handler', async () => {
    let seen: { chatId: string; userId: string } | null = null;
    const onMessage = await start({}, async (msg) => {
      seen = { chatId: msg.chatId, userId: msg.userId };
      return 'ok';
    });
    await onMessage(new FakeCtx());
    expect(seen).toEqual({ chatId: '42', userId: '7' });
  });

  it('falls back to the user id when the update has no chat', async () => {
    let chatId = '';
    const onMessage = await start({}, async (msg) => {
      chatId = msg.chatId;
      return 'ok';
    });
    const ctx = new FakeCtx();
    ctx.chat = undefined;
    await onMessage(ctx);
    expect(chatId).toBe('7');
  });
});

describe('final mode', () => {
  it('renders markdown as Telegram HTML by default', async () => {
    const onMessage = await start({ streamMode: 'final' }, async () => '**bold** and `code`');
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const [call] = ctx.calls;
    expect(call?.opts).toEqual({ parse_mode: 'HTML' });
    expect(call?.text).toContain('<b>bold</b>');
    expect(call?.text).toContain('<code>code</code>');
  });

  it('sends the raw text in plain mode, markers and all', async () => {
    const onMessage = await start(
      { streamMode: 'final', parseMode: 'plain' },
      async () => '**bold**',
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.calls[0]?.opts).toBeUndefined();
    expect(ctx.calls[0]?.text).toBe('**bold**');
  });

  it('falls back to plain text when Telegram rejects the markup', async () => {
    // The point of the fallback: the user gets the reply. Dropping the turn
    // because a tag was malformed would be the worse failure.
    const onMessage = await start({ streamMode: 'final' }, async () => '**bold**');
    const ctx = new FakeCtx();
    ctx.failOnce('reply', telegramError("can't parse entities"));

    await onMessage(ctx);

    const texts = ctx.texts('reply');
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe('bold');
  });

  it('reports a non-Telegram failure instead of swallowing it', async () => {
    // A TypeError from our own code is a bug, not a markup problem, and
    // stripping tags would not help. It should surface.
    const onMessage = await start({ streamMode: 'final' }, async () => 'hi');
    const ctx = new FakeCtx();
    ctx.failOnce('reply', new TypeError('boom'));

    await onMessage(ctx);

    // handleTurn's catch turns it into a visible error message.
    expect(ctx.texts('reply').at(-1)).toMatch(/asterisk error: boom/);
  });

  it('splits a reply longer than Telegram allows', async () => {
    const long = 'x'.repeat(4096 * 2 + 10);
    const onMessage = await start({ streamMode: 'final', parseMode: 'plain' }, async () => long);
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const texts = ctx.texts('reply');
    expect(texts).toHaveLength(3);
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThanOrEqual(4096);
    expect(texts.join('')).toBe(long);
  });

  it('tells the user when the turn threw', async () => {
    const onMessage = await start({ streamMode: 'final' }, async () => {
      throw new Error('provider unreachable');
    });
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.texts('reply')[0]).toBe('asterisk error: provider unreachable');
  });
});

describe('attachments', () => {
  it('routes each kind to its own Telegram method', async () => {
    const onMessage = await start({ streamMode: 'final' }, async () => ({
      text: 'here',
      attachments: [
        { kind: 'image' as const, path: '/tmp/a.png' },
        { kind: 'video' as const, path: '/tmp/b.mp4' },
        { kind: 'audio' as const, path: '/tmp/c.mp3' },
        { kind: 'document' as const, path: '/tmp/d.pdf' },
      ],
    }));
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.calls.map((c) => c.method)).toEqual([
      'reply',
      'replyWithPhoto',
      'replyWithVideo',
      'replyWithAudio',
      'replyWithDocument',
    ]);
  });

  it('forwards a caption', async () => {
    const onMessage = await start({ streamMode: 'final' }, async () => ({
      text: 'here',
      attachments: [{ kind: 'image' as const, path: '/tmp/a.png', caption: 'the graph' }],
    }));
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.calls[1]?.opts).toEqual({ caption: 'the graph' });
  });

  it('keeps sending after one attachment fails', async () => {
    // A missing file is common — a screenshot the agent cleaned up, say. It
    // should cost that one attachment, not the rest of them.
    const onMessage = await start({ streamMode: 'final' }, async () => ({
      text: 'here',
      attachments: [
        { kind: 'image' as const, path: '/tmp/gone.png' },
        { kind: 'document' as const, path: '/tmp/fine.pdf' },
      ],
    }));
    const ctx = new FakeCtx();
    ctx.failAlways('replyWithPhoto', new Error('ENOENT'));

    await onMessage(ctx);

    expect(ctx.texts('reply').at(-1)).toMatch(/failed to send image \/tmp\/gone\.png: ENOENT/);
    expect(ctx.calls.some((c) => c.method === 'replyWithDocument')).toBe(true);
  });

  it('sends them in stream mode too, not only in final mode', async () => {
    // Both delivery paths route through the same sendAttachments now. Before
    // that they were two identical copies, and a test of one proved nothing
    // about the other.
    const onMessage = await start({ streamMode: 'stream', parseMode: 'plain' }, async () => ({
      text: 'here',
      attachments: [{ kind: 'image' as const, path: '/tmp/shot.png' }],
    }));
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.calls.some((c) => c.method === 'replyWithPhoto')).toBe(true);
  });

  it('keeps going when a stream-mode attachment fails', async () => {
    const onMessage = await start({ streamMode: 'stream', parseMode: 'plain' }, async () => ({
      text: 'here',
      attachments: [
        { kind: 'image' as const, path: '/tmp/gone.png' },
        { kind: 'document' as const, path: '/tmp/fine.pdf' },
      ],
    }));
    const ctx = new FakeCtx();
    ctx.failAlways('replyWithPhoto', new Error('ENOENT'));

    await onMessage(ctx);

    expect(ctx.texts('reply').at(-1)).toMatch(/failed to send image/);
    expect(ctx.calls.some((c) => c.method === 'replyWithDocument')).toBe(true);
  });

  it('sends attachments with no text at all', async () => {
    const onMessage = await start({ streamMode: 'final' }, async () => ({
      text: '',
      attachments: [{ kind: 'image' as const, path: '/tmp/only.png' }],
    }));
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.calls.map((c) => c.method)).toEqual(['replyWithPhoto']);
  });
});

describe('status mode', () => {
  it('puts a placeholder up, edits it with status, then replaces it', async () => {
    const onMessage = await start({ streamMode: 'status' }, async (_msg, opts) => {
      opts?.sink?.({ type: 'status', text: 'Bash · npm test' });
      return 'done';
    });
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.calls[0]?.method).toBe('reply');
    expect(ctx.calls[0]?.text).toMatch(/thinking/);

    const edits = ctx.texts('editMessageText');
    expect(edits.some((t) => t.includes('Bash · npm test'))).toBe(true);
    expect(edits.at(-1)).toBe('done');
  });

  it('ignores streamed text — the final reply is the canonical one', async () => {
    const onMessage = await start({ streamMode: 'status' }, async (_msg, opts) => {
      opts?.sink?.({ type: 'text', text: 'partial…' });
      return 'final answer';
    });
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const edits = ctx.texts('editMessageText');
    expect(edits.some((t) => t.includes('partial'))).toBe(false);
    expect(edits.at(-1)).toBe('final answer');
  });

  it('degrades to final mode when the update has no chat to edit in', async () => {
    const onMessage = await start({ streamMode: 'status', parseMode: 'plain' }, async () => 'done');
    const ctx = new FakeCtx();
    ctx.chat = undefined;
    await onMessage(ctx);

    expect(ctx.texts('editMessageText')).toEqual([]);
    expect(ctx.texts('reply')).toEqual(['done']);
  });

  it('says so rather than leaving the spinner up when there is no reply', async () => {
    const onMessage = await start({ streamMode: 'status' }, async () => '');
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.texts('editMessageText').at(-1)).toBe('(no reply)');
  });

  it('writes the status unmarked when markup is off', async () => {
    const onMessage = await start(
      { streamMode: 'status', parseMode: 'plain' },
      async (_msg, opts) => {
        opts?.sink?.({ type: 'status', text: 'Bash · npm test' });
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const status = ctx.texts('editMessageText').find((t) => t.includes('Bash · npm test'));
    expect(status).toBeDefined();
    expect(status).not.toContain('<i>');
    const editOpts = ctx.calls.filter((c) => c.method === 'editMessageText').map((c) => c.opts);
    expect(editOpts.every((o) => o === undefined)).toBe(true);
  });

  it('truncates a status too long to sit in the placeholder', async () => {
    // A tool can report something enormous — a grep pattern, a long path.
    // The placeholder is a progress line, not the payload.
    const onMessage = await start(
      { streamMode: 'status', parseMode: 'plain' },
      async (_msg, opts) => {
        opts?.sink?.({ type: 'status', text: 'z'.repeat(300) });
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const status = ctx.texts('editMessageText').find((t) => t.includes('zzz'));
    expect(status).toBeDefined();
    expect(status).toContain('…');
    expect(status?.match(/z/g)).toHaveLength(200);
  });
});

describe('stream mode', () => {
  it('edits the placeholder as text arrives', async () => {
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain' },
      async (_m, opts) => {
        opts?.sink?.({ type: 'text', text: 'Hel' });
        return 'Hello';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const edits = ctx.texts('editMessageText');
    expect(edits.some((t) => t.startsWith('Hel'))).toBe(true);
    expect(edits.at(-1)).toBe('Hello');
  });

  it('shows the whole block when the provider did not stream', async () => {
    // text-final is the fallback for a provider that returns one lump.
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain' },
      async (_m, opts) => {
        opts?.sink?.({ type: 'text-final', text: 'all at once' });
        return 'all at once';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    expect(ctx.texts('editMessageText').some((t) => t.includes('all at once'))).toBe(true);
  });

  it('ignores text-final once deltas have arrived, so the text is not doubled', async () => {
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain' },
      async (_m, opts) => {
        opts?.sink?.({ type: 'text', text: 'streamed' });
        opts?.sink?.({ type: 'text-final', text: 'streamed' });
        return 'streamed';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    for (const edit of ctx.texts('editMessageText')) {
      expect(edit).not.toContain('streamedstreamed');
    }
  });

  it('appends a status tail under the text it already has', async () => {
    // The turn has to outlive the throttle window, or the coalesced edit is
    // still pending when the final reply flushes it away. That is correct —
    // the final text replaces the placeholder either way — but it means the
    // tail is only ever visible on a turn that lasts longer than
    // streamThrottleMs, which is 1000ms unless configured down.
    vi.useFakeTimers();
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain', streamThrottleMs: 250 },
      async (_m, opts) => {
        opts?.sink?.({ type: 'text', text: 'working on it' });
        opts?.sink?.({ type: 'status', text: 'Grep · pattern' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    const turn = onMessage(ctx);
    await vi.advanceTimersByTimeAsync(500);
    await turn;

    const withTail = ctx.texts('editMessageText').find((t) => t.includes('Grep · pattern'));
    expect(withTail).toBeDefined();
    expect(withTail).toContain('working on it');
    expect(ctx.texts('editMessageText').at(-1)).toBe('done');
  });

  it('coalesces rapid deltas instead of one edit each', async () => {
    // Telegram allows ~1 edit/sec/chat. Fifty deltas must not become fifty
    // calls, or the API starts rejecting them.
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain' },
      async (_m, opts) => {
        for (let i = 0; i < 50; i++) opts?.sink?.({ type: 'text', text: `${i} ` });
        return 'finished';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    // One immediate edit, one final edit — the other 49 deltas coalesce.
    expect(ctx.texts('editMessageText').length).toBeLessThanOrEqual(3);
    expect(ctx.texts('editMessageText').at(-1)).toBe('finished');
  });

  it('splits a final reply that outgrew one message', async () => {
    const long = 'y'.repeat(4096 + 50);
    const onMessage = await start({ streamMode: 'stream', parseMode: 'plain' }, async () => long);
    const ctx = new FakeCtx();
    await onMessage(ctx);

    // Head replaces the placeholder; the tail arrives as a new message.
    expect(ctx.texts('editMessageText').at(-1)?.length).toBe(4096);
    expect(ctx.texts('reply').at(-1)?.length).toBe(50);
  });

  it('renders the partial text as markup, not as literal markers', async () => {
    // The whole point of streaming into the placeholder is that it reads like
    // the finished reply. Leaving `**` visible until the final edit would make
    // every streamed turn look broken for its whole duration.
    const onMessage = await start({ streamMode: 'stream' }, async (_m, opts) => {
      opts?.sink?.({ type: 'text', text: 'a **bold** claim' });
      return 'a **bold** claim';
    });
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const partial = ctx.texts('editMessageText')[0];
    expect(partial).toContain('<b>bold</b>');
    expect(partial).not.toContain('**');
    expect(ctx.calls.find((c) => c.method === 'editMessageText')?.opts).toEqual({
      parse_mode: 'HTML',
    });
  });

  it('appends an italic status tail under the text it already has', async () => {
    // The html twin of the plain-mode case above: the tail is emphasis, so a
    // reader can tell progress chatter from the answer itself.
    vi.useFakeTimers();
    const onMessage = await start(
      { streamMode: 'stream', streamThrottleMs: 250 },
      async (_m, opts) => {
        opts?.sink?.({ type: 'text', text: 'working on it' });
        opts?.sink?.({ type: 'status', text: 'Grep · pattern' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    const turn = onMessage(ctx);
    await vi.advanceTimersByTimeAsync(500);
    await turn;

    const withTail = ctx.texts('editMessageText').find((t) => t.includes('Grep · pattern'));
    expect(withTail).toContain('working on it');
    expect(withTail).toContain('<i>Grep · pattern</i>');
  });

  it('shows a bare status before any text has streamed', async () => {
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain' },
      async (_m, opts) => {
        opts?.sink?.({ type: 'status', text: 'Grep · pattern' });
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const status = ctx.texts('editMessageText').find((t) => t.includes('Grep · pattern'));
    expect(status).toBeDefined();
    expect(status).not.toContain('<i>');
  });

  it('italicises a bare status before any text has streamed, in html mode', async () => {
    const onMessage = await start({ streamMode: 'stream' }, async (_m, opts) => {
      opts?.sink?.({ type: 'status', text: 'Grep · pattern' });
      return 'done';
    });
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const status = ctx.texts('editMessageText').find((t) => t.includes('Grep · pattern'));
    expect(status).toContain('<i>Grep · pattern</i>');
  });

  it('truncates the placeholder rather than letting an edit exceed the limit', async () => {
    // Telegram rejects an edit over 4096 chars outright, which would freeze
    // the placeholder on its last good frame for the rest of a long answer.
    const onMessage = await start(
      { streamMode: 'stream', parseMode: 'plain' },
      async (_m, opts) => {
        opts?.sink?.({ type: 'text', text: 'q'.repeat(5000) });
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    await onMessage(ctx);

    const first = ctx.texts('editMessageText')[0] ?? '';
    expect(first.length).toBeLessThanOrEqual(4096);
    expect(first.endsWith('…(truncated)')).toBe(true);
  });
});

describe('the placeholder spinner', () => {
  it('keeps animating and counting while the turn produces nothing', async () => {
    // A turn can spend a minute in one tool call with no status and no text.
    // Without the self-tick the placeholder would sit frozen and read as a
    // hung bot.
    vi.useFakeTimers();
    const onMessage = await start({ streamMode: 'status', parseMode: 'plain' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return 'done';
    });
    const ctx = new FakeCtx();
    const turn = onMessage(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    await turn;

    const edits = ctx.texts('editMessageText');
    expect(edits.length).toBeGreaterThan(1);
    expect(edits.some((t) => / · \d+s$/.test(t))).toBe(true);
    // The leading glyph has to actually change, or it is not an animation.
    const spinning = edits.filter((t) => t.includes('thinking'));
    expect(new Set(spinning.map((t) => t[0])).size).toBeGreaterThan(1);
    expect(edits.at(-1)).toBe('done');
  });

  it('does not re-send an edit whose rendered content is unchanged', async () => {
    // Two identical statuses in a row are ordinary — the same tool reporting
    // twice. Sending the second costs a request and earns a Telegram
    // "message is not modified" rejection.
    vi.useFakeTimers();
    const onMessage = await start(
      { streamMode: 'status', parseMode: 'plain', streamThrottleMs: 250 },
      async (_m, opts) => {
        opts?.sink?.({ type: 'status', text: 'Bash · npm test' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        opts?.sink?.({ type: 'status', text: 'Bash · npm test' });
        return 'done';
      },
    );
    const ctx = new FakeCtx();
    const turn = onMessage(ctx);
    await vi.advanceTimersByTimeAsync(400);
    await turn;

    expect(ctx.texts('editMessageText').filter((t) => t.includes('npm test'))).toHaveLength(1);
  });
});

describe('permission prompts during a live turn', () => {
  it('handles the button press while the turn that raised it is still waiting', async () => {
    // The regression this pins down: grammy's built-in polling processes
    // updates one at a time, so a handler that awaits its turn holds the whole
    // update stream. A turn waiting on a permission prompt then waits for a
    // button press that can never be delivered — the question sits there with
    // its spinner until the policy times out and denies it.
    const adapter = createTelegramAdapter({ token: 't', allowedUserIds: [7] });
    let outcome: string | undefined;

    await adapter.start(async (msg) => {
      outcome = await adapter.promptApproval?.(msg.chatId, {
        command: 'docker ps',
        reason: 'docker is not on the allowlist',
        rules: ['docker ps'],
        timeoutMs: 5_000,
      });
      return `outcome=${outcome}`;
    });

    const bot = fakeBotInstances.at(-1);
    const ctx = new FakeCtx();
    // Returns immediately: the turn is now running off the update stream.
    await bot?.handler?.(ctx);
    await vi.waitFor(() => expect(bot?.sent).toHaveLength(1));
    expect(bot?.sent[0]?.text).toContain('docker ps');

    const keyboard = bot?.sent[0]?.extra['reply_markup'] as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const allowOnce = keyboard.inline_keyboard.flat()[0]?.callback_data;

    const answers: unknown[] = [];
    await bot?.callbackHandler?.({
      callbackQuery: { data: allowOnce },
      from: { id: 7 },
      answerCallbackQuery: async (arg: unknown) => {
        answers.push(arg);
      },
    });

    await adapter.whenIdle();
    expect(answers).toEqual([{ text: '✅ allowed once' }]);
    expect(outcome).toBe('allow-once');
    expect(ctx.texts('reply')).toContain('outcome=allow-once');
  });
});

describe('bot manager wiring', () => {
  it('starts the configured telegram adapter and forwards its options', async () => {
    // The manager is the only place config becomes adapter options. A dropped
    // field here is invisible until a user notices their setting does nothing.
    const manager = createBotManager({
      config: ConfigSchema.parse({
        bots: {
          telegram: {
            enabled: true,
            allowedUserIds: [7],
            streamMode: 'final',
            parseMode: 'plain',
          },
        },
      }),
      secrets: { ASTERISK_TELEGRAM_BOT_TOKEN: 'tok' },
    });

    const started = await manager.start(async () => '**bold**');
    expect(started).toEqual(['telegram']);

    const bot = fakeBotInstances.at(-1);
    expect(bot?.token).toBe('tok');

    const ctx = new FakeCtx();
    await bot?.handler?.(ctx);
    // The handler hands the turn off rather than awaiting it, so the reply
    // lands a tick later — asserting straight after the call would pass only
    // by whatever the microtask queue happened to do.
    await vi.waitFor(() => expect(ctx.texts('reply')).toEqual(['**bold**']));

    await manager.stop();
    expect(bot?.stopCalls).toBe(1);
  });

  it('reports that a permission prompt can be shown, since Telegram has buttons', async () => {
    // The bridge asks this before claiming an approver exists. Answering "yes"
    // when nothing can render a prompt would hang every request until the
    // policy's timeout denied it.
    const manager = createBotManager({
      config: ConfigSchema.parse({ bots: { telegram: { enabled: true, allowedUserIds: [7] } } }),
      secrets: { ASTERISK_TELEGRAM_BOT_TOKEN: 'tok' },
    });
    expect(manager.canPromptApproval()).toBe(true);

    const disabled = createBotManager({
      config: ConfigSchema.parse({}),
      secrets: {},
    });
    expect(disabled.canPromptApproval()).toBe(false);
    // With no transport at all, asking is a refusal rather than a hang.
    await expect(
      disabled.promptApproval('1', { command: 'x', reason: 'y', rules: [], timeoutMs: 10 }),
    ).resolves.toBe('deny');
  });

  it('swallows a failure to stop one adapter so the rest still stop', async () => {
    const manager = createBotManager({
      config: ConfigSchema.parse({ bots: { telegram: { enabled: true, allowedUserIds: [7] } } }),
      secrets: { ASTERISK_TELEGRAM_BOT_TOKEN: 'tok' },
    });
    await manager.start(async () => 'ok');
    const bot = fakeBotInstances.at(-1);
    if (bot) bot.stopError = new Error('long-poll already torn down');

    await expect(manager.stop()).resolves.toBeUndefined();
  });
});

describe('editing failures', () => {
  it('treats "message is not modified" as success', async () => {
    // Two identical renders in a row is normal — the spinner ticked but the
    // content did not change. It must not reach the user as an error.
    //
    // Coverage limit, stated rather than implied: this pins the outcome, not
    // the branch. safeEdit's final `catch` swallows everything anyway, so
    // deleting the `not modified` early return keeps this test green. The
    // branch is not observable from outside the module; the behaviour is.
    const onMessage = await start({ streamMode: 'status' }, async () => 'done');
    const ctx = new FakeCtx();
    ctx.failAlways('editMessageText', telegramError('message is not modified'));

    await expect(onMessage(ctx)).resolves.toBeUndefined();
    expect(ctx.texts('reply').some((t) => t.includes('asterisk error'))).toBe(false);
  });

  it('retries an edit as plain text when the markup is rejected', async () => {
    const onMessage = await start({ streamMode: 'stream' }, async () => '**bold**');
    const ctx = new FakeCtx();
    ctx.failOnce('editMessageText', telegramError("can't parse entities"));

    await onMessage(ctx);

    const edits = ctx.texts('editMessageText');
    expect(edits.at(-1)).toBe('bold');
  });

  it('never lets a failed edit break the turn', async () => {
    const onMessage = await start({ streamMode: 'stream' }, async () => 'done');
    const ctx = new FakeCtx();
    ctx.failAlways('editMessageText', new Error('network down'));

    await expect(onMessage(ctx)).resolves.toBeUndefined();
  });

  it('gives up quietly on a rejection that stripping tags would not fix', async () => {
    // "message to edit not found" is what Telegram says when the user deleted
    // the placeholder mid-turn. Retrying as plain text would fail identically,
    // so the turn should end without a second attempt and without an error.
    const onMessage = await start({ streamMode: 'stream' }, async () => 'done');
    const ctx = new FakeCtx();
    ctx.failAlways('editMessageText', telegramError('message to edit not found'));

    await expect(onMessage(ctx)).resolves.toBeUndefined();
    expect(ctx.texts('editMessageText')).toHaveLength(1);
    expect(ctx.texts('reply').some((t) => t.includes('asterisk error'))).toBe(false);
  });
});
