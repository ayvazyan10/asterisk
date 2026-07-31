// Database handle management.
//
// One connection per process, keyed by file path. Tests point ASTERISK_HOME at
// a fresh temp dir per case, so the cache is keyed by path rather than being a
// bare module-level singleton — otherwise the second test in a file would keep
// talking to the first test's database.

import { chmodSync } from 'node:fs';

import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { openDriver, type SqliteDriver } from './driver.ts';
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
  const db = openDriver(target);
  migrate(db);
  seedBuiltinPricing(db);

  // The database holds API keys and bot tokens, so it gets the same 0600 the
  // old secrets.env had. Applied after open so the file definitely exists;
  // the -wal and -shm sidecars inherit the main file's mode from SQLite.
  if (target !== ':memory:') {
    try {
      chmodSync(target, 0o600);
    } catch {
      // Some filesystems (notably Windows shares and certain FUSE mounts)
      // reject chmod. Refusing to start over file permissions would be worse
      // than continuing, so this is best-effort.
    }
  }

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
