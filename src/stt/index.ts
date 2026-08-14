// Speech to text — one entry point, two backends.
//
// `transcribeAudio` is what everything else calls: the Telegram bridge for an
// incoming voice message, and the Transcribe tool when the agent is handed a
// file. It validates first, picks a backend second, and never throws — a
// transcription that cannot happen is a message the user can act on, not an
// exception that ends a turn.

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { loadConfig } from '../config/load.ts';
import { transcribeWithCommand } from './command.ts';
import { transcribeOverHttp } from './openai-compatible.ts';
import { type SttResult, type SttSettings, sttFail } from './types.ts';

/** What Whisper builds and the hosted APIs agree on accepting. */
export const SUPPORTED_AUDIO = new Set([
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.aac',
]);

export interface TranscribeOptions {
  /** Override the configured settings — the tool uses this for a per-call model. */
  overrides?: Partial<SttSettings>;
  signal?: AbortSignal;
}

interface Resolved {
  settings: SttSettings;
  apiKey: string;
}

function resolveSettings(overrides?: Partial<SttSettings>): Resolved {
  const loaded = loadConfig();
  return {
    settings: { ...loaded.config.stt, ...overrides },
    apiKey: loaded.secrets.ASTERISK_STT_API_KEY ?? '',
  };
}

/**
 * Decides which backend runs.
 *
 * `auto` prefers the command, because a local binary costs nothing and sends
 * nobody's voice anywhere. A pinned backend is never silently swapped: being
 * told "command" and quietly uploading the audio instead would be a privacy
 * decision made on the user's behalf.
 */
export function chooseBackend(settings: SttSettings): 'command' | 'openai-compatible' | null {
  const hasCommand = settings.command.trim().length > 0;
  const hasUrl = settings.baseUrl.trim().length > 0;

  if (settings.provider === 'command') return hasCommand ? 'command' : null;
  if (settings.provider === 'openai-compatible') return hasUrl ? 'openai-compatible' : null;
  if (settings.provider === 'off') return null;

  if (hasCommand) return 'command';
  if (hasUrl) return 'openai-compatible';
  return null;
}

function unconfiguredMessage(settings: SttSettings): string {
  if (settings.provider === 'command') {
    return 'speech-to-text is set to the command backend but stt.command is empty';
  }
  if (settings.provider === 'openai-compatible') {
    return 'speech-to-text is set to the openai-compatible backend but stt.baseUrl is empty';
  }
  return (
    'speech-to-text is not configured — set stt.command to a local transcription command, ' +
    'or stt.baseUrl to an OpenAI-compatible /audio/transcriptions endpoint'
  );
}

export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOptions = {},
): Promise<SttResult> {
  const { settings, apiKey } = resolveSettings(opts.overrides);

  if (!settings.enabled || settings.provider === 'off') {
    return sttFail('speech-to-text is disabled (stt.enabled)');
  }

  const extension = extname(audioPath).toLowerCase();
  if (!SUPPORTED_AUDIO.has(extension)) {
    return sttFail(
      `unsupported audio format ${extension || '(none)'} — supported: ${[...SUPPORTED_AUDIO].sort().join(' ')}`,
    );
  }

  let size: number;
  try {
    const info = await stat(audioPath);
    if (!info.isFile()) return sttFail(`not a file: ${audioPath}`);
    size = info.size;
  } catch {
    return sttFail(`audio file not found: ${audioPath}`);
  }

  const limit = settings.maxFileMb * 1024 * 1024;
  if (size > limit) {
    return sttFail(
      `audio is ${(size / (1024 * 1024)).toFixed(1)}MB, over the ${settings.maxFileMb}MB limit (stt.maxFileMb)`,
    );
  }
  if (size === 0) return sttFail('audio file is empty');

  const backend = chooseBackend(settings);
  if (backend === null) return sttFail(unconfiguredMessage(settings));

  if (backend === 'command') {
    return transcribeWithCommand(audioPath, settings, opts.signal);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(audioPath);
  } catch (e) {
    return sttFail(`could not read ${audioPath}: ${(e as Error).message}`);
  }
  return transcribeOverHttp(audioPath, bytes, settings, apiKey, opts.signal);
}

export type { SttResult, SttSettings } from './types.ts';
