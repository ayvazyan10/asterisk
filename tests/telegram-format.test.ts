import { describe, expect, it } from 'vitest';

import {
  balanceOpenTags,
  chunkHtml,
  escapeHtml,
  markdownToTelegramHtml,
} from '../src/bots/telegram/format.ts';
import { stripTags } from '../src/bots/telegram/index.ts';

describe('markdownToTelegramHtml', () => {
  it('renders bold (** and __) as <b>', () => {
    expect(markdownToTelegramHtml('hello **world** there')).toBe('hello <b>world</b> there');
    expect(markdownToTelegramHtml('hello __world__ there')).toBe('hello <b>world</b> there');
  });

  it('renders italic (single * and _) as <i>', () => {
    expect(markdownToTelegramHtml('hello *world* there')).toBe('hello <i>world</i> there');
    expect(markdownToTelegramHtml('hello _world_ there')).toBe('hello <i>world</i> there');
  });

  it('keeps bold and italic separate when they appear together', () => {
    const out = markdownToTelegramHtml('be **bold** and *brave*');
    expect(out).toBe('be <b>bold</b> and <i>brave</i>');
  });

  it('renders inline code as <code>', () => {
    expect(markdownToTelegramHtml('use `npm i` to install')).toBe(
      'use <code>npm i</code> to install',
    );
  });

  it('renders fenced code blocks as <pre><code>', () => {
    const out = markdownToTelegramHtml('```ts\nconst x = 1;\n```');
    expect(out).toContain('<pre><code class="language-ts">');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('</code></pre>');
  });

  it('escapes HTML special chars inside code blocks', () => {
    const out = markdownToTelegramHtml('```\n<script>alert(1)</script>\n```');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('renders links as <a href>', () => {
    const out = markdownToTelegramHtml('[click](https://example.com)');
    expect(out).toBe('<a href="https://example.com">click</a>');
  });

  it('escapes an ampersand in a url exactly once', () => {
    // The url reaches the link rule already escaped by the tokeniser, so
    // escaping it again produced `&amp;amp;`. Telegram decodes entities inside
    // an attribute, so that reached the user as a literal `&amp;` in the href
    // and broke every link carrying two query parameters.
    expect(markdownToTelegramHtml('[q](https://e.com/?a=1&b=2)')).toBe(
      '<a href="https://e.com/?a=1&amp;b=2">q</a>',
    );
  });

  it('survives the round trip an HTML parser will do to the href', () => {
    // The check that matters is not what we emit but what Telegram reads back
    // out of it, which is the entity-decoded form.
    const href = /href="([^"]*)"/.exec(
      markdownToTelegramHtml('[watch](https://youtu.be/x?v=abc&t=42s&list=PL1)'),
    )?.[1];
    const decoded = href?.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    expect(decoded).toBe('https://youtu.be/x?v=abc&t=42s&list=PL1');
  });

  it('still escapes a quote that would close the href attribute', () => {
    // A quote is the one character the tokeniser does not handle, because it
    // is harmless in text and only matters once the value lands in an
    // attribute. Dropping it would let a url break out of the href.
    expect(markdownToTelegramHtml('[q](https://e.com/a"b)')).toBe(
      '<a href="https://e.com/a&quot;b">q</a>',
    );
  });

  it('escapes angle brackets in a url once', () => {
    expect(markdownToTelegramHtml('[q](https://e.com/<x>)')).toBe(
      '<a href="https://e.com/&lt;x&gt;">q</a>',
    );
  });

  it('escapes HTML special chars in plain text', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('leaves a backtick that opens nothing as a literal character', () => {
    // The first pair closes; the third tick has no partner and must survive
    // as text rather than swallowing the rest of the message into a code span.
    expect(markdownToTelegramHtml('`ok`` and a lone tick')).toBe(
      '<code>ok</code>` and a lone tick',
    );
  });

  it('does not let an inline code span cross a newline', () => {
    // Two ticks on different lines are almost always two separate literals,
    // not one span — treating them as a span would eat the line break.
    expect(markdownToTelegramHtml('a `b\nc` d')).toBe('a `b\nc` d');
  });

  it('does not parse markdown inside inline code', () => {
    expect(markdownToTelegramHtml('use `**not** bold` please')).toBe(
      'use <code>**not** bold</code> please',
    );
  });

  it('renders headings as <b>', () => {
    expect(markdownToTelegramHtml('# Title\nbody')).toBe('<b>Title</b>\nbody');
    expect(markdownToTelegramHtml('## Subtitle\nbody')).toBe('<b>Subtitle</b>\nbody');
  });

  it('unifies bullets', () => {
    const out = markdownToTelegramHtml('- one\n- two\n* three\n+ four');
    expect(out).toContain('• one');
    expect(out).toContain('• two');
    expect(out).toContain('• three');
    expect(out).toContain('• four');
  });

  it('renders block quotes as <blockquote>', () => {
    const out = markdownToTelegramHtml('> a quote\n> still quoted\nout');
    expect(out).toBe('<blockquote>a quote\nstill quoted</blockquote>\nout');
  });

  it('handles a realistic agent reply with mixed formatting', () => {
    const md =
      'Мой повелитель, я *проверил* погоду:\n\n' +
      '**Гюмри, Армения** — `+12°C`, ясно.\n\n' +
      'Источник: [wttr.in](https://wttr.in/Gyumri).';
    const out = markdownToTelegramHtml(md);
    expect(out).toContain('<i>проверил</i>');
    expect(out).toContain('<b>Гюмри, Армения</b>');
    expect(out).toContain('<code>+12°C</code>');
    expect(out).toContain('<a href="https://wttr.in/Gyumri">wttr.in</a>');
    // The literal asterisks the user originally complained about must be gone.
    expect(out).not.toContain('*проверил*');
    expect(out).not.toContain('**Гюмри');
  });

  it('asterisks not surrounding text stay literal', () => {
    expect(markdownToTelegramHtml('5 * 3 = 15')).toBe('5 * 3 = 15');
  });
});

