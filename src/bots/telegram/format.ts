// Convert the agent's plain markdown into Telegram HTML so emphasis, code,
// links etc. render instead of showing as literal markup. Telegram supports
// a small subset of HTML: <b> <i> <u> <s> <code> <pre> <a> <blockquote>
// (plus a couple of variants). Reference:
//   https://core.telegram.org/bots/api#html-style
//
// Approach: extract code spans first (their contents must NOT be re-parsed
// as markdown), HTML-escape everything, then apply inline transforms on the
// non-code segments.

const TG_HTML_TAGS = ['b', 'i', 'u', 's', 'a', 'code', 'pre', 'blockquote'] as const;

interface Segment {
  kind: 'text' | 'code' | 'pre';
  /** Already HTML-escaped, ready to drop into output. */
  body: string;
  /** For pre blocks, the optional language hint (used for the class attr). */
  lang?: string;
}

/** Convert markdown-flavoured text to Telegram HTML. Safe to apply to a
 *  partial buffer (e.g. a stream chunk); see `balanceOpenTags` below. */
export function markdownToTelegramHtml(input: string): string {
  const segs = tokenize(input);
  const out: string[] = [];
  for (const s of segs) {
    if (s.kind === 'text') {
      out.push(applyInline(s.body));
    } else if (s.kind === 'code') {
      out.push(`<code>${s.body}</code>`);
    } else {
      const cls = s.lang ? ` class="language-${escapeAttr(s.lang)}"` : '';
      out.push(`<pre><code${cls}>${s.body}</code></pre>`);
    }
  }
  return out.join('');
}

/** During mid-stream edits we may have an unclosed `<b>`/`<i>`/etc.
 *  Telegram rejects the edit if tags don't balance, so close any opens. */
export function balanceOpenTags(html: string): string {
  const stack: string[] = [];
  // Walk the string, push on open tags, pop on close tags.
  const re = /<\/?([a-z]+)(?:\s[^>]*)?>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  for (; m !== null; m = re.exec(html)) {
    const tag = m[1]?.toLowerCase();
    if (!tag || !TG_HTML_TAGS.includes(tag as (typeof TG_HTML_TAGS)[number])) continue;
    if (m[0].startsWith('</')) {
      // pop matching
      const idx = stack.lastIndexOf(tag);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push(tag);
    }
  }
  if (stack.length === 0) return html;
  // Close in reverse order.
  return (
    html +
    stack
      .reverse()
      .map((t) => `</${t}>`)
      .join('')
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Length-bounded splitting for already-rendered, fully-balanced HTML
// ─────────────────────────────────────────────────────────────────────────

interface TagToken {
  start: number;
  end: number;
  name: string;
  close: boolean;
  /** The tag's exact source text — carries any attribute, e.g. the fence's
   *  `class="language-ts"` — so reopening it reproduces it verbatim. */
  raw: string;
}

function findTagTokens(html: string): TagToken[] {
  const tokens: TagToken[] = [];
  const re = /<\/?([a-z]+)(?:\s[^>]*)?>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  for (; m !== null; m = re.exec(html)) {
    const name = m[1]?.toLowerCase();
    if (!name || !TG_HTML_TAGS.includes(name as (typeof TG_HTML_TAGS)[number])) continue;
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      name,
      close: m[0].startsWith('</'),
      raw: m[0],
    });
  }
  return tokens;
}

interface OpenTag {
  name: string;
  raw: string;
}

/** Replays every tag fully inside [from, to) against `base`, returning the
 *  resulting open-tag stack — what a chunk starting at `from` needs
 *  reopened, and what a chunk ending at `to` needs closed. */
function stackAfter(
  base: readonly OpenTag[],
  tags: readonly TagToken[],
  from: number,
  to: number,
): OpenTag[] {
  const next = [...base];
  for (const t of tags) {
    if (t.start < from || t.end > to) continue;
    if (t.close) {
      const idx = next.map((o) => o.name).lastIndexOf(t.name);
      if (idx !== -1) next.splice(idx, 1);
    } else {
      next.push({ name: t.name, raw: t.raw });
    }
  }
  return next;
}

function closingTags(stack: readonly OpenTag[]): string {
  return stack
    .slice()
    .reverse()
    .map((t) => `</${t.name}>`)
    .join('');
}

/**
 * Splits already-rendered, fully-balanced Telegram HTML into chunks no
 * longer than `max` chars, without ever cutting through a tag.
 *
 * A plain `slice(i, i + max)` (the bug this replaced) can land inside a tag
 * — e.g. cut `<pre><code class="langua` / `ge-ts">…` — which Telegram
 * rejects outright, and whose plain-text fallback (`stripTags`) then leaves
 * the broken fragment visible verbatim, since it has no closing `>` for the
 * regexp to match. Here a candidate boundary that would land inside a tag is
 * pulled back to just before that tag, and whatever tag is left open at a
 * chunk's end is closed there and reopened (with its original attributes)
 * at the next chunk's start, so every chunk is independently valid markup.
 */
