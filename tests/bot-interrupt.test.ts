// /stop — the per-chat interrupt.
//
// The registry is deliberately free of the daemon, the bot and the network, so
// most of this is a direct unit test. The last block is the one that needs
// wiring: it rebuilds the daemon's dispatch shape around the real KeyedQueue
// and the real agent loop, because the property under test — that /stop
// reaches a turn already running instead of queueing behind it — only exists
// in the combination. `src/entrypoints/daemon.ts` is a top-level script that
// starts a provider, a bot and a scheduler on import, so it cannot be the
// thing under test; the wiring is mirrored here and the comments in both
// places point at each other.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { parseBotCommand } from '../src/bots/commands.ts';
import {
  _resetInterruptsForTesting,
  _trackedChatCount,
  clearTurn,
  currentEpoch,
  formatStopAck,
  interrupt,
  isStale,
  noteDequeued,
  noteQueued,
  registerTurn,
} from '../src/bots/interrupt.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';
import { KeyedQueue } from '../src/utils/keyed-queue.ts';

afterEach(() => {
  _resetInterruptsForTesting();
});

describe('interrupt registry', () => {
  it('aborts the turn running for that chat', () => {
    const ctrl = new AbortController();
    noteQueued('chat');
    noteDequeued('chat');
    registerTurn('chat', ctrl);

    const result = interrupt('chat');

    expect(result).toEqual({ aborted: true, dropped: 0 });
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('reports that nothing was running when nothing is', () => {
    expect(interrupt('quiet-chat')).toEqual({ aborted: false, dropped: 0 });
  });

  it('does not abort a second time once the turn is gone', () => {
    const ctrl = new AbortController();
    registerTurn('chat', ctrl);
    expect(interrupt('chat').aborted).toBe(true);
    expect(interrupt('chat').aborted).toBe(false);
  });

  it('touches only the chat it was given', () => {
    const mine = new AbortController();
    const theirs = new AbortController();
    registerTurn('mine', mine);
    registerTurn('theirs', theirs);

    interrupt('mine');

    expect(mine.signal.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
  });

  it('will not let a stale finally clear a newer turn', () => {
    // The exact sequence /stop produces: turn A is aborted, turn B starts
    // while A is still unwinding, and A's `finally` fires afterwards. Without
    // the identity guard it clears B's controller and the next /stop finds
    // nothing to abort.
    const first = new AbortController();
    registerTurn('chat', first);
    interrupt('chat');

    const second = new AbortController();
    registerTurn('chat', second);
    clearTurn('chat', first);

    expect(interrupt('chat').aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it('clears the turn it was actually given', () => {
    const ctrl = new AbortController();
    registerTurn('chat', ctrl);
    clearTurn('chat', ctrl);

    expect(interrupt('chat').aborted).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('counts the messages queued behind the running turn as dropped', () => {
    const ctrl = new AbortController();
    noteQueued('chat'); // the turn that is running
    noteDequeued('chat');
    registerTurn('chat', ctrl);
    noteQueued('chat'); // two more waiting
    noteQueued('chat');

    expect(interrupt('chat')).toEqual({ aborted: true, dropped: 2 });
  });

  it('reports dropped messages even when no turn was running', () => {
    noteQueued('chat');
    expect(interrupt('chat')).toEqual({ aborted: false, dropped: 1 });
  });

  it('marks a message enqueued before the interrupt as stale', () => {
    const before = currentEpoch('chat');
    noteQueued('chat');

    interrupt('chat');

    expect(isStale('chat', before)).toBe(true);
  });

  it('leaves a message enqueued after the interrupt alone', () => {
    noteQueued('chat');
    interrupt('chat');

    const after = currentEpoch('chat');
    noteQueued('chat');

    expect(isStale('chat', after)).toBe(false);
  });

  it('does not make an untouched chat look stale', () => {
    const epoch = currentEpoch('chat');
    noteQueued('chat');
    expect(isStale('chat', epoch)).toBe(false);
  });

  it('forgets a chat once its turn and its queue are done', () => {
    const ctrl = new AbortController();
    noteQueued('chat');
    noteDequeued('chat');
    registerTurn('chat', ctrl);
    noteQueued('chat');
    expect(_trackedChatCount()).toBe(1);

    interrupt('chat');
    // Still tracked: one message is queued and has yet to look at the epoch.
    expect(_trackedChatCount()).toBe(1);

    // Reading staleness before the dequeue is what the daemon does, and why:
    // the dequeue that empties the chat drops the entry, epoch included.
    const stale = isStale('chat', 0);
    noteDequeued('chat');
    expect(stale).toBe(true);
    expect(_trackedChatCount()).toBe(0);
  });

  it('does not accumulate chats over many completed turns', () => {
    for (let i = 0; i < 50; i++) {
      const ctrl = new AbortController();
      noteQueued(`chat-${i}`);
      noteDequeued(`chat-${i}`);
      registerTurn(`chat-${i}`, ctrl);
      clearTurn(`chat-${i}`, ctrl);
    }
    expect(_trackedChatCount()).toBe(0);
  });

  it('ignores a dequeue for a chat it never saw', () => {
    noteDequeued('never-seen');
    expect(_trackedChatCount()).toBe(0);
  });
});

describe('/stop acknowledgement', () => {
  it('says what it stopped', () => {
    expect(formatStopAck({ aborted: true, dropped: 0, cancelledApprovals: 0 })).toBe(
      '⏹ stopped the running turn.',
    );
  });

  it('counts what it dropped, singular and plural', () => {
    expect(formatStopAck({ aborted: true, dropped: 1, cancelledApprovals: 0 })).toBe(
      '⏹ stopped the running turn · dropped 1 queued message.',
    );
    expect(formatStopAck({ aborted: true, dropped: 3, cancelledApprovals: 0 })).toBe(
      '⏹ stopped the running turn · dropped 3 queued messages.',
    );
  });

  it('reports withdrawn permission prompts', () => {
    expect(formatStopAck({ aborted: true, dropped: 0, cancelledApprovals: 2 })).toBe(
      '⏹ stopped the running turn · cancelled 2 pending permission prompts.',
    );
  });

  it('does not claim to have stopped a turn that was not running', () => {
    const ack = formatStopAck({ aborted: false, dropped: 2, cancelledApprovals: 0 });
    expect(ack).toBe('⏹ nothing was running · dropped 2 queued messages.');
    expect(ack).not.toContain('stopped the running turn');
  });

  it('has a distinct answer for a chat with nothing to stop', () => {
    expect(formatStopAck({ aborted: false, dropped: 0, cancelledApprovals: 0 })).toBe(
      '⏹ nothing to stop — no turn is running for this chat.',
    );
  });
});

describe('/stop recognition', () => {
  const isStop = (text: string): boolean => parseBotCommand(text)?.cmd === 'stop';

  it('matches the forms Telegram actually delivers', () => {
    expect(isStop('/stop')).toBe(true);
    expect(isStop('/stop@somebot')).toBe(true);
    expect(isStop('/STOP')).toBe(true);
    expect(isStop('  /stop  ')).toBe(true);
    expect(isStop('/stop now please')).toBe(true);
  });

  it('does not match a command that merely starts with "stop"', () => {
    expect(isStop('/stopwatch')).toBe(false);
    expect(isStop('/stop-all')).toBe(false);
    expect(isStop('stop')).toBe(false);
    expect(isStop('please stop')).toBe(false);
  });
});

/** A provider that never answers on its own — it settles only when the turn's
 *  signal fires, the way a real HTTP client rejects a cancelled request. It
 *  also counts what it was asked, so a test can prove it was never asked. */
function countingHangingProvider(): Provider & { requests: number } {
  return {
    name: 'fake-hang',
    requests: 0,
    send(request): Promise<ProviderResponse> {
      this.requests += 1;
      return new Promise<ProviderResponse>((_resolve, reject) => {
        const fail = (): void => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (request.signal?.aborted) {
          fail();
          return;
        }
        request.signal?.addEventListener('abort', fail, { once: true });
      });
    },
  };
}

interface DispatcherOptions {
  /**
   * Stands in for everything the daemon does between starting a job and
   * calling runAgentTurn — chiefly intakeVoice, which on a local Whisper
   * model can run for tens of seconds.
   */
  beforeTurn?: () => Promise<void>;
  /** Stands in for tryHandleBotCommand answering and returning early. */
  earlyReply?: string;
}

/**
 * The daemon's dispatch, reduced to the parts /stop interacts with: the
 * per-chat KeyedQueue, the interrupt registry, and a real agent turn carrying
 * the controller's signal. Mirrors src/entrypoints/daemon.ts, including where
 * the controller is registered — before the turn's own work, not just before
 * the model call.
 */
function createDispatcher(options: DispatcherOptions = {}) {
  const queue = new KeyedQueue();
  const started: string[] = [];
  const reasons: string[] = [];
  const provider = countingHangingProvider();

  const dispatch = (chatId: string, text: string): Promise<string> => {
    // Answered outside the queue — the whole point.
    if (parseBotCommand(text)?.cmd === 'stop') {
      return Promise.resolve(formatStopAck({ ...interrupt(chatId), cancelledApprovals: 0 }));
    }

    const epochAtEnqueue = currentEpoch(chatId);
    noteQueued(chatId);

    return queue.run(chatId, async () => {
      const stale = isStale(chatId, epochAtEnqueue);
      noteDequeued(chatId);
      if (stale) return '';

      const ctrl = new AbortController();
      registerTurn(chatId, ctrl);
      try {
        started.push(text);
        if (options.beforeTurn) await options.beforeTurn();
        if (options.earlyReply !== undefined) return options.earlyReply;

        const turn = await runAgentTurn(provider, createAgentState(), text, {
          signal: ctrl.signal,
          session: { id: `bot:${chatId}`, scope: 'unknown' },
          summariseDropped: false,
        });
        reasons.push(turn.reason);
        return turn.finalText;
      } finally {
        clearTurn(chatId, ctrl);
      }
    });
  };

  return { dispatch, started, reasons, provider };
}

/** A promise the test releases by hand — no timing, no flake. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('a /stop sent while a turn is running', () => {
  it('aborts that turn instead of queueing behind it', async () => {
    const d = createDispatcher();

    const running = d.dispatch('chat', 'do the slow thing');
    const queued = d.dispatch('chat', 'and then this');
    await vi.waitFor(() => expect(d.started).toEqual(['do the slow thing']));

    // If /stop went through the queue this would never resolve: the provider
    // above only settles when the turn it is meant to kill is aborted.
    const ack = await d.dispatch('chat', '/stop');

    expect(ack).toBe('⏹ stopped the running turn · dropped 1 queued message.');
    await expect(running).resolves.toBe('');
    expect(d.reasons).toEqual(['aborted']);

    // The queued message is dropped rather than run the moment the chat frees
    // up — otherwise /stop would just be a pause.
    await expect(queued).resolves.toBe('');
    expect(d.started).toEqual(['do the slow thing']);
    expect(_trackedChatCount()).toBe(0);
  });

  it('leaves another chat’s turn running', async () => {
    const d = createDispatcher();

    const mine = d.dispatch('mine', 'my slow thing');
    const theirs = d.dispatch('theirs', 'their slow thing');
    await vi.waitFor(() => expect(d.started).toHaveLength(2));

    await d.dispatch('mine', '/stop');
    await expect(mine).resolves.toBe('');

    let settled = false;
    void theirs.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    // Tidy up: leaving a hung turn behind would hold the suite open.
    await d.dispatch('theirs', '/stop');
    await theirs;
  });

  it('aborts a turn interrupted before the provider is ever reached', async () => {
    // The window the daemon holds open while it transcribes a voice message.
    // /stop landing in it used to answer "nothing to stop" and then let the
    // turn run to completion anyway — the case a user is most likely to hit,
    // since a long voice note is exactly what they change their mind about.
    const window = gate();
    const d = createDispatcher({ beforeTurn: () => window.promise });

    const running = d.dispatch('chat', 'a long voice note');
    await vi.waitFor(() => expect(d.started).toEqual(['a long voice note']));

    const ack = await d.dispatch('chat', '/stop');
    expect(ack).toBe('⏹ stopped the running turn.');

    // The pre-turn work finishes, as it must — nothing cancels a transcription
    // half way. What matters is what happens next.
    window.open();
    await expect(running).resolves.toBe('');
    expect(d.reasons).toEqual(['aborted']);
    // The loop checks its signal at the top of the first iteration, before
    // compaction and before the request. Nothing was ever sent.
    expect(d.provider.requests).toBe(0);
    expect(_trackedChatCount()).toBe(0);
  });

  it('releases the chat when the message turns out to be a bot command', async () => {
    // The bot-command branch returns before runAgentTurn exists, and it sits
    // inside the same window. A controller stranded there would make the next
    // /stop abort a turn that had already finished.
    const d = createDispatcher({ earlyReply: '✓ conversation cleared.' });

    await expect(d.dispatch('chat', '/clear')).resolves.toBe('✓ conversation cleared.');

    expect(_trackedChatCount()).toBe(0);
    expect(interrupt('chat')).toEqual({ aborted: false, dropped: 0 });
    expect(d.provider.requests).toBe(0);
  });

  it('answers a /stop from a chat with nothing running', async () => {
    const d = createDispatcher();
    await expect(d.dispatch('idle', '/stop')).resolves.toBe(
      '⏹ nothing to stop — no turn is running for this chat.',
    );
    expect(d.started).toEqual([]);
  });
});
