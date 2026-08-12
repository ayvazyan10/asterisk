// Summarising the messages compaction is about to drop.
//
// Dropping used to leave "[N earlier message(s) dropped]" and nothing else, so
// a long session lost the decisions that shaped it — which approach was
// rejected and why, the paths already touched, the thing the user asked for
// twice. The model then re-derived them, wrongly, with total confidence.
//
// Replacing the dropped span with a summary keeps the substance at a fraction
// of the tokens. It costs one model call at the moment the user is already
// waiting, which is why it only runs when messages are actually being dropped
// — shortening alone never triggers it.
//
// Every failure path returns null and the caller falls back to the plain
// notice. A summary is an improvement on dropping, never a precondition for
// it: an unreachable model must not be able to fail a turn.

import type { Message, Provider } from '../types/messages.ts';

/** Characters of each message fed to the summariser. */
const PER_MESSAGE_CAP = 2_000;

/** Total characters of transcript fed to the summariser. */
const TRANSCRIPT_CAP = 24_000;

/** Ceiling on the summary itself, so it cannot undo the compaction. */
const SUMMARY_MAX_TOKENS = 600;

const SYSTEM = `You compress a conversation transcript so an assistant can keep working after the original messages are gone.

Write a dense factual summary. Preserve:
- decisions taken and the reasoning behind them, including approaches rejected
- file paths, identifiers, commands, versions and other exact strings
- what the user asked for, especially anything asked more than once
- open threads: what was in progress, what was agreed but not yet done
- errors hit and how they were resolved

Drop pleasantries, restatements and tool output that led nowhere.

Write plain prose or terse bullets. No preamble, no "here is a summary", no
closing remarks. You are writing notes for someone who has to continue this
work with no other record of it.`;

/** Renders messages as a transcript the summariser can read. */
function renderTranscript(messages: readonly Message[]): string {
  const parts: string[] = [];
  let budget = TRANSCRIPT_CAP;

  for (const msg of messages) {
    if (budget <= 0) break;
    const chunks: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') chunks.push(block.text);
      else if (block.type === 'tool_use') {
        chunks.push(`[called ${block.name} with ${JSON.stringify(block.input)}]`);
      } else if (block.type === 'tool_result') {
        chunks.push(`[result${block.is_error ? ' (error)' : ''}] ${block.content}`);
      }
    }
    const body = chunks.join('\n').slice(0, PER_MESSAGE_CAP);
    if (!body.trim()) continue;
    const line = `${msg.role}: ${body}`;
    parts.push(line.slice(0, budget));
    budget -= line.length;
  }

  return parts.join('\n\n');
}

/**
 * Returns a summary of `messages`, or null if one could not be produced.
 *
 * Never throws and never rejects — the caller is mid-turn and a failure here
 * must degrade to the plain drop notice, not surface as an error.
 */
export async function summariseMessages(
  messages: readonly Message[],
  provider: Provider,
  signal?: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) return null;
  if (signal?.aborted) return null;

  const transcript = renderTranscript(messages);
  if (!transcript.trim()) return null;

  try {
    const response = await provider.send({
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      // No tools: this is a single-shot compression, and offering tools invites
      // the model to start working instead of summarising.
      tools: [],
      maxTokens: SUMMARY_MAX_TOKENS,
      ...(signal ? { signal } : {}),
    });

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return text.length > 0 ? text : null;
  } catch {
    // Unreachable model, timeout, abort, malformed response — all the same
    // answer here. The caller drops the messages either way.
    return null;
  }
}
