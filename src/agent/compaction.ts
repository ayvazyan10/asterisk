// History compaction.
//
// Two things were wrong with the previous version and both were silent.
//
// The threshold was a hardcoded 80 000 tokens while the default
// `ollama.contextWindow` is 65 536 — so on a default install the model's window
// overflowed roughly 19% *before* compaction was ever attempted. The threshold
// is now derived from the window the active provider actually reports.
//
// And compaction only ever *shortened* blocks: a history made of many small
// messages could sit above the threshold permanently, with every turn paying to
// rebuild the whole array and nothing getting smaller. When shortening is not
// enough, whole oldest turns are now dropped — in `tool_use`/`tool_result`
// pairs, because splitting a pair produces the 400 that `history.ts` exists to
// prevent.

import type { ContentBlock, Message } from '../types/messages.ts';

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

export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use')
        chars += JSON.stringify(block.input).length + block.name.length;
    }
  }
  // Four characters per token is a rough English-prose average and it
  // under-counts code and CJK. Replacing it with a real tokenizer is a separate
  // change; until then the 0.6 budget above absorbs the error.
  return Math.ceil(chars / 4);
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
function dropOldest(messages: Message[], budget: number): Message[] {
  const floor = Math.max(KEEP_RECENT, 0);
  // The notice prepended below is itself part of the history, so the loop has
  // to fit inside the budget minus its cost. Without this reserve the result
  // came back a few tokens over, which also made compaction non-idempotent:
  // the next turn saw an over-budget history and compacted all over again.
  const reserve = estimateTokens([noticeFor(0)]);
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
        text:
          `[${count} earlier message(s) dropped to fit the context window. ` +
          'Ask the user to restate anything you need from before this point.]',
      },
    ],
  };
}

/**
 * Returns a history that fits the provider's context window.
 *
 * `contextWindow` should be what the active provider reports; omit it and a
 * conservative default is used.
 */
export function compactHistory(messages: Message[], contextWindow?: number): Message[] {
  const budget = compactionThreshold(contextWindow);
  if (estimateTokens(messages) <= budget || messages.length <= KEEP_RECENT) {
    return messages;
  }

  const keep = messages.slice(messages.length - KEEP_RECENT);
  const older = messages.slice(0, messages.length - KEEP_RECENT).map(shortenMessage);
  const shortened = [...older, ...keep];

  // Shortening is cheap and lossy-but-recoverable; dropping is neither, so it
  // only happens when shortening was not enough.
  if (estimateTokens(shortened) <= budget) return shortened;
  return dropOldest(shortened, budget);
}
