// Configuration loader — reads ~/.asterisk/config.json and ~/.asterisk/secrets.env,
// validates with Zod, merges with environment variables.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { type AsteriskConfig, ConfigSchema, SECRET_KEYS, type SecretKey } from './schema.ts';
import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';

export interface LoadedConfig {
  config: AsteriskConfig;
  secrets: Partial<Record<SecretKey, string>>;
}

export function loadConfig(): LoadedConfig {
  const paths = asteriskPaths();
  ensurePaths(paths);

  let raw: unknown = {};
  if (existsSync(paths.configFile)) {
    try {
      raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    } catch (e) {
      throw new Error(`config.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`config.json failed validation: ${parsed.error.message}`);
  }
  const config = parsed.data;

  // Default whatsapp-web session dir to ~/.asterisk/whatsapp-web-session if blank.
  if (!config.bots.whatsapp.webJs.sessionDir) {
    config.bots.whatsapp.webJs.sessionDir = paths.whatsappSession;
  }

  return { config, secrets: loadSecrets(paths.secretsFile) };
}

function loadSecrets(file: string): Partial<Record<SecretKey, string>> {
  const out: Partial<Record<SecretKey, string>> = {};
  // Pull from real env first.
  for (const key of SECRET_KEYS) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  if (!existsSync(file)) return out;

  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      out[key as SecretKey] = value;
    }
  }
  return out;
}

export function saveConfig(config: AsteriskConfig): void {
  const paths = asteriskPaths();
  ensurePaths(paths);
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
}

export function saveSecrets(secrets: Partial<Record<SecretKey, string>>): void {
  const paths = asteriskPaths();
  ensurePaths(paths);
  const lines: string[] = [
    '# asterisk secrets — chmod 600',
    '# managed by `asterisk configure`',
  ];
  for (const key of SECRET_KEYS) {
    const v = secrets[key];
    if (v !== undefined && v !== '') {
      // Escape any literal quotes by stripping (we re-quote)
      const safe = v.replace(/"/g, '\\"');
      lines.push(`${key}="${safe}"`);
    }
  }
  writeFileSync(paths.secretsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
}
