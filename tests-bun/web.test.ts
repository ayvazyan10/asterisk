import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb } from '../src/db/index.ts';
import { issueToken } from '../src/web/auth.ts';
import { startWebServer } from '../src/web/server.ts';

test('Bun.serve requires a token and serves the panel with a CSP nonce', async () => {
  const previousHome = process.env['ASTERISK_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'asterisk-bun-web-'));
  process.env['ASTERISK_HOME'] = home;
  let server: ReturnType<typeof startWebServer> | undefined;
  try {
    const db = getDb();
    const token = issueToken(db, 'bun-smoke');
    server = startWebServer({ db, host: '127.0.0.1', port: 0, authRequired: true });

    const unauthorized = await fetch(`${server.url}/`);
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();

    const authorized = await fetch(`${server.url}/`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);
    const csp = authorized.headers.get('content-security-policy');
    const nonce = csp?.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(await authorized.text()).toContain(`nonce="${nonce}"`);
  } finally {
    await server?.stop();
    closeDb();
    if (previousHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
