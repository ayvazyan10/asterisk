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
import { audit, type Handler, HttpError, json, readJsonObject } from '../http.ts';

export const getMcpServers: Handler = ({ db }) => json({ servers: listMcpServers(db) });

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
