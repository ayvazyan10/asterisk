// Speech to text: backend selection, both backends, and every refusal path.
//
// The command backend is exercised with real shell commands (printf, a script
// that writes a .txt) rather than a mock — the whole point of a command
// template is that it is a real process, and quoting is where it breaks.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveConfig, saveSecrets } from '../src/config/load.ts';
import { type AsteriskConfig, ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import { buildCommand, shellQuote } from '../src/stt/command.ts';
import { chooseBackend, transcribeAudio } from '../src/stt/index.ts';
import { extractTranscript } from '../src/stt/openai-compatible.ts';
import type { SttSettings } from '../src/stt/types.ts';

let home: string;
let prevHome: string | undefined;
let audio: string;

function settings(over: Partial<SttSettings> = {}): SttSettings {
  return { ...ConfigSchema.parse({}).stt, ...over };
}

function withStt(over: Partial<AsteriskConfig['stt']>): void {
  const config = ConfigSchema.parse({});
  saveConfig({ ...config, stt: { ...config.stt, ...over } });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-stt-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
  audio = join(home, 'voice.ogg');
  await writeFile(audio, 'not really audio, but the backends are stubbed');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  closeDb();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('backend selection', () => {
  it('prefers the local command in auto mode', () => {
    expect(chooseBackend(settings({ command: 'x {input}', baseUrl: 'http://h/v1' }))).toBe(
      'command',
    );
    expect(chooseBackend(settings({ baseUrl: 'http://h/v1' }))).toBe('openai-compatible');
    expect(chooseBackend(settings())).toBeNull();
  });

  it('never swaps a pinned backend for the other one', () => {
    // Being told "command" and quietly uploading the audio instead would make
    // a privacy decision on the user's behalf.
    expect(chooseBackend(settings({ provider: 'command', baseUrl: 'http://h/v1' }))).toBeNull();
    expect(
      chooseBackend(settings({ provider: 'openai-compatible', command: 'x {input}' })),
    ).toBeNull();
    expect(chooseBackend(settings({ provider: 'off', command: 'x {input}' }))).toBeNull();
  });
});

describe('validation before any backend runs', () => {
  it('refuses when disabled', async () => {
    withStt({ enabled: false, command: 'printf hi' });
    const r = await transcribeAudio(audio);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('disabled') });
  });

  it('refuses an unsupported extension, a missing file and an empty one', async () => {
    withStt({ command: 'printf hi {input}' });

    const notes = join(home, 'notes.txt');
    await writeFile(notes, 'hello');
    expect(await transcribeAudio(notes)).toMatchObject({
      ok: false,
      error: expect.stringContaining('unsupported audio format'),
    });

    expect(await transcribeAudio(join(home, 'nope.ogg'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    });

    const empty = join(home, 'empty.wav');
    await writeFile(empty, '');
    expect(await transcribeAudio(empty)).toMatchObject({
      ok: false,
      error: expect.stringContaining('empty'),
    });
  });

  it('refuses audio over the size limit', async () => {
    withStt({ command: 'printf hi {input}', maxFileMb: 1 });
    const big = join(home, 'big.wav');
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024));
    expect(await transcribeAudio(big)).toMatchObject({
      ok: false,
      error: expect.stringContaining('over the 1MB limit'),
    });
  });

  it('says what to configure when nothing is', async () => {
    withStt({});
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('stt.command'),
    });

    withStt({ provider: 'command' });
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('stt.command is empty'),
    });
  });
});

describe('command backend', () => {
  it('quotes every substitution, so a path with spaces stays one argument', () => {
    const built = buildCommand('transcribe {input} --model {model} --language {language}', {
      input: '/tmp/my voice.ogg',
      model: 'large-v3',
      language: 'ru',
      outputDir: '',
    });
    expect(built).toBe("transcribe '/tmp/my voice.ogg' --model 'large-v3' --language 'ru'");
    // A quote in the value cannot end the quoting.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('reads stdout when the template has no {output_dir}', async () => {
    // `cat` stands in for a CLI that prints the transcript: it proves the file
    // reached the command and that stdout is what gets returned.
    await writeFile(audio, 'spoken words\n');
    withStt({ command: 'cat {input}' });
    const r = await transcribeAudio(audio);
    expect(r).toEqual({ ok: true, text: 'spoken words', backend: 'command' });
  });

  it('passes the file through and reads back a written transcript', async () => {
    // Mimics a CLI that writes <name>.txt into an output directory.
    withStt({
      command: 'sh -c "cat {input} > {output_dir}/out.txt" && printf ignored',
      model: '',
      language: '',
    });
    await writeFile(audio, 'hello from the file');
    const r = await transcribeAudio(audio);
    expect(r).toMatchObject({ ok: true, text: 'hello from the file', backend: 'command' });
  });

  it('reports the command failure instead of an empty transcript', async () => {
    withStt({ command: 'sh -c "echo broken pipeline >&2; exit 3" {input}' });
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('broken pipeline'),
    });
  });

  it('rejects a template that never receives the audio', async () => {
    withStt({ command: 'whisper --model base' });
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('{input}'),
    });
  });

  it('treats silence as a failure rather than an empty answer', async () => {
    withStt({ command: 'printf "" {input}' });
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no text'),
    });
  });
});

describe('openai-compatible backend', () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response): unknown[] {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    });
    return calls;
  }

  it('posts multipart audio and returns the transcript', async () => {
    withStt({
      baseUrl: 'https://api.groq.com/openai/v1/',
      model: 'whisper-large-v3',
      language: 'ru',
    });
    saveSecrets({ ASTERISK_STT_API_KEY: 'sk-test' });

    const calls = stubFetch(() => new Response('  привет мир  ', { status: 200 }));
    const r = await transcribeAudio(audio);

    expect(r).toEqual({ ok: true, text: 'привет мир', backend: 'openai-compatible' });
    const call = calls[0] as {
      url: string;
      init: { headers: Record<string, string>; body: FormData };
    };
    // The trailing slash in baseUrl must not produce a doubled one.
    expect(call.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(call.init.headers['authorization']).toBe('Bearer sk-test');
    expect(call.init.body.get('model')).toBe('whisper-large-v3');
    expect(call.init.body.get('language')).toBe('ru');
    expect(call.init.body.get('file')).toBeInstanceOf(Blob);
  });

  it('omits the key header when no secret is set', async () => {
    withStt({ baseUrl: 'http://127.0.0.1:8080/v1' });
    const calls = stubFetch(() => new Response('local transcript', { status: 200 }));
    await transcribeAudio(audio);
    const call = calls[0] as { init: { headers: Record<string, string> } };
    expect(call.init.headers['authorization']).toBeUndefined();
  });

  it('surfaces the server error, which is the part worth reading', async () => {
    withStt({ baseUrl: 'http://127.0.0.1:8080/v1' });
    stubFetch(
      () =>
        new Response('{"error":{"message":"The current model does not support audio input."}}', {
          status: 501,
        }),
    );
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not support audio input'),
    });
  });

  it('reports a connection failure as a failure, not a crash', async () => {
    withStt({ baseUrl: 'http://127.0.0.1:9/v1' });
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await transcribeAudio(audio)).toMatchObject({
      ok: false,
      error: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('accepts a JSON body as well as plain text', () => {
    expect(extractTranscript('{"text":"from json"}')).toBe('from json');
    expect(extractTranscript('plain text')).toBe('plain text');
    expect(extractTranscript('{"error":{"message":"nope"}}')).toBeNull();
    expect(extractTranscript('   ')).toBeNull();
  });
});
