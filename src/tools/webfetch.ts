// Fetch a URL and return its text content. HTML pages are stripped to
// readable text (script/style/nav blocks removed, tags collapsed) so the
// agent gets something it can actually reason over.
//
// Reference: https://undici.nodejs.org/

import { request } from 'undici';

import { checkOutboundUrl } from './ssrf-guard.ts';
import { type Tool, ok, err } from './types.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_RETURN_CHARS = 30_000;

export const webFetchTool: Tool = {
  name: 'WebFetch',
  description:
    'Fetch a URL and return its content as text. HTML is stripped to readable text. Truncated at 30k chars; pass `query` to focus the excerpt around a search term.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      query: {
        type: 'string',
        description: 'Optional — return the 30k chars surrounding this term.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Network timeout (default 15000, max 60000).',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const url = typeof input['url'] === 'string' ? input['url'] : '';
    if (!url) return err('url is required');
    // The URL can originate from a page the agent just read or a message a
    // stranger sent the bot, so it is untrusted input aimed at the host's own
    // network. See ssrf-guard.ts.
    const guard = checkOutboundUrl(url);
    if (guard.reason) return err(guard.reason);

    const timeoutMs = Math.min(
      Math.max(typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : DEFAULT_TIMEOUT_MS, 1_000),
      60_000,
    );
    const query = typeof input['query'] === 'string' ? input['query'].trim() : '';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    if (opts?.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        return err('aborted');
      }
      opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal?.reason), { once: true });
    }

    try {
      const res = await request(url, {
        method: 'GET',
        headers: {
          'user-agent': 'asterisk/0.1 (+https://github.com/ayvazyan10/asterisk)',
          accept: 'text/html,text/plain,application/json,*/*;q=0.5',
        },
        signal: ctrl.signal,
      });
      const status = res.statusCode;
      const ctype = (res.headers['content-type'] as string | undefined) ?? '';
      const buf = await readUpTo(res.body as unknown as AsyncIterable<Uint8Array>, MAX_BYTES);
      const raw = Buffer.from(buf).toString('utf8');

      if (status >= 400) {
        return err(`HTTP ${status}: ${truncate(raw, 400)}`);
      }

      const isHtml = ctype.includes('html') || /<html[\s>]/i.test(raw.slice(0, 4096));
      const text = isHtml ? htmlToText(raw) : raw;
      const focused = query ? focusAround(text, query, MAX_RETURN_CHARS) : text;
      const final = focused.length > MAX_RETURN_CHARS
        ? `${focused.slice(0, MAX_RETURN_CHARS)}\n[truncated · ${focused.length - MAX_RETURN_CHARS} chars]`
        : focused;
      return ok(`URL: ${url}\nStatus: ${status}  ·  ${ctype || 'unknown content-type'}\n---\n${final}`);
    } catch (e) {
      return err(`WebFetch failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

async function readUpTo(stream: AsyncIterable<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= max) break;
  }
  const out = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= max) break;
    const len = Math.min(c.length, max - off);
    out.set(c.subarray(0, len), off);
    off += len;
  }
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|li|tr|h[1-6]|div)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|li|tr|h[1-6]|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function focusAround(text: string, query: string, maxChars: number): string {
  if (!query || text.length <= maxChars) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxChars);
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, start + maxChars);
  return text.slice(start, end);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
