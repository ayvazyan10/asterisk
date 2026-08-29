// Fetching a voice message off Telegram.
//
// The download itself is in download.ts, shared with images. What stays here
// is what is specific to a voice note: where it lands, what it is called in an
// error, and the duration the agent is told about.

import type { Context } from 'grammy';

import { asteriskPaths } from '../../daemon/paths.ts';
import { downloadTelegramFile } from './download.ts';

export interface DownloadedVoice {
  path: string;
  seconds?: number;
}

export type VoiceDownload = { ok: true; voice: DownloadedVoice } | { ok: false; error: string };

export async function downloadVoice(ctx: Context, token: string): Promise<VoiceDownload> {
  const { audioDir } = asteriskPaths();
  const result = await downloadTelegramFile(ctx, token, {
    label: 'voice message',
    dir: audioDir,
    prefix: 'voice',
    // Telegram serves .oga for voice notes; keep whatever it actually named.
    defaultExtension: '.oga',
  });
  if (!result.ok) return result;

  const seconds = ctx.message?.voice?.duration;
  return {
    ok: true,
    voice: { path: result.path, ...(typeof seconds === 'number' ? { seconds } : {}) },
  };
}
