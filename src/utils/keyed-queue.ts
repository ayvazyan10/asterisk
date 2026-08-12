// Serial execution, keyed.
//
// Work submitted under the same key runs strictly one at a time, in submission
// order; different keys run concurrently.
//
// The daemon needs this because grammy dispatches Telegram updates
// concurrently. Two messages arriving in one chat within a second both called
// runAgentTurn against the *same* mutable AgentState, so their pushes
// interleaved: one turn's tool_use blocks landed between another turn's
// tool_use and its tool_result. That is the same unanswered-tool_use shape that
// permanently breaks a conversation, arrived at from a different direction.

export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `fn` after everything already queued under `key` has settled. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);

    // The tail swallows rejections: one failed turn must not poison the queue
    // for every later message in that chat. The caller still sees the original
    // rejection through `result`.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    void tail.then(() => {
      // Drop the entry once the queue for this key has drained, so a daemon
      // talking to thousands of chats does not accumulate resolved promises.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return result;
  }

  /** True if work is queued or running under `key`. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  /** Number of keys with outstanding work. */
  get size(): number {
    return this.tails.size;
  }
}
