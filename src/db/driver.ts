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

import { createRequire } from 'node:module';

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
 * Opens (creating if needed) the SQLite database at `file`. Pass ':memory:'
 * for an ephemeral database — used throughout the test suite.
 */
export function openDriver(file: string): SqliteDriver {
  const db = openRaw(file);

  // WAL lets the daemon, the REPL and `asterisk web` share one database file
  // without blocking each other on reads. Not available for in-memory DBs.
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
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
      db.exec('BEGIN');
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
