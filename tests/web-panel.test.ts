// Control-panel API tests. The handler is a pure Request -> Response
// function, so nothing here binds a port.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config/schema.ts';
import { readConfig, writeConfig } from '../src/config/store.ts';
import { type SqliteDriver, openDriver } from '../src/db/driver.ts';
import { writeMcpCredentials } from '../src/db/mcp-credentials.ts';
import { migrate } from '../src/db/migrations.ts';
import { getSecret } from '../src/db/settings.ts';
import { issueToken, verifyToken } from '../src/web/auth.ts';
import { matchRoute } from '../src/web/router.ts';
import { createRequestHandler } from '../src/web/server.ts';

interface CallResult {
  status: number;
  // Responses are arbitrary JSON shapes; tests assert on them structurally.
  // biome-ignore lint/suspicious/noExplicitAny: test-local convenience
  body: any;
  res: Response;
}

let db: SqliteDriver;
let home: string;
let prevHome: string | undefined;
let call: (path: string, init?: RequestInit) => Promise<CallResult>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-panel-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;

  db = openDriver(':memory:');
  migrate(db);
  writeConfig(db, ConfigSchema.parse({}));

  const handler = createRequestHandler({ db, host: '127.0.0.1', port: 0, authRequired: false });
  call = async (path, init) => {
    const res = await handler(new Request(`http://localhost${path}`, init));
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, res };
  };
});