describe('fenced code blocks', () => {
  it('closes a fence the model never closed', () => {
    // Streaming means we routinely render a buffer that stops mid-block. The
    // opening fence has to produce a complete <pre>, or Telegram rejects the
    // edit and the user sees nothing at all.
    expect(markdownToTelegramHtml('```ts\nconst x = 1;')).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  it('treats a fence carrying only a language as an empty block', () => {
    expect(markdownToTelegramHtml('```js```')).toBe('<pre><code class="language-js"></code></pre>');
  });

  it('keeps the prose that precedes a fence', () => {
    // The plain-text scanner has to stop at the fence rather than swallowing
    // it; if it doesn't, the code block renders as escaped backticks.
    expect(markdownToTelegramHtml('see this:\n```\nx\n```')).toBe(
      'see this:\n<pre><code>x\n</code></pre>',
    );
  });

  it('escapes a language hint so it cannot break out of the class attribute', () => {
    // The language hint is the one part of a fence that is *not* pre-escaped
    // by the tokeniser — it goes straight into an HTML attribute. A bare
    // quote there would end the attribute and let the rest be read as markup.
    const out = markdownToTelegramHtml('```<script>&"\ncode\n```');
    expect(out).toBe('<pre><code class="language-&lt;script&gt;&amp;&quot;">code\n</code></pre>');
    expect(out).not.toContain('<script>');
  });
});

describe('balanceOpenTags', () => {
  it('closes a single open tag', () => {
    expect(balanceOpenTags('hello <b>world')).toBe('hello <b>world</b>');
  });

  it('closes nested tags in reverse order', () => {
    expect(balanceOpenTags('<b>bold and <i>italic')).toBe('<b>bold and <i>italic</i></b>');
  });

  it('leaves balanced markup alone', () => {
    expect(balanceOpenTags('<b>x</b> <i>y</i>')).toBe('<b>x</b> <i>y</i>');
  });

  it('ignores tags Telegram does not support', () => {
    expect(balanceOpenTags('<div>x')).toBe('<div>x');
  });

  it('handles tags with attributes', () => {
    const out = balanceOpenTags('<a href="https://x">click');
    expect(out).toBe('<a href="https://x">click</a>');
  });

  it('leaves a close tag that never had an open alone', () => {
    // Inventing an opening tag to match it would be worse than passing it
    // through: this function exists to stop Telegram rejecting an edit, not
    // to rewrite the model's output.
    expect(balanceOpenTags('</b>x')).toBe('</b>x');
  });

  it('closes only what is still open when a tag was already closed', () => {
    expect(balanceOpenTags('<b>bold</b> then <i>italic')).toBe('<b>bold</b> then <i>italic</i>');
  });
});

describe('chunkHtml', () => {
  const MAX = 4096;
  const PRE_TAG = '<pre>';
  const CODE_TAG_OPEN = '<code class="language-ts">';

  it('never cuts through a tag, on a real rendered message with a code block over the limit', () => {
    // Engineered so a naive slice(0, MAX) — the bug this replaced — lands
    // inside `<code class="language-ts">`, exactly the reported failure:
    // the first piece ended `<pre><code class="langua`, the second began
    // `ge-ts">…`, and stripTags's fallback then showed that fragment to the
    // user as literal text because it has no closing `>` to match.
    const landInsideTagBy = 10;
    const prefixLen = MAX - landInsideTagBy - PRE_TAG.length - '\n\n'.length;
    const prefix = 'x'.repeat(prefixLen);
    const body = 'const value = 1;\n'.repeat(200);
    const markdown = `${prefix}\n\n\`\`\`ts\n${body}\`\`\`\n`;
    const rendered = markdownToTelegramHtml(markdown);

    // Confirm the setup actually reproduces the reported failure mode
    // before trusting the assertions below.
    const codeTagStart = rendered.indexOf(CODE_TAG_OPEN);
    expect(codeTagStart).toBeGreaterThan(0);
    expect(codeTagStart).toBeLessThan(MAX);
    expect(codeTagStart + CODE_TAG_OPEN.length).toBeGreaterThan(MAX);
    expect(rendered.slice(0, MAX)).toMatch(/<code[^>]*$/);
    expect(rendered.length).toBeGreaterThan(MAX);

    const chunks = chunkHtml(rendered, MAX);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
      // No chunk ends (or, since a reopened tag is prepended whole, begins)
      // mid-tag.
      expect(chunk).not.toMatch(/<[a-zA-Z/][^<>]*$/);
      // Every tag in the chunk is complete, so stripping them all leaves no
      // markup-shaped leftovers — the concrete acceptance check: Telegram's
      // real fallback (`stripTags`) must never show a raw fragment.
      expect(stripTags(chunk)).not.toMatch(/[<>]/);
    }

    // The code content itself survives the split intact.
    expect(chunks.map(stripTags).join('')).toContain('const value = 1;\nconst value = 1;');
  });

  it('reopens a tag that spans a boundary with its original attributes', () => {
    const body = 'line\n'.repeat(900); // long enough to force a split inside <pre><code>
    const rendered = markdownToTelegramHtml(`\`\`\`with-a-long-name-xyz\n${body}\`\`\``);
    expect(rendered.length).toBeGreaterThan(MAX);

    const chunks = chunkHtml(rendered, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk picks up inside the code block, so it must reopen
    // <pre><code class="..."> verbatim rather than starting bare.
    expect(chunks[1]).toMatch(/^<pre><code class="language-with-a-long-name-xyz">/);
    // And the first chunk closed what it left open.
    expect(chunks[0]?.endsWith('</code></pre>')).toBe(true);
  });

  it('leaves short HTML alone', () => {
    const rendered = markdownToTelegramHtml('**bold** and `code`');
    expect(chunkHtml(rendered, MAX)).toEqual([rendered]);
  });

  it('matches plain chunkText slicing when there are no tags to protect', () => {
    const plain = 'y'.repeat(MAX + 50);
    expect(chunkHtml(plain, MAX)).toEqual([plain.slice(0, MAX), plain.slice(MAX)]);
  });
});

describe('escapeHtml', () => {
  it('escapes the three required chars', () => {
    expect(escapeHtml('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });
});
