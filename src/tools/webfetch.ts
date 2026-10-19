// Fetch a URL and return its text content. HTML pages are stripped to
// readable text (script/style/nav blocks removed, tags collapsed) so the
// agent gets something it can actually reason over.
//
// Reference: https://undici.nodejs.org/

import { request } from 'undici';

import { checkOutboundUrl } from './ssrf-guard.ts';
import { type Tool, err, ok } from './types.ts';

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
    // network. See ssrf-guard.ts. Every redirect hop is checked again below.
    const guard = checkOutboundUrl(url);
    if (guard.reason) return err(guard.reason);

    const timeoutMs = Math.min(
      Math.max(
        typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : DEFAULT_TIMEOUT_MS,
        1_000,
      ),
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
      const { url: finalUrl, status, ctype, raw } = await fetchText(url, ctrl.signal);

      if (status >= 400) {
        return err(`HTTP ${status}: ${truncate(raw, 400)}`);
      }

      const isHtml = ctype.includes('html') || /<html[\s>]/i.test(raw.slice(0, 4096));
      const text = isHtml ? htmlToText(raw) : raw;
      const focused = query ? focusAround(text, query, MAX_RETURN_CHARS) : text;
      const final =
        focused.length > MAX_RETURN_CHARS
          ? `${focused.slice(0, MAX_RETURN_CHARS)}\n[truncated · ${focused.length - MAX_RETURN_CHARS} chars]`
          : focused;
      return ok(
        `URL: ${finalUrl}\nStatus: ${status}  ·  ${ctype || 'unknown content-type'}\n---\n${final}`,
      );
    } catch (e) {
      return err(`WebFetch failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

async function fetchText(url: string, signal: AbortSignal) {
  let currentUrl = url;
  for (let hops = 0; ; hops++) {
    const res = await request(currentUrl, {
      method: 'GET',
      headers: {
        'user-agent': 'asterisk/0.1 (+https://github.com/ayvazyan10/asterisk)',
        accept: 'text/html,text/plain,application/json,*/*;q=0.5',
      },
      signal,
    });
    const status = res.statusCode;
    const location = res.headers['location'];
    if (status >= 300 && status < 400 && typeof location === 'string') {
      // Not `body.dump()`: Bun's built-in undici, which production resolves,
      // does not have it. Breaking out of the iteration releases the socket.
      await readUpTo(res.body as unknown as AsyncIterable<Uint8Array>, 1);
      if (hops >= 5) throw new Error('Too many redirects (maximum 5 hops)');
      currentUrl = new URL(location, currentUrl).href;
      const guard = checkOutboundUrl(currentUrl);
      if (guard.reason) throw new Error(guard.reason);
      continue;
    }
    const ctype = (res.headers['content-type'] as string | undefined) ?? '';
    const buf = await readUpTo(res.body as unknown as AsyncIterable<Uint8Array>, MAX_BYTES);
    const charset = /\bcharset\s*=\s*["']?([^\s;"']+)/i.exec(ctype)?.[1] ?? 'utf-8';
    let raw: string;
    try {
      raw = new TextDecoder(charset).decode(buf);
    } catch {
      raw = new TextDecoder('utf-8').decode(buf);
    }
    return { url: currentUrl, status, ctype, raw };
  }
}

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
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity: string, value: string) => {
      const point = /^x/i.test(value) ? Number.parseInt(value.slice(1), 16) : Number(value);
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(/&amp;/gi, '&')
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
