// CRUD endpoints for the list-shaped configuration: MCP servers and hooks.

import { HookConfigSchema, McpServerSchema } from '../../config/schema.ts';
import {
  deleteHook,
  deleteMcpServer,
  listHooks,
  listMcpServers,
  upsertHook,
  upsertMcpServer,
} from '../../db/collections.ts';
import { mcpAuthStatus } from '../../db/mcp-credentials.ts';
import { beginConnectorFlow, disconnectConnector } from '../../mcp/oauth/connect.ts';
import { type Handler, HttpError, audit, json, readJsonObject } from '../http.ts';

/**
 * Servers plus, for connectors, whether they currently hold a token.
 *
 * Only the status — never the token, never the client secret. The panel has no
 * legitimate use for the credential itself, and anything sent to the browser
 * ends up in a devtools network log.
 */
export const getMcpServers: Handler = ({ db }) =>
  json({
    servers: listMcpServers(db).map((server) =>
      server.transport === 'http' && server.auth === 'oauth'
        ? { ...server, oauth: mcpAuthStatus(db, server.name, server.url) }
        : server,
    ),
  });

export const putMcpServer: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const parsed = McpServerSchema.safeParse(body['server']);
  if (!parsed.success) {
    throw new HttpError('invalid MCP server definition', 422, parsed.error.format());
  }
  const saved = upsertMcpServer(db, parsed.data);
  audit(db, 'mcp.upsert', saved.name, { transport: saved.transport, enabled: saved.enabled });
  return json({ ok: true, server: saved });
};

export const removeMcpServer: Handler = ({ db, params }) => {
  const name = params[0];
  if (!name) throw new HttpError('server name is required');
  if (!deleteMcpServer(db, name)) throw new HttpError(`no MCP server named "${name}"`, 404);
  audit(db, 'mcp.delete', name);
  return json({ ok: true });
};

/**
 * Starts a connector's consent flow and hands the URL back to the caller.
 *
 * The panel is already open in a browser on this machine, so the URL goes to
 * that tab rather than to a browser spawned server-side — which would be the
 * wrong machine entirely when the panel is reached over an SSH tunnel.
 *
 * Returns as soon as there is a URL. The exchange finishes in the background
 * when the user comes back through the loopback listener; the panel learns the
 * outcome by re-reading GET /api/mcp.
 */
export const beginMcpAuth: Handler = async ({ db, params }) => {
  const name = params[0];
  if (!name) throw new HttpError('server name is required');
  const server = listMcpServers(db).find((s) => s.name === name);
  if (!server) throw new HttpError(`no MCP server named "${name}"`, 404);
  if (server.transport !== 'http' || server.auth !== 'oauth') {
    throw new HttpError(`"${name}" is not a connector (auth: oauth)`, 409);
  }

  const flow = await beginConnectorFlow(
    { name, url: server.url, scopes: server.scopes },
    { db, openBrowser: () => false },
  );
  audit(db, 'mcp.connect', name, { status: flow.status });
  return json({
    ok: true,
    status: flow.status,
    authorizationUrl: flow.consentUrl ?? null,
  });
};

export const clearMcpAuth: Handler = ({ db, params }) => {
  const name = params[0];
  if (!name) throw new HttpError('server name is required');
  const removed = disconnectConnector(name, db);
  audit(db, 'mcp.disconnect', name, { removed });
  return json({ ok: true, removed });
};

export const getHooks: Handler = ({ db }) => json({ hooks: listHooks(db) });

export const putHook: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const parsed = HookConfigSchema.safeParse(body['hook']);
  if (!parsed.success) {
    throw new HttpError('invalid hook definition', 422, parsed.error.format());
  }
  const saved = upsertHook(db, parsed.data);
  audit(db, 'hook.upsert', saved.name, { event: saved.event, enabled: saved.enabled });
  return json({ ok: true, hook: saved });
};

export const removeHook: Handler = ({ db, params }) => {
  const name = params[0];
  if (!name) throw new HttpError('hook name is required');
  if (!deleteHook(db, name)) throw new HttpError(`no hook named "${name}"`, 404);
  audit(db, 'hook.delete', name);
  return json({ ok: true });
};
