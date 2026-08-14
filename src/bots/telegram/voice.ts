// Fetching a voice message off Telegram.
//
// grammy resolves a file id to a path (`getFile`) but does not download it —
// that lives in the @grammyjs/files plugin, and one fetch is not worth a
// dependency. The download URL embeds the bot token, so it is built here and
// never logged.
//
// Bots may fetch files up to 20 MB; past that `getFile` itself fails, and the
// message the user gets should say so rather than surfacing a raw API error.

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { Context } from 'grammy';

import { asteriskPaths } from '../../daemon/paths.ts';
import { OWNER_ONLY_DIR, OWNER_ONLY_FILE } from '../../utils/fs-safe.ts';

export interface DownloadedVoice {
  path: string;
  seconds?: number;
}

export type VoiceDownload = { ok: true; voice: DownloadedVoice } | { ok: false; error: string };

/** Telegram serves .oga for voice notes; keep whatever it actually named. */
function extensionFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return ext || '.oga';
}

export async function downloadVoice(ctx: Context, token: string): Promise<VoiceDownload> {
  let filePath: string;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) return { ok: false, error: 'Telegram returned no path for that file' };
    filePath = file.file_path;
  } catch (e) {
    return { ok: false, error: `could not fetch the voice message (${(e as Error).message})` };
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

  const { audioDir } = asteriskPaths();
  try {
    await mkdir(audioDir, { recursive: true, mode: OWNER_ONLY_DIR });
    const name = `voice-${Date.now()}-${randomBytes(4).toString('hex')}${extensionFor(filePath)}`;
    const target = join(audioDir, name);
    // A voice message is the user speaking; it is written as owner-only for
    // the same reason the transcript store is.
    await writeFile(target, bytes, { mode: OWNER_ONLY_FILE });
    const seconds = ctx.message?.voice?.duration;
    return {
      ok: true,
      voice: { path: target, ...(typeof seconds === 'number' ? { seconds } : {}) },
    };
  } catch (e) {
    return { ok: false, error: `could not save the voice message: ${(e as Error).message}` };
  }
}
