// Write tool — overwrites or creates a file with the given content.
//
// Unlike Edit, Write always fully replaces a file's content rather than
// patching one it read — so there is no risk of the "decode the whole file,
// re-encode the whole file" corruption Edit guards against (see edit.ts's
// header). Overwriting a binary file outright is a legitimate use of Write.
// But silently destroying non-UTF-8 content without saying so is still
// worth a signal, since the caller usually did not mean to — hence the note
// appended below, advisory only, never a refusal.

import { constants as FS } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { recordFileChange } from '../agent/file-history.ts';
import { type Tool, err, ok } from './types.ts';
import { checkWritable } from './write-policy.ts';

/** Same cap as Read's own refusal threshold — this check is advisory only,
 *  so a huge file that turns out to be binary is not worth reading in full
 *  just to phrase the success message better. */
const BINARY_CHECK_MAX_BYTES = 1_000_000;

/** A short note appended to the success message when Write just replaced
 *  content that was not valid UTF-8 — empty string when there is nothing to
 *  say (new file, empty file, too large to check cheaply, or unreadable for
 *  a reason unrelated to encoding). */
async function binaryOverwriteNote(abs: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    return ''; // doesn't exist yet — nothing to warn about.
  }
  if (!info.isFile() || info.size === 0 || info.size > BINARY_CHECK_MAX_BYTES) return '';

  let raw: Buffer;
  try {
    raw = await readFile(abs);
  } catch {
    return ''; // unreadable for some other reason — not this check's job.
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return '';
  } catch {
    return ' (note: replaced non-UTF-8 content — previous file was binary or a different text encoding)';
  }
}

/**
 * Opens `abs` for writing with the smallest practical TOCTOU window.
 *
 * `checkWritable` runs once, up front — but `mkdir`, `binaryOverwriteNote`
 * and `recordFileChange` all happen after it and before the actual write,
 * and every one of them is an await point where a symlink could be swapped
 * into place at `abs`. A first `open()` with `O_NOFOLLOW` closes that: if
 * anything is a symlink there *right now*, the kernel refuses atomically
 * instead of silently following it.
 *
 * O_NOFOLLOW cannot be the whole answer, though — it refuses a symlink
 * unconditionally, including a legitimate one already inside the workspace
 * that `checkWritable` already resolved and approved (a config file that is
 * itself a symlink, say). So on `ELOOP` this re-runs `checkWritable`
 * immediately before falling back to a normal, symlink-following open: a
 * freshly-planted malicious symlink fails that re-check and the write is
 * refused; a pre-existing legitimate one passes it and the write proceeds
 * with the window now as small as this module can make it. Fully closing
 * that residual window needs `openat2`/`RESOLVE_NO_SYMLINKS`, which Node's
 * `fs` module does not expose.
 */
async function openForWriteGuarded(path: string, abs: string) {
  const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW;
  try {
    return await open(abs, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ELOOP') throw e;
    const guard = checkWritable(path);
    if (guard) throw new Error(guard);
    return open(abs, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC);
  }
}

export const writeTool: Tool = {
  name: 'Write',
  description:
    'Write content to a file (creates or overwrites). Parent directories are created as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target file path.' },
      content: { type: 'string', description: 'File content to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(input) {
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    const content = typeof input['content'] === 'string' ? input['content'] : '';
    if (!path) return err('path is required');
    const guard = checkWritable(path);
    if (guard) return err(guard);

    try {
      const abs = resolve(path);
      await mkdir(dirname(abs), { recursive: true });
      const note = await binaryOverwriteNote(abs);
      recordFileChange(abs, 'Write');
      const handle = await openForWriteGuarded(path, abs);
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      return ok(`wrote ${content.length} bytes to ${abs}${note}`);
    } catch (e) {
      return err(`Write failed: ${(e as Error).message}`);
    }
  },
};
