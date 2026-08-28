// Per-chat interrupt registry — what /stop needs in order to reach a turn that
// is already running.
//
// The daemon serialises turns per chat through a KeyedQueue
// (src/utils/keyed-queue.ts): work submitted under one chat id runs strictly
// one at a time, in submission order. That is exactly why /stop cannot be an
// ordinary bot command. `tryHandleBotCommand` runs *inside* the queued job, so
// a /stop routed the ordinary way would queue behind the very turn it was sent
// to kill and could not run until that turn had finished by itself — the one
// outcome the user was asking not to wait for.
//
// So the daemon intercepts /stop *before* `turnQueue.run` is called, and this
// module holds the state that makes the interception mean something:
//
//   * the AbortController of the turn currently running for that chat, so it
//     can be aborted from outside the queue;
//   * a per-chat epoch, bumped by every interrupt. A message reads the epoch
//     when it is enqueued and compares it when its job finally starts; if the
//     epoch moved in between, an interrupt happened while it waited and the
//     job skips itself. This is deliberately not a cancel/drain method on
//     KeyedQueue: that class promises "runs in submission order" and nothing
//     else, and letting one caller discard queued work from inside it would
//     make the promise conditional for every other caller;
//   * how many messages are queued but not yet started, so /stop can report
//     what it actually invalidated instead of guessing.
//
// Scope is one chat. There is no global stop and no admin tier: a chat may
// interrupt its own turn and nobody else's.
//
// Nothing here touches a bot, a socket or the daemon — it is a Map and three
// counters, so the whole mechanism is unit-testable on its own.

/** What an interrupt actually did. */
export interface InterruptResult {
  /** True when a turn was running and has now been aborted. */
  aborted: boolean;
  /** Messages that were queued, never started, and are now invalidated. */
  dropped: number;
}

interface ChatInterruptState {
  /** The turn running right now, if any. */
  controller: AbortController | null;
  /** Submitted to the queue but not yet started. */
  queued: number;
  /** Bumped by every interrupt; queued work compares against it. */
  epoch: number;
}

const chats = new Map<string, ChatInterruptState>();

function ensure(chatId: string): ChatInterruptState {
  const existing = chats.get(chatId);
  if (existing) return existing;
  const fresh: ChatInterruptState = { controller: null, queued: 0, epoch: 0 };
  chats.set(chatId, fresh);
  return fresh;
}

/**
 * Drops a chat with nothing left to track, so a daemon serving thousands of
 * chats does not keep an entry per chat for its whole lifetime.
 *
 * Losing the epoch with the entry is safe, and only because `noteQueued` runs
 * *before* the message enters the queue: an entry can be idle only when no
 * message is still holding an epoch read from it.
 */
function dropIfIdle(chatId: string, state: ChatInterruptState): void {
  if (state.controller === null && state.queued === 0) chats.delete(chatId);
}

/** A turn has started for this chat. */
export function registerTurn(chatId: string, controller: AbortController): void {
  ensure(chatId).controller = controller;
}

/**
 * A turn has finished. Identity-guarded on purpose: a late `finally` from a
 * turn that was already aborted must not clear the controller of the turn that
 * started after it, or the next /stop would find nothing to abort.
 */
export function clearTurn(chatId: string, controller: AbortController): void {
  const state = chats.get(chatId);
  if (!state || state.controller !== controller) return;
  state.controller = null;
  dropIfIdle(chatId, state);
}

/** A message has been submitted to the queue. */
export function noteQueued(chatId: string): void {
  ensure(chatId).queued += 1;
}

/**
 * A queued message's job has started.
 *
 * Call `isStale` *before* this: the dequeue that empties a chat drops the
 * entry, and the epoch goes with it.
 */
export function noteDequeued(chatId: string): void {
  const state = chats.get(chatId);
  if (!state) return;
  if (state.queued > 0) state.queued -= 1;
  dropIfIdle(chatId, state);
}

/** The chat's current interrupt epoch. Read it when a message is enqueued. */
export function currentEpoch(chatId: string): number {
  return chats.get(chatId)?.epoch ?? 0;
}

/** True when an interrupt happened after this message was enqueued. */
export function isStale(chatId: string, epochAtEnqueue: number): boolean {
  return currentEpoch(chatId) > epochAtEnqueue;
}

/**
 * Aborts the turn running for this chat and invalidates everything queued
 * behind it. Never throws — a /stop that fails is a /stop that did not happen.
 */
export function interrupt(chatId: string): InterruptResult {
  const state = chats.get(chatId);
  if (!state) return { aborted: false, dropped: 0 };

  const controller = state.controller;
  const dropped = state.queued;
  // Cleared before abort() so a listener that unwinds the turn synchronously
  // finds nothing of its own left to clear.
  state.controller = null;
  state.epoch += 1;
  controller?.abort();
  dropIfIdle(chatId, state);
  return { aborted: controller !== null, dropped };
}

/** An interrupt plus what the transport cleaned up alongside it. */
export interface StopOutcome extends InterruptResult {
  /** Permission prompts that were still waiting for a button press. */
  cancelledApprovals: number;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The acknowledgement /stop sends back. It reports what happened rather than a
 * fixed string: "stopped" when nothing was running reads as a lie the next
 * time the user wonders why their turn kept going.
 */
export function formatStopAck(outcome: StopOutcome): string {
  const extras: string[] = [];
  if (outcome.dropped > 0) extras.push(`dropped ${count(outcome.dropped, 'queued message')}`);
  if (outcome.cancelledApprovals > 0) {
    extras.push(`cancelled ${count(outcome.cancelledApprovals, 'pending permission prompt')}`);
  }
  if (!outcome.aborted && extras.length === 0) {
    return '⏹ nothing to stop — no turn is running for this chat.';
  }
  const head = outcome.aborted ? '⏹ stopped the running turn' : '⏹ nothing was running';
  return extras.length > 0 ? `${head} · ${extras.join(' · ')}.` : `${head}.`;
}

/** Test-only: forget every chat, so one test cannot leak state into the next. */
export function _resetInterruptsForTesting(): void {
  chats.clear();
}

/** Test-only: how many chats are being tracked, for the no-leak assertion. */
export function _trackedChatCount(): number {
  return chats.size;
}
