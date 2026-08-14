// The local-command backend.
//
// Every local Whisper build has a different CLI — whisper.cpp writes files,
// whisper-ctranslate2 takes --output_dir, a hand-rolled script prints to
// stdout — so the config carries a command template rather than a provider
// name per tool. Two output conventions are supported, and which one applies
// is decided by the template itself: mention {output_dir} and the transcript
// is read from the file left there, omit it and stdout is the transcript.

import { readFile, readdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { type SttResult, type SttSettings, sttFail, sttOk } from './types.ts';

const OUTPUT_DIR_TOKEN = '{output_dir}';

/**
 * Fills the template.
 *
 * Values are substituted, not concatenated, so a path with a space cannot
 * silently become two arguments: the command runs through a shell, and every
 * substituted value is quoted first.
 */
export function buildCommand(
  template: string,
  values: { input: string; model: string; language: string; outputDir: string },
): string {
  return template
    .replaceAll('{input}', shellQuote(values.input))
    .replaceAll('{model}', shellQuote(values.model))
    .replaceAll('{language}', shellQuote(values.language))
    .replaceAll(OUTPUT_DIR_TOKEN, shellQuote(values.outputDir));
}

/** POSIX single-quote quoting: the only character that needs care is `'`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Reads the transcript a file-writing CLI left behind. */
async function readTranscriptFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const texts = entries.filter((e) => e.endsWith('.txt')).sort();
  const first = texts[0];
  if (first === undefined) return null;
  return readFile(join(dir, first), 'utf8').catch(() => null);
}

export async function transcribeWithCommand(
  audioPath: string,
  settings: SttSettings,
  signal?: AbortSignal,
): Promise<SttResult> {
  const template = settings.command.trim();
  if (!template) return sttFail('stt.command is empty');
  if (!template.includes('{input}')) {
    return sttFail('stt.command must contain {input}, the path of the file to transcribe');
  }

  const needsOutputDir = template.includes(OUTPUT_DIR_TOKEN);
  const outputDir = needsOutputDir ? await mkdtemp(join(tmpdir(), 'asterisk-stt-')) : '';

  try {
    const command = buildCommand(template, {
      input: audioPath,
      model: settings.model,
      language: settings.language,
      outputDir,
    });

    const result = await execa(command, {
      shell: true,
      timeout: settings.timeoutSeconds * 1000,
      maxBuffer: 8 * 1024 * 1024,
      reject: false,
      ...(signal ? { cancelSignal: signal } : {}),
    });

    if (result.failed || result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.exitCode}`)
        .toString()
        .trim()
        .slice(0, 500);
      return sttFail(`transcription command failed: ${detail}`);
    }

    const text = needsOutputDir ? await readTranscriptFile(outputDir) : String(result.stdout ?? '');

    if (text === null) {
      return sttFail('transcription command wrote no .txt file to {output_dir}');
    }
    if (!text.trim()) return sttFail('transcription produced no text');

    return sttOk(text, 'command');
  } catch (e) {
    return sttFail(`transcription command failed: ${(e as Error).message}`);
  } finally {
    if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}
