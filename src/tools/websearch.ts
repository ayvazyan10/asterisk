// Web search — DuckDuckGo HTML scrape (no API key required). Returns the
// top results' title, URL, and snippet so the agent can pick which ones to
// WebFetch.
//
// Reference: https://html.duckduckgo.com/html/

import { request } from 'undici';

import { type Tool, ok, err } from './types.ts';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_MAX = 8;
const TIMEOUT_MS = 15_000;

export const webSearchTool: Tool = {
  name: 'WebSearch',
  description:
    'Search the web (DuckDuckGo HTML; no key needed). Returns title + URL + snippet for the top results. Pair with WebFetch to read individual pages.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      maxResults: {
        type: 'number',
        description: 'Cap on returned results (default 8, max 20).',
      },
      region: {
        type: 'string',
        description: 'DDG region code, e.g. "us-en" (default "wt-wt").',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
    if (!query) return err('query is required');
    const maxResults = Math.min(
      Math.max(typeof input['maxResults'] === 'number' ? input['maxResults'] : DEFAULT_MAX, 1),
      20,
    );
    const region = typeof input['region'] === 'string' ? input['region'] : 'wt-wt';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
    if (opts?.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        return err('aborted');
      }
      opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal?.reason), { once: true });
    }

    try {
      const body = new URLSearchParams({ q: query, kl: region }).toString();
      const res = await request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'Mozilla/5.0 (compatible; asterisk-search/0.1)',
        },
        body,
        signal: ctrl.signal,
      });
      if (res.statusCode >= 400) {
        const text = await res.body.text();
        return err(`DuckDuckGo HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
      }
      const html = await res.body.text();
      const results = parseDuckDuckGoHtml(html).slice(0, maxResults);
      if (results.length === 0) return ok('(no results)');
      const lines = [`Search: "${query}"`, `Results: ${results.length}`, ''];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r) continue;
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push('');
      }
      return ok(lines.join('\n').trim());
    } catch (e) {
      return err(`WebSearch failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  // DDG HTML lite renders each result as a <div class="result">…</div> block
  // containing an anchor with class "result__a" and a snippet
  // <a class="result__snippet">. We extract those triples.
  const blockRe = /<div class="result"[\s\S]*?<\/div>\s*<\/div>/g;
  for (const block of html.match(blockRe) ?? []) {
    const titleMatch = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
      block,
    );
    const snippetMatch = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleMatch) continue;
    const rawHref = titleMatch[1] ?? '';
    const url = decodeRedirectUrl(rawHref);
    const title = stripTags(titleMatch[2] ?? '').trim();
    const snippet = stripTags(snippetMatch?.[1] ?? '').trim();
    if (!title || !url) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

function decodeRedirectUrl(href: string): string {
  // DDG wraps result links in /l/?uddg=ENCODED&… — pull the real URL out.
  if (!href) return '';
  if (!href.includes('/l/')) return href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, ' ')
    .trim();
}
