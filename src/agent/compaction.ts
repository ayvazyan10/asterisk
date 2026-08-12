// History compaction.
//
// Two things were wrong with the previous version and both were silent.
//
// The threshold was a hardcoded 80 000 tokens while the default
// `ollama.contextWindow` is 65 536 — so on a default install the model's window
// overflowed roughly 19% *before* compaction was ever attempted. The threshold
// is now derived from the window the active provider actually reports.
//
// The estimate itself was `chars / 4`, which under-counts CJK by roughly 4x
// and punctuation-dense code by 2–3x — see tokens.ts. Under-counting is the
// direction that hurts: it reports a history as fitting when it does not.
//
// And compaction only ever *shortened* blocks: a history made of many small
// messages could sit above the threshold permanently, with every turn paying to
// rebuild the whole array and nothing getting smaller. When shortening is not
// enough, whole oldest turns are now dropped — in `tool_use`/`tool_result`
// pairs, because splitting a pair produces the 400 that `history.ts` exists to
// prevent.

import type { ContentBlock, Message } from '../types/messages.ts';
import { estimateImageTokens, estimateTextTokens, messageOverhead } from './tokens.ts';

/** Used when the provider does not report a window. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Fraction of the context window that history may occupy.
 *
 * The remainder is the system prompt, the tool schemas — which can run to tens
 * of thousands of tokens on their own — and room for the model's reply.
 */
const HISTORY_BUDGET = 0.6;

/** Messages at the end of the history that are never touched. */
const KEEP_RECENT = 6;

const TOOL_RESULT_MAX = 200;
const TEXT_MAX = 500;

/**
 * Room left for a summary that has not been written yet.
 *
 * The drop point is chosen before the summariser runs, so its output has to be
 * budgeted for in advance. Sized to match the summariser's own token ceiling
 * in summarise.ts — under-reserving would put the compacted history back over
 * budget and make compaction fire again on the very next turn.
 */
const SUMMARY_TOKEN_RESERVE = 700;

/**
 * Per-message cost, memoised on the message object.
 *
 * `dropOldest` re-estimates the remaining history on every iteration, which is
 * quadratic in message count. That was free when the estimate was
 * `text.length / 4`; a character-class model is not, and without this cache a
 * 60-message history took over a minute to compact. Messages are treated as
 * immutable everywhere in the loop — compaction builds new objects rather than
 * editing them — so identity is a sound cache key.
 */
const messageCost = new WeakMap<object, number>();

function messageTokens(msg: Message): number {
  const cached = messageCost.get(msg);
  if (cached !== undefined) return cached;

  let total = messageOverhead();
  for (const block of msg.content) {
    if (block.type === 'text') total += estimateTextTokens(block.text);
    else if (block.type === 'image') total += estimateImageTokens(block.data.length);
    else if (block.type === 'tool_result') total += estimateTextTokens(block.content);
    else if (block.type === 'tool_use') {
      total += estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input));
    }
  }

  messageCost.set(msg, total);
  return total;
}

export function estimateTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) total += messageTokens(msg);
  return Math.ceil(total);
}

/** Token budget history may occupy for a given context window. */
export function compactionThreshold(contextWindow = DEFAULT_CONTEXT_WINDOW): number {
  return Math.floor(contextWindow * HISTORY_BUDGET);
}

/** Shortens oversized blocks in place-free fashion, returning a new message. */
function shortenMessage(msg: Message): Message {
  const content: ContentBlock[] = msg.content.map((block) => {
    if (block.type === 'tool_result' && block.content.length > TOOL_RESULT_MAX) {
      const firstLine = block.content.split('\n')[0] ?? '';
      return {
        ...block,
        content: `[compacted] ${firstLine.slice(0, 150)}… (${block.content.length} chars original)`,
      };
    }
    if (block.type === 'text' && block.text.length > TEXT_MAX) {
      return {
        ...block,
        text: `${block.text.slice(0, 400)}… [compacted from ${block.text.length} chars]`,
      };
    }
    return block;
  });
  return { ...msg, content };
}

/** True if `msg` holds a tool_use whose result lives in a later message. */
function opensToolCall(msg: Message): boolean {
  return msg.content.some((b) => b.type === 'tool_use');
}

/** True if `msg` is the user message answering a preceding tool_use. */
function answersToolCall(msg: Message): boolean {
  return msg.content.some((b) => b.type === 'tool_result');
}

