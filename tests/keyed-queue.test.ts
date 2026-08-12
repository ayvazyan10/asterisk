// KeyedQueue serialises the daemon's per-chat turns.
//
// grammy dispatches Telegram updates concurrently, so two messages arriving in
// one chat within a second ran runAgentTurn against the same mutable
// AgentState and interleaved their history pushes.

import { describe, expect, it } from 'vitest';

import { KeyedQueue } from '../src/utils/keyed-queue.ts';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('KeyedQueue', () => {
  it('runs same-key work strictly one at a time', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];

    const job = (name: string, ms: number) => async (): Promise<void> => {
      events.push(`${name}:start`);
      await tick(ms);
      events.push(`${name}:end`);
    };

    // The slow job is submitted first; the fast one must still wait.
    await Promise.all([queue.run('chat', job('a', 30)), queue.run('chat', job('b', 1))]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('preserves submission order across many jobs', async () => {
    const queue = new KeyedQueue();
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        queue.run('chat', async () => {
          await tick(10 - i);
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('runs different keys concurrently', async () => {
    const queue = new KeyedQueue();
    const started: string[] = [];

    const gate = async (name: string): Promise<void> => {
      started.push(name);
      await tick(30);
    };

    const all = Promise.all([queue.run('a', () => gate('a')), queue.run('b', () => gate('b'))]);
    // Both should be in flight immediately, not one after the other.
    await tick(5);
    expect(started).toEqual(['a', 'b']);
    await all;
  });

  it('keeps serving a key after one job rejects', async () => {
    const queue = new KeyedQueue();

    const failed = queue.run('chat', async () => {
      throw new Error('turn blew up');
    });
    await expect(failed).rejects.toThrow('turn blew up');

    // A poisoned chain would leave this pending forever.
    await expect(queue.run('chat', async () => 'still works')).resolves.toBe('still works');
  });

  it('surfaces the original rejection to the caller', async () => {
    const queue = new KeyedQueue();
    const err = new Error('specific failure');
    await expect(queue.run('chat', () => Promise.reject(err))).rejects.toBe(err);
  });

  it('returns the job result', async () => {
    const queue = new KeyedQueue();
    await expect(queue.run('chat', async () => 42)).resolves.toBe(42);
  });

  it('reports busy while work is outstanding and drains afterwards', async () => {
    const queue = new KeyedQueue();
    const running = queue.run('chat', () => tick(20));

    expect(queue.isBusy('chat')).toBe(true);
    expect(queue.isBusy('other')).toBe(false);

    await running;
    // Give the drain callback a turn of the microtask queue.
    await tick(1);
    expect(queue.isBusy('chat')).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('does not accumulate keys over many completed jobs', async () => {
    const queue = new KeyedQueue();
    for (let i = 0; i < 50; i++) {
      await queue.run(`chat-${i}`, async () => i);
    }
    await tick(1);
    expect(queue.size).toBe(0);
  });
});
