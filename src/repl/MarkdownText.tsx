// Lightweight inline-markdown renderer for assistant messages. Handles the
// subset that matters in chat output: **bold**, *italic*, `inline code`,
// fenced code blocks, headers, ordered/unordered lists, and blockquotes.
//
// The grammar itself lives in ./markdown.ts — this file is only the mapping
// from block descriptors to Ink elements.

import { Box, Text } from 'ink';

import { type InlinePart, type MarkdownBlock, parseBlocks, parseInline } from './markdown.ts';

// Re-exported because this module is where callers reach for the renderer and
// its parser together.
export { parseInline, parseBlocks };
export type { InlinePart, MarkdownBlock };

interface Props {
  text: string;
}

export function MarkdownText({ text }: Props) {
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <Box key={`b${i}:${block.kind}`} flexDirection="column">
          <BlockView block={block} />
        </Box>
      ))}
    </Box>
  );
}

function BlockView({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'code':
      return <CodeBlock lang={block.lang} code={block.code} />;
    case 'heading':
      return <Heading level={block.level} text={block.text} />;
    case 'bullets':
      return <BulletList items={block.items} />;
    case 'ordered':
      return <OrderedList items={block.items} />;
    case 'quote':
      return <Quote lines={block.lines} />;
    case 'blank':
      return <Text> </Text>;
    default:
      return <Inline text={block.text} />;
  }
}

function Heading({ level, text }: { level: number; text: string }) {
  return (
    <Box marginTop={1}>
      <Text color="cyan" bold>
        {`${'#'.repeat(level)} ${text}`}
      </Text>
    </Box>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const lines = code.split('\n');
  return (
    <Box flexDirection="column" marginY={1}>
      {lang && <Text dimColor>{`┌─ ${lang}`}</Text>}
      {lines.map((l, i) => (
        <Box key={`c${i}:${l}`}>
          <Text dimColor color="cyan">
            {'│ '}
          </Text>
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
        <Box key={`bul${i}:${item}`}>
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
        <Box key={`ord${i}:${item}`}>
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
        <Box key={`q${i}:${l}`}>
          <Text dimColor>{'  ▎ '}</Text>
          <Text dimColor italic>
            {l}
          </Text>
        </Box>
      ))}
    </Box>
  );
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