export function chunkHtml(html: string, max: number): string[] {
  if (html.length <= max) return [html];
  const tags = findTagTokens(html);
  const chunks: string[] = [];
  let pos = 0;
  let stack: OpenTag[] = [];

  while (pos < html.length) {
    const prefix = stack.map((t) => t.raw).join('');
    let end = Math.min(pos + Math.max(1, max - prefix.length), html.length);

    // Never cut through a tag — back the boundary off to its start (or, if
    // the tag itself starts at/before `pos`, keep it whole even if that
    // overflows `max`; a single tag is never worth further splitting).
    for (let guard = 0; guard < 6; guard++) {
      const straddling = tags.find((t) => t.start < end && end < t.end);
      if (!straddling) break;
      end = straddling.start > pos ? straddling.start : straddling.end;
      if (straddling.start <= pos) break;
    }

    // Shrink further if reopening + closing tags would push this chunk over
    // `max`, then re-check for a straddled tag at the new boundary.
    for (let guard = 0; guard < 6; guard++) {
      const total =
        prefix.length + (end - pos) + closingTags(stackAfter(stack, tags, pos, end)).length;
      if (total <= max || end >= html.length) break;
      end = Math.max(pos + 1, end - (total - max));
      const straddling = tags.find((t) => t.start < end && end < t.end);
      if (straddling) end = straddling.start > pos ? straddling.start : straddling.end;
    }

    const nextStack = stackAfter(stack, tags, pos, end);
    chunks.push(prefix + html.slice(pos, end) + closingTags(nextStack));
    stack = nextStack;
    pos = end;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────
//  Tokeniser
// ─────────────────────────────────────────────────────────────────────────

function tokenize(input: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < input.length) {
    // Fenced code block: ```lang\n...\n```
    if (input.startsWith('```', i)) {
      const end = input.indexOf('```', i + 3);
      const block = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
      const newline = block.indexOf('\n');
      const lang = newline === -1 ? block.trim() : block.slice(0, newline).trim();
      const body = newline === -1 ? '' : block.slice(newline + 1);
      const seg: Segment = { kind: 'pre', body: escapeHtml(body) };
      if (lang) seg.lang = lang;
      out.push(seg);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    // Inline code: `...` (no backticks inside; spec says not greedy across newlines).
    if (input[i] === '`') {
      const end = input.indexOf('`', i + 1);
      if (end !== -1 && end - i < 200 && !input.slice(i + 1, end).includes('\n')) {
        out.push({ kind: 'code', body: escapeHtml(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    // Plain run — collect until the next backtick or fence.
    let j = i;
    while (j < input.length) {
      if (input.startsWith('```', j)) break;
      if (input[j] === '`') {
        const end = input.indexOf('`', j + 1);
        if (end !== -1 && end - j < 200 && !input.slice(j + 1, end).includes('\n')) break;
      }
      j++;
    }
    out.push({ kind: 'text', body: escapeHtml(input.slice(i, j)) });
    i = j;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Inline transforms (applied to already-escaped plain text segments only)
// ─────────────────────────────────────────────────────────────────────────

function applyInline(escaped: string): string {
  let s = escaped;
  // Bold first (longer markers consume before italic).  **x** or __x__
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  // Italic.  *x*  or  _x_  (single)
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_])_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g, '$1<i>$2</i>');
  // Strikethrough.  ~~x~~
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  // Links.  [text](url)
  // The url arrives already HTML-escaped — see finishAttrEscape.
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, txt, url) => `<a href="${finishAttrEscape(url)}">${txt}</a>`,
  );
  // Headings — Telegram has no header tags. Render as bold + a blank line so
  // there is visual separation from the body text.
  s = s.replace(/(^|\n)(#{1,6})\s+([^\n]+)/g, (_, lead, _hashes, head) => `${lead}<b>${head}</b>`);
  // Bullet markers — Telegram has no list tags; just unify the glyph.
  s = s.replace(/(^|\n)\s*[-*+]\s+/g, '$1• ');
  // Block quotes per-line. Coalesce contiguous lines into a single
  // <blockquote> so Telegram renders the whole quote as one block.
  s = collapseBlockquote(s);
  return s;
}

function collapseBlockquote(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    out.push(`<blockquote>${buf.join('\n')}</blockquote>`);
    buf = [];
  };
  for (const ln of lines) {
    const m = /^&gt;\s?(.*)$/.exec(ln);
    if (m) {
      buf.push(m[1] ?? '');
    } else {
      flush();
      out.push(ln);
    }
  }
  flush();
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
//  HTML escape helpers
// ─────────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/**
 * Finishes attribute-escaping a value `tokenize` already put through
 * `escapeHtml` — so `&`, `<` and `>` are done, and only `"` is left.
 *
 * Running the full `escapeAttr` here instead is the bug this replaced: the
 * `&amp;` already in the string became `&amp;amp;`, and because an HTML parser
 * decodes entities inside an attribute, Telegram turned that back into a
 * literal `&amp;` in the href. Every link with two query parameters — a
 * YouTube timestamp, a search result, anything with `?a=1&b=2` — arrived
 * broken. Note that `escapeAttr` is still right for the fence language hint,
 * which reaches it raw.
 */
function finishAttrEscape(escaped: string): string {
  return escaped.replace(/"/g, '&quot;');
}
