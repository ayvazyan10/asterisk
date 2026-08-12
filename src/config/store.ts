// Config persistence backed by SQLite.
//
// The database is the source of truth. `config.json` survives only as an
// import/export format: on first run an existing file is absorbed into the
// database and renamed aside, and `asterisk config export` can write one back
// out for backup or transfer.
//
// Scalar fields live in the `settings` KV table keyed by dotted path; the two
// list-shaped fields (mcpServers, hooks) live in their own tables so the web
// UI can edit individual entries.

import { existsSync, readFileSync, renameSync } from 'node:fs';

import {
  hooksForConfig,
  mcpServersForConfig,
  replaceHooks,
  replaceMcpServers,
} from '../db/collections.ts';
import type { SqliteDriver } from '../db/driver.ts';
import {
  allSecrets,
  allSettings,
  deleteSecret,
  pruneSettings,
  setSecret,
  setSettings,
} from '../db/settings.ts';
import { flatten, unflatten } from '../utils/object-path.ts';
import { type AsteriskConfig, ConfigSchema, SECRET_KEYS, type SecretKey } from './schema.ts';

/** Config keys whose contents live in dedicated tables, not the settings KV. */
const COLLECTION_KEYS = ['mcpServers', 'hooks'] as const;

/**
 * Materialises the full config from the database. Missing rows fall back to
 * the Zod defaults, so a brand-new database yields a valid default config.
 */
export function readConfig(db: SqliteDriver): AsteriskConfig {
  const raw = unflatten(allSettings(db));
  for (const key of COLLECTION_KEYS) delete raw[key];

  const parsed = ConfigSchema.safeParse({
    ...raw,
    mcpServers: mcpServersForConfig(db),
    hooks: hooksForConfig(db),
  });
  if (!parsed.success) {
    throw new Error(`stored configuration failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Persists the full config, replacing both the scalar settings and the
 * collections. Settings no longer present in the schema are pruned so removed
 * fields don't linger forever.
 */
export function writeConfig(db: SqliteDriver, config: AsteriskConfig): void {
  const validated = ConfigSchema.parse(config);
  const scalars: Record<string, unknown> = { ...validated };
  for (const key of COLLECTION_KEYS) delete scalars[key];
  const entries = flatten(scalars);

  db.transaction(() => {
    setSettings(db, entries);
    pruneSettings(db, new Set(entries.map(([k]) => k)));
    replaceMcpServers(db, validated.mcpServers);
    replaceHooks(db, validated.hooks);
  });
}

/** Reads a single dotted path out of the stored config. */
export function readConfigPath(db: SqliteDriver, path: string): unknown {
  const config = readConfig(db) as unknown as Record<string, unknown>;
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[seg];
  }, config);
}

// --- secrets -------------------------------------------------------------

/**
 * Resolves secrets, highest priority first:
 *   1. process environment — the standard escape hatch for CI and one-off runs
 *   2. the database — what the web UI and `asterisk configure` write
 *   3. legacy secrets.env — read-only fallback for installs predating the DB
 *
 * Note this inverts the pre-database precedence, where secrets.env overrode
 * the environment. Environment-wins is what every other CLI does.
 */
export function readSecrets(
  db: SqliteDriver,
  legacyFile?: string,
): Partial<Record<SecretKey, string>> {
  const out: Partial<Record<SecretKey, string>> = {};

  if (legacyFile && existsSync(legacyFile)) {
    for (const [key, value] of parseEnvFile(readFileSync(legacyFile, 'utf8'))) {
      if ((SECRET_KEYS as readonly string[]).includes(key)) out[key as SecretKey] = value;
    }
  }

  const stored = allSecrets(db);
  for (const key of SECRET_KEYS) {
    const v = stored[key];
    if (v) out[key] = v;
  }

  for (const key of SECRET_KEYS) {
    const v = process.env[key];
    if (v) out[key] = v;
  }

  return out;
}

/**
 * Upserts the secrets present in `secrets`. An explicit empty string deletes
 * that key; a key that is simply absent is left alone.
 *
 * The distinction matters. This used to iterate SECRET_KEYS and delete every
 * key the caller had not supplied, which made a partial update silently
 * destroy the other credentials — saving an Anthropic key from a form that
 * did not also carry the Telegram token wiped it. Callers
 * happened to be safe only because they spread the full existing set back in.
 * Use `deleteSecrets` to remove keys deliberately.
 */
export function writeSecrets(db: SqliteDriver, secrets: Partial<Record<SecretKey, string>>): void {
  db.transaction(() => {
    for (const key of SECRET_KEYS) {
      if (!(key in secrets)) continue;
      const value = secrets[key];
      if (value === undefined || value === '') deleteSecret(db, key);
      else setSecret(db, key, value);
    }
  });
}

/** Removes `keys` from the secret store. The explicit counterpart to writeSecrets. */
export function deleteSecrets(db: SqliteDriver, keys: readonly SecretKey[]): void {
  db.transaction(() => {
    for (const key of keys) deleteSecret(db, key);
  });
}

function parseEnvFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    out.push([key, value]);
  }
  return out;
}

// --- one-time migration --------------------------------------------------

export interface MigrationReport {
  configImported: boolean;
  secretsImported: number;
}

/**
 * Absorbs a pre-database install into the database. Runs at most once: the
 * settings table being non-empty is the marker that migration already
 * happened. The old config.json is renamed rather than deleted so a user can
 * still recover it; secrets.env is left in place as a read-only fallback.
 */
export function importLegacyFiles(
  db: SqliteDriver,
  paths: { configFile: string; secretsFile: string },
): MigrationReport {
  const report: MigrationReport = { configImported: false, secretsImported: 0 };

  const alreadySeeded = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings');
  if ((alreadySeeded?.n ?? 0) > 0) return report;

  if (existsSync(paths.configFile)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    } catch (e) {
      throw new Error(`config.json is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`config.json failed validation: ${parsed.error.message}`);
    }
    writeConfig(db, parsed.data);
    renameSync(paths.configFile, `${paths.configFile}.migrated`);
    report.configImported = true;
  } else {
    // Seed defaults so the "already seeded" check above is meaningful on the
    // next run even when there was nothing to import.
    writeConfig(db, ConfigSchema.parse({}));
  }

  if (existsSync(paths.secretsFile)) {
    const found: Partial<Record<SecretKey, string>> = {};
    for (const [key, value] of parseEnvFile(readFileSync(paths.secretsFile, 'utf8'))) {
      if ((SECRET_KEYS as readonly string[]).includes(key) && value) {
        found[key as SecretKey] = value;
        report.secretsImported++;
      }
    }
    if (report.secretsImported > 0) writeSecrets(db, found);
  }

  return report;
}
