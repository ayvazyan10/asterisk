// Markdown parsing for assistant messages — the pure half of MarkdownText.
// Splits text into block descriptors and inline runs; rendering them is
// MarkdownText.tsx's job.
//
// Kept separate from the component so the grammar can be exercised directly.
// The parser is where the behaviour lives (what counts as a fence, what an
// unterminated one does, how a malformed link degrades); asserting that
// through rendered Ink frames would test the frame layout instead.
//
// Deliberately regex-based and line-oriented. A full CommonMark parser would
// be heavier than the value it adds for chat output.

export type MarkdownBlock =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'blank' }
  | { kind: 'paragraph'; text: string };

export function parseBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx] ?? '';

    // Fenced code block: ``` or ~~~. An unterminated fence swallows the rest
    // of the message rather than leaking the raw backticks into the chat.
    const fence = /^(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const lang = (fence[2] ?? '').trim();
      const code: string[] = [];
      idx++;
      while (idx < lines.length && !/^(```|~~~)\s*$/.test(lines[idx] ?? '')) {
        code.push(lines[idx] ?? '');
        idx++;
      }
      idx++;
      blocks.push({ kind: 'code', lang, code: code.join('\n') });
      continue;
    }

    // Heading: # … to ###### …
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]?.length ?? 1,
        text: heading[2] ?? '',
      });
      idx++;
      continue;
    }

    // Bullet list: - …, * …, + …
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*[-*+]\s+/.test(lines[idx] ?? '')) {
        items.push((lines[idx] ?? '').replace(/^\s*[-*+]\s+/, ''));
        idx++;
      }
      blocks.push({ kind: 'bullets', items });
      continue;
    }

    // Ordered list: 1. …
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*\d+\.\s+/.test(lines[idx] ?? '')) {
        items.push((lines[idx] ?? '').replace(/^\s*\d+\.\s+/, ''));
        idx++;
      }
      blocks.push({ kind: 'ordered', items });
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (idx < lines.length && /^\s*>\s?/.test(lines[idx] ?? '')) {
        quoted.push((lines[idx] ?? '').replace(/^\s*>\s?/, ''));
        idx++;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    if (line.trim() === '') {
      blocks.push({ kind: 'blank' });
      idx++;
      continue;
    }

    // Plain paragraph (one line). Line-oriented on purpose: Ink's <Text>
    // already wraps long lines, so coalescing wrapped paragraphs would only
    // move the wrapping decision somewhere worse.
    blocks.push({ kind: 'paragraph', text: line });
    idx++;
  }

  return blocks;
}

export type InlinePart =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; value: string; href: string };

const INLINE_RE =
  /(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(`[^`\n]+?`)|(\[[^\]\n]+?\]\([^)\n]+?\))/g;

export function parseInline(text: string): InlinePart[] {
  const out: InlinePart[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const matchStart = m.index ?? 0;
    if (matchStart > lastIndex) {
      out.push({ kind: 'text', value: text.slice(lastIndex, matchStart) });
    }
    if (m[1]) out.push({ kind: 'bold', value: m[1].slice(2, -2) });
    else if (m[2]) out.push({ kind: 'bold', value: m[2].slice(2, -2) });
    else if (m[3]) out.push({ kind: 'italic', value: m[3].slice(1, -1) });
    else if (m[4]) out.push({ kind: 'italic', value: m[4].slice(1, -1) });
    else if (m[5]) out.push({ kind: 'code', value: m[5].slice(1, -1) });
    else if (m[6]) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(m[6]);
      if (linkMatch?.[1] && linkMatch[2]) {
        out.push({ kind: 'link', value: linkMatch[1], href: linkMatch[2] });
      } else {
        out.push({ kind: 'text', value: m[6] });
      }
    }
    lastIndex = matchStart + m[0].length;
  }
  if (lastIndex < text.length) out.push({ kind: 'text', value: text.slice(lastIndex) });
  return out;
}
