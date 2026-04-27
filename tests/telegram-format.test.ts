import { describe, expect, it } from 'vitest';

import {
  balanceOpenTags,
  escapeHtml,
  markdownToTelegramHtml,
} from '../src/bots/telegram/format.ts';

describe('markdownToTelegramHtml', () => {
  it('renders bold (** and __) as <b>', () => {
    expect(markdownToTelegramHtml('hello **world** there')).toBe(
      'hello <b>world</b> there',
    );
    expect(markdownToTelegramHtml('hello __world__ there')).toBe(
      'hello <b>world</b> there',
    );
  });

  it('renders italic (single * and _) as <i>', () => {
    expect(markdownToTelegramHtml('hello *world* there')).toBe(
      'hello <i>world</i> there',
    );
    expect(markdownToTelegramHtml('hello _world_ there')).toBe(
      'hello <i>world</i> there',
    );
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

  it('escapes HTML special chars in plain text', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
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

describe('balanceOpenTags', () => {
  it('closes a single open tag', () => {
    expect(balanceOpenTags('hello <b>world')).toBe('hello <b>world</b>');
  });

  it('closes nested tags in reverse order', () => {
    expect(balanceOpenTags('<b>bold and <i>italic')).toBe(
      '<b>bold and <i>italic</i></b>',
    );
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
});

describe('escapeHtml', () => {
  it('escapes the three required chars', () => {
    expect(escapeHtml('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });
});
