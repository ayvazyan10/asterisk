// Turning image files into content blocks the model can look at.
//
// The agent takes screenshots and, until now, learned only where it had put
// them. Feeding the bytes back is what turns BrowserScreenshot from a thing
// the *user* looks at into a thing the *agent* can act on.
//
// Images are expensive — a full-page screenshot runs to well over a thousand
// tokens — so everything here is about limits: how big a file may be, how many
// may ride along with one turn, and how quickly they are evicted from history.

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { loadConfig } from '../config/load.ts';
import type { ImageBlock, Message } from '../types/messages.ts';

/** Extensions the providers accept, mapped to their media types. */
const MEDIA_TYPES: Record<string, ImageBlock['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface ImageLimits {
  /** Largest file that will be sent, in bytes. */
  maxBytes: number;
  /** Most images allowed to ride along with a single turn. */
  maxPerTurn: number;
}

export function mediaTypeFor(path: string): ImageBlock['mediaType'] | null {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? null;
}

/**
 * Reads `path` into an image block, or returns null with a reason.
 *
 * Never throws: a screenshot that cannot be attached should cost the agent its
 * eyesight for that turn, not the turn itself.
 */
export async function readImageBlock(
  path: string,
  maxBytes: number,
): Promise<{ block: ImageBlock } | { skipped: string }> {
  const mediaType = mediaTypeFor(path);
  if (!mediaType) return { skipped: `${path} is not an image format the providers accept` };

  try {
    const info = await stat(path);
    if (!info.isFile()) return { skipped: `${path} is not a file` };
    if (info.size > maxBytes) {
      return {
        skipped: `${path} is ${Math.round(info.size / 1024)}KB, over the ${Math.round(maxBytes / 1024)}KB limit`,
      };
    }
    const bytes = await readFile(path);
    return { block: { type: 'image', data: bytes.toString('base64'), mediaType, source: path } };
  } catch (e) {
    return { skipped: `${path} could not be read: ${(e as Error).message}` };
  }
}

/**
 * Drops all but the most recent `keep` images from a history.
 *
 * Images dominate a context window once there is more than one of them, and
 * an old screenshot is almost never what the model needs — it needs the
 * current one. Each removed block leaves a note so the model knows it saw
 * something rather than silently forgetting.
 */
export function evictOldImages(messages: Message[], keep: number): Message[] {
  const total = messages.reduce(
    (n, m) => n + m.content.filter((b) => b.type === 'image').length,
    0,
  );
  if (total <= keep) return messages;

  let remaining = total - keep;
  return messages.map((msg) => {
    if (remaining <= 0) return msg;
    if (!msg.content.some((b) => b.type === 'image')) return msg;

    const content = msg.content.map((block) => {
      if (block.type !== 'image' || remaining <= 0) return block;
      remaining -= 1;
      const where = block.source ? ` (${block.source})` : '';
      return {
        type: 'text' as const,
        text: `[an earlier image${where} was dropped to fit the context window]`,
      };
    });
    return { ...msg, content };
  });
}

/**
 * Reads the caps from configuration, falling back to the schema defaults.
 *
 * Only called once a turn has actually produced an image, so the agent loop
 * does not open the database on every turn just in case one shows up.
 */
export function imageLimits(): ImageLimits & { enabled: boolean; keepInHistory: number } {
  try {
    const v = loadConfig().config.vision;
    return {
      enabled: v.enabled,
      maxBytes: v.maxBytes,
      maxPerTurn: v.maxPerTurn,
      keepInHistory: v.keepInHistory,
    };
  } catch {
    return { enabled: true, maxBytes: 4_000_000, maxPerTurn: 2, keepInHistory: 2 };
  }
}

/**
 * Turns the image attachments a turn produced into content blocks.
 *
 * Returns the blocks plus a line per skipped image, which the caller appends
 * to the transcript — an image silently not sent is how you get an agent
 * confidently describing a screenshot it never received.
 */
export async function collectImageBlocks(
  paths: readonly string[],
): Promise<{ blocks: ImageBlock[]; notes: string[] }> {
  const limits = imageLimits();
  if (!limits.enabled || limits.maxPerTurn === 0) return { blocks: [], notes: [] };

  const blocks: ImageBlock[] = [];
  const notes: string[] = [];

  for (const path of paths) {
    if (blocks.length >= limits.maxPerTurn) {
      notes.push(`[${path} not sent: over the ${limits.maxPerTurn}-image limit for one turn]`);
      continue;
    }
    const result = await readImageBlock(path, limits.maxBytes);
    if ('block' in result) blocks.push(result.block);
    else notes.push(`[image not sent: ${result.skipped}]`);
  }

  return { blocks, notes };
}
