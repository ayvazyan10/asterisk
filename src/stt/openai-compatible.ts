// The HTTP backend: POST /audio/transcriptions, OpenAI's audio API shape.
//
// One request body serves Groq, OpenAI, whisper.cpp's server and any local
// proxy, which is why there is no provider-per-service here — the same reason
// providers/openai-compatible.ts is the universal path for chat.
//
// `response_format: text` is requested because it is the one shape every
// implementation agrees on; a server that answers with JSON anyway is still
// handled, since the difference is not worth a failed transcription.

import { basename } from 'node:path';

import { type SttResult, type SttSettings, sttFail, sttOk } from './types.ts';

/** Pulls the transcript out of either a bare string or an OpenAI-shaped body. */
export function extractTranscript(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown; error?: { message?: unknown } };
    if (typeof parsed.text === 'string') return parsed.text;
    return null;
  } catch {
    // Not JSON after all — a transcript that merely starts with a brace.
    return trimmed;
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
}

export async function transcribeOverHttp(
  audioPath: string,
  bytes: Uint8Array,
  settings: SttSettings,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SttResult> {
  const baseUrl = settings.baseUrl.trim();
  if (!baseUrl) return sttFail('stt.baseUrl is empty');

  const form = new FormData();
  // The filename matters: hosted services decide the decoder from its
  // extension, and an unnamed part is rejected outright.
  form.append('file', new Blob([bytes as unknown as BlobPart]), basename(audioPath));
  if (settings.model) form.append('model', settings.model);
  if (settings.language) form.append('language', settings.language);
  form.append('response_format', 'text');

  const timeout = AbortSignal.timeout(settings.timeoutSeconds * 1000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(endpoint(baseUrl), {
      method: 'POST',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: abort,
    });
  } catch (e) {
    const reason = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    return sttFail(`transcription request to ${baseUrl} failed: ${reason}`);
  }

  const body = await response.text().catch(() => '');
  if (!response.ok) {
    // The server's own message is the useful part — a 401 from Groq and a 501
    // from a text-only llama.cpp read very differently to whoever has to fix it.
    return sttFail(
      `transcription endpoint returned ${response.status}: ${body.trim().slice(0, 300) || '(no body)'}`,
    );
  }

  const text = extractTranscript(body);
  if (text === null || !text.trim()) return sttFail('transcription produced no text');
  return sttOk(text, 'openai-compatible');
}
