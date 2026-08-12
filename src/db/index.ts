// Database handle management.
//
// One connection per process, keyed by file path. Tests point ASTERISK_HOME at
// a fresh temp dir per case, so the cache is keyed by path rather than being a
// bare module-level singleton — otherwise the second test in a file would keep
// talking to the first test's database.

import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { openDriver, restrictSidecars, type SqliteDriver } from './driver.ts';
import { migrate } from './migrations.ts';
import { seedBuiltinPricing } from './pricing.ts';

const open = new Map<string, SqliteDriver>();

/** Resolves the database path for the active ASTERISK_HOME. */
export function dbPath(): string {
  return asteriskPaths().dbFile;
}

/**
 * Returns the shared connection for `file` (defaulting to the active
 * ASTERISK_HOME), opening and migrating it on first use.
 */
export function getDb(file?: string): SqliteDriver {
  const target = file ?? dbPath();
  const existing = open.get(target);
  if (existing) return existing;

  if (target !== ':memory:') ensurePaths(asteriskPaths());

  // openDriver creates the database 0600 before enabling WAL, so the sidecars
  // inherit the restriction rather than the umask. Migrating writes through the
  // WAL, which can recreate them, so re-restrict once the schema is settled.
  const db = openDriver(target);
  migrate(db);
  seedBuiltinPricing(db);
  if (target !== ':memory:') restrictSidecars(target);

  open.set(target, db);
  return db;
}

/**
 * Closes one connection (or all of them). Called from test teardown and on
 * daemon shutdown; leaving WAL connections open holds -wal/-shm files around.
 */
export function closeDb(file?: string): void {
  if (file === undefined) {
    for (const db of open.values()) db.close();
    open.clear();
    return;
  }
  const db = open.get(file);
  if (db) {
    db.close();
    open.delete(file);
  }
}

export type { SqliteDriver } from './driver.ts';
