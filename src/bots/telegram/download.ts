// Fetching a file off Telegram.
//
// grammy resolves a file id to a path (`getFile`) but does not download it —
// that lives in the @grammyjs/files plugin, and one fetch is not worth a
// dependency. The download URL embeds the bot token, so it is built here and
// never logged, never returned in an error, and never put in a chat message.
//
// Bots may fetch files up to 20 MB; past that `getFile` itself fails, and the
// message the user gets should say so rather than surfacing a raw API error.
//
// One implementation for voice notes and images alike. They differ only in
// where the file lands and what it is called in an error, and a second copy of
// this would be a second place for the token to leak out of.

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { Context } from 'grammy';

import { OWNER_ONLY_DIR, OWNER_ONLY_FILE } from '../../utils/fs-safe.ts';

export interface DownloadRequest {
  /** What the file is called in an error the user reads, e.g. 'voice message'. */
  label: string;
  /** Directory the file is written to; created owner-only if missing. */
  dir: string;
  /** Filename prefix, e.g. 'voice' → voice-<ts>-<rand>.oga */
  prefix: string;
  /** Used when Telegram's own path has no extension. */
  defaultExtension: string;
  /**
   * Overrides the extension entirely.
   *
   * Images need this: what the file is called decides its media type
   * downstream (agent/images.ts reads the extension), and a JPEG someone
   * uploaded as `shot.jfif` would otherwise be dropped for a naming quirk
   * when Telegram already told us its mime type.
   */
  forceExtension?: string | undefined;
  /**
   * Refuse anything larger, in bytes. Checked against the size Telegram
   * reports and again against what actually arrived, because the first is
   * advisory and the second is what a provider would have to carry.
   */
  maxBytes?: number;
}

export type FileDownload = { ok: true; path: string } | { ok: false; error: string };

function extensionFor(filePath: string, fallback: string): string {
  const ext = extname(filePath).toLowerCase();
  return ext || fallback;
}

function describeSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export async function downloadTelegramFile(
  ctx: Context,
  token: string,
  req: DownloadRequest,
): Promise<FileDownload> {
  let filePath: string;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) return { ok: false, error: 'Telegram returned no path for that file' };
    // Advisory, but it saves downloading megabytes only to throw them away.
    if (req.maxBytes !== undefined && (file.file_size ?? 0) > req.maxBytes) {
      return {
        ok: false,
        error: `that ${req.label} is ${describeSize(file.file_size ?? 0)}, over the ${describeSize(req.maxBytes)} limit`,
      };
    }
    filePath = file.file_path;
  } catch (e) {
    return { ok: false, error: `could not fetch the ${req.label} (${(e as Error).message})` };
  }

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      // The URL carries the token — report the status, never the URL.
      return { ok: false, error: `Telegram file download failed with ${response.status}` };
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    const reason = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    return { ok: false, error: `Telegram file download failed: ${reason}` };
  }

  if (req.maxBytes !== undefined && bytes.byteLength > req.maxBytes) {
    return {
      ok: false,
      error: `that ${req.label} is ${describeSize(bytes.byteLength)}, over the ${describeSize(req.maxBytes)} limit`,
    };
  }

  try {
    await mkdir(req.dir, { recursive: true, mode: OWNER_ONLY_DIR });
    const ext = req.forceExtension ?? extensionFor(filePath, req.defaultExtension);
    const name = `${req.prefix}-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    const target = join(req.dir, name);
    // Whatever someone sent their assistant is theirs: written owner-only for
    // the same reason the transcript store is.
    await writeFile(target, bytes, { mode: OWNER_ONLY_FILE });
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: `could not save the ${req.label}: ${(e as Error).message}` };
  }
}
