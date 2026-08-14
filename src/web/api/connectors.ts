// The connector surface: the catalog joined to what is actually configured.
//
// /api/mcp is the raw view — every server, both transports, exactly as stored.
// This is the other half: one row per *service*, whether or not it has been
// added yet, with the state the user actually asks about ("is this connected,
// and if not what do I press"). The panel's Connectors page is built on this
// endpoint alone; /api/mcp stays the place to see the machinery.
//
// A catalog entry becomes a real `mcp_servers` row the first time it is
// connected, named after its catalog id. Nothing is written before that, so
// browsing the catalog leaves no trace in the config.

import { listMcpServers, upsertMcpServer } from '../../db/collections.ts';
import type { SqliteDriver } from '../../db/index.ts';
import { mcpAuthStatus, writeMcpUserToken } from '../../db/mcp-credentials.ts';
import { BUNDLED_CONNECTORS, findCatalogConnector } from '../../mcp/catalog.ts';
import { CallbackPortBusyError } from '../../mcp/oauth/callback.ts';
import { beginConnectorFlow } from '../../mcp/oauth/connect.ts';
import { type Handler, HttpError, audit, json, readJsonObject } from '../http.ts';

interface ConnectorView {
  id: string;
  name: string;
  description: string;
  url: string;
  /** 'catalog' — shipped with Asterisk; 'custom' — the user added the URL. */
  source: 'catalog' | 'custom';
  installed: boolean;
  enabled: boolean;
  connected: boolean;
  expiresAt: number | null;
  docs: string | null;
  /** How this one is authenticated — decides which button the panel shows. */
  auth: 'oauth' | 'token';
  tokenUrl: string | null;
  tokenHelp: string | null;
}

/**
 * Catalog entries first, then any configured connector the catalog does not
 * know about.
 *
 * Matching is by name only, deliberately. A row named `linear` pointing
 * somewhere else is still that user's Linear connector — retitling it "custom"
 * because a URL differs would be a confusing way to tell them their own
 * override took effect, and the URL is shown on the row either way.
 */
export const getConnectors: Handler = ({ db }) => {
  const servers = listMcpServers(db);
  const byName = new Map(servers.map((s) => [s.name, s]));

  const fromCatalog: ConnectorView[] = BUNDLED_CONNECTORS.map((entry) => {
    const server = byName.get(entry.id);
    const installed = server !== undefined && server.transport === 'http';
    const url = installed && server.transport === 'http' ? server.url : entry.url;
    const status = installed ? mcpAuthStatus(db, entry.id, url) : undefined;
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      url,
      source: 'catalog',
      installed,
      enabled: server?.enabled ?? false,
      connected: status?.connected ?? false,
      expiresAt: status?.expiresAt ?? null,
      docs: entry.docs,
      auth: entry.auth,
      tokenUrl: entry.tokenUrl ?? null,
      tokenHelp: entry.tokenHelp ?? null,
    };
  });

  const known = new Set(BUNDLED_CONNECTORS.map((c) => c.id));
  const fromConfig: ConnectorView[] = servers
    .filter(
      (s) =>
        s.transport === 'http' && (s.auth === 'oauth' || s.auth === 'token') && !known.has(s.name),
    )
    .map((s) => {
      const url = s.transport === 'http' ? s.url : '';
      const status = mcpAuthStatus(db, s.name, url);
      return {
        id: s.name,
        name: s.name,
        description: 'Added by hand.',
        url,
        source: 'custom' as const,
        installed: true,
        enabled: s.enabled,
        connected: status.connected,
        expiresAt: status.expiresAt ?? null,
        docs: null,
        auth:
          s.transport === 'http' && s.auth === 'token' ? ('token' as const) : ('oauth' as const),
        tokenUrl: null,
        tokenHelp: null,
      };
    });

  return json({ connectors: [...fromCatalog, ...fromConfig] });
};

/**
 * Begins a flow, turning a busy callback port into an answer the panel can
 * show.
 *
 * Everything else out of `beginConnectorFlow` is a genuine surprise and keeps
 * the 500-with-a-correlation-id treatment; a taken port is a state the user
 * can resolve, so it says which port and which variable moves it.
 */
