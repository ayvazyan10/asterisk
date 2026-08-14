// Turning an incoming voice message into something the agent can read.
//
// The transport downloads the file and stops there. What the model finally
// sees is decided here, in one place, for every transport:
//
//   * A transcript is labelled, not disguised as typed text. The agent's reply
//     often depends on knowing it was spoken — "I didn't catch that" is a
//     sensible answer to a bad transcript and a nonsensical one to a message.
//   * A failure is reported to the agent rather than swallowed. The user is
//     waiting for an answer either way, and "I couldn't hear it, here's why"
//     is one; silence is not.
//   * The file is temporary and is deleted whatever happens. It is a recording
//     of someone's voice; keeping it because a transcription failed would be
//     the wrong default.

import { rm } from 'node:fs/promises';

import { transcribeAudio } from '../stt/index.ts';
import type { IncomingMessage } from './adapter.ts';

export interface VoiceIntakeResult {
  /** The text the agent turn should run on. */
  text: string;
  /** Present when transcription ran — for the daemon log, not the model. */
  outcome?: { ok: boolean; backend?: string; error?: string };
}

function describeDuration(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return 'voice message';
  return `voice message, ${seconds}s`;
}

/**
 * Resolves `msg` to plain text, transcribing a voice note if there is one.
 *
 * Never throws: this sits directly in front of the agent turn, and a failure
 * to transcribe must not cost the user their turn.
 */
export async function intakeVoice(msg: IncomingMessage): Promise<VoiceIntakeResult> {
  if (!msg.voice) return { text: msg.text };

  const caption = msg.text.trim();
  try {
    const result = await transcribeAudio(msg.voice.path);

    if (result.ok) {
      const label = describeDuration(msg.voice.seconds);
      const transcript = `[${label}, transcribed] ${result.text}`;
      return {
        text: caption ? `${transcript}\n\n${caption}` : transcript,
        outcome: { ok: true, backend: result.backend },
      };
    }

    const note = `[the user sent a voice message but it could not be transcribed: ${result.error}]`;
    return {
      text: caption ? `${note}\n\n${caption}` : note,
      outcome: { ok: false, error: result.error },
    };
  } finally {
    await rm(msg.voice.path, { force: true }).catch(() => {});
  }
}
