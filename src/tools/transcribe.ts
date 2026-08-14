// Transcribe — speech to text for a file the agent already has a path to.
//
// The Telegram bridge transcribes incoming voice messages on its own; this is
// for everything else: a recording the user points at, an attachment saved to
// disk, an audio file found while working. It is a thin shell over src/stt so
// there is exactly one place where backends and validation live.

import { transcribeAudio } from '../stt/index.ts';
import { type Tool, err, ok } from './types.ts';

export const transcribeTool: Tool = {
  name: 'Transcribe',
  description:
    'Transcribe an audio file to text (speech-to-text). Takes a path to an audio file (mp3, m4a, wav, ogg, opus, webm, flac, …) and returns what was said. Uses the configured local command or OpenAI-compatible endpoint. Optionally force a language (ISO code) when auto-detection gets it wrong.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the audio file.' },
      language: {
        type: 'string',
        description: 'Optional ISO language code, e.g. "ru". Omit to auto-detect.',
      },
      model: {
        type: 'string',
        description: 'Optional model override for this call.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const path = typeof input['path'] === 'string' ? input['path'].trim() : '';
    if (!path) return err('path is required');

    const language = typeof input['language'] === 'string' ? input['language'].trim() : '';
    const model = typeof input['model'] === 'string' ? input['model'].trim() : '';

    const result = await transcribeAudio(path, {
      overrides: {
        ...(language ? { language } : {}),
        ...(model ? { model } : {}),
      },
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    if (!result.ok) return err(result.error);
    return ok(result.text);
  },
};
