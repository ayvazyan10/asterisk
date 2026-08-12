// Markdown rendering for assistant messages. The model writes this text, so
// the parser has to survive whatever it produces — including markup that is
// half-finished because a stream was cut off mid-token.

import { describe, expect, it } from 'vitest';

import { MarkdownText } from '../src/repl/MarkdownText.tsx';
import { parseBlocks, parseInline } from '../src/repl/markdown.ts';
import { flush, renderInk } from './repl-harness.ts';

describe('parseBlocks — fenced code', () => {
  it('captures the body and drops the fences', () => {
    const blocks = parseBlocks('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'code', lang: 'ts', code: 'const a = 1;\nconst b = 2;' });
  });

  it('accepts tilde fences', () => {
    expect(parseBlocks('~~~\nx\n~~~')[0]).toEqual({ kind: 'code', lang: '', code: 'x' });
  });

  it('lets a tilde fence close a backtick fence', () => {
    // Being lenient here is deliberate: a small model that opens with ``` and
    // closes with ~~~ should not swallow the rest of the reply.
    expect(parseBlocks('```\nx\n~~~\nafter')).toEqual([
      { kind: 'code', lang: '', code: 'x' },
      { kind: 'paragraph', text: 'after' },
    ]);
  });

  it('swallows the remainder when the fence is never closed', () => {
    // A truncated stream is the common case. Showing the tail as code is
    // better than leaking raw backticks into the chat.
    const blocks = parseBlocks('```py\nprint(1)\nprint(2)');
    expect(blocks).toEqual([{ kind: 'code', lang: 'py', code: 'print(1)\nprint(2)' }]);
  });

  it('handles an empty fenced block', () => {
    expect(parseBlocks('```\n```')).toEqual([{ kind: 'code', lang: '', code: '' }]);
  });

  it('keeps everything after the fence marker as the language tag', () => {
    expect(parseBlocks('```js title=x\nq\n```')[0]).toMatchObject({ lang: 'js title=x' });
  });

  it('does not treat markup inside a fence as markup', () => {
    const blocks = parseBlocks('```\n# not a heading\n- not a bullet\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ code: '# not a heading\n- not a bullet' });
  });
});

describe('parseBlocks — headings', () => {
  it('recognises every level from 1 to 6', () => {
    for (let level = 1; level <= 6; level++) {
      const blocks = parseBlocks(`${'#'.repeat(level)} Title`);
      expect(blocks[0]).toEqual({ kind: 'heading', level, text: 'Title' });
    }
  });

  it('rejects seven hashes and hashes with no space', () => {
    expect(parseBlocks('####### too deep')[0]?.kind).toBe('paragraph');
    expect(parseBlocks('#nospace')[0]?.kind).toBe('paragraph');
    expect(parseBlocks('#')[0]?.kind).toBe('paragraph');
  });

  it('rejects a heading with no text after the hashes', () => {
    expect(parseBlocks('## ')[0]?.kind).toBe('paragraph');
  });
});

describe('parseBlocks — lists', () => {
  it('coalesces consecutive bullets into one block', () => {
    expect(parseBlocks('- a\n- b\n- c')).toEqual([{ kind: 'bullets', items: ['a', 'b', 'c'] }]);
  });

  it('accepts -, * and + as markers', () => {
    expect(parseBlocks('* a\n+ b\n- c')[0]).toEqual({ kind: 'bullets', items: ['a', 'b', 'c'] });
  });

  it('does not mistake emphasis at line start for a bullet', () => {
    // "*italic*" and "**bold**" have no space after the marker, which is the
    // only thing separating them from a list item.
    expect(parseBlocks('*italic* text')[0]?.kind).toBe('paragraph');
    expect(parseBlocks('**bold** text')[0]?.kind).toBe('paragraph');
  });

  it('renumbers ordered lists from the item positions, not the source numbers', () => {
    const blocks = parseBlocks('3. first\n7. second');
    expect(blocks[0]).toEqual({ kind: 'ordered', items: ['first', 'second'] });
  });

  it('requires a space after the ordinal', () => {
    expect(parseBlocks('1.no-space')[0]?.kind).toBe('paragraph');
  });

  it('keeps indented list items', () => {
    expect(parseBlocks('  - nested')[0]).toEqual({ kind: 'bullets', items: ['nested'] });
  });

  it('ends the list at the first non-item line', () => {
    expect(parseBlocks('- a\nprose').map((b) => b.kind)).toEqual(['bullets', 'paragraph']);
  });
});

describe('parseBlocks — quotes, blanks and prose', () => {
  it('strips one level of quote marker', () => {
    expect(parseBlocks('> quoted\n>tight')[0]).toEqual({
      kind: 'quote',
      lines: ['quoted', 'tight'],
    });
  });

  it('keeps blank lines as blocks so vertical rhythm survives', () => {
    expect(parseBlocks('a\n\nb').map((b) => b.kind)).toEqual(['paragraph', 'blank', 'paragraph']);
  });

  it('treats whitespace-only lines as blank', () => {
    expect(parseBlocks('   ')[0]?.kind).toBe('blank');
  });

  it('returns a single blank block for empty input', () => {
    expect(parseBlocks('')).toEqual([{ kind: 'blank' }]);
  });

  it('leaves inline markup in paragraphs for the inline pass', () => {
    expect(parseBlocks('a **b** c')[0]).toEqual({ kind: 'paragraph', text: 'a **b** c' });
  });

  it('preserves document order across mixed blocks', () => {
    const doc = '# Title\n\nintro\n\n- one\n- two\n\n```sh\nls\n```\n\n> note';
    expect(parseBlocks(doc).map((b) => b.kind)).toEqual([
      'heading',
      'blank',
      'paragraph',
      'blank',
      'bullets',
      'blank',
      'code',
      'blank',
      'quote',
    ]);
  });
});

describe('parseInline — malformed markup', () => {
  const malformed = [
    '**unclosed bold',
    'trailing **',
    '`unclosed code',
    '[link](no-close',
    '[](empty)',
    '**',
    '__',
    '***',
    '*',
    '_ _',
    'a * b * c',
    '```',
    'C:\\path_with_underscores\\file_name.txt',
  ];

  it('never throws', () => {
    for (const text of malformed) {
      expect(() => parseInline(text)).not.toThrow();
    }
  });

  it('never drops a letter or digit, whatever it decides the markup was', () => {
    // Markers may be consumed; content may not. Silently eating text would be
    // the worst possible failure for a chat renderer, and it is exactly what a
    // greedy regex change would cause.
    const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
    for (const text of [...malformed, '**a** _b_ `c` [d](http://e)', 'plain sentence']) {
      const joined = parseInline(text)
        .map((p) => (p.kind === 'link' ? p.value + p.href : p.value))
        .join('');
      expect(letters(joined)).toBe(letters(text));
    }
  });

  it('leaves an unclosed marker as literal text', () => {
    expect(parseInline('**unclosed bold')).toEqual([{ kind: 'text', value: '**unclosed bold' }]);
    expect(parseInline('`unclosed')).toEqual([{ kind: 'text', value: '`unclosed' }]);
  });

  it('does not match emphasis across a newline', () => {
    const parts = parseInline('*not\nemphasis*');
    expect(parts.every((p) => p.kind === 'text')).toBe(true);
  });

  it('requires content between markers', () => {
    expect(parseInline('****').every((p) => p.kind === 'text')).toBe(true);
  });

  it('keeps a link label and href apart', () => {
    expect(parseInline('[a](http://x)')).toEqual([{ kind: 'link', value: 'a', href: 'http://x' }]);
  });

  it('handles adjacent runs with no separator', () => {
    expect(parseInline('**a**`b`').map((p) => p.kind)).toEqual(['bold', 'code']);
  });
});

describe('MarkdownText rendering', () => {
  async function frameOf(text: string): Promise<string> {
    const h = renderInk(<MarkdownText text={text} />);
    await flush();
    const frame = h.lastFrame();
    h.unmount();
    return frame;
  }

  it('shows code content without the fence markers', async () => {
    const frame = await frameOf('```sh\nls -la\n```');
    expect(frame).toContain('ls -la');
    expect(frame).not.toContain('```');
  });

  it('labels a fenced block with its language', async () => {
    expect(await frameOf('```python\npass\n```')).toContain('python');
  });

  it('shows emphasis content without its markers', async () => {
    const frame = await frameOf('say **loudly** now');
    expect(frame).toContain('loudly');
    expect(frame).not.toContain('**');
  });

  it('shows link text rather than the URL', async () => {
    const frame = await frameOf('read [the docs](https://example.com/x)');
    expect(frame).toContain('the docs');
    expect(frame).not.toContain('https://example.com/x');
  });

  it('renumbers an ordered list from one', async () => {
    const frame = await frameOf('5. alpha\n9. beta');
    expect(frame).toContain('1. alpha');
    expect(frame).toContain('2. beta');
  });

  it('marks bullets with a glyph', async () => {
    const frame = await frameOf('- alpha\n- beta');
    expect(frame).toContain('• alpha');
    expect(frame).toContain('• beta');
  });

  it('keeps heading hashes visible so structure survives in a plain terminal', async () => {
    expect(await frameOf('## Section')).toContain('## Section');
  });

  it('still shows the text of malformed markup', async () => {
    const frame = await frameOf('**unclosed and `dangling');
    expect(frame).toContain('unclosed and');
    expect(frame).toContain('dangling');
  });

  it('renders an empty message without crashing', async () => {
    expect(await frameOf('')).toBeDefined();
  });
});
