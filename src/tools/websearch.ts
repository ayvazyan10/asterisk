// Web search — tries multiple backends in priority order so the agent
// gets results regardless of any one provider's rate limiting / bot blocks.
//
// Order:
//   1. Brave Search API   ($ASTERISK_BRAVE_API_KEY)    — best quality
//   2. Tavily             ($ASTERISK_TAVILY_API_KEY)   — designed for agents
//   3. SearXNG            ($ASTERISK_SEARXNG_URL)      — user-supplied instance
//   4. DDG instant-answer (no key)                     — limited, "factoid" queries
//
// Pair with WebFetch to read individual pages from the result list.

import { request } from 'undici';

import { type Tool, ok, err } from './types.ts';

const TIMEOUT_MS = 12_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchTool: Tool = {
  name: 'WebSearch',
  description:
    'Search the web. Tries Brave / Tavily / SearXNG / DDG instant-answer in priority order based on configured API keys / URLs. Returns title + URL + snippet for each result. Pair with WebFetch to read individual pages. If no backend is configured (or all return empty), the tool reports "(no results)" — do NOT treat that as a dead end: fall back to BrowserNavigate on the authoritative site or WebFetch a direct plain-text endpoint (e.g. https://wttr.in/<place>?format=4 for weather, en.wikipedia.org for facts).',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      maxResults: {
        type: 'number',
        description: 'Cap on returned results (default 8, max 20).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input) {
    const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
    if (!query) return err('query is required');
    const maxResults = Math.min(
      Math.max(typeof input['maxResults'] === 'number' ? input['maxResults'] : 8, 1),
      20,
    );

    const backends: Array<() => Promise<{ results: SearchResult[]; backend: string } | null>> = [
      () => braveBackend(query, maxResults),
      () => tavilyBackend(query, maxResults),
      () => searxngBackend(query, maxResults),
      () => ddgInstantBackend(query, maxResults),
    ];

    const tried: string[] = [];
    for (const backend of backends) {
      try {
        const result = await backend();
        if (!result) continue;
        tried.push(result.backend);
        if (result.results.length === 0) continue;
        return ok(formatResults(query, result.backend, result.results));
      } catch (e) {
        tried.push(`error: ${(e as Error).message.slice(0, 80)}`);
      }
    }

    const agentHint = [
      'Next steps (do not stop here):',
      '  • For weather:    WebFetch  https://wttr.in/<place>?format=4&lang=<bcp47>',
      '  • For facts:      WebFetch  https://<lang>.wikipedia.org/wiki/<Topic>',
      '  • For everything: BrowserNavigate to the authoritative site, then',
      '                    BrowserSnapshot to read it. Browser handles JS pages.',
      '  • Search results UI fallback: BrowserNavigate to',
      '                    https://duckduckgo.com/?q=<urlencoded query>  →  BrowserSnapshot.',
    ].join('\n');
    const operatorHint = [
      'Operator: configure a real search backend to enable WebSearch:',
      '  ASTERISK_BRAVE_API_KEY   — https://api.search.brave.com (free 2k/month)',
      '  ASTERISK_TAVILY_API_KEY  — https://tavily.com (free tier)',
      '  ASTERISK_SEARXNG_URL     — your own SearXNG instance',
    ].join('\n');
    return ok(
      `(no results)  ·  tried: ${tried.join(', ') || '(none)'}\n\n${agentHint}\n\n${operatorHint}`,
    );
  },
};

function formatResults(query: string, backend: string, results: SearchResult[]): string {
  const lines = [`Search: "${query}"  ·  via ${backend}`, `Results: ${results.length}`, ''];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────
//  Brave Search API
//  https://api.search.brave.com/app/documentation/web-search/get-started

async function braveBackend(
  query: string,
  max: number,
): Promise<{ results: SearchResult[]; backend: string } | null> {
  const key = process.env['ASTERISK_BRAVE_API_KEY'];
  if (!key) return null;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
  const res = await request(url, {
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'x-subscription-token': key,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.statusCode >= 400) {
    const t = await res.body.text();
    throw new Error(`Brave HTTP ${res.statusCode}: ${t.slice(0, 120)}`);
  }
  const data = (await res.body.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const items = (data.web?.results ?? []).map((r) => ({
    title: stripTags(r.title ?? ''),
    url: r.url ?? '',
    snippet: stripTags(r.description ?? ''),
  }));
  return { results: items.filter((r) => r.url && r.title), backend: 'Brave' };
}

// ─────────────────────────────────────────────────────────────────────────
//  Tavily
//  https://docs.tavily.com/

async function tavilyBackend(
  query: string,
  max: number,
): Promise<{ results: SearchResult[]; backend: string } | null> {
  const key = process.env['ASTERISK_TAVILY_API_KEY'];
  if (!key) return null;
  const res = await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: max,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.statusCode >= 400) {
    const t = await res.body.text();
    throw new Error(`Tavily HTTP ${res.statusCode}: ${t.slice(0, 120)}`);
  }
  const data = (await res.body.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const items = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 280),
  }));
  return { results: items.filter((r) => r.url && r.title), backend: 'Tavily' };
}

// ─────────────────────────────────────────────────────────────────────────
//  SearXNG (user-supplied instance)

async function searxngBackend(
  query: string,
  max: number,
): Promise<{ results: SearchResult[]; backend: string } | null> {
  const base = process.env['ASTERISK_SEARXNG_URL'];
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`;
  const res = await request(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.statusCode >= 400) {
    const t = await res.body.text();
    throw new Error(`SearXNG HTTP ${res.statusCode}: ${t.slice(0, 120)}`);
  }
  const data = (await res.body.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const items = (data.results ?? []).slice(0, max).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
  return { results: items.filter((r) => r.url && r.title), backend: 'SearXNG' };
}

// ─────────────────────────────────────────────────────────────────────────
//  DDG Instant-Answer (always-on fallback, no key)
//  Returns "factoid" answers — Wikipedia summaries, definitions — not real
//  web search. Often empty for ambiguous queries, but it never hits the
//  bot block that DDG's HTML page does.

async function ddgInstantBackend(
  query: string,
  max: number,
): Promise<{ results: SearchResult[]; backend: string } | null> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await request(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.statusCode >= 400) return null;
  const data = (await res.body.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    Results?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const out: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    out.push({
      title: data.Heading ?? data.AbstractText.slice(0, 80),
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  for (const r of data.Results ?? []) {
    if (out.length >= max) break;
    if (r.FirstURL && r.Text) {
      out.push({ title: r.Text.slice(0, 100), url: r.FirstURL, snippet: r.Text });
    }
  }
  for (const r of data.RelatedTopics ?? []) {
    if (out.length >= max) break;
    if (r.FirstURL && r.Text) {
      out.push({ title: r.Text.slice(0, 100), url: r.FirstURL, snippet: r.Text });
    }
  }
  return { results: out, backend: 'DDG-InstantAnswer' };
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

// Kept as a stable export so legacy tests still link. We no longer scrape
// DDG HTML (they serve a CAPTCHA challenge instead of results); this returns [].
export function parseDuckDuckGoHtml(_html: string): SearchResult[] {
  return [];
}
