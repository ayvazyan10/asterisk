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
  /** Statements applied after `sql`, each allowed to fail without failing the
   *  migration. One statement per entry — see applyOptionalSql. */
  readonly optionalSql?: readonly string[];
}

/**
 * The FTS5 index over `memories`, kept out of migration 5's `sql` because it
 * is the one piece of the schema a healthy SQLite build can legitimately
 * refuse: FTS5 is a compile-time option, so `CREATE VIRTUAL TABLE … USING
 * fts5` fails with "no such module" wherever it was left out. Failing the
 * migration over that would take the whole database — the config, the secrets,
 * the permission grants — down with it.
 *
 * External content (`content='memories'`), not a plain or contentless FTS5
 * table. A plain one would hold the only copy of the text, so a build without
 * FTS5 would have nowhere to put memories at all and the LIKE fallback would
 * have nothing to scan. A contentless one cannot return column values, so
 * recall would need the base table anyway and the index would just be a second
 * place to keep in step. External content indexes the terms and reads the text
 * back from `memories`, which stores it exactly once.
 *
 * src/memory/store.ts retries this on first use, so an install that later
 * moves to an FTS5-capable build picks the index up without a new migration.
 */
export const MEMORY_FTS_SQL = `
  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    tags,
    content='memories',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )`;

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
  {
    version: 4,
    name: 'command-permissions',
    sql: `
      -- Bash rules the user answered "always allow" to. Kept out of the
      -- settings table because these are grants, not preferences: they are
      -- append-only in practice, carry their own provenance, and want to be
      -- listable and revocable one at a time.
      --
      -- The rule text is the matcher from tools/bash-permissions.ts — words
      -- matched positionally against [bin, ...args], e.g. 'npm test'.
      CREATE TABLE command_permissions (
        rule       TEXT PRIMARY KEY,
        granted_by TEXT NOT NULL DEFAULT 'repl',
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'agent-memory',
    sql: `
      -- Durable agent memory: notes the model writes for itself and reads back
      -- in later sessions. This table is the record of truth — the FTS5 index
      -- beside it (MEMORY_FTS_SQL) only makes search fast, and recall falls
      -- back to LIKE over these same rows when it is absent.
      --
      -- Tags are one space-separated string, not a join table. They are
      -- free-form labels the model invents, never joined on, and only read
      -- back whole or matched as text; a second table would buy nothing and
      -- the FTS tokeniser already splits the column the way we want.
      --
      -- source records the channel that wrote the note ('repl', 'telegram', …)
      -- rather than a chat id: memory is install-wide by design, and a chat id
      -- would put a phone number in a column nothing filters on.
      CREATE TABLE memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '',
        source     TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_memories_created ON memories (created_at DESC);
    `,
    optionalSql: [MEMORY_FTS_SQL],
  },
  {
    version: 6,
    name: 'drop-whatsapp',
    sql: `
      -- WhatsApp support was removed from the product. Neither of these rows
      -- can be reached by code any more, so nothing else would ever clear them.
      --
      -- Settings: readConfig() parses the settings table through ConfigSchema,
      -- which strips unknown keys, so orphaned 'bots.whatsapp.*' rows are
      -- harmless to read — but they only get pruned when something calls
      -- writeConfig(), and an install that never saves a config change would
      -- carry them forever.
      --
      -- Secrets: this is the half that actually matters. readSecrets() and
      -- writeSecrets() both iterate SECRET_KEYS, and deleteSecrets() takes a
      -- SecretKey[], so once the keys leave the schema a stored Meta Cloud
      -- access token becomes unreadable, unlistable and undeletable — a live
      -- credential sitting in the database with no code path that can reach
      -- it. Deleting it here is the only chance we get.
      --
      -- Note this does NOT revoke anything upstream: a Meta token stays valid
      -- until it is rotated in the Meta app dashboard, and a linked web-js
      -- device stays linked until it is removed in WhatsApp itself.
      DELETE FROM settings WHERE key = 'bots.whatsapp' OR key LIKE 'bots.whatsapp.%';
      DELETE FROM secrets WHERE key IN (
        'ASTERISK_WHATSAPP_META_TOKEN',
        'ASTERISK_WHATSAPP_VERIFY_TOKEN'
      );
    `,
  },
];

/**
 * Runs one statement the database is allowed to reject, reporting whether it
 * stuck. For schema that is an optimisation rather than a requirement, where
 * going without is better than refusing to open the database at all.
 *
 * One statement per call, deliberately. bun:sqlite 1.3 does not surface the
 * "no such module" error from a `CREATE VIRTUAL TABLE` when it leads a
 * multi-statement exec(): it swallows it and runs the rest, so a batch would
 * report success while leaving everything that depended on the virtual table
 * half-built. Alone, both bun:sqlite and node:sqlite throw. A caught failure
 * does not poison the surrounding transaction on either runtime — the
 * statement never gets past prepare.
 *
 * The boolean is a hint, not proof; callers that care confirm by querying.
 */
export function applyOptionalSql(db: SqliteDriver, sql: string): boolean {
  try {
    db.exec(sql);
    return true;
  } catch {
    return false;
  }
}

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
      for (const optional of m.optionalSql ?? []) applyOptionalSql(db, optional);
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
