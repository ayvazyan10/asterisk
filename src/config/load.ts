// Configuration loader.
//
// Backed by SQLite (~/.asterisk/asterisk.db) since v0.2. The exported surface
// is deliberately unchanged from the config.json era — `loadConfig()`,
// `saveConfig()` and `saveSecrets()` keep their signatures so every call site
// across the REPL, daemon, bots and command registry works untouched.

import { writeFileSync } from 'node:fs';

import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { getDb } from '../db/index.ts';
import type { AsteriskConfig, SecretKey } from './schema.ts';
import { importLegacyFiles, readConfig, readSecrets, writeConfig, writeSecrets } from './store.ts';

export interface LoadedConfig {
  config: AsteriskConfig;
  secrets: Partial<Record<SecretKey, string>>;
}

export function loadConfig(): LoadedConfig {
  const paths = asteriskPaths();
  ensurePaths(paths);

  const db = getDb();
  importLegacyFiles(db, paths);

  const config = readConfig(db);

  return { config, secrets: readSecrets(db, paths.secretsFile) };
}

export function saveConfig(config: AsteriskConfig): void {
  const paths = asteriskPaths();
  ensurePaths(paths);
  writeConfig(getDb(), config);
}

export function saveSecrets(secrets: Partial<Record<SecretKey, string>>): void {
  const paths = asteriskPaths();
  ensurePaths(paths);
  writeSecrets(getDb(), secrets);
}

/**
 * Writes the current configuration out as JSON — for backups, for moving an
 * install between machines, and for anyone who wants to read their settings in
 * an editor. Secrets are never included.
 */
export function exportConfigJson(file?: string): string {
  const paths = asteriskPaths();
  ensurePaths(paths);
  const target = file ?? paths.configFile;
  const json = `${JSON.stringify(readConfig(getDb()), null, 2)}\n`;
  writeFileSync(target, json, { mode: 0o644 });
  return target;
}
