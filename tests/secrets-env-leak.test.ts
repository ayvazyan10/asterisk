// An env-only secret must never be copied into the database just because a
// form saved a different key. loadConfig() merges env > db > secrets.env, so
// spreading that merged object back into saveSecrets persisted the env key in
// plaintext.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, saveSecrets } from '../src/config/load.ts';
import { closeDb, getDb } from '../src/db/index.ts';

describe('env-only secrets', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-secrets-'));
    prevHome = process.env['ASTERISK_HOME'];
    prevKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ASTERISK_HOME'] = home;
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-only';
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = prevKey;
    await rm(home, { recursive: true, force: true });
  });

  it('is visible through loadConfig but absent from the database after a partial save', () => {
    expect(loadConfig().secrets.ANTHROPIC_API_KEY).toBe('sk-ant-env-only');

    // The shape the fixed call sites use: only the key the form changed.
    saveSecrets({ ASTERISK_TELEGRAM_BOT_TOKEN: '123:telegram' });

    const stored = getDb().all<{ key: string }>('SELECT key FROM secrets');
    expect(stored.map((row) => row.key)).toEqual(['ASTERISK_TELEGRAM_BOT_TOKEN']);
    expect(loadConfig().secrets.ANTHROPIC_API_KEY).toBe('sk-ant-env-only');
  });
});
