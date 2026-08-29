// Turning an incoming picture into something the agent can look at.
//
// The transport downloads the file and stops there. What happens to it is
// decided here, in one place, for every transport — the same split voice-intake
// makes, for the same reasons:
//
//   * Whether the model can see at all is asked before the turn, not during
//     it. A text-only endpoint handed an image block answers with a provider
//     error mid-turn that names neither images nor the setting that fixes it;
//     the user is left with a red message and no next step.
//   * A refusal is a reply, not a dropped message. Someone who sends a
//     screenshot is waiting for an answer, and "I can't see pictures with the
//     model I'm on" is one. Silence is what this module exists to end.
//   * The turn does not run on the caption alone. A caption is almost always
//     *about* the picture — "what's wrong here?" — so answering it without the
//     picture produces a confident answer to a question nobody asked.
//   * The file is temporary. On the refusal path it is deleted here, because
//     no turn will ever read it; on the accepted path the caller deletes it
//     once the turn is done, since the bytes are read inside the turn.

import { rm } from 'node:fs/promises';

import { imageLimits } from '../agent/images.ts';
import { IMAGE_SUPPORT_SETTING, providerAcceptsImages } from '../providers/vision.ts';
import type { Provider } from '../types/messages.ts';
import type { IncomingMessage } from './adapter.ts';

/** What the agent is told when a picture arrives with nothing written on it. */
const BARE_IMAGE_PROMPT = '[the user sent an image with no caption]';

/**
 * The sentence a user gets when the picture cannot be used.
 *
 * Deliberately one plain line naming the setting: whoever sent the screenshot
 * is mid-thought and needs to know it did not land and what to do about it,
 * not a paragraph about model modalities.
 */
export const NO_VISION_REPLY = `I can't look at images with the model I'm currently running — it isn't set up to accept them, so I've discarded that one. Describe it in words and I'll help, or set \`${IMAGE_SUPPORT_SETTING}\` to \`on\` if the model does take images and I got it wrong.`;

/** The same, for someone who turned images off themselves. */
export const VISION_DISABLED_REPLY =
  "I can't look at images right now — `vision.enabled` is off in the config, so I've discarded that one. Turn it back on, or describe the picture in words and I'll help.";

export type ImageIntakeResult =
  /** Run the turn on `text`, attaching `images` to the user's message. */
  | { kind: 'accepted'; text: string; images: readonly string[] }
  /** Send `reply` and run no turn. The file is already gone. */
  | { kind: 'refused'; reply: string; reason: string };

/**
 * Decides what to do with the picture on `msg`, if there is one.
 *
 * Never throws: this sits directly in front of the agent turn, and a failure
 * here must not cost the user their turn.
 */
export async function intakeImage(
  msg: IncomingMessage,
  provider: Provider,
): Promise<ImageIntakeResult> {
  if (!msg.image) return { kind: 'accepted', text: msg.text, images: [] };

  const path = msg.image.path;
  const refuse = async (reply: string, reason: string): Promise<ImageIntakeResult> => {
    await rm(path, { force: true }).catch(() => {});
    return { kind: 'refused', reply, reason };
  };

  // The user's own switch is read first: it is the one answer that needs no
  // network, and someone who turned vision off should not have their local
  // server woken up to confirm it.
  const limits = imageLimits();
  if (!limits.enabled || limits.maxPerTurn === 0) {
    return refuse(VISION_DISABLED_REPLY, 'vision disabled in config');
  }

  if (!(await providerAcceptsImages(provider))) {
    return refuse(NO_VISION_REPLY, `${provider.name} does not accept images`);
  }

  const caption = msg.text.trim();
  return {
    kind: 'accepted',
    text: caption || BARE_IMAGE_PROMPT,
    images: [path],
  };
}

/** Deletes the files an accepted intake handed to a turn. Never throws. */
export async function discardImages(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})));
}
