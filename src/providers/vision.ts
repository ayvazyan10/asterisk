// Whether the model on the other end can look at a picture.
//
// Three tiers, in this order, because they differ in how much they actually
// know:
//
//   1. The user said so. `openaiCompatible.imageSupport` is `on` or `off` and
//      that is the end of it — a human who has seen their own server start up
//      outranks anything guessed from a wire format.
//   2. The server said so. llama.cpp publishes the loaded model's modalities
//      (see model-detect.ts), and whether an mmproj is attached is a fact
//      about the running process, not about the model's name.
//   3. Nothing said anything, so the name is read. This is the last resort and
//      it is deliberately a poor one.
//
// Tier 3 errs toward refusing, and the reason is asymmetry. A wrong "yes"
// sends image blocks to an endpoint that rejects them, and what the user gets
// is a provider error mid-turn that names neither images nor the setting that
// would fix it. A wrong "no" gets one plain sentence naming
// `openaiCompatible.imageSupport`, which the user flips once and never thinks
// about again. The costs are not close.
//
// The name heuristic exists only for servers that report nothing at all. It is
// not a model registry and must never be treated as one: the machine this was
// built for serves `qwen3.8-27b-abliterated` with an mmproj, whose name
// contains no "vl", no "vision" and no "llava". Tier 2 is what gets that right,
// and any impulse to fix such a case by adding another regex here is a sign
// the detection tier was skipped.

import type { Provider } from '../types/messages.ts';

/** How `openaiCompatible.imageSupport` reads. */
export type ImageSupportMode = 'auto' | 'on' | 'off';

/** Named once so the refusal text and the schema cannot drift apart. */
export const IMAGE_SUPPORT_SETTING = 'openaiCompatible.imageSupport';

/**
 * Families whose *names* are the only clue left.
 *
 * Matched against a lowercased id. Anything ambiguous is left out on purpose:
 * a family that only sometimes ships a vision variant belongs in tier 2, and
 * a false positive here is the expensive kind of wrong.
 */
const VISION_NAME_PATTERNS: readonly RegExp[] = [
  /llava/,
  /bakllava/,
  /\bvision\b|-vision|vision-/,
  /multimodal/,
  // qwen2-vl, qwen2.5-vl, glm-4.1v, "…-vl-7b" — a standalone "vl" segment.
  /(^|[^a-z])vl([^a-z]|$)/,
  /internvl/,
  /minicpm-?v/,
  /pixtral/,
  /moondream/,
  /idefics/,
  /cogvlm/,
  /smolvlm/,
  /granite-?vision/,
  /molmo/,
  /aya-?vision/,
  // Anchored so "provisional" and friends cannot claim it.
  /(^|[^a-z])ovis/,
  // glm-4v, yi-vl's "-4v" style suffix.
  /(^|[^a-z0-9])\d+v($|[^a-z])/,
  // gemma 3 is multimodal where gemma 2 is not, so the generation matters.
  /gemma-?3/,
];

/**
 * A guess from the model id alone. False whenever it cannot tell.
 *
 * Only reached when neither the config nor the server had an answer — see the
 * module header for why a guess defaults to no.
 */
export function modelIdSuggestsVision(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  return VISION_NAME_PATTERNS.some((re) => re.test(id));
}

export interface ImageSupportInput {
  mode: ImageSupportMode;
  /** The model that will actually answer — detected, or the configured pin. */
  modelId: string;
  /** What the server reported, when it reported anything. */
  detected?: boolean | undefined;
}

/** Settles the three tiers into the one boolean the gate needs. */
export function resolveImageSupport(input: ImageSupportInput): boolean {
  if (input.mode === 'on') return true;
  if (input.mode === 'off') return false;
  if (input.detected !== undefined) return input.detected;
  return modelIdSuggestsVision(input.modelId);
}

/**
 * Asks a provider whether it takes images, applying the fail-closed default
 * for one that never declared the capability.
 *
 * Never throws: a backend that cannot answer the question has not said yes,
 * and the caller is about to refuse politely either way.
 */
export async function providerAcceptsImages(provider: Provider): Promise<boolean> {
  if (!provider.supportsImages) return false;
  try {
    return await provider.supportsImages();
  } catch {
    return false;
  }
}
