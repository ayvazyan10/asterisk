// Attach tool — sends a file (image / video / audio / document) to the
// user alongside the agent's text reply. In a bot context (Telegram /
// WhatsApp) the daemon picks up the attachment and ships it via the
// channel's media API. In the REPL, image attachments are rendered inline
// when the terminal supports it; everything else gets a "📎 path" row.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { type AttachmentKind, inferAttachmentKind } from '../bots/adapter.ts';
import { expandHome } from '../utils/path.ts';
import { type Tool, ok, err } from './types.ts';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — Telegram's hard cap for sendPhoto/sendDocument

export const attachTool: Tool = {
  name: 'Attach',
  description:
    'Send a local file to the user as an attachment alongside your text reply. Use this to share screenshots you took (BrowserScreenshot), files you generated, etc. Path can be absolute, ~/, or cwd-relative. The kind is auto-detected from the extension (png/jpg/gif/webp → image, mp4/mov/webm → video, mp3/wav/ogg → audio, anything else → document); override with `kind` if needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file on disk.' },
      caption: { type: 'string', description: 'Optional caption to attach.' },
      kind: {
        type: 'string',
        description: 'image | video | audio | document — auto-detected if omitted.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input) {
    const raw = typeof input['path'] === 'string' ? input['path'].trim() : '';
    if (!raw) return err('path is required');
    const abs = resolve(raw.startsWith('~') ? expandHome(raw) : raw);
    if (!existsSync(abs)) return err(`file not found: ${abs}`);
    const stats = statSync(abs);
    if (!stats.isFile()) return err(`not a regular file: ${abs}`);
    if (stats.size > MAX_BYTES) {
      return err(`file too large (${stats.size} bytes); cap is ${MAX_BYTES} bytes`);
    }

    const requestedKind = typeof input['kind'] === 'string' ? input['kind'] : '';
    const kind: AttachmentKind = isAttachmentKind(requestedKind)
      ? requestedKind
      : inferAttachmentKind(abs);

    const caption = typeof input['caption'] === 'string' ? input['caption'] : undefined;

    return {
      output: `📎 attached · ${kind} · ${abs} (${stats.size} bytes)${caption ? ` · "${caption}"` : ''}`,
      isError: false,
      attachments: [
        caption !== undefined
          ? { kind, path: abs, caption }
          : { kind, path: abs },
      ],
    };
  },
};

function isAttachmentKind(s: string): s is AttachmentKind {
  return s === 'image' || s === 'video' || s === 'audio' || s === 'document';
}
