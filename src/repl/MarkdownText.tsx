// Lightweight inline-markdown renderer for assistant messages. Handles the
// subset that matters in chat output: **bold**, *italic*, `inline code`,
// fenced code blocks, headers, ordered/unordered lists, and blockquotes.
// Implementation is regex-based — a full CommonMark parser would be heavier
// than the value it adds here.

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

interface Props {
  text: string;
}

interface Block {
  key: string;
  node: ReactNode;
}

export function MarkdownText({ text }: Props) {
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b) => (
        <Box key={b.key} flexDirection="column">
          {b.node}
        </Box>
      ))}
    </Box>
  );
}

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx] ?? '';

    // Fenced code block: ``` or ~~~
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
      blocks.push({ key: `b${blocks.length}`, node: <CodeBlock lang={lang} code={code.join('\n')} /> });
      continue;
    }

    // Heading: # … to ###### …
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const content = heading[2] ?? '';
      blocks.push({ key: `b${blocks.length}`, node: <Heading level={level} text={content} /> });
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
      blocks.push({ key: `b${blocks.length}`, node: <BulletList items={items} /> });
      continue;
    }

    // Ordered list: 1. …
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*\d+\.\s+/.test(lines[idx] ?? '')) {
        items.push((lines[idx] ?? '').replace(/^\s*\d+\.\s+/, ''));
        idx++;
      }
      blocks.push({ key: `b${blocks.length}`, node: <OrderedList items={items} /> });
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (idx < lines.length && /^\s*>\s?/.test(lines[idx] ?? '')) {
        quoted.push((lines[idx] ?? '').replace(/^\s*>\s?/, ''));
        idx++;
      }
      blocks.push({ key: `b${blocks.length}`, node: <Quote lines={quoted} /> });
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      blocks.push({ key: `b${blocks.length}`, node: <Text> </Text> });
      idx++;
      continue;
    }

    // Plain paragraph (one line). MarkdownText is line-oriented; we don't
    // try to coalesce wrapped paragraphs because Ink's <Text> already wraps
    // long lines automatically.
    blocks.push({ key: `b${blocks.length}`, node: <Inline text={line} /> });
    idx++;
  }

  return blocks;
}

function Heading({ level, text }: { level: number; text: string }) {
  const colorByLevel = ['cyan', 'cyan', 'cyan', 'cyan', 'cyan', 'cyan'] as const;
  return (
    <Box marginTop={1}>
      <Text color={colorByLevel[level - 1] ?? 'cyan'} bold>
        {`${'#'.repeat(level)} ${text}`}
      </Text>
    </Box>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const lines = code.split('\n');
  return (
    <Box flexDirection="column" marginY={1}>
      {lang && (
        <Text dimColor>{`┌─ ${lang}`}</Text>
      )}
      {lines.map((l, i) => (
        <Box key={`c${i}`}>
          <Text dimColor color="cyan">{'│ '}</Text>
          <Text color="cyan">{l}</Text>
        </Box>
      ))}
      <Text dimColor>{'└──'}</Text>
    </Box>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={`bul${i}`}>
          <Text color="cyan">{'  • '}</Text>
          <Inline text={item} />
        </Box>
      ))}
    </Box>
  );
}

function OrderedList({ items }: { items: string[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={`ord${i}`}>
          <Text color="cyan">{`  ${i + 1}. `}</Text>
          <Inline text={item} />
        </Box>
      ))}
    </Box>
  );
}

function Quote({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column" marginY={1}>
      {lines.map((l, i) => (
        <Box key={`q${i}`}>
          <Text dimColor>{'  ▎ '}</Text>
          <Text dimColor italic>
            {l}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Inline parser

type InlinePart =
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
      if (linkMatch && linkMatch[1] && linkMatch[2]) {
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

function Inline({ text }: { text: string }) {
  const parts = parseInline(text);
  if (parts.length === 0) return <Text> </Text>;
  return (
    <Text>
      {parts.map((p, i) => {
        const key = `p${i}`;
        if (p.kind === 'bold') {
          return (
            <Text key={key} bold>
              {p.value}
            </Text>
          );
        }
        if (p.kind === 'italic') {
          return (
            <Text key={key} italic>
              {p.value}
            </Text>
          );
        }
        if (p.kind === 'code') {
          return (
            <Text key={key} color="cyan">
              {p.value}
            </Text>
          );
        }
        if (p.kind === 'link') {
          return (
            <Text key={key} color="blue" underline>
              {p.value}
            </Text>
          );
        }
        return <Text key={key}>{p.value}</Text>;
      })}
    </Text>
  );
}
