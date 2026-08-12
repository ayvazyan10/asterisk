// The control-panel HTTP server.
//
// `createRequestHandler` is a pure Request -> Response function so the whole
// API can be exercised in tests without binding a port; `startWebServer` wraps
// it in Bun.serve for real use.

import { randomBytes } from 'node:crypto';

import type { SqliteDriver } from '../db/driver.ts';
import { authenticate } from './auth.ts';
import { HttpError, type RequestContext, fail } from './http.ts';
import { checkRequestOrigin } from './origin-guard.ts';
import { matchRoute } from './router.ts';
import { renderIndexHtml } from './ui/index.ts';

export interface WebServerOptions {
  db: SqliteDriver;
  host: string;
  port: number;
  authRequired: boolean;
}

/**
 * Baseline response headers. The panel is a single self-hosted page: it loads
 * no third-party origins, frames nothing and is framed by nothing.
 */
function securityHeaders(nonce: string): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  };
}

export function createRequestHandler(opts: WebServerOptions): (req: Request) => Promise<Response> {
  const { db, authRequired } = opts;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const nonce = randomBytes(16).toString('base64');

    // Before authentication: a rebound or cross-site request must be refused
    // even when it carries a valid session cookie, because the cookie is
    // exactly what such a request is trying to ride on.
    const originProblem = checkRequestOrigin(req, { host: opts.host, port: opts.port });
    if (originProblem) {
      return fail(originProblem, 403);
    }

    const auth = authenticate(db, req, {
      required: authRequired,
      secure: url.protocol === 'https:',
    });
    const cookieHeader = auth.setCookie ? { 'set-cookie': auth.setCookie } : {};

    if (!auth.ok) {
      // An unauthenticated page load gets a human-readable prompt; an API call
      // gets JSON, so fetch() callers don't have to parse HTML.
      if (url.pathname.startsWith('/api/')) {
        return fail('unauthorized — supply ?token= or an Authorization: Bearer header', 401);
      }
      return new Response(renderIndexHtml({ nonce, authenticated: false }), {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8', ...securityHeaders(nonce) },
      });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(renderIndexHtml({ nonce, authenticated: true }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...securityHeaders(nonce),
          ...cookieHeader,
        },
      });
    }

    const matched = matchRoute(req.method, url.pathname);
    if (!matched) return fail('not found', 404);
    if (!('handler' in matched)) {
      return fail('method not allowed', 405, { allowed: matched.allowed });
    }

    const ctx: RequestContext = { db, params: matched.params, url, req };

    try {
      const res = await matched.handler(ctx);
      for (const [k, v] of Object.entries({ ...securityHeaders(nonce), ...cookieHeader })) {
        // Route handlers own content-type; only add what they didn't set.
        if (!res.headers.has(k)) res.headers.set(k, v);
      }
      return res;
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message, e.status, e.detail);
      // Unexpected errors carry absolute paths, SQLite schema details and Zod
      // internals. "It's only localhost" stopped being a good enough reason to
      // return them once we accepted that a browser can be made to reach
      // localhost; the caller gets a correlation id and the detail stays in the
      // server's own output.
      const ref = randomBytes(4).toString('hex');
      // stderr is this process's log — `asterisk web` reports everything else
      // the same way, and under the daemon it lands in daemon.log.
      console.error(`[web ${ref}]`, e);
      return fail(`internal error (ref ${ref})`, 500);
    }
  };
}

export interface RunningServer {
  url: string;
  stop: () => void;
}

/** Binds the handler with Bun.serve. Bun-only; the tests call the handler directly. */
export function startWebServer(opts: WebServerOptions): RunningServer {
  if (typeof Bun === 'undefined') {
    throw new Error('the web control panel requires the Bun runtime');
  }

  const handler = createRequestHandler(opts);
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: handler,
    error(err: Error) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    url: `http://${opts.host}:${server.port}`,
    stop: () => server.stop(true),
  };
}
