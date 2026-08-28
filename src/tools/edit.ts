// Edit tool — exact string replacement in a file. Requires uniqueness unless
// replaceAll is set.
//
// Three things this refuses to get wrong:
//
//   * Encoding. `readFile(path, 'utf8')` decodes invalid byte sequences by
//     substituting U+FFFD, silently and everywhere they occur — not just at
//     the edit site. Round-tripping that back through `writeFile` then
//     replaces every offending byte in the whole file with the replacement
//     character, whether the file is binary, Latin-1, Windows-1252, or
//     anything else that isn't UTF-8. There is no warning and no error: the
//     tool reports success over a file it just corrupted. `readFile` (no
//     encoding) plus a `fatal: true` TextDecoder catches this before any
//     write happens, and the tool refuses instead. Write is deliberately
//     different — see its own header — because it replaces a file's content
//     outright rather than patching one it read.
//
//   * Line endings. A CRLF file's multi-line content, read out through
//     `Read`, shows no visible `\r` (see read.ts), so an agent composing
//     `oldString` from what it saw naturally writes plain `\n` between
//     lines. `original.indexOf(oldString)` then never matches a CRLF file
//     for anything but a single-line replacement. The fix is not to
//     normalise the whole file to LF — that would be exactly the same class
//     of silent, file-wide corruption as the encoding problem above — it is
//     to match tolerantly and write back only the exact span that changed,
//     in the file's own line-ending style.
//
//   * TOCTOU. `checkWritable` runs once, up front — see `openForWriteGuarded`
//     for why the actual write goes through a second, much later check
//     instead of trusting that one across every await in between.

import { constants as FS } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recordFileChange } from '../agent/file-history.ts';
import { type Tool, err, ok } from './types.ts';
import { checkWritable } from './write-policy.ts';

/** Decodes strictly: throws instead of substituting U+FFFD for invalid
 *  UTF-8, unlike `Buffer#toString('utf8')`. */
function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex that matches `needle` against file content byte-for-byte, except
 * that each line break inside `needle` also accepts a CRLF pair in the file.
 * Built directly against the *unnormalised* file text, so the match index
 * and length it reports are real offsets into that text — every other
 * part of the file stays untouched.
 */
function eolTolerantPattern(needle: string): RegExp {
  const lines = needle.replace(/\r\n/g, '\n').split('\n').map(escapeRegExp);
  return new RegExp(lines.join('\\r?\\n'), 'g');
}

/** True once `text` contains at least one CRLF pair. */
function usesCrlf(text: string): boolean {
  return text.includes('\r\n');
}

/** Re-expresses `text`'s line breaks as CRLF, without doubling ones that
 *  already are — so a replacement dropped into a CRLF file reads as part of
 *  it instead of leaving a patch of bare LF behind. */
function toCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/**
 * Opens `abs` for writing with the smallest practical TOCTOU window — same
 * reasoning and same shape as write.ts's `openForWriteGuarded`, duplicated
 * rather than imported so each tool file stays self-contained. An `open()`
 * with `O_NOFOLLOW` goes first, so a symlink swapped into place after
 * `checkWritable` ran (during the read, the matching, or any other await
 * before this call) is caught atomically instead of silently followed. On
 * `ELOOP` — including the legitimate case where `abs` was already a symlink
 * `checkWritable` had approved — this re-runs `checkWritable` immediately
 * before falling back to a normal, symlink-following open.
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

export const editTool: Tool = {
  name: 'Edit',
  description:
    'Replace an exact string in a file. Set replaceAll:true to swap every occurrence in one call (cheaper than per-match). Multiple Edits in the same turn for distinct strings.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  async execute(input) {
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    const oldString = typeof input['oldString'] === 'string' ? input['oldString'] : '';
    const newString = typeof input['newString'] === 'string' ? input['newString'] : '';
    const replaceAll = input['replaceAll'] === true;
    if (!path) return err('path is required');
    if (!oldString) return err('oldString is required (and must be non-empty)');
    const guard = checkWritable(path);
    if (guard) return err(guard);

    try {
      const abs = resolve(path);
      const raw = await readFile(abs);
      let original: string;
      try {
        original = decodeUtf8Strict(raw);
      } catch {
        return err(
          `Edit refused: ${abs} is not valid UTF-8 (binary file, or a non-UTF-8 text encoding such as Latin-1/Windows-1252/Shift-JIS). Decoding and re-encoding it as UTF-8 would replace every offending byte in the whole file with U+FFFD, not just at the edit site — nothing was written. Use Write to replace the file outright, or convert its encoding first.`,
        );
      }

      const pattern = eolTolerantPattern(oldString);
      const matches = [...original.matchAll(pattern)];
      if (matches.length === 0) return err('oldString not found in file');

      const effectiveNewString = usesCrlf(original) ? toCrlf(newString) : newString;

      const commit = async (next: string, message: string) => {
        recordFileChange(abs, 'Edit');
        const handle = await openForWriteGuarded(path, abs);
        try {
          await handle.writeFile(next, 'utf8');
        } finally {
          await handle.close();
        }
        return ok(message);
      };

      if (replaceAll) {
        const next = original.replace(pattern, () => effectiveNewString);
        return await commit(next, `replaced ${matches.length} occurrence(s) in ${abs}`);
      }

      if (matches.length > 1) {
        return err('oldString is not unique; pass replaceAll=true to replace every occurrence');
      }
      const m = matches[0];
      if (!m || m.index === undefined) return err('oldString not found in file');
      const next =
        original.slice(0, m.index) + effectiveNewString + original.slice(m.index + m[0].length);
      return await commit(next, `replaced 1 occurrence in ${abs}`);
    } catch (e) {
      return err(`Edit failed: ${(e as Error).message}`);
    }
  },
};
