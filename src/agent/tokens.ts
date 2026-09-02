// Token estimation for the compaction budget.
//
// What this is not: a tokenizer. Asterisk talks to llama.cpp and
// Anthropic, which use three different vocabularies, and none of them exposes
// one cheaply enough to run over the whole history on every turn — llama.cpp's
// /tokenize is a network round trip, Anthropic's count_tokens is a billable
// API call, a local server usually has no endpoint at all. Shipping a BPE table would pin the
// estimate to one vendor's vocabulary and be wrong for the other two.
//
// What it is: a character-class model that errs high. `chars / 4` is an
// English-prose average, and it fails in the three places that matter most —
//
//   * CJK, where one character is often a whole token, so chars/4 under-counts
//     by roughly 4x. A Chinese conversation would report a quarter of its real
//     size and overflow the window with compaction never having fired.
//   * punctuation-dense code and JSON, where `{`, `":` and `=>` each cost a
//     token or so, and chars/4 under-counts by 2–3x.
//   * scripts the vocabulary does not cover, which the tokenizer spells out one
//     raw UTF-8 byte at a time — two tokens for a letter, not a quarter of one.
//
// Under-counting is the dangerous direction: it means believing the history
// fits when it does not, and the provider answering with a context-overflow
// error. Every rule below rounds towards over-counting for that reason.
//
// Calibration. The per-script constants are measured, not inherited from
// rules of thumb: llama.cpp's /tokenize over the multilingual Qwen3 vocabulary
// (n_vocab 248320), per character class, with each token attributed across the
// characters it spells. That is one vocabulary, and the limit is worth stating
// plainly — nothing here has been checked against Anthropic's tokenizer. It is
// still the right basis for this number, because the estimate only has to pick
// a compaction point. What it must get right is the *ratio* between scripts,
// and that ratio is a property of how much of a script a multilingual BPE
// vocabulary bothers to cover, which is a fact about the script and its corpus
// rather than about whose vocabulary it is. A uniform ±20% error is absorbed by
// the 0.6 budget in compaction.ts; a 2x error between two scripts in the same
// conversation is not.
//
// Measured characters per token, and what it costs to ignore the spread:
//
//   Cyrillic U+0410-044F  3.6 | Arabic 3.8 | Greek 3.4 | Thai 4.1
//   Cyrillic U+0450-045F  2.1 | Hebrew 2.3 | Devanagari 2.7
//   Cyrillic U+0460-052F  1.4 | Georgian 1.8 | Armenian 1.4
//
// One constant for all of them is what was here before, and the previous
// comment was half right. A flat 0.5 really did over-count Russian, by 1.61x
// measured — but the correction to 1/3 was applied to every non-Latin script at
// once, and Armenian is not Russian. Armenian came out at 0.46 of its real
// cost, Georgian 0.58, Hebrew 0.73. The bug was the single class, not the
// number in it.
//
// Two places still miss, both measured and both left alone deliberately:
// Kazakh reads 0.85, because its *words* are unfamiliar to the vocabulary even
// where its letters are the well-covered Russian ones — no per-character model
// can see that. Punctuation-dense TypeScript reads 0.87, which is the ASCII
// path below and a separate problem: real punctuation cost swings from 0.35
// tokens/char in JSON to 0.91 in prose, so no single constant fixes both.

/** Cost of a message's role and framing, independent of its content. */
const MESSAGE_OVERHEAD = 4;

/**
 * Runs of ASCII letters and digits up to this length are usually one token —
 * BPE vocabularies carry whole common words. Past it, cost grows by roughly
 * one token per four characters.
 */
const SHORT_WORD = 6;
const CHARS_PER_TOKEN = 4;

// CJK ideographs, kana, hangul, and full-width punctuation. Roughly one token
// per character across every vocabulary in use.
const CJK = /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/**
 * Non-Latin scripts the vocabulary carries syllables and whole words for.
 * Measured 3.4-4.1 characters per token; 0.36 sits above all of them so the
 * estimate stays on the safe side of every one.
 */
const COVERED_SCRIPT_COST = 0.36;

/**
 * Everything else in the BMP: scripts measured around 2.1-2.7 characters per
 * token, and — deliberately — scripts nobody has measured at all. An unknown
 * script is far likelier to be poorly covered than well covered, so the
 * fallthrough belongs here rather than in the cheap class. General punctuation
 * (U+2000-206F: em dashes, curly quotes, the ellipsis) measures 1.8 characters
 * per token and lands here correctly by the same rule.
 */
