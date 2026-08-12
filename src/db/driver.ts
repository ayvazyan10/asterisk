// SQLite driver shim.
//
// Asterisk runs under Bun in production but its test suite runs under Node
// (Vitest). Neither runtime can load the other's SQLite binding: `bun:sqlite`
// is Bun-only, and `node:sqlite` panics under Bun. Both expose the same
// synchronous surface we need — `exec` plus `prepare().run/get/all` — so this
// module picks the right one at load time and normalises the differences away.
//
// Loading is synchronous via createRequire so callers stay synchronous; the
// entire config layer above is sync and 40+ call sites depend on that.
//
// References:
//   https://bun.sh/docs/api/sqlite
//   https://nodejs.org/api/sqlite.html

import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';

import { OWNER_ONLY_FILE, touchOwnerOnly } from '../utils/fs-safe.ts';

const require = createRequire(import.meta.url);

/** Values SQLite can bind. Booleans are normalised to 0/1 before binding. */
export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlParam = SqlValue | boolean | undefined;

export interface SqliteDriver {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlParam[]): void;
  get<T>(sql: string, params?: readonly SqlParam[]): T | undefined;
  all<T>(sql: string, params?: readonly SqlParam[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * node:sqlite rejects booleans and undefined outright; bun:sqlite accepts some
 * of them but not consistently across versions. Normalising here keeps call
 * sites free of runtime-specific coercion.
 */
function normalise(params: readonly SqlParam[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

interface RawStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

function openRaw(file: string): RawDatabase {
  if (typeof process.versions.bun === 'string') {
    const { Database } = require('bun:sqlite') as {
      Database: new (path: string, opts?: { create?: boolean }) => RawDatabase;
    };
    return new Database(file, { create: true });
  }
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => RawDatabase;
  };
  return new DatabaseSync(file);
}

/**
 * Restricts the -wal and -shm sidecars to the owner.
 *
 * Creating the main database 0600 first is normally enough for SQLite to
 * inherit the mode, but not every build does, and the sidecars are recreated
 * whenever the last connection drops. Belt and braces: this is cheap and the
 * failure mode it guards against is plaintext secrets in a world-readable file.
 */
export function restrictSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${file}${suffix}`, OWNER_ONLY_FILE);
    } catch {
      // The sidecars only exist while a WAL connection is open, so ENOENT here
      // is the normal case rather than an error.
    }
  }
}

/**
 * Opens (creating if needed) the SQLite database at `file`. Pass ':memory:'
 * for an ephemeral database — used throughout the test suite.
 */
export function openDriver(file: string): SqliteDriver {
  // Create the database 0600 *before* SQLite opens it. Enabling WAL below makes
  // SQLite create the -wal and -shm sidecars, and it derives their mode from
  // the main database file. Restricting the database afterwards — which is what
  // this used to do — left the sidecars at the process umask, and the -wal holds
  // a verbatim copy of recent writes, including every API key and bot token.
  if (file !== ':memory:') touchOwnerOnly(file);

  const db = openRaw(file);

  // WAL lets the daemon, the REPL and `asterisk web` share one database file
  // without blocking each other on reads. Not available for in-memory DBs.
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    restrictSidecars(file);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Prepared statements are cached: settings reads happen on every turn and
  // re-preparing the same SQL each time is measurable overhead.
  const cache = new Map<string, RawStatement>();
  const stmt = (sql: string): RawStatement => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  let depth = 0;

  return {
    exec(sql) {
      // DDL invalidates cached statements that reference the changed tables.
      cache.clear();
      db.exec(sql);
    },
    run(sql, params = []) {
      stmt(sql).run(...normalise(params));
    },
    get<T>(sql: string, params: readonly SqlParam[] = []) {
      return stmt(sql).get(...normalise(params)) as T | undefined;
    },
    all<T>(sql: string, params: readonly SqlParam[] = []) {
      return stmt(sql).all(...normalise(params)) as T[];
    },
    /**
     * Runs `fn` inside a transaction, rolling back if it throws. Nested calls
     * join the outer transaction rather than starting a second one, which
     * SQLite would reject.
     */
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      // IMMEDIATE, not deferred. Under WAL a deferred BEGIN upgrades to a write
      // lock lazily, and if another connection wrote in between, SQLite fails
      // the upgrade with SQLITE_BUSY_SNAPSHOT — which busy_timeout does *not*
      // retry. Taking the write lock upfront makes contention wait out the
      // busy_timeout instead of erroring, which is what lets three Asterisk
      // processes share one database file.
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // A failed rollback means the transaction was already unwound by
          // SQLite (e.g. on a fatal constraint error). The original error is
          // the useful one, so swallow this and rethrow below.
        }
        throw e;
      } finally {
        depth--;
      }
    },
    close() {
      cache.clear();
      db.close();
    },
  };
}
