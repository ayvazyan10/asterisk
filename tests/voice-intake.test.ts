// What the agent actually sees when someone sends a voice message, and the
// Transcribe tool that shares the same pipeline.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IncomingMessage } from '../src/bots/adapter.ts';
import { intakeVoice } from '../src/bots/voice-intake.ts';
import { saveConfig } from '../src/config/load.ts';
import { type AsteriskConfig, ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import { transcribeTool } from '../src/tools/transcribe.ts';

let home: string;
let prevHome: string | undefined;
let voicePath: string;

function withStt(over: Partial<AsteriskConfig['stt']>): void {
  const config = ConfigSchema.parse({});
  saveConfig({ ...config, stt: { ...config.stt, ...over } });
}

function voiceMessage(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatId: '275805082',
    userId: '275805082',
    text: '',
    timestamp: Date.now(),
    voice: { path: voicePath, seconds: 4 },
    ...over,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-voice-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
  voicePath = join(home, 'voice.oga');
  await writeFile(voicePath, 'запусти сборку\n');
});

afterEach(async () => {
  closeDb();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('voice intake', () => {
  it('labels the transcript instead of passing it off as typed text', async () => {
    withStt({ command: 'cat {input}' });

    const result = await intakeVoice(voiceMessage());

    // The agent has to know it was spoken: "I didn't catch that" is a sensible
    // reply to a bad transcript and nonsense as a reply to a typed message.
    expect(result.text).toBe('[voice message, 4s, transcribed] запусти сборку');
    expect(result.outcome).toEqual({ ok: true, backend: 'command' });
  });

  it('keeps a caption alongside the transcript', async () => {
    withStt({ command: 'cat {input}' });
    const result = await intakeVoice(voiceMessage({ text: 'см. вложение' }));
    expect(result.text).toContain('запусти сборку');
    expect(result.text).toContain('см. вложение');
  });

  it('tells the agent why it could not hear, rather than going silent', async () => {
    withStt({ provider: 'command', command: '' });

    const result = await intakeVoice(voiceMessage());

    expect(result.text).toContain('could not be transcribed');
    expect(result.text).toContain('stt.command is empty');
    expect(result.outcome).toMatchObject({ ok: false });
  });

  it('deletes the recording whether transcription worked or not', async () => {
    withStt({ command: 'cat {input}' });
    await intakeVoice(voiceMessage());
    expect(existsSync(voicePath)).toBe(false);

    await writeFile(voicePath, 'again');
    withStt({ command: 'sh -c "exit 1" {input}' });
    await intakeVoice(voiceMessage());
    // Someone's voice is not kept around because the transcriber failed.
    expect(existsSync(voicePath)).toBe(false);
  });

  it('leaves a plain text message untouched and reports no outcome', async () => {
    const result = await intakeVoice({
      chatId: '1',
      userId: '1',
      text: 'обычное сообщение',
      timestamp: Date.now(),
    });
    expect(result).toEqual({ text: 'обычное сообщение' });
  });
});

describe('Transcribe tool', () => {
  it('returns the transcript for a path', async () => {
    withStt({ command: 'cat {input}' });
    const r = await transcribeTool.execute({ path: voicePath });
    expect(r.isError).toBe(false);
    expect(r.output).toBe('запусти сборку');
  });

  it('passes a per-call language override to the backend', async () => {
    // The template echoes the language back, which is how the test sees it.
    withStt({ command: 'sh -c "printf %s {language}" {input}', language: '' });
    const r = await transcribeTool.execute({ path: voicePath, language: 'hy' });
    expect(r.output).toBe('hy');
  });

  it('reports a missing path and a failed transcription as tool errors', async () => {
    withStt({ command: 'cat {input}' });
    expect((await transcribeTool.execute({ path: '' })).isError).toBe(true);

    const missing = await transcribeTool.execute({ path: join(home, 'nope.ogg') });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('not found');
  });
});
