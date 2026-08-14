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
import { mcpAuthStatus } from '../../db/mcp-credentials.ts';
import { BUNDLED_CONNECTORS, findCatalogConnector } from '../../mcp/catalog.ts';
import { beginConnectorFlow } from '../../mcp/oauth/connect.ts';
import { type Handler, HttpError, audit, json } from '../http.ts';

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
    };
  });

  const known = new Set(BUNDLED_CONNECTORS.map((c) => c.id));
  const fromConfig: ConnectorView[] = servers
    .filter((s) => s.transport === 'http' && s.auth === 'oauth' && !known.has(s.name))
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
      };
    });

  return json({ connectors: [...fromCatalog, ...fromConfig] });
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
  } else if (existing.transport === 'http' && existing.auth !== 'oauth') {
    throw new HttpError(`"${id}" is configured with auth: none — edit it on the MCP page`, 409);
  }

  const flow = await beginConnectorFlow(
    { name: id, url, scopes },
    { db, openBrowser: () => false },
  );
  audit(db, 'connector.connect', id, { status: flow.status });
  return json({
    ok: true,
    status: flow.status,
    authorizationUrl: flow.consentUrl ?? null,
  });
};
