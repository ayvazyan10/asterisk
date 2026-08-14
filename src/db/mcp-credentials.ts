// Credential store for OAuth-authenticated MCP servers (connectors).
//
// One row per server name, holding the three things an OAuth client has to
// remember between processes: the dynamic client registration, the PKCE
// verifier of a flow that is currently open, and the tokens themselves.
//
// Kept out of the `secrets` table on purpose. That table is a flat KV whose
// keys come from SECRET_KEYS — a closed list the code enumerates to read,
// write and delete. A connector's credentials are neither flat nor
// enumerable in advance: the server name is user-chosen, and the record has
// parts with different lifetimes (a registration outlives every token; a
// verifier dies with the flow that made it). They do inherit every *handling*
// rule secrets have: excluded from config export, never rendered by the web
// panel, never logged.
//
// `resource` is the URL the tokens were issued for, and readCredentials()
// refuses to hand back a record whose resource no longer matches the server's
// configured URL. Without that check, editing a server's URL would keep the
// old service's access token attached to requests aimed at the new host.

import type { SqliteDriver } from './driver.ts';

export interface McpCredentialRecord {
  serverName: string;
  resource: string;
  /** Dynamic client registration (RFC 7591) as returned by the server. */
  clientInfo: unknown | undefined;
  /** OAuth token set. Shape is validated by the MCP SDK, not here. */
  tokens: unknown | undefined;
  /** PKCE verifier, present only between redirect and code exchange. */
  codeVerifier: string | undefined;
  /** Absolute ms when the access token expires, when the server said. */
  expiresAt: number | undefined;
  updatedAt: number;
}

interface CredentialRow {
  server_name: string;
  resource: string;
  client_info: string | null;
  tokens: string | null;
  code_verifier: string | null;
  expires_at: number | null;
  updated_at: number;
}

function parseJson(raw: string | null): unknown | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A corrupted blob is treated as absent rather than fatal: the worst case
    // is one more trip through the consent screen.
    return undefined;
  }
}

function rowToRecord(row: CredentialRow): McpCredentialRecord {
  return {
    serverName: row.server_name,
    resource: row.resource,
    clientInfo: parseJson(row.client_info),
    tokens: parseJson(row.tokens),
    codeVerifier: row.code_verifier ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads the stored credentials for one server.
 *
 * `resource` is required and compared against the stored one. A mismatch
 * returns undefined *and* deletes the row: the tokens belong to a service
 * this server no longer points at, so there is nothing to keep.
 */
export function readMcpCredentials(
  db: SqliteDriver,
  serverName: string,
  resource: string,
): McpCredentialRecord | undefined {
  const row = db.get<CredentialRow>('SELECT * FROM mcp_credentials WHERE server_name = ?', [
    serverName,
  ]);
  if (!row) return undefined;
  if (row.resource !== resource) {
    deleteMcpCredentials(db, serverName);
    return undefined;
  }
  return rowToRecord(row);
}

type CredentialPatch = Partial<
  Pick<McpCredentialRecord, 'clientInfo' | 'tokens' | 'codeVerifier' | 'expiresAt'>
>;

/**
 * Writes the named fields, creating the row if needed and leaving every field
 * not mentioned alone. Passing `null` for a field clears it — which is how a
 * spent code verifier is dropped after the exchange.
 */
export function writeMcpCredentials(
  db: SqliteDriver,
  serverName: string,
  resource: string,
  patch: CredentialPatch,
): void {
  const now = Date.now();
  const existing = db.get<CredentialRow>('SELECT * FROM mcp_credentials WHERE server_name = ?', [
    serverName,
  ]);

  // A resource change invalidates everything that came before it, so the
  // patch is applied to an empty record rather than to the stale one.
  const base: CredentialRow =
    existing && existing.resource === resource
      ? existing
      : {
          server_name: serverName,
          resource,
          client_info: null,
          tokens: null,
          code_verifier: null,
          expires_at: null,
          updated_at: now,
        };

  const next: CredentialRow = {
    ...base,
    resource,
    client_info:
      patch.clientInfo === undefined ? base.client_info : JSON.stringify(patch.clientInfo),
    tokens: patch.tokens === undefined ? base.tokens : JSON.stringify(patch.tokens),
    code_verifier: 'codeVerifier' in patch ? (patch.codeVerifier ?? null) : base.code_verifier,
    expires_at: 'expiresAt' in patch ? (patch.expiresAt ?? null) : base.expires_at,
    updated_at: now,
  };

  db.run(
    `INSERT INTO mcp_credentials
       (server_name, resource, client_info, tokens, code_verifier, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_name) DO UPDATE SET
       resource      = excluded.resource,
       client_info   = excluded.client_info,
       tokens        = excluded.tokens,
       code_verifier = excluded.code_verifier,
       expires_at    = excluded.expires_at,
       updated_at    = excluded.updated_at`,
    [
      next.server_name,
      next.resource,
      next.client_info,
      next.tokens,
      next.code_verifier,
      next.expires_at,
      next.updated_at,
    ],
  );
}

/** Drops the whole record. Local only — the token stays valid upstream until revoked there. */
export function deleteMcpCredentials(db: SqliteDriver, serverName: string): boolean {
  const row = db.get<{ server_name: string }>(
    'SELECT server_name FROM mcp_credentials WHERE server_name = ?',
    [serverName],
  );
  if (!row) return false;
  db.run('DELETE FROM mcp_credentials WHERE server_name = ?', [serverName]);
  return true;
}

/**
 * Clears part of a record, for the SDK's `invalidateCredentials` hook.
 *
 *   tokens   — the server rejected the access token; keep the registration so
 *              re-consent does not have to register a second client.
 *   client   — the registration itself was rejected; tokens minted under it
 *              are worthless too, so both go.
 *   verifier — a flow was abandoned.
 *   all      — start from nothing.
 */
export function clearMcpCredentials(
  db: SqliteDriver,
  serverName: string,
  scope: 'all' | 'client' | 'tokens' | 'verifier',
): void {
  if (scope === 'all' || scope === 'client') {
    deleteMcpCredentials(db, serverName);
    return;
  }
  const column = scope === 'tokens' ? 'tokens' : 'code_verifier';
  const extra = scope === 'tokens' ? ', expires_at = NULL' : '';
  db.run(
    `UPDATE mcp_credentials SET ${column} = NULL${extra}, updated_at = ? WHERE server_name = ?`,
    [Date.now(), serverName],
  );
}

/** Connection status for one server, for `/mcp list` and the panel. */
export interface McpAuthStatus {
  connected: boolean;
  expiresAt: number | undefined;
  hasRefreshToken: boolean;
}

export function mcpAuthStatus(
  db: SqliteDriver,
  serverName: string,
  resource: string,
): McpAuthStatus {
  const record = readMcpCredentials(db, serverName, resource);
  const tokens = record?.tokens as { access_token?: string; refresh_token?: string } | undefined;
  return {
    connected: typeof tokens?.access_token === 'string',
    expiresAt: record?.expiresAt,
    hasRefreshToken: typeof tokens?.refresh_token === 'string',
  };
}
