// Compaction replaces dropped messages with a model-written summary.
//
// The property that matters most is the fallback: a summariser that fails —
// unreachable model, timeout, aborted turn, empty reply — must cost context
// and nothing else. Dropping already worked without it, and a turn must not
// fail because a summary could not be produced.

import { describe, expect, it, vi } from 'vitest';

import { compactHistory, compactHistoryWithSummary } from '../src/agent/compaction.ts';
import { summariseMessages } from '../src/agent/summarise.ts';
import type { Message, Provider, ProviderRequest } from '../src/types/messages.ts';

/** A history long enough that shortening alone cannot save it. */
function longHistory(count: number, chars: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: [{ type: 'text' as const, text: `msg ${i} ${'x'.repeat(chars)}` }],
  }));
}

const WINDOW = 16_384;

function textOf(msg: Message | undefined): string {
  return (msg?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

describe('compactHistoryWithSummary', () => {
  it('embeds the summary in place of the dropped messages', async () => {
    const history = longHistory(400, 2000);
    const summarise = vi.fn().mockResolvedValue('User wanted X. Y was rejected because Z.');

    const out = await compactHistoryWithSummary(history, WINDOW, summarise);

    expect(summarise).toHaveBeenCalledTimes(1);
    const notice = textOf(out[0]);
    expect(notice).toContain('dropped to fit the context window');
    expect(notice).toContain('Y was rejected because Z');
    // Labelled as notes so the model does not quote it back as user speech.
    expect(notice).toContain('not a verbatim record');
  });

  it('passes only the messages actually being dropped', async () => {
    const history = longHistory(400, 2000);
    let received: Message[] = [];
    await compactHistoryWithSummary(history, WINDOW, async (dropped) => {
      received = dropped;
      return 'summary';
    });

    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(history.length);
    // The tail is kept verbatim, so it must not also be summarised.
    expect(textOf(received.at(-1))).not.toBe(textOf(history.at(-1)));
  });

  it('falls back to the plain notice when the summariser returns null', async () => {
    const history = longHistory(400, 2000);
    const out = await compactHistoryWithSummary(history, WINDOW, async () => null);

    const notice = textOf(out[0]);
    expect(notice).toContain('dropped to fit the context window');
    expect(notice).toContain('Ask the user to restate');
    expect(notice).not.toContain('not a verbatim record');
  });

  it('never calls the summariser when nothing is dropped', async () => {
    const summarise = vi.fn().mockResolvedValue('unused');
    const small: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

    const out = await compactHistoryWithSummary(small, WINDOW, summarise);

    expect(summarise).not.toHaveBeenCalled();
    expect(out).toBe(small);
  });

  it('stays inside the budget even with a summary attached', async () => {
    const history = longHistory(400, 2000);
    const fat = 'word '.repeat(500);

    const out = await compactHistoryWithSummary(history, WINDOW, async () => fat);

    const { estimateTokens, compactionThreshold } = await import('../src/agent/compaction.ts');
    expect(estimateTokens(out)).toBeLessThanOrEqual(compactionThreshold(WINDOW));
  });

  it('drops slightly more than the synchronous path, to leave room for the summary', async () => {
    // The drop point is chosen before the summary exists, so its tokens have
    // to be reserved in advance. Reserving too little would put the compacted
    // history back over budget and fire compaction again next turn.
    const history = longHistory(400, 2000);
    const withSummary = await compactHistoryWithSummary(history, WINDOW, async () => null);
    const plain = compactHistory(history, WINDOW);

    expect(withSummary.length).toBeLessThanOrEqual(plain.length);
    // …but not wildly more: this is a reserve, not a second compaction pass.
    expect(withSummary.length).toBeGreaterThan(plain.length * 0.5);
  });
});

describe('summariseMessages', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'add retry to the http client' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done, with jitter' }] },
  ];

  function provider(impl: (req: ProviderRequest) => Promise<unknown>): Provider {
    return { name: 'fake', send: impl as Provider['send'] };
  }

  it('returns the model text', async () => {
    const p = provider(async () => ({
      content: [{ type: 'text', text: 'Added retry with jitter.' }],
      stopReason: 'end_turn',
    }));
    expect(await summariseMessages(history, p)).toBe('Added retry with jitter.');
  });

  it('offers no tools, so the model compresses instead of working', async () => {
    let seen: ProviderRequest | undefined;
    const p = provider(async (req) => {
      seen = req;
      return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' };
    });
    await summariseMessages(history, p);
    expect(seen?.tools).toEqual([]);
    expect(seen?.maxTokens).toBeGreaterThan(0);
  });

  it('returns null when the provider throws', async () => {
    const p = provider(async () => {
      throw new Error('connection refused');
    });
    expect(await summariseMessages(history, p)).toBeNull();
  });

  it('returns null when the model replies with nothing usable', async () => {
    const p = provider(async () => ({ content: [], stopReason: 'end_turn' }));
    expect(await summariseMessages(history, p)).toBeNull();
  });

  it('returns null without calling the provider on an aborted turn', async () => {
    const send = vi.fn();
    const p = provider(send as never);
    expect(await summariseMessages(history, p, AbortSignal.abort())).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns null for an empty span', async () => {
    const send = vi.fn();
    expect(await summariseMessages([], provider(send as never))).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('caps how much transcript it sends', async () => {
    let seen: ProviderRequest | undefined;
    const p = provider(async (req) => {
      seen = req;
      return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' };
    });
    await summariseMessages(longHistory(200, 5000), p);
    const sent = textOf(seen?.messages[0]);
    // Otherwise the call made to survive an overflowing history would itself
    // overflow.
    expect(sent.length).toBeLessThan(30_000);
  });
});