/**
 * Drops the oldest messages until the estimate fits `budget`, never separating
 * a `tool_use` from the `tool_result` that answers it and never touching the
 * most recent `KEEP_RECENT`.
 */
function findDropPoint(messages: Message[], budget: number, reserve: number): number {
  const floor = Math.max(KEEP_RECENT, 0);
  // The notice prepended in place of the dropped span is itself part of the
  // history, so the loop has to fit inside the budget minus its cost. Without
  // this reserve the result came back a few tokens over, which also made
  // compaction non-idempotent: the next turn saw an over-budget history and
  // compacted all over again.
  const target = Math.max(0, budget - reserve);
  let start = 0;

  while (start < messages.length - floor && estimateTokens(messages.slice(start)) > target) {
    const current = messages[start];
    // An assistant turn that called tools is dropped together with the user
    // message carrying the results, so the pair never splits.
    if (current && opensToolCall(current)) {
      const next = messages[start + 1];
      start += next && answersToolCall(next) ? 2 : 1;
      continue;
    }
    start += 1;
  }

  return start;
}

function dropOldest(messages: Message[], budget: number): Message[] {
  const start = findDropPoint(messages, budget, estimateTokens([noticeFor(0)]));
  if (start === 0) return messages;
  return [noticeFor(start), ...messages.slice(start)];
}

/**
 * The marker left in place of dropped messages.
 *
 * Said out loud rather than dropped silently: without it the model reads the
 * truncated history as the whole conversation and confidently contradicts
 * things the user actually said.
 */
function noticeFor(count: number): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[${count} earlier message(s) dropped to fit the context window. Ask the user to restate anything you need from before this point.]`,
      },
    ],
  };
}

/**
 * The same marker, carrying a summary of what was dropped.
 *
 * Labelled as a summary rather than presented as conversation, so the model
 * does not quote it back as something the user said.
 */
function summaryNoticeFor(count: number, summary: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          `[${count} earlier message(s) were dropped to fit the context window.`,
          'This is a summary of them, not a verbatim record — treat it as notes,',
          'and ask the user rather than guessing at anything it does not cover.]',
          '',
          summary,
        ].join('\n'),
      },
    ],
  };
}

/** Room reserved for the notice, whichever kind ends up being used. */
function noticeReserve(): number {
  return estimateTokens([summaryNoticeFor(0, '')]) + SUMMARY_TOKEN_RESERVE;
}

/**
 * Returns a history that fits the provider's context window.
 *
 * `contextWindow` should be what the active provider reports; omit it and a
 * conservative default is used.
 */
export function compactHistory(messages: Message[], contextWindow?: number): Message[] {
  const staged = shortenForBudget(messages, contextWindow);
  if (staged.done) return staged.messages;
  return dropOldest(staged.messages, staged.budget);
}

/**
 * `compactHistory`, but the dropped span is replaced by a model-written
 * summary instead of a bare count.
 *
 * `summarise` is called only when messages are actually being dropped, and
 * only with the span about to go. Returning null — which
 * `summariseMessages` does for every failure — falls back to the plain notice,
 * so an unreachable model costs context, never the turn.
 */
export async function compactHistoryWithSummary(
  messages: Message[],
  contextWindow: number | undefined,
  summarise: (dropped: Message[]) => Promise<string | null>,
): Promise<Message[]> {
  const staged = shortenForBudget(messages, contextWindow);
  if (staged.done) return staged.messages;

  const shortened = staged.messages;
  const start = findDropPoint(shortened, staged.budget, noticeReserve());
  if (start === 0) return shortened;

  const summary = await summarise(shortened.slice(0, start));
  const notice = summary ? summaryNoticeFor(start, summary) : noticeFor(start);
  return [notice, ...shortened.slice(start)];
}

/**
 * The half of compaction both entry points share: shorten oversized blocks and
 * report whether that was enough.
 */
function shortenForBudget(
  messages: Message[],
  contextWindow?: number,
): { done: boolean; messages: Message[]; budget: number } {
  const budget = compactionThreshold(contextWindow);
  if (estimateTokens(messages) <= budget || messages.length <= KEEP_RECENT) {
    return { done: true, messages, budget };
  }

  const keep = messages.slice(messages.length - KEEP_RECENT);
  const older = messages.slice(0, messages.length - KEEP_RECENT).map(shortenMessage);
  const shortened = [...older, ...keep];

  // Shortening is cheap and lossy-but-recoverable; dropping is neither, so it
  // only happens when shortening was not enough.
  return { done: estimateTokens(shortened) <= budget, messages: shortened, budget };
}
