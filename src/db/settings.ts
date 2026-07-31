// Key/value access to the `settings` and `secrets` tables.
//
// Values are stored JSON-encoded so a boolean toggle, a numeric timeout and a
// string array all round-trip through one TEXT column without the caller
// having to know the column type.

import type { SqliteDriver } from './driver.ts';

interface KvRow {
  key: string;
  value: string;
}

function decode(raw: string, key: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`setting "${key}" holds invalid JSON: ${(e as Error).message}`);
  }
}

/** Reads one setting. Returns undefined when the key was never written. */
export function getSetting(db: SqliteDriver, key: string): unknown {
  const row = db.get<KvRow>('SELECT key, value FROM settings WHERE key = ?', [key]);
  return row ? decode(row.value, row.key) : undefined;
}

/** Writes one setting, replacing any previous value. */
export function setSetting(db: SqliteDriver, key: string, value: unknown): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value ?? null), Date.now()],
  );
}

/** Writes many settings in one transaction. */
export function setSettings(db: SqliteDriver, entries: Iterable<[string, unknown]>): void {
  db.transaction(() => {
    for (const [key, value] of entries) setSetting(db, key, value);
  });
}

/** Every stored setting as dotted-path entries. */
export function allSettings(db: SqliteDriver): Array<[string, unknown]> {
  return db
    .all<KvRow>('SELECT key, value FROM settings ORDER BY key')
    .map((r) => [r.key, decode(r.value, r.key)] as [string, unknown]);
}

export function deleteSetting(db: SqliteDriver, key: string): void {
  db.run('DELETE FROM settings WHERE key = ?', [key]);
}

/** Removes every setting whose key is not in `keep`. */
export function pruneSettings(db: SqliteDriver, keep: ReadonlySet<string>): void {
  const stale = db
    .all<KvRow>('SELECT key, value FROM settings')
    .filter((r) => !keep.has(r.key))
    .map((r) => r.key);
  if (stale.length === 0) return;
  db.transaction(() => {
    for (const key of stale) deleteSetting(db, key);
  });
}

// --- secrets -------------------------------------------------------------
// Same shape, separate table: secrets are excluded from config exports and
// never leave the API as plaintext.

export function getSecret(db: SqliteDriver, key: string): string | undefined {
  return db.get<KvRow>('SELECT key, value FROM secrets WHERE key = ?', [key])?.value;
}

export function setSecret(db: SqliteDriver, key: string, value: string): void {
  db.run(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  );
}

export function deleteSecret(db: SqliteDriver, key: string): void {
  db.run('DELETE FROM secrets WHERE key = ?', [key]);
}

export function allSecrets(db: SqliteDriver): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of db.all<KvRow>('SELECT key, value FROM secrets')) {
    out[row.key] = row.value;
  }
  return out;
}

/**
 * Renders a secret for display: enough to recognise which key is installed,
 * not enough to use. Short values are fully masked rather than leaking a
 * meaningful fraction of their characters.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '•'.repeat(8);
  return `${value.slice(0, 3)}${'•'.repeat(6)}${value.slice(-4)}`;
}