afterEach(async () => {
  db.close();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('router', () => {
  it('matches static and parameterised routes', () => {
    expect(matchRoute('GET', '/api/status')).toMatchObject({ params: [] });
    expect(matchRoute('DELETE', '/api/mcp/my-server')).toMatchObject({ params: ['my-server'] });
  });

  it('captures wildcard tails as separate segments', () => {
    expect(matchRoute('GET', '/api/content/rules/common/style.md')).toMatchObject({
      params: ['rules', 'common', 'style.md'],
    });
  });

  it('prefers the file route over the listing route', () => {
    expect(matchRoute('GET', '/api/content/rules')).toMatchObject({ params: ['rules'] });
    expect(matchRoute('GET', '/api/content/rules/a.md')).toMatchObject({
      params: ['rules', 'a.md'],
    });
  });

  it('reports allowed methods for a known path with the wrong verb', () => {
    expect(matchRoute('DELETE', '/api/settings')).toEqual({ allowed: ['GET', 'PATCH'] });
  });

  it('returns undefined for unknown paths', () => {
    expect(matchRoute('GET', '/api/nope')).toBeUndefined();
  });

  it('decodes percent-encoded segments', () => {
    expect(matchRoute('DELETE', '/api/hooks/my%20hook')).toMatchObject({ params: ['my hook'] });
  });
});

describe('settings API', () => {
  it('serves the schema-derived registry with current values', async () => {
    const { status, body } = await call('/api/settings');
    expect(status).toBe(200);

    const fields = body.groups.flatMap((g: { fields: unknown[] }) => g.fields);
    const paths = fields.map((f: { path: string }) => f.path);
    expect(paths).toContain('ollama.model');
    expect(paths).toContain('web.port');

    expect(fields.find((f: { path: string }) => f.path === 'provider')).toMatchObject({
      kind: 'enum',
      value: 'ollama',
    });
  });

  it('applies a valid patch', async () => {
    const { status } = await call(
      '/api/settings',
      send('PATCH', { updates: { provider: 'anthropic', 'ollama.contextWindow': 8192 } }),
    );
    expect(status).toBe(200);

    const config = readConfig(db);
    expect(config.provider).toBe('anthropic');
    expect(config.ollama.contextWindow).toBe(8192);
  });

  it('rejects the whole patch when one field is invalid', async () => {
    const { status, body } = await call(
      '/api/settings',
      send('PATCH', { updates: { provider: 'anthropic', 'ollama.contextWindow': -5 } }),
    );
    expect(status).toBe(422);
    expect(body.detail).toHaveProperty('ollama.contextWindow');
    // The valid half must not have been applied.
    expect(readConfig(db).provider).toBe('ollama');
  });

  it('rejects unknown setting paths', async () => {
    const { status, body } = await call(
      '/api/settings',
      send('PATCH', { updates: { 'not.a.setting': 1 } }),
    );
    expect(status).toBe(422);
    expect(body.detail['not.a.setting']).toMatch(/no such setting/);
  });

  it('rejects a malformed body', async () => {
    const bad = await call('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{ nope',
    });
    expect(bad.status).toBe(400);
    expect((await call('/api/settings', send('PATCH', { updates: {} }))).status).toBe(400);
  });

  it('resets a single setting to its default', async () => {
    await call('/api/settings', send('PATCH', { updates: { 'ollama.model': 'weird:1b' } }));
    const { status, body } = await call(
      '/api/settings/reset',
      send('POST', { path: 'ollama.model' }),
    );
    expect(status).toBe(200);
    expect(body.value).toBe('carstenuhlig/omnicoder-9b:q8_0');
    expect(readConfig(db).ollama.model).toBe('carstenuhlig/omnicoder-9b:q8_0');
  });

  it('records changes in the audit log', async () => {
    await call('/api/settings', send('PATCH', { updates: { provider: 'anthropic' } }));
    const { body } = await call('/api/audit');
    expect(body.entries[0]).toMatchObject({ action: 'settings.patch', target: 'provider' });
  });
});

describe('secrets API', () => {
  it('never returns plaintext', async () => {
    await call(
      '/api/secrets',
      send('PUT', { key: 'ANTHROPIC_API_KEY', value: 'sk-supersecret-1234' }),
    );
    const { body } = await call('/api/secrets');

    expect(JSON.stringify(body)).not.toContain('sk-supersecret-1234');
    expect(body.secrets.find((s: { key: string }) => s.key === 'ANTHROPIC_API_KEY')).toMatchObject({
      set: true,
      masked: 'sk-••••••1234',
    });
    // ...but it is stored intact.
    expect(getSecret(db, 'ANTHROPIC_API_KEY')).toBe('sk-supersecret-1234');
  });

  it('clears a secret when given an empty value', async () => {
    await call('/api/secrets', send('PUT', { key: 'ANTHROPIC_API_KEY', value: 'sk-x' }));
    await call('/api/secrets', send('PUT', { key: 'ANTHROPIC_API_KEY', value: '' }));
    expect(getSecret(db, 'ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('rejects unknown secret keys', async () => {
    expect((await call('/api/secrets', send('PUT', { key: 'MY_KEY', value: 'x' }))).status).toBe(
      400,
    );
  });
});

describe('collections API', () => {
  it('creates, lists and deletes an MCP server', async () => {
    const created = await call(
      '/api/mcp',
      send('PUT', {
        server: { name: 'files', transport: 'stdio', command: 'mcp-files', args: ['/tmp'] },
      }),
    );
    expect(created.status).toBe(200);

    const listed = await call('/api/mcp');
    expect(listed.body.servers).toHaveLength(1);
    expect(listed.body.servers[0]).toMatchObject({ name: 'files', enabled: true });

    expect((await call('/api/mcp/files', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/api/mcp')).body.servers).toHaveLength(0);
  });

  it('404s when deleting something that is not there', async () => {
    expect((await call('/api/mcp/ghost', { method: 'DELETE' })).status).toBe(404);
  });

  it('reports connector status without leaking the credential', async () => {
    await call(
      '/api/mcp',
      send('PUT', {
        server: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          auth: 'oauth',
        },
      }),
    );
    writeMcpCredentials(db, 'linear', 'https://mcp.linear.app/mcp', {
      tokens: { access_token: 'super-secret', refresh_token: 'also-secret' },
    });

    const listed = await call('/api/mcp');
    expect(listed.body.servers[0].oauth).toMatchObject({ connected: true, hasRefreshToken: true });
    expect(JSON.stringify(listed.body)).not.toContain('super-secret');
  });

  it('refuses to start a consent flow for a server that is not a connector', async () => {
    await call(
      '/api/mcp',
      send('PUT', { server: { name: 'plain', transport: 'http', url: 'https://example.com/mcp' } }),
    );
    expect((await call('/api/mcp/plain/connect', { method: 'POST' })).status).toBe(409);
    expect((await call('/api/mcp/ghost/connect', { method: 'POST' })).status).toBe(404);
  });

  it('lists the bundled catalog before anything is configured', async () => {
    const { body } = await call('/api/connectors');
    const ids = body.connectors.map((c: { id: string }) => c.id);
    expect(ids).toContain('linear');
    expect(body.connectors.every((c: { source: string }) => c.source === 'catalog')).toBe(true);
    // Browsing must not write anything.
    expect((await call('/api/mcp')).body.servers).toHaveLength(0);
  });

  it('shows a hand-added connector alongside the catalog', async () => {
    await call(
      '/api/mcp',
      send('PUT', {
        server: {
          name: 'in-house',
          transport: 'http',
          url: 'https://mcp.example/mcp',
          auth: 'oauth',
        },
      }),
    );
    const { body } = await call('/api/connectors');
    const custom = body.connectors.find((c: { id: string }) => c.id === 'in-house');
    expect(custom).toMatchObject({ source: 'custom', installed: true, connected: false });
  });

  it('sends a token connector down the token path instead of the browser flow', async () => {
    const { status, body } = await call('/api/connectors/github/connect', { method: 'POST' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/token/);
    // Nothing may be written by a refused connect.
    expect((await call('/api/mcp')).body.servers).toHaveLength(0);
  });

  it('stores a token connector’s token outside the exported config', async () => {
    const { status } = await call(
      '/api/connectors/github/token',
      send('PUT', { token: 'ghp-super-secret' }),
    );
    expect(status).toBe(200);

    const server = (await call('/api/mcp')).body.servers[0];
    expect(server).toMatchObject({ name: 'github', auth: 'token' });
    // The token is a credential, so it must not reach headers — which are
    // part of what /api/config/export hands out.
    expect(JSON.stringify(server)).not.toContain('ghp-super-secret');
    expect(JSON.stringify((await call('/api/config/export')).body)).not.toContain(
      'ghp-super-secret',
    );

    const github = (await call('/api/connectors')).body.connectors.find(
      (c: { id: string }) => c.id === 'github',
    );
    expect(github).toMatchObject({ connected: true, auth: 'token' });
  });

  it('sends a manual-client connector to the client path instead of the browser flow', async () => {
    const { status, body } = await call('/api/connectors/google-drive/connect', { method: 'POST' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/OAuth client/);
    // Same rule as the token path: a refused connect writes nothing.
    expect((await call('/api/mcp')).body.servers).toHaveLength(0);
  });

  it('stores a user-registered OAuth client outside the exported config', async () => {
    const { status } = await call(
      '/api/connectors/google-drive/client',
      send('PUT', {
        clientId: 'client-123.apps.googleusercontent.com',
        clientSecret: 'gocspx-hush',
      }),
    );
    expect(status).toBe(200);

    const server = (await call('/api/mcp')).body.servers[0];
    expect(server).toMatchObject({ name: 'google-drive', auth: 'oauth' });
    expect(JSON.stringify(server)).not.toContain('gocspx-hush');
    expect(JSON.stringify((await call('/api/config/export')).body)).not.toContain('gocspx-hush');

    const drive = (await call('/api/connectors')).body.connectors.find(
      (c: { id: string }) => c.id === 'google-drive',
    );
    // The panel learns that a client exists and nothing more — not the id,
    // and certainly not the secret.
    expect(drive).toMatchObject({
      hasClient: true,
      connected: false,
      clientRegistration: 'manual',
    });
    expect(JSON.stringify(drive)).not.toContain('gocspx-hush');
    expect(JSON.stringify(drive)).not.toContain('client-123');
  });

  it('rejects an empty client id', async () => {
    expect(
      (await call('/api/connectors/google-drive/client', send('PUT', { clientId: ' ' }))).status,
    ).toBe(400);
  });

  it('asks Google for the scopes its own docs name, not for everything on offer', async () => {
    const drive = (await call('/api/connectors')).body.connectors.find(
      (c: { id: string }) => c.id === 'google-drive',
    );
    // Google's resource metadata advertises full `drive` too, and the SDK falls
    // back to all of it when no scope is given. These have to stay explicit.
    expect(drive.scopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ]);
    expect(drive.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('rejects an empty token', async () => {
    expect((await call('/api/connectors/github/token', send('PUT', { token: '  ' }))).status).toBe(
      400,
    );
  });

  it('refuses to take over a name already used by a stdio server', async () => {
    await call(
      '/api/mcp',
      send('PUT', { server: { name: 'linear', transport: 'stdio', command: 'linear-cli' } }),
    );
    const { status } = await call('/api/connectors/linear/connect', { method: 'POST' });
    expect(status).toBe(409);
  });

  it('404s on a connector id that is neither configured nor in the catalog', async () => {
    expect((await call('/api/connectors/nope/connect', { method: 'POST' })).status).toBe(404);
  });

  it('forgets stored credentials on disconnect', async () => {
    await call(
      '/api/mcp',
      send('PUT', {
        server: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          auth: 'oauth',
        },
      }),
    );
    writeMcpCredentials(db, 'linear', 'https://mcp.linear.app/mcp', {
      tokens: { access_token: 'tok' },
    });

    expect((await call('/api/mcp/linear/disconnect', { method: 'POST' })).body).toMatchObject({
      removed: true,
    });
    expect((await call('/api/mcp')).body.servers[0].oauth.connected).toBe(false);
  });

  it('rejects an invalid MCP definition', async () => {
    const { status } = await call(
      '/api/mcp',
      send('PUT', { server: { name: 'x', transport: 'carrier-pigeon' } }),
    );
    expect(status).toBe(422);
  });

  it('round-trips a hook', async () => {
    await call(
      '/api/hooks',
      send('PUT', { hook: { name: 'fmt', event: 'after_tool', command: 'biome check' } }),
    );
    const { body } = await call('/api/hooks');
    expect(body.hooks[0]).toMatchObject({ name: 'fmt', event: 'after_tool', enabled: true });
  });

  it('rejects an unknown hook event', async () => {
    const { status } = await call(
      '/api/hooks',
      send('PUT', { hook: { name: 'x', event: 'whenever', command: 'true' } }),
    );
    expect(status).toBe(422);
  });
});

describe('content API', () => {
  beforeEach(async () => {
    await mkdir(join(home, 'rules', 'common'), { recursive: true });
    await writeFile(join(home, 'rules', 'common', 'style.md'), '# Style\n');
    await writeFile(join(home, 'SOUL.md'), '# Soul\n');
    await writeFile(join(home, 'secrets.env'), 'ANTHROPIC_API_KEY="sk-ondisk"\n');
  });

  it('lists files across kinds, including the root SOUL.md', async () => {
    const { body } = await call('/api/content');
    const rules = body.kinds.find((k: { kind: string }) => k.kind === 'rules');
    expect(rules.files.map((f: { path: string }) => f.path)).toContain('common/style.md');

    const souls = body.kinds.find((k: { kind: string }) => k.kind === 'souls');
    expect(souls.files.map((f: { path: string }) => f.path)).toContain('@SOUL.md');
  });

  it('reads and writes a nested file', async () => {
    expect((await call('/api/content/rules/common/style.md')).body.content).toBe('# Style\n');

    const written = await call(
      '/api/content/rules/common/style.md',
      send('PUT', { content: '# Updated\n' }),
    );
    expect(written.status).toBe(200);
    expect(await readFile(join(home, 'rules', 'common', 'style.md'), 'utf8')).toBe('# Updated\n');
  });

  it('creates intermediate directories on write', async () => {
    const { status } = await call(
      '/api/content/agents/deep/nested/a.md',
      send('PUT', { content: 'x' }),
    );
    expect(status).toBe(200);
    expect(await readFile(join(home, 'agents', 'deep', 'nested', 'a.md'), 'utf8')).toBe('x');
  });

  it('refuses percent-encoded path traversal', async () => {
    // A literal `../` is collapsed by the URL parser before routing, so the
    // encoded forms are the ones that actually reach path validation.
    for (const path of [
      '/api/content/rules/..%2f..%2fetc%2fpasswd',
      '/api/content/rules/%2e%2e/%2e%2e/secrets.env',
      '/api/content/rules/%2e%2e%2fsecrets.env',
    ]) {
      const { status } = await call(path);
      expect(status, path).toBeGreaterThanOrEqual(400);
      expect(status, path).toBeLessThan(500);
    }
  });

  it('refuses to write outside the content root', async () => {
    const encoded = '/api/content/rules/..%2f..%2fpwned.md';
    expect((await call(encoded, send('PUT', { content: 'x' }))).status).toBe(400);
    await expect(readFile(join(home, 'pwned.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses non-markdown files', async () => {
    expect(
      (await call('/api/content/rules/config.json', send('PUT', { content: '{}' }))).status,
    ).toBe(400);
  });

  it('only allows declared extras through the @ escape hatch', async () => {
    expect((await call('/api/content/souls/@SOUL.md')).status).toBe(200);
    expect((await call('/api/content/souls/@secrets.env')).status).toBe(400);
    expect((await call('/api/content/rules/@SOUL.md')).status).toBe(400);
  });

  it('404s on a missing file', async () => {
    expect((await call('/api/content/rules/nope.md')).status).toBe(404);
  });

  it('deletes a file', async () => {
    expect((await call('/api/content/rules/common/style.md', { method: 'DELETE' })).status).toBe(
      200,
    );
    expect((await call('/api/content/rules/common/style.md')).status).toBe(404);
  });

  it('rejects an unknown kind', async () => {
    expect((await call('/api/content/passwords/x.md')).status).toBe(404);
  });
});

describe('config export and import', () => {
  it('exports the current config', async () => {
    await call('/api/settings', send('PATCH', { updates: { provider: 'anthropic' } }));
    expect((await call('/api/config/export')).body.provider).toBe('anthropic');
  });

  it('imports a full config and rejects an invalid one', async () => {
    const ok = await call(
      '/api/config/import',
      send('POST', { config: { provider: 'anthropic', ollama: { model: 'imported:1b' } } }),
    );
    expect(ok.status).toBe(200);
    expect(readConfig(db).ollama.model).toBe('imported:1b');

    expect(
      (await call('/api/config/import', send('POST', { config: { provider: 'nope' } }))).status,
    ).toBe(422);
  });
});

describe('status and system', () => {
  it('reports version, provider and counts', async () => {
    await call(
      '/api/mcp',
      send('PUT', { server: { name: 'a', transport: 'stdio', command: 'a' } }),
    );
    const { body } = await call('/api/status');
    expect(body).toMatchObject({
      provider: 'ollama',
      counts: { mcpServers: 1, enabledMcpServers: 1 },
    });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects an unknown daemon action', async () => {
    expect((await call('/api/daemon/explode', { method: 'POST' })).status).toBe(404);
  });

  it('clamps the log line count', async () => {
    expect((await call('/api/logs?lines=999999')).body.lines).toBe(2000);
    expect((await call('/api/logs?lines=abc')).body.lines).toBe(200);
  });
});

describe('tokens and auth', () => {
  it('issues a token and verifies it', () => {
    const token = issueToken(db, 'test');
    expect(verifyToken(db, token)).toBe(true);
    expect(verifyToken(db, 'wrong')).toBe(false);
    expect(verifyToken(db, '')).toBe(false);
  });

  it('stores only the hash, never the plaintext', () => {
    const token = issueToken(db, 'test');
    const row = db.get<{ token_hash: string }>('SELECT token_hash FROM web_tokens');
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks API calls without a token when auth is on', async () => {
    const guarded = createRequestHandler({ db, host: '127.0.0.1', port: 0, authRequired: true });
    expect((await guarded(new Request('http://localhost/api/status'))).status).toBe(401);
  });

  it('accepts a bearer token and hands back a hardened session cookie', async () => {
    const token = issueToken(db, 'test');
    const guarded = createRequestHandler({ db, host: '127.0.0.1', port: 0, authRequired: true });

    const res = await guarded(
      new Request('http://localhost/api/status', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(200);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('asterisk_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('accepts the session cookie on later requests', async () => {
    const token = issueToken(db, 'test');
    const guarded = createRequestHandler({ db, host: '127.0.0.1', port: 0, authRequired: true });
    const res = await guarded(
      new Request('http://localhost/api/status', {
        headers: { cookie: `asterisk_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('accepts a query token on the page load', async () => {
    const token = issueToken(db, 'test');
    const guarded = createRequestHandler({ db, host: '127.0.0.1', port: 0, authRequired: true });
    const res = await guarded(new Request(`http://localhost/?token=${token}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Asterisk');
  });

  it('revokes a token', async () => {
    expect((await call('/api/tokens', send('POST', { label: 'laptop' }))).body.token).toBeTruthy();
    const id = (await call('/api/tokens')).body.tokens[0].id;
    expect((await call(`/api/tokens/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/api/tokens')).body.tokens).toHaveLength(0);
  });
});

describe('responses', () => {
  it('serves the panel under a CSP nonce that matches its inline tags', async () => {
    // The page is not JSON, so `call` hands the raw HTML back as `body`.
    const { res, body: html } = await call('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];

    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it('sets hardening headers on API responses', async () => {
    const { res } = await call('/api/status');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('404s unknown paths and 405s wrong methods', async () => {
    expect((await call('/api/nonsense')).status).toBe(404);
    const wrong = await call('/api/settings', { method: 'DELETE' });
    expect(wrong.status).toBe(405);
    expect(wrong.body.detail.allowed).toContain('PATCH');
  });
});
