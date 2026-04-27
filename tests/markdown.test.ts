import { describe, expect, it } from 'vitest';

import { parseInline } from '../src/repl/MarkdownText.tsx';

describe('parseInline', () => {
  it('returns plain text untouched', () => {
    expect(parseInline('hello world')).toEqual([{ kind: 'text', value: 'hello world' }]);
  });

  it('parses **bold** correctly', () => {
    expect(parseInline('say **hi**!')).toEqual([
      { kind: 'text', value: 'say ' },
      { kind: 'bold', value: 'hi' },
      { kind: 'text', value: '!' },
    ]);
  });

  it('parses *italic*', () => {
    expect(parseInline('be *quick*')).toEqual([
      { kind: 'text', value: 'be ' },
      { kind: 'italic', value: 'quick' },
    ]);
  });

  it('parses inline `code`', () => {
    expect(parseInline('try `bun run test`')).toEqual([
      { kind: 'text', value: 'try ' },
      { kind: 'code', value: 'bun run test' },
    ]);
  });

  it('parses [links](url)', () => {
    expect(parseInline('see [docs](https://example.com)')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'docs', href: 'https://example.com' },
    ]);
  });

  it('combines bold + italic + code in one pass', () => {
    const parts = parseInline('**bold** and *italic* and `code`');
    expect(parts.map((p) => p.kind)).toEqual([
      'bold',
      'text',
      'italic',
      'text',
      'code',
    ]);
  });

  it('handles __underscored bold__', () => {
    expect(parseInline('__strong__').map((p) => p.kind)).toEqual(['bold']);
  });

  it('handles _underscored italic_', () => {
    expect(parseInline('_em_').map((p) => p.kind)).toEqual(['italic']);
  });
});
