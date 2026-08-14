// Settings and secrets endpoints.
//
// The settings surface is generated from the Zod schema (see
// config/introspect.ts) rather than hand-written, so a new field in
// ConfigSchema appears in the browser without touching this file.

import { settingsByGroup, validateField } from '../../config/introspect.ts';
import { ConfigSchema, SECRET_KEYS, type SecretKey } from '../../config/schema.ts';
import { readConfig, writeConfig } from '../../config/store.ts';
import { allSecrets, deleteSecret, maskSecret, setSecret } from '../../db/settings.ts';
import { getPath, setPath } from '../../utils/object-path.ts';
import { type Handler, HttpError, audit, json, readJsonObject } from '../http.ts';

/** Registry plus current values — everything the settings UI needs in one call. */
export const getSettings: Handler = ({ db }) => {
  const config = readConfig(db) as unknown as Record<string, unknown>;
  return json({
    groups: settingsByGroup().map((group) => ({
      group: group.group,
      label: group.label,
      fields: group.fields.map((field) => ({
        ...field,
        value: getPath(config, field.path),
      })),
    })),
  });
};

/**
 * Applies a partial update, keyed by dotted path. Every field is validated
 * against its own slice of the schema first, so a request touching five
 * settings either applies all five or none.
 */
export const patchSettings: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const updates = body['updates'];
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    throw new HttpError('"updates" must be an object of dotted-path -> value');
  }

  const entries = Object.entries(updates as Record<string, unknown>);
  if (entries.length === 0) throw new HttpError('"updates" was empty');

  const errors: Record<string, string> = {};
  for (const [path, value] of entries) {
    const result = validateField(path, value);
    if (!result.ok) errors[path] = result.error;
  }
  if (Object.keys(errors).length > 0) {
    throw new HttpError('one or more settings are invalid', 422, errors);
  }

  let next = readConfig(db) as unknown as Record<string, unknown>;
  for (const [path, value] of entries) next = setPath(next, path, value);

  // Re-validate the assembled object: cross-field refinements and unknown-key
  // stripping only happen at the top level.
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new HttpError('resulting configuration is invalid', 422, parsed.error.format());
  }

  writeConfig(db, parsed.data);
  audit(db, 'settings.patch', entries.map(([p]) => p).join(', '), updates);

  return json({ ok: true, updated: entries.length });
};

/** Resets one setting to its schema default. */
export const resetSetting: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const path = body['path'];
  if (typeof path !== 'string') throw new HttpError('"path" is required');

  const defaults = ConfigSchema.parse({}) as unknown as Record<string, unknown>;
  const value = getPath(defaults, path);
  if (value === undefined) throw new HttpError(`no such setting: ${path}`, 404);

  const next = setPath(readConfig(db) as unknown as Record<string, unknown>, path, value);
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) throw new HttpError('reset produced an invalid config', 422);

  writeConfig(db, parsed.data);
  audit(db, 'settings.reset', path);
  return json({ ok: true, path, value });
};

/** Full config as JSON, for download. Secrets are never included. */
export const exportConfig: Handler = ({ db }) => json(readConfig(db));

/** Replaces the entire config from an uploaded JSON document. */
export const importConfig: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const parsed = ConfigSchema.safeParse(body['config']);
  if (!parsed.success) {
    throw new HttpError('uploaded configuration is invalid', 422, parsed.error.format());
  }
  writeConfig(db, parsed.data);
  audit(db, 'config.import', 'full');
  return json({ ok: true });
};

// --- secrets -------------------------------------------------------------

/** Lists known secret keys with masked values — never the plaintext. */
export const getSecrets: Handler = ({ db }) => {
  const stored = allSecrets(db);
  return json({
    secrets: SECRET_KEYS.map((key) => {
      const value = stored[key];
      const fromEnv = Boolean(process.env[key]);
      return {
        key,
        set: Boolean(value),
        masked: value ? maskSecret(value) : null,
        // Surfaced so the UI can explain why an edit here appears to have no
        // effect: the environment takes precedence over the stored value.
        overriddenByEnv: fromEnv,
      };
    }),
  });
};

export const putSecret: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const key = body['key'];
  const value = body['value'];

  if (typeof key !== 'string' || !(SECRET_KEYS as readonly string[]).includes(key)) {
    throw new HttpError(`unknown secret key; expected one of ${SECRET_KEYS.join(', ')}`);
  }
  if (typeof value !== 'string') throw new HttpError('"value" must be a string');

  if (value === '') {
    deleteSecret(db, key);
    audit(db, 'secret.delete', key);
    return json({ ok: true, key, set: false });
  }

  setSecret(db, key as SecretKey, value);
  audit(db, 'secret.set', key);
  return json({ ok: true, key, set: true, masked: maskSecret(value) });
};