const PARTIAL_SCRIPT_COST = 0.52;

/**
 * Scripts with no vocabulary coverage, spelled out in raw UTF-8 bytes: 1.4-1.8
 * characters per token, so a letter costs more than half a token and often
 * more than one. This is the class the old single `else` branch was missing,
 * and missing it is what let an Armenian conversation report less than half
 * its real size.
 */
const BYTE_FALLBACK_COST = 0.8;

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

function isAsciiSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * Scripts measured at 3.4 characters per token or better.
 *
 * Cyrillic is split mid-block on purpose. U+0410-044F is the Russian alphabet
 * and is covered well; the letters just outside it that Ukrainian, Serbian and
 * Kazakh need are not, and charging them the Russian rate is what put Ukrainian
 * under 1.0. Ranges rather than a regex because this runs per character over
 * the whole history.
 */
function isWellCoveredScript(code: number): boolean {
  return (
    (code >= 0x0410 && code <= 0x044f) || // Cyrillic, the Russian alphabet
    (code >= 0x00a0 && code <= 0x024f) || // Latin-1 Supplement, Latin Extended-A/B
    (code >= 0x0600 && code <= 0x06ff) || // Arabic
    (code >= 0x0370 && code <= 0x03ff) || // Greek and Coptic
    (code >= 0x0e00 && code <= 0x0e7f) // Thai
  );
}

/** Scripts the tokenizer falls back to raw bytes for. */
function isByteFallbackScript(code: number): boolean {
  return (
    (code >= 0x0530 && code <= 0x058f) || // Armenian
    (code >= 0x0460 && code <= 0x052f) || // Cyrillic Extended-A/B and Supplement
    (code >= 0x10a0 && code <= 0x10ff) // Georgian
  );
}

/** Cost of one run of ASCII word characters. */
function wordCost(length: number): number {
  if (length === 0) return 0;
  if (length <= SHORT_WORD) return 1;
  return Math.ceil(length / CHARS_PER_TOKEN);
}

/**
 * Estimated tokens for a string.
 *
 * Synchronous and single-pass by design: it runs over the entire history at
 * the top of every turn, so it must not allocate per character or await
 * anything. The script ranges are all below U+1100 and are therefore tested
 * before the CJK pattern — a Russian or Armenian conversation never runs a
 * regex at all, and no code point can match both.
 */
export function estimateTextTokens(text: string): number {
  let total = 0;
  let wordRun = 0;

  // Iterating by code point rather than code unit so an emoji counts once
  // rather than twice as two surrogate halves.
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;

    if (code < 128) {
      if (isAsciiWordChar(code)) {
        wordRun += 1;
        continue;
      }
      total += wordCost(wordRun);
      wordRun = 0;
      // Whitespace usually merges into the following token; punctuation
      // usually does not, and in code it dominates.
      total += isAsciiSpace(code) ? 0.25 : 0.5;
      continue;
    }

    total += wordCost(wordRun);
    wordRun = 0;

    if (code > 0xffff) {
      // Emoji and other astral characters routinely cost several tokens.
      total += 2;
    } else if (isWellCoveredScript(code)) {
      total += COVERED_SCRIPT_COST;
    } else if (isByteFallbackScript(code)) {
      total += BYTE_FALLBACK_COST;
    } else if (CJK.test(ch)) {
      total += 1;
    } else {
      total += PARTIAL_SCRIPT_COST;
    }
  }

  total += wordCost(wordRun);
  return total;
}

/**
 * Estimated tokens for an image, from the size of its base64 payload.
 *
 * Anthropic bills roughly (width × height) / 750, which needs dimensions we
 * would have to decode the file to learn. Bytes are a usable stand-in: a
 * 100KB screenshot lands near 1.1k tokens, a 1MB one near the 1.6k cap that
 * matches a full 1568px-edge image. Rough, and deliberately not cheap — the
 * failure that matters is under-counting an image and overflowing the window.
 */
export function estimateImageTokens(base64Length: number): number {
  const bytes = Math.ceil((base64Length * 3) / 4);
  return Math.min(1600, 750 + Math.round(bytes / 900));
}

/** Per-message framing cost, exported so callers can reason about the total. */
export function messageOverhead(): number {
  return MESSAGE_OVERHEAD;
}
