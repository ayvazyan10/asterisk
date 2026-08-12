// Small constructors so a scenario script reads as "what the model said next"
// rather than as content-block bookkeeping.

import type { Message, ProviderResponse, ToolResultBlock } from '../types/messages.ts';

export function say(text: string): ProviderResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' };
}

export interface PlannedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Several calls in one model turn — the shape that exercises the loop's
 *  parallel batching for concurrency-safe tools. */
export function toolBatch(calls: readonly PlannedCall[]): ProviderResponse {
  return {
    content: calls.map((c) => ({
      type: 'tool_use' as const,
      id: c.id,
      name: c.name,
      input: c.input,
    })),
    stopReason: 'tool_use',
  };
}

/** The tool results the loop fed back for the previous turn. Scripts branch on
 *  these so "recovers from an error" means it actually observed the error. */
export function lastToolResults(messages: readonly Message[]): ToolResultBlock[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const results = message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
    if (results.length > 0) return results;
  }
  return [];
}

/** True when the most recent tool batch reported at least one failure. */
export function lastCallFailed(messages: readonly Message[]): boolean {
  return lastToolResults(messages).some((r) => r.is_error === true);
}
