// Schema migrations for ~/.asterisk/asterisk.db.
//
// Migrations are append-only: never edit a shipped entry, add a new one. The
// runner records applied versions in `schema_migrations` and applies the rest
// inside a single transaction so a partial upgrade can't leave the database
// half-migrated.

import type { SqliteDriver } from './driver.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      -- Scalar settings, keyed by dotted path into ConfigSchema
      -- (e.g. 'ollama.model'). Values are JSON-encoded so booleans, numbers
      -- and arrays all round-trip through one column.
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Secrets live in their own table so they can be excluded from exports
      -- and masked in the web UI without special-casing the settings table.
      CREATE TABLE secrets (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- MCP servers. The transport column discriminates the union: stdio uses
      -- command/args/env, http uses url/headers. The unused columns stay NULL.
      CREATE TABLE mcp_servers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        transport  TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
        command    TEXT,
        args       TEXT NOT NULL DEFAULT '[]',
        env        TEXT NOT NULL DEFAULT '{}',
        url        TEXT,
        headers    TEXT NOT NULL DEFAULT '{}',
        enabled    INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE hooks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL UNIQUE,
        event           TEXT NOT NULL,
        matcher         TEXT,
        command         TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL DEFAULT 30,
        enabled         INTEGER NOT NULL DEFAULT 1,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX idx_hooks_event ON hooks (event);

      -- Access tokens for the web control panel. Only the SHA-256 hash is
      -- stored; the plaintext token is shown once at creation time.
      CREATE TABLE web_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        label       TEXT NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        last_used_at INTEGER
      );

      -- Append-only audit of every mutation made through the web UI, so a
      -- surprising config change can be traced back.
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        target     TEXT NOT NULL,
        detail     TEXT
      );

      CREATE INDEX idx_audit_at ON audit_log (at DESC);
    `,
  },
  {
    version: 2,
    name: 'usage-and-pricing',
    sql: `
      -- One row per agent turn. Token counts are summed across every model
      -- call the turn made, so a turn that used tools still yields one row.
      CREATE TABLE usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            INTEGER NOT NULL,
        session_scope TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        model_calls   INTEGER NOT NULL DEFAULT 1,
        -- NULL when no price is known for the model, which is different from
        -- 0.0 (a local model that genuinely costs nothing).
        cost_usd      REAL
      );

      CREATE INDEX idx_usage_at ON usage (at DESC);
      CREATE INDEX idx_usage_session ON usage (session_scope, session_id);

      -- Rates in USD per million tokens. Seeded with published Anthropic
      -- pricing; editable, because published rates change and self-hosted or
      -- proxied endpoints have their own.
      CREATE TABLE model_pricing (
        model                TEXT PRIMARY KEY,
        input_per_mtok       REAL NOT NULL,
        output_per_mtok      REAL NOT NULL,
        cache_write_per_mtok REAL,
        cache_read_per_mtok  REAL,
        source               TEXT NOT NULL DEFAULT 'builtin',
        updated_at           INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'drop-usage-and-pricing',
    sql: `
      -- Token accounting and cost estimation were removed from the product.
      -- Migration 2 is left in place because it has already been applied on
      -- existing installs and migrations are never rewritten; this drops what
      -- it created. Existing rows go with the tables — they described a
      -- feature that no longer exists, and keeping per-turn token counts
      -- around would be retaining data nothing reads.
      DROP INDEX IF EXISTS idx_usage_at;
      DROP INDEX IF EXISTS idx_usage_session;
      DROP TABLE IF EXISTS usage;
      DROP TABLE IF EXISTS model_pricing;
    `,
  },
];

interface MigrationRow {
  version: number;
}

/**
 * Applies every migration newer than the database's current version.
 * Idempotent — safe to call on every process start.
 */
export function migrate(db: SqliteDriver): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  // The applied set has to be read *inside* the write transaction. Reading it
  // outside let the REPL, the daemon and `asterisk web` — which routinely start
  // together on a fresh install — all observe an empty set, and then two of
  // them ran the same CREATE TABLE and died with "table settings already
  // exists" thrown out of getDb() with no handler. transaction() opens with
  // BEGIN IMMEDIATE, so the readers serialise on the write lock instead.
  return db.transaction(() => {
    const applied = new Set(
      db.all<MigrationRow>('SELECT version FROM schema_migrations').map((r) => r.version),
    );

    const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
      (a, b) => a.version - b.version,
    );
    if (pending.length === 0) return 0;

    for (const m of pending) {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        Date.now(),
      ]);
    }
    return pending.length;
  });
}

/** Highest migration version this build knows about. */
export function latestVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}
