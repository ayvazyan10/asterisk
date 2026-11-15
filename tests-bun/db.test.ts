import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDriver } from '../src/db/driver.ts';
import { closeDb, dbPath, getDb } from '../src/db/index.ts';
import { getSecret, getSetting, setSecret, setSetting } from '../src/db/settings.ts';

test('migrated settings and secrets persist through the bun:sqlite driver with mode 0600', () => {
  const previousHome = process.env['ASTERISK_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'asterisk-bun-db-'));
  process.env['ASTERISK_HOME'] = home;
  // A call-through spy identifies the native driver without replacing SQLite.
  const prepare = spyOn(Database.prototype, 'prepare');
  try {
    const db = getDb();
    setSetting(db, 'sandbox.mode', 'off');
    setSecret(db, 'ASTERISK_OPENAI_API_KEY', 'bun-smoke-secret');
    expect(prepare).toHaveBeenCalled();
    expect(statSync(dbPath()).mode & 0o777).toBe(0o600);

    const reader = openDriver(dbPath());
    try {
      expect(getSetting(reader, 'sandbox.mode')).toBe('off');
      expect(getSecret(reader, 'ASTERISK_OPENAI_API_KEY')).toBe('bun-smoke-secret');
    } finally {
      reader.close();
    }
  } finally {
    prepare.mockRestore();
    closeDb();
    if (previousHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
