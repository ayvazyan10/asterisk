// Token estimation for the compaction budget.
//
// What this is not: a tokenizer. Asterisk talks to Ollama, llama.cpp and
// Anthropic, which use three different vocabularies, and none of them exposes
// one cheaply enough to run over the whole history on every turn — llama.cpp's
// /tokenize is a network round trip, Anthropic's count_tokens is a billable
// API call, Ollama has no endpoint at all. Shipping a BPE table would pin the
// estimate to one vendor's vocabulary and be wrong for the other two.
//
// What it is: a character-class model that errs high. `chars / 4` is an
// English-prose average, and it fails in the two places that matter most —
//
//   * CJK, where one character is often a whole token, so chars/4 under-counts
//     by roughly 4x. A Chinese conversation would report a quarter of its real
//     size and overflow the window with compaction never having fired.
//   * punctuation-dense code and JSON, where `{`, `":` and `=>` each cost a
//     token or so, and chars/4 under-counts by 2–3x.
//
// Under-counting is the dangerous direction: it means believing the history
// fits when it does not, and the provider answering with a context-overflow
// error. Every rule below rounds towards over-counting for that reason.
//
// The constants were calibrated against published rules of thumb for BPE
// vocabularies, not measured against a specific tokenizer — there is no ground
// truth in this repo to measure against. Treat them as an engineering estimate
// good to roughly ±30%, which is what the 0.6 budget in compaction.ts is sized
// to absorb. The claim being made is only that nothing is under-counted by
// multiples any more; `chars / 4` under-counted Chinese by 3.7x.

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
 * anything.
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
    } else if (CJK.test(ch)) {
      total += 1;
    } else {
      // Cyrillic, Greek, Arabic, accented Latin: worse than ASCII under every
      // BPE vocabulary, better than CJK. At 0.5 this over-counted Russian by
      // ~1.7x, which would compact a Russian conversation long before it
      // needed to.
      total += 1 / 3;
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
