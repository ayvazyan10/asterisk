// Fetching a picture off Telegram.
//
// Two updates carry one: `message:photo`, which is the compressed thing the
// app produces, and `message:document` when the sender ticked "send as file".
// The second is not an edge case — anyone sending a screenshot they care about
// sends it uncompressed — so ignoring documents would reproduce the bug this
// exists to fix. Documents that are not images stay ignored, exactly as before.
//
// The transport downloads and does not interpret: whether the model can look
// at the picture, and what the user is told when it cannot, is policy and
// lives in bots/image-intake.ts.
//
// Size is refused, never resized. Downscaling would mean an image codec in the
// dependency tree to rescue a case the user can fix in one gesture by sending
// a smaller picture, and a silently altered image is a worse answer than a
// clear no.

import type { Context } from 'grammy';

import { asteriskPaths } from '../../daemon/paths.ts';
import { downloadTelegramFile } from './download.ts';

/**
 * Mime types the providers accept, mapped to the extension the file is saved
 * under. Kept in step with agent/images.ts, which reads the extension back to
 * decide a media type — anything not here would be downloaded and then
 * dropped, so it is refused up front instead.
 */
const ACCEPTED_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export type ImageDownload = { ok: true; path: string } | { ok: false; error: string };

/** Strips any `; charset=…` and normalises case, the way a header may arrive. */
function normaliseMime(mime: string | undefined): string {
  return (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
}

/** True when a document update is carrying a picture we could actually send. */
export function isSupportedImageMime(mime: string | undefined): boolean {
  return normaliseMime(mime) in ACCEPTED_MIME;
}

/** The extension a document's mime type earns it, or `.jpg` for a photo. */
function extensionForMime(mime: string | undefined): string {
  return ACCEPTED_MIME[normaliseMime(mime)] ?? '.jpg';
}

/**
 * Downloads the image on the current update.
 *
 * `ctx.getFile()` resolves the largest size of a photo, which is the one worth
 * showing a model — the thumbnails Telegram also sends are too small to read
 * text off.
 */
export async function downloadImage(
  ctx: Context,
  token: string,
  maxBytes: number,
): Promise<ImageDownload> {
  const mime = ctx.message?.document?.mime_type;
  return downloadTelegramFile(ctx, token, {
    label: 'image',
    dir: asteriskPaths().imageDir,
    prefix: 'image',
    defaultExtension: '.jpg',
    // Telegram compresses photos to JPEG; a document keeps whatever it is.
    forceExtension: extensionForMime(mime),
    maxBytes,
  });
}