async function startFlow(db: SqliteDriver, name: string, url: string, scopes: readonly string[]) {
  try {
    return await beginConnectorFlow({ name, url, scopes }, { db, openBrowser: () => false });
  } catch (e) {
    if (e instanceof CallbackPortBusyError) throw new HttpError(e.message, 409);
    // The SDK reports a server with no registration endpoint as a bare Error.
    // It is the single most likely reason a plausible-looking endpoint cannot
    // be connected — GitHub's is one — and it has a concrete answer, so it
    // says so instead of becoming a correlation id.
    if (e instanceof Error && /does not support dynamic client registration/i.test(e.message)) {
      throw new HttpError(
        `${name} does not let clients register themselves, so the browser flow cannot be used. Use a token instead: set Authentication to token and paste one.`,
        409,
      );
    }
    throw e;
  }
}

/** Stores a user-issued token for a `token` connector, installing the row if needed. */
export const setConnectorToken: Handler = async ({ db, params, req }) => {
  const id = params[0];
  if (!id) throw new HttpError('connector id is required');
  const body = await readJsonObject(req);
  const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
  if (!token) throw new HttpError('token is required');

  const existing = listMcpServers(db).find((s) => s.name === id);
  const entry = findCatalogConnector(id);
  if (existing && existing.transport !== 'http') {
    throw new HttpError(`"${id}" is configured as a stdio MCP server`, 409);
  }
  if (!existing && !entry) throw new HttpError(`no connector named "${id}"`, 404);

  const url = existing?.transport === 'http' ? existing.url : (entry?.url ?? '');
  upsertMcpServer(db, {
    name: id,
    transport: 'http',
    url,
    headers: existing?.transport === 'http' ? existing.headers : {},
    auth: 'token',
    scopes: existing?.transport === 'http' ? existing.scopes : [...(entry?.scopes ?? [])],
    enabled: true,
  });
  writeMcpUserToken(db, id, url, token);
  // The token itself is never echoed back and never logged, here or anywhere.
  audit(db, 'connector.token', id, { url });
  return json({ ok: true });
};

/**
 * Install-if-needed, then start the consent flow — the whole of what the
 * Connect button does.
 *
 * Collapsing the two steps is the point: a catalog entry that got written to
 * the config but never authorized is a row that looks configured and answers
 * 401, which is a worse state than not having pressed the button.
 */
export const connectCatalogConnector: Handler = async ({ db, params }) => {
  const id = params[0];
  if (!id) throw new HttpError('connector id is required');

  const existing = listMcpServers(db).find((s) => s.name === id);
  const entry = findCatalogConnector(id);

  if (existing && existing.transport !== 'http') {
    throw new HttpError(
      `"${id}" is already configured as a stdio MCP server — rename or remove it first`,
      409,
    );
  }
  if (!existing && !entry) throw new HttpError(`no connector named "${id}"`, 404);

  const url = existing?.transport === 'http' ? existing.url : (entry?.url ?? '');
  const scopes = existing?.transport === 'http' ? existing.scopes : [...(entry?.scopes ?? [])];

  // Checked before anything is written: installing the row first and then
  // refusing would leave a token connector recorded as an OAuth one, which is
  // a configuration the user never asked for and would have to undo by hand.
  const tokenKind =
    entry?.auth === 'token' || (existing?.transport === 'http' && existing.auth === 'token');
  if (tokenKind) {
    throw new HttpError(
      `${id} authenticates with a token, not a browser flow — send it to /api/connectors/${id}/token`,
      409,
    );
  }

  if (!existing) {
    upsertMcpServer(db, {
      name: id,
      transport: 'http',
      url,
      headers: {},
      auth: 'oauth',
      scopes,
      enabled: true,
    });
    audit(db, 'connector.install', id, { url });
  } else if (existing.transport === 'http' && existing.auth === 'none') {
    throw new HttpError(`"${id}" is configured with auth: none — edit it on the MCP page`, 409);
  }

  const flow = await startFlow(db, id, url, scopes);
  audit(db, 'connector.connect', id, { status: flow.status });
  return json({
    ok: true,
    status: flow.status,
    authorizationUrl: flow.consentUrl ?? null,
  });
};
