// Runaway-repetition detection for streamed completions.
//
// Quantised models fall into loops: the same sentence, the same list item, the
// same closing brace, emitted until something stops them. Nothing in the
// existing timeouts does — the total timeout is 300s of wasted generation, and
// the idle timeout never fires because tokens keep arriving. With
// `openaiCompatible.maxTokens` left at its default of 0 no `max_tokens` is sent
// either, so the only real bound is the context window.
//
// This is a *conservative* detector. It only trips on a tail that is exactly
// periodic over more than a kilobyte of output, which normal prose, code and
// tables do not produce. The cost of a false positive is a truncated answer,
// so the thresholds are deliberately far above anything a model writes on
// purpose.

export interface RunawayRepetition {
  /** Index into the text where the repeating run begins. */
  start: number;
  /** The repeating unit — the shortest one that explains the run. */
  unit: string;
  /** How many times the unit repeats, including the first occurrence. */
  repeats: number;
}

export interface RepetitionOptions {
  /** Longest repeating unit considered. A whole repeated paragraph is longer
   *  than this, but a model looping on a paragraph repeats a shorter unit
   *  inside it too. */
  maxUnit?: number;
  /** Minimum total characters of repetition before the detector fires. */
  minSpan?: number;
  /** Minimum number of repeats, so `abcabc` at unit 3 is not enough. */
  minRepeats?: number;
  /** How much of the tail to examine. */
  windowSize?: number;
}

const DEFAULTS = {
  maxUnit: 160,
  minSpan: 1200,
  minRepeats: 4,
  windowSize: 4096,
} as const;

/**
 * Finds a repeating tail, or null. Pure — used both incrementally while
 * streaming and once over a non-streamed completion.
 */
export function findRunawayRepetition(
  text: string,
  options: RepetitionOptions = {},
): RunawayRepetition | null {
  const maxUnit = options.maxUnit ?? DEFAULTS.maxUnit;
  const minSpan = options.minSpan ?? DEFAULTS.minSpan;
  const minRepeats = options.minRepeats ?? DEFAULTS.minRepeats;
  const windowSize = options.windowSize ?? DEFAULTS.windowSize;

  if (text.length < minSpan) return null;
  const from = Math.max(0, text.length - windowSize);
  const end = text.length;

  // Smallest period first: a run of "abab…" should be reported as unit "ab",
  // not "abab", so the kept prefix below is as short as it can honestly be.
  for (let unit = 1; unit <= maxUnit; unit++) {
    const limit = end - unit;
    if (limit <= from) break;
    let i = end - 1;
    while (i >= from + unit && text[i] === text[i - unit]) i--;
    const matched = end - 1 - i;
    const span = matched + unit;
    if (span < minSpan) continue;
    const repeats = Math.floor(span / unit);
    if (repeats < minRepeats) continue;
    const start = end - span;
    return { start, unit: text.slice(start, start + unit), repeats };
  }
  return null;
}

export interface RepetitionGuard {
  /** Feed a streamed delta. Returns true the first time runaway is detected. */
  push(delta: string): boolean;
  /** The detection, or null while the stream still looks healthy. */
  readonly hit: RunawayRepetition | null;
  /** Length to truncate the accumulated text to — the run start plus one
   *  copy of the unit, so the reply still reads as a sentence rather than
   *  stopping mid-word. */
  keepLength(): number;
}

/** How many new characters to accept between scans. Scanning per delta would
 *  run the detector once per token for no extra signal. */
const CHECK_EVERY = 256;

export function createRepetitionGuard(options: RepetitionOptions = {}): RepetitionGuard {
  let text = '';
  let sinceCheck = 0;
  let hit: RunawayRepetition | null = null;

  return {
    push(delta: string): boolean {
      if (hit !== null || !delta) return false;
      text += delta;
      sinceCheck += delta.length;
      if (sinceCheck < CHECK_EVERY) return false;
      sinceCheck = 0;
      hit = findRunawayRepetition(text, options);
      return hit !== null;
    },
    get hit(): RunawayRepetition | null {
      return hit;
    },
    keepLength(): number {
      return hit === null ? text.length : hit.start + hit.unit.length;
    },
  };
}
