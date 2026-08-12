// Conversation history invariants.
//
// Every provider that supports tool use requires the same pairing: each
// `tool_use` block in an assistant message must be answered by a `tool_result`
// block carrying the same id, in the message immediately after. Anthropic
// rejects a violation with 400 "tool_use ids were found without tool_result
// blocks immediately after", which `classifyHttpError` maps to `bad-request` —
// a kind that is deliberately *not* retryable, because retrying a malformed
// request just burns quota.
//
// That combination is what made this worth its own module. The loop persists
// history after every turn, so a single violation is not a failed turn: it is a
// conversation that fails on every subsequent message, is written to disk in
// that state, and is faithfully restored by `/resume`.
//
// The loop used to produce exactly that. Aborting (ESC) part-way through a
// batch of tool calls broke out of the turn *before* pushing the accumulated
// tool results, stranding the assistant's `tool_use` blocks unanswered.

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '../types/messages.ts';

/** The default explanation given to the model for a result it never got. */
export const ABORTED_RESULT = 'Tool call cancelled: the user interrupted the turn before it ran.';

function toolUsesIn(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

function answeredIds(content: readonly ContentBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of content) {
    if (block.type === 'tool_result') ids.add(block.tool_use_id);
  }
  return ids;
}

function cancelledResult(use: ToolUseBlock, reason: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: reason,
    is_error: true,
  };
}

/**
 * Returns `results` extended with an error `tool_result` for every `tool_use`
 * in `assistantContent` that nothing in `results` answers.
 *
 * Order matters to some providers, so the synthesised results are appended in
 * the order the tool calls were requested rather than grouped at the end.
 */
export function completeToolResults(
  assistantContent: readonly ContentBlock[],
  results: readonly ContentBlock[],
  reason: string = ABORTED_RESULT,
): ContentBlock[] {
  const answered = answeredIds(results);
  const missing = toolUsesIn(assistantContent).filter((use) => !answered.has(use.id));
  if (missing.length === 0) return [...results];
  return [...results, ...missing.map((use) => cancelledResult(use, reason))];
}

/** True if every `tool_use` in `history` is answered by the message after it. */
export function isPaired(history: readonly Message[]): boolean {
  return findUnpaired(history).length === 0;
}

/**
 * Returns the ids of `tool_use` blocks that no following message answers.
 * Exposed for tests and for the loop's defensive assertion.
 */
export function findUnpaired(history: readonly Message[]): string[] {
  const unpaired: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message === undefined || message.role !== 'assistant') continue;
    const uses = toolUsesIn(message.content);
    if (uses.length === 0) continue;
    const next = history[i + 1];
    const answered = next === undefined ? new Set<string>() : answeredIds(next.content);
    for (const use of uses) {
      if (!answered.has(use.id)) unpaired.push(use.id);
    }
  }
  return unpaired;
}

/**
 * Returns a history in which every `tool_use` is answered.
 *
 * Used on the abort path and when loading a conversation from disk, so a
 * transcript corrupted by an older build becomes usable again instead of
 * failing every turn forever. Returns the input unchanged when it is already
 * well-formed, so the common case allocates nothing.
 */
export function repairHistory(
  history: readonly Message[],
  reason: string = ABORTED_RESULT,
): Message[] {
  if (isPaired(history)) return [...history];

  const repaired: Message[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    repaired.push(message);

    if (message.role !== 'assistant') continue;
    const uses = toolUsesIn(message.content);
    if (uses.length === 0) continue;

    const next = history[i + 1];
    // Only a user message directly after can carry the results. Anything else
    // (another assistant message, or the end of the history) means they are
    // missing and a synthetic user message has to be inserted.
    if (next !== undefined && next.role === 'user') {
      const completed = completeToolResults(message.content, next.content, reason);
      if (completed.length !== next.content.length) {
        repaired.push({ role: 'user', content: completed });
        i++;
      }
      continue;
    }

    repaired.push({
      role: 'user',
      content: uses.map((use) => cancelledResult(use, reason)),
    });
  }
  return repaired;
}
