// Smoke tests for WebFetch + WebSearch — schema, validation, and the small
// pure helpers we use to parse HTML. We don't hit the network; live
// behaviour is verified via the REPL.

import { describe, expect, it } from 'vitest';

import { htmlToText, webFetchTool } from '../src/tools/webfetch.ts';
import { parseDuckDuckGoHtml, webSearchTool } from '../src/tools/websearch.ts';

describe('WebFetch', () => {
  it('schema requires url', async () => {
    const r = await webFetchTool.execute({});
    expect(r.isError).toBe(true);
  });

  it('rejects non-http(s) urls', async () => {
    const r = await webFetchTool.execute({ url: 'file:///etc/passwd' });
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/http/);
  });
});

describe('htmlToText', () => {
  it('strips tags and entities', () => {
    const html = '<html><head><title>T</title></head><body><p>Hello, <b>world</b>&amp;Co.</p><script>alert(1)</script></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Hello,');
    expect(text).toContain('world');
    expect(text).toContain('&Co.');
    expect(text).not.toContain('alert(1)');
  });

  it('collapses whitespace and newlines', () => {
    const html = '<p>one</p><p>two</p>';
    expect(htmlToText(html)).toMatch(/one\s+two/);
  });
});

describe('WebSearch', () => {
  it('schema requires query', async () => {
    const r = await webSearchTool.execute({});
    expect(r.isError).toBe(true);
  });
});

describe('parseDuckDuckGoHtml', () => {
  it('returns [] for empty html', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([]);
  });

  it('extracts title / url / snippet from a result block', () => {
    const html = `
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>
  </h2>
  <a class="result__snippet" href="x">A short snippet about the page.</a>
</div>
</div>
`;
    const out = parseDuckDuckGoHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Example Page');
    expect(out[0]?.url).toBe('https://example.com/page');
    expect(out[0]?.snippet).toBe('A short snippet about the page.');
  });
});
