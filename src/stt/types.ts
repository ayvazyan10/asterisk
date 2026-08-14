// The transcription contract.
//
// A result is a union rather than `{ ok, text, error }` with every field
// optional: the caller either has a transcript or has a reason, and the type
// should not let it read one while holding the other.

export type SttBackend = 'command' | 'openai-compatible';

export interface SttSuccess {
  ok: true;
  text: string;
  backend: SttBackend;
}

export interface SttFailure {
  ok: false;
  /** Written for a person to act on — it reaches the user through the agent. */
  error: string;
}

export type SttResult = SttSuccess | SttFailure;

export interface SttSettings {
  enabled: boolean;
  provider: 'auto' | 'command' | 'openai-compatible' | 'off';
  command: string;
  baseUrl: string;
  model: string;
  language: string;
  timeoutSeconds: number;
  maxFileMb: number;
}

export function sttOk(text: string, backend: SttBackend): SttSuccess {
  return { ok: true, text: text.trim(), backend };
}

export function sttFail(error: string): SttFailure {
  return { ok: false, error };
}
