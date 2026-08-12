// Row <-> config mapping for the list-shaped parts of the configuration:
// MCP servers and hooks. These get real tables rather than JSON blobs in the
// settings KV so the web UI can add, edit, reorder and delete individual
// entries without rewriting the whole array.

import type { HookConfig, McpServerConfig } from '../config/schema.ts';
import { HookConfigSchema, McpServerSchema } from '../config/schema.ts';
import type { SqliteDriver } from './driver.ts';

interface McpRow {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  enabled: number;
  sort_order: number;
}

interface HookRow {
  id: number;
  name: string;
  event: string;
  matcher: string | null;
  command: string;
  timeout_seconds: number;
  enabled: number;
  sort_order: number;
}

/** A stored entry plus its database id, which the config type has no room for. */
export type WithId<T> = T & { id: number };

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A hand-edited database shouldn't take the whole process down; fall back
    // to the empty value and let schema validation flag anything else.
    return fallback;
  }
}

function rowToMcp(row: McpRow): WithId<McpServerConfig> {
  const base =
    row.transport === 'stdio'
      ? {
          name: row.name,
          transport: 'stdio' as const,
          command: row.command ?? '',
          args: parseJson<string[]>(row.args, []),
          env: parseJson<Record<string, string>>(row.env, {}),
          enabled: row.enabled === 1,
        }
      : {
          name: row.name,
          transport: 'http' as const,
          url: row.url ?? '',
          headers: parseJson<Record<string, string>>(row.headers, {}),
          enabled: row.enabled === 1,
        };
  return { ...base, id: row.id };
}

export function listMcpServers(db: SqliteDriver): Array<WithId<McpServerConfig>> {
  return db.all<McpRow>('SELECT * FROM mcp_servers ORDER BY sort_order, id').map(rowToMcp);
}

/** Config-shaped view, for `loadConfig()`. Ids are stripped. */
export function mcpServersForConfig(db: SqliteDriver): McpServerConfig[] {
  return listMcpServers(db).map(({ id: _id, ...rest }) => rest as McpServerConfig);
}

export function upsertMcpServer(
  db: SqliteDriver,
  input: McpServerConfig,
  sortOrder?: number,
): WithId<McpServerConfig> {
  const server = McpServerSchema.parse(input);
  const order =
    sortOrder ??
    db.get<{ next: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM mcp_servers')
      ?.next ??
    0;

  db.run(
    `INSERT INTO mcp_servers
       (name, transport, command, args, env, url, headers, enabled, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       transport  = excluded.transport,
       command    = excluded.command,
       args       = excluded.args,
       env        = excluded.env,
       url        = excluded.url,
       headers    = excluded.headers,
       enabled    = excluded.enabled,
       updated_at = excluded.updated_at`,
    [
      server.name,
      server.transport,
      server.transport === 'stdio' ? server.command : null,
      JSON.stringify(server.transport === 'stdio' ? server.args : []),
      JSON.stringify(server.transport === 'stdio' ? server.env : {}),
      server.transport === 'http' ? server.url : null,
      JSON.stringify(server.transport === 'http' ? server.headers : {}),
      server.enabled,
      order,
      Date.now(),
    ],
  );

  const row = db.get<McpRow>('SELECT * FROM mcp_servers WHERE name = ?', [server.name]);
  if (!row) throw new Error(`failed to persist MCP server "${server.name}"`);
  return rowToMcp(row);
}

export function deleteMcpServer(db: SqliteDriver, name: string): boolean {
  const existing = db.get<McpRow>('SELECT id FROM mcp_servers WHERE name = ?', [name]);
  if (!existing) return false;
  db.run('DELETE FROM mcp_servers WHERE name = ?', [name]);
  return true;
}

/** Replaces the whole collection — used by config import. */
export function replaceMcpServers(db: SqliteDriver, servers: readonly McpServerConfig[]): void {
  db.transaction(() => {
    db.run('DELETE FROM mcp_servers');
    servers.forEach((s, i) => upsertMcpServer(db, s, i));
  });
}

// --- hooks ---------------------------------------------------------------

function rowToHook(row: HookRow): WithId<HookConfig> {
  const parsed = HookConfigSchema.parse({
    name: row.name,
    event: row.event,
    ...(row.matcher ? { matcher: row.matcher } : {}),
    command: row.command,
    timeoutSeconds: row.timeout_seconds,
    enabled: row.enabled === 1,
  });
  return { ...parsed, id: row.id };
}

export function listHooks(db: SqliteDriver): Array<WithId<HookConfig>> {
  return db.all<HookRow>('SELECT * FROM hooks ORDER BY sort_order, id').map(rowToHook);
}

export function hooksForConfig(db: SqliteDriver): HookConfig[] {
  return listHooks(db).map(({ id: _id, ...rest }) => rest);
}

export function upsertHook(
  db: SqliteDriver,
  input: HookConfig,
  sortOrder?: number,
): WithId<HookConfig> {
  const hook = HookConfigSchema.parse(input);
  const order =
    sortOrder ??
    db.get<{ next: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM hooks')?.next ??
    0;

  db.run(
    `INSERT INTO hooks
       (name, event, matcher, command, timeout_seconds, enabled, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       event           = excluded.event,
       matcher         = excluded.matcher,
       command         = excluded.command,
       timeout_seconds = excluded.timeout_seconds,
       enabled         = excluded.enabled,
       updated_at      = excluded.updated_at`,
    [
      hook.name,
      hook.event,
      hook.matcher ?? null,
      hook.command,
      hook.timeoutSeconds,
      hook.enabled,
      order,
      Date.now(),
    ],
  );

  const row = db.get<HookRow>('SELECT * FROM hooks WHERE name = ?', [hook.name]);
  if (!row) throw new Error(`failed to persist hook "${hook.name}"`);
  return rowToHook(row);
}

export function deleteHook(db: SqliteDriver, name: string): boolean {
  const existing = db.get<HookRow>('SELECT id FROM hooks WHERE name = ?', [name]);
  if (!existing) return false;
  db.run('DELETE FROM hooks WHERE name = ?', [name]);
  return true;
}

export function replaceHooks(db: SqliteDriver, hooks: readonly HookConfig[]): void {
  db.transaction(() => {
    db.run('DELETE FROM hooks');
    hooks.forEach((h, i) => upsertHook(db, h, i));
  });
}
