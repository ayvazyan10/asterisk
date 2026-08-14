// Connector tests — the OAuth half of an http MCP server.
//
// The end-to-end case runs the real MCP SDK against a fake authorization
// server and a fake protected resource, both plain node:http servers. Nothing
// is mocked out of the SDK: discovery, dynamic registration, PKCE and the code
// exchange all happen for real, and the only thing standing in for a human is
// a fetch() against the loopback callback that a browser would otherwise make.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { type AddressInfo, createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../src/config/schema.ts';
import { deleteMcpServer, listMcpServers, upsertMcpServer } from '../src/db/collections.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import {
  clearMcpCredentials,
  mcpAuthStatus,
  readMcpCredentials,
  writeMcpCredentials,
  writeMcpOAuthClient,
} from '../src/db/mcp-credentials.ts';
import { CallbackPortBusyError, startCallbackServer } from '../src/mcp/oauth/callback.ts';
import {
  beginConnectorFlow,
  browserCommands,
  disconnectConnector,
  openInBrowser,
} from '../src/mcp/oauth/connect.ts';
import { ConsentRequiredError, createConnectorAuthProvider } from '../src/mcp/oauth/provider.ts';
import { defined } from './helpers.ts';

const RESOURCE = 'https://example.com/mcp';

async function freePort(): Promise<number> {
  const probe = createSocketServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function withTempHome(prefix: string): () => string {
  let home = '';
  let savedHome: string | undefined;
  let savedPort: string | undefined;

  beforeEach(async () => {
    savedHome = process.env['ASTERISK_HOME'];
    savedPort = process.env['ASTERISK_OAUTH_PORT'];
    home = await mkdtemp(join(tmpdir(), `asterisk-${prefix}-`));
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    closeDb();
    if (savedHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = savedHome;
    if (savedPort === undefined) delete process.env['ASTERISK_OAUTH_PORT'];
    else process.env['ASTERISK_OAUTH_PORT'] = savedPort;
    await rm(home, { recursive: true, force: true });
  });

  return () => home;
}

describe('mcp credential store', () => {
  withTempHome('mcp-creds');

  it('round-trips a patch without disturbing fields it did not name', () => {
    const db = getDb();
    writeMcpCredentials(db, 'demo', RESOURCE, { clientInfo: { client_id: 'abc' } });
    writeMcpCredentials(db, 'demo', RESOURCE, { codeVerifier: 'verifier-1' });

    const record = defined(readMcpCredentials(db, 'demo', RESOURCE), 'credential record');
    expect(record.clientInfo).toEqual({ client_id: 'abc' });
    expect(record.codeVerifier).toBe('verifier-1');
  });

  it('refuses — and deletes — credentials issued for a different URL', () => {
    const db = getDb();
    writeMcpCredentials(db, 'demo', RESOURCE, { tokens: { access_token: 'tok' } });

    expect(readMcpCredentials(db, 'demo', 'https://elsewhere.example/mcp')).toBeUndefined();
    // Gone for the original URL too: the row was dropped, not just hidden.
    expect(readMcpCredentials(db, 'demo', RESOURCE)).toBeUndefined();
  });

  it('clears tokens but keeps the client registration', () => {
    const db = getDb();
    writeMcpCredentials(db, 'demo', RESOURCE, {
      clientInfo: { client_id: 'abc' },
      tokens: { access_token: 'tok' },
      expiresAt: Date.now() + 1000,
    });

    clearMcpCredentials(db, 'demo', 'tokens');

    const record = defined(readMcpCredentials(db, 'demo', RESOURCE), 'credential record');
    expect(record.tokens).toBeUndefined();
    expect(record.expiresAt).toBeUndefined();
    expect(record.clientInfo).toEqual({ client_id: 'abc' });
  });

  it('takes a client the user registered, and drops what the last one earned', () => {
    const db = getDb();
    writeMcpCredentials(db, 'demo', RESOURCE, {
      clientInfo: { client_id: 'old' },
      tokens: { access_token: 'issued-to-old' },
      codeVerifier: 'half-finished',
    });

    writeMcpOAuthClient(db, 'demo', RESOURCE, 'new-id', 'new-secret');

    const record = defined(readMcpCredentials(db, 'demo', RESOURCE), 'credential record');
    expect(record.clientInfo).toEqual({ client_id: 'new-id', client_secret: 'new-secret' });
    // A token minted for another client id is not usable with this one, and an
    // abandoned flow's verifier belongs to the client that began it.
    expect(record.tokens).toBeUndefined();
    expect(record.codeVerifier).toBeUndefined();
    expect(mcpAuthStatus(db, 'demo', RESOURCE)).toMatchObject({
      hasClient: true,
      connected: false,
    });
  });

  it('stores no client_secret when the client has none', () => {
    const db = getDb();
    writeMcpOAuthClient(db, 'demo', RESOURCE, 'public-id');
    const record = defined(readMcpCredentials(db, 'demo', RESOURCE), 'credential record');
    // An empty secret is not the same as no secret: the SDK picks the token
    // endpoint's auth method from whether one is present at all.
    expect(record.clientInfo).toEqual({ client_id: 'public-id' });
  });

  it('reports connection status from the stored token', () => {
    const db = getDb();
    expect(mcpAuthStatus(db, 'demo', RESOURCE).connected).toBe(false);

    writeMcpCredentials(db, 'demo', RESOURCE, {
      tokens: { access_token: 'tok', refresh_token: 'ref' },
      expiresAt: 4242,
    });

    expect(mcpAuthStatus(db, 'demo', RESOURCE)).toEqual({
      connected: true,
      hasClient: false,
      expiresAt: 4242,
      hasRefreshToken: true,
    });
  });
});

describe('credential lifecycle against the server row', () => {
  withTempHome('mcp-creds-life');

  const connector = (url: string): McpServerConfig => ({
    name: 'demo',
    transport: 'http',
    url,
    headers: {},
    auth: 'oauth',
    scopes: [],
    enabled: true,
  });

  it('drops credentials when the URL changes', () => {
    const db = getDb();
    upsertMcpServer(db, connector(RESOURCE));
    writeMcpCredentials(db, 'demo', RESOURCE, { tokens: { access_token: 'tok' } });

    upsertMcpServer(db, connector('https://other.example/mcp'));

    expect(readMcpCredentials(db, 'demo', 'https://other.example/mcp')).toBeUndefined();
  });

  it('keeps credentials when an unrelated field changes', () => {
    const db = getDb();
    upsertMcpServer(db, connector(RESOURCE));
    writeMcpCredentials(db, 'demo', RESOURCE, { tokens: { access_token: 'tok' } });

    upsertMcpServer(db, { ...connector(RESOURCE), enabled: false });

    expect(mcpAuthStatus(db, 'demo', RESOURCE).connected).toBe(true);
  });

  it('drops credentials when OAuth is switched off', () => {
    const db = getDb();
    upsertMcpServer(db, connector(RESOURCE));
    writeMcpCredentials(db, 'demo', RESOURCE, { tokens: { access_token: 'tok' } });

    upsertMcpServer(db, {
      name: 'demo',
      transport: 'http',
      url: RESOURCE,
      headers: {},
      auth: 'none',
      scopes: [],
      enabled: true,
    });

    expect(mcpAuthStatus(db, 'demo', RESOURCE).connected).toBe(false);
    expect(defined(listMcpServers(db)[0], 'server row').transport).toBe('http');
  });

  it('drops credentials when the server is deleted', () => {
    const db = getDb();
    upsertMcpServer(db, connector(RESOURCE));
    writeMcpCredentials(db, 'demo', RESOURCE, { tokens: { access_token: 'tok' } });

    deleteMcpServer(db, 'demo');

    expect(mcpAuthStatus(db, 'demo', RESOURCE).connected).toBe(false);
  });

  it('disconnectConnector reports whether anything was stored', () => {
    const db = getDb();
    writeMcpCredentials(db, 'demo', RESOURCE, { tokens: { access_token: 'tok' } });

    expect(disconnectConnector('demo', db)).toBe(true);
    expect(disconnectConnector('demo', db)).toBe(false);
  });
});

describe('connector auth provider', () => {
  withTempHome('mcp-provider');

  it('refuses to start a consent flow with nobody to consent', () => {
    const provider = createConnectorAuthProvider({
      serverName: 'demo',
      serverUrl: RESOURCE,
      db: getDb(),
    });

    expect(() =>
      provider.redirectToAuthorization(new URL('https://auth.example/authorize')),
    ).toThrow(ConsentRequiredError);
  });

  it('stores an expiry alongside the tokens and drops the spent verifier', () => {
    const db = getDb();
    const provider = createConnectorAuthProvider({ serverName: 'demo', serverUrl: RESOURCE, db });

    provider.saveCodeVerifier('verifier-1');
    provider.saveTokens({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });

    const record = defined(readMcpCredentials(db, 'demo', RESOURCE), 'credential record');
    expect(record.codeVerifier).toBeUndefined();
    expect(defined(record.expiresAt, 'expiry')).toBeGreaterThan(Date.now());
  });

  it('advertises itself as a public client with the loopback redirect', () => {
    const provider = createConnectorAuthProvider({
      serverName: 'demo',
      serverUrl: RESOURCE,
      scopes: ['read', 'write'],
      redirectUrl: 'http://127.0.0.1:4322/callback',
      db: getDb(),
    });

    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:4322/callback']);
    expect(provider.clientMetadata.scope).toBe('read write');
  });
});

describe('oauth callback listener', () => {
  withTempHome('mcp-callback');

  it('accepts a code once and rejects the replay', async () => {
    const port = await freePort();
    const listener = await startCallbackServer({ expectedState: () => 'state-1', port });
    try {
      const pending = listener.waitForCode(5000);
      const first = await fetch(`${listener.redirectUrl}?code=abc&state=state-1`);
      expect(first.status).toBe(200);
      await expect(pending).resolves.toBe('abc');

      const replay = await fetch(`${listener.redirectUrl}?code=abc&state=state-1`);
      expect(replay.status).toBe(400);
    } finally {
      await listener.close();
    }
  });

  it('rejects a code that arrives with the wrong state', async () => {
    const port = await freePort();
    const listener = await startCallbackServer({ expectedState: () => 'state-1', port });
    try {
      // The assertion is attached before the request that triggers the
      // rejection — attaching it afterwards leaves the promise momentarily
      // unhandled, which Node reports as an unhandled rejection.
      const pending = expect(listener.waitForCode(5000)).rejects.toThrow(/state mismatch/);
      await fetch(`${listener.redirectUrl}?code=abc&state=forged`);
      await pending;
    } finally {
      await listener.close();
    }
  });

  it('surfaces the authorization server’s own error', async () => {
    const port = await freePort();
    const listener = await startCallbackServer({ expectedState: () => undefined, port });
    try {
      const pending = expect(listener.waitForCode(5000)).rejects.toThrow(
        /access_denied: user said no/,
      );
      await fetch(`${listener.redirectUrl}?error=access_denied&error_description=user%20said%20no`);
      await pending;
    } finally {
      await listener.close();
    }
  });
});

// --- end-to-end -----------------------------------------------------------

interface FakeAuthServer {
  issuer: string;
  registrations: number;
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

async function startFakeAuthServer(): Promise<FakeAuthServer> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const state: { registrations: number; tokenRequests: URLSearchParams[] } = {
    registrations: 0,
    tokenRequests: [],
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      state.registrations += 1;
      json(
        {
          client_id: 'test-client',
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: [],
        },
        201,
      );
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        state.tokenRequests.push(new URLSearchParams(body));
        json({
          access_token: 'access-token-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-token-1',
        });
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  return {
    issuer,
    get registrations() {
      return state.registrations;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A protected MCP endpoint that answers 401 and points at its authorization server. */
async function startFakeResource(
  authIssuer: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const mcpUrl = `${origin}/mcp`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: mcpUrl, authorization_servers: [authIssuer] }));
      return;
    }
    res.writeHead(401, {
      'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  return {
    url: mcpUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe('connector consent flow, end to end', () => {
  withTempHome('mcp-flow');

  it('registers, redirects, exchanges the code and stores the tokens', async () => {
    const authServer = await startFakeAuthServer();
    const resource = await startFakeResource(authServer.issuer);
    process.env['ASTERISK_OAUTH_PORT'] = String(await freePort());
    const db = getDb();

    try {
      const flow = await beginConnectorFlow(
        { name: 'demo', url: resource.url },
        { db, openBrowser: () => false, timeoutMs: 10_000 },
      );

      expect(flow.status).toBe('consent-required');
      expect(authServer.registrations).toBe(1);

      const consent = new URL(defined(flow.consentUrl, 'consent url'));
      expect(consent.origin).toBe(authServer.issuer);
      // PKCE, not a client secret: the code is bound to a challenge only this
      // process can answer.
      expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
      const state = defined(consent.searchParams.get('state'), 'state parameter');

      // Stand in for the browser the user would have been sent to.
      const callback = new URL(defined(consent.searchParams.get('redirect_uri'), 'redirect_uri'));
      callback.searchParams.set('code', 'auth-code-1');
      callback.searchParams.set('state', state);
      await fetch(callback);

      await flow.completion;

      const status = mcpAuthStatus(db, 'demo', resource.url);
      expect(status.connected).toBe(true);
      expect(status.hasRefreshToken).toBe(true);
      expect(defined(status.expiresAt, 'expiry')).toBeGreaterThan(Date.now());

      const tokenRequest = defined(authServer.tokenRequests[0], 'token request');
      expect(tokenRequest.get('grant_type')).toBe('authorization_code');
      expect(tokenRequest.get('code')).toBe('auth-code-1');
      expect(tokenRequest.get('code_verifier')).toBeTruthy();
    } finally {
      await resource.close();
      await authServer.close();
    }
  });

  it('supersedes a flow that is still waiting instead of failing to bind', async () => {
    const authServer = await startFakeAuthServer();
    const resource = await startFakeResource(authServer.issuer);
    process.env['ASTERISK_OAUTH_PORT'] = String(await freePort());
    const db = getDb();

    try {
      // The first flow holds the fixed callback port for its whole timeout.
      const first = await beginConnectorFlow(
        { name: 'one', url: resource.url },
        { db, openBrowser: () => false, timeoutMs: 60_000 },
      );
      expect(first.status).toBe('consent-required');
      const abandoned = expect(first.completion).rejects.toThrow(/superseded/);

      // Pressing Connect again must work rather than hitting EADDRINUSE.
      const second = await beginConnectorFlow(
        { name: 'two', url: resource.url },
        { db, openBrowser: () => false, timeoutMs: 10_000 },
      );
      expect(second.status).toBe('consent-required');
      await abandoned;

      // ...and the surviving flow still completes.
      const consent = new URL(defined(second.consentUrl, 'consent url'));
      const callback = new URL(defined(consent.searchParams.get('redirect_uri'), 'redirect_uri'));
      callback.searchParams.set('code', 'auth-code-2');
      callback.searchParams.set('state', defined(consent.searchParams.get('state'), 'state'));
      await fetch(callback);
      await second.completion;

      expect(mcpAuthStatus(db, 'two', resource.url).connected).toBe(true);
      expect(mcpAuthStatus(db, 'one', resource.url).connected).toBe(false);
    } finally {
      await resource.close();
      await authServer.close();
    }
  });

  it('reports a callback port held by something else as its own error', async () => {
    const port = await freePort();
    process.env['ASTERISK_OAUTH_PORT'] = String(port);
    // Something outside Asterisk is on the port — not a flow we can supersede.
    const squatter = await startCallbackServer({ expectedState: () => undefined, port });

    try {
      await expect(
        startCallbackServer({ expectedState: () => undefined, port }),
      ).rejects.toBeInstanceOf(CallbackPortBusyError);
      await expect(startCallbackServer({ expectedState: () => undefined, port })).rejects.toThrow(
        /ASTERISK_OAUTH_PORT/,
      );
    } finally {
      await squatter.close();
    }
  });

  it('gives up when consent never arrives, and frees the port', async () => {
    const authServer = await startFakeAuthServer();
    const resource = await startFakeResource(authServer.issuer);
    const port = await freePort();
    process.env['ASTERISK_OAUTH_PORT'] = String(port);

    try {
      const flow = await beginConnectorFlow(
        { name: 'demo', url: resource.url },
        { db: getDb(), openBrowser: () => false, timeoutMs: 50 },
      );
      await expect(flow.completion).rejects.toThrow(/timed out/);

      // The listener is closed on the failure path too, so a retry can bind
      // the same fixed port instead of dying on EADDRINUSE.
      const retry = await startCallbackServer({ expectedState: () => undefined, port });
      await retry.close();
    } finally {
      await resource.close();
      await authServer.close();
    }
  });
});

describe('handing the consent URL to a browser', () => {
  const URL_ = 'https://auth.example.com/authorize?x=1';

  it('puts the Windows-side openers first under WSL', () => {
    // The distro usually has no xdg-open handler at all, so trying it first
    // would mean every WSL user copy-pastes the URL by hand.
    expect(browserCommands(URL_, 'linux', true).map(([c]) => c)).toEqual([
      'wslview',
      'explorer.exe',
      'xdg-open',
    ]);
    expect(browserCommands(URL_, 'linux', false)).toEqual([['xdg-open', [URL_]]]);
    expect(browserCommands(URL_, 'darwin')).toEqual([['open', [URL_]]]);
    // The empty argument is the title `start` would otherwise take the URL for.
    expect(browserCommands(URL_, 'win32')).toEqual([['cmd', ['/c', 'start', '', URL_]]]);
  });

  it('falls through to the next opener and reports whether any took it', async () => {
    const tried: string[] = [];
    const failFirst = async (command: string): Promise<void> => {
      tried.push(command);
      if (tried.length === 1) throw new Error('not installed');
    };
    expect(await openInBrowser(URL_, failFirst)).toBe(true);
    expect(tried.length).toBeGreaterThan(0);

    const alwaysFails = async (command: string): Promise<void> => {
      tried.push(command);
      throw new Error('nope');
    };
    // Not an error: the caller shows the URL either way, which is the whole
    // reason this returns a boolean instead of throwing.
    expect(await openInBrowser(URL_, alwaysFails)).toBe(false);
  });
});
