import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config/schema.ts';
import { readConfig, writeConfig } from '../src/config/store.ts';
import {
  deleteHook,
  deleteMcpServer,
  listHooks,
  listMcpServers,
  upsertHook,
  upsertMcpServer,
} from '../src/db/collections.ts';
import { type SqliteDriver, openDriver } from '../src/db/driver.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import { latestVersion, migrate } from '../src/db/migrations.ts';
import {
  allSettings,
  getSecret,
  getSetting,
  maskSecret,
  pruneSettings,
  setSecret,
  setSetting,
} from '../src/db/settings.ts';
import { flatten, getPath, setPath, unflatten } from '../src/utils/object-path.ts';

function fresh(): SqliteDriver {
  const db = openDriver(':memory:');
  migrate(db);
  return db;
}

describe('sqlite driver', () => {
  it('round-trips values and coerces booleans', () => {
    const db = fresh();
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['x', true]);
    db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['y', false]);
    expect(db.all<{ a: string; b: number }>('SELECT * FROM t ORDER BY a')).toEqual([
      { a: 'x', b: 1 },
      { a: 'y', b: 0 },
    ]);
    db.close();
  });

  it('maps undefined to NULL', () => {
    const db = fresh();
    db.exec('CREATE TABLE t (a TEXT)');
    db.run('INSERT INTO t (a) VALUES (?)', [undefined]);
    expect(db.get<{ a: string | null }>('SELECT a FROM t')).toEqual({ a: null });
    db.close();
  });

  it('rolls back a failing transaction', () => {
    const db = fresh();
    db.exec('CREATE TABLE t (a TEXT PRIMARY KEY)');
    db.run('INSERT INTO t (a) VALUES (?)', ['keep']);

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (a) VALUES (?)', ['gone']);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.all('SELECT a FROM t')).toEqual([{ a: 'keep' }]);
    db.close();
  });

  it('joins nested transactions rather than nesting them', () => {
    const db = fresh();
    db.exec('CREATE TABLE t (a TEXT)');
    db.transaction(() => {
      db.run('INSERT INTO t (a) VALUES (?)', ['outer']);
      db.transaction(() => db.run('INSERT INTO t (a) VALUES (?)', ['inner']));
    });
    expect(db.all('SELECT a FROM t')).toHaveLength(2);
    db.close();
  });
});

describe('migrations', () => {
  it('applies pending migrations once and is idempotent', () => {
    const db = openDriver(':memory:');
    expect(migrate(db)).toBe(latestVersion());
    expect(migrate(db)).toBe(0);
    db.close();
  });

  it('drops WhatsApp settings and secrets left behind by an older install', () => {
    const db = openDriver(':memory:');
    migrate(db);
    // Rewind the removal so the rows an older build wrote can be recreated,
    // then let the migration run against them the way an upgrade would.
    db.run('DELETE FROM schema_migrations WHERE version = 6');

    setSetting(db, 'bots.whatsapp.enabled', true);
    setSetting(db, 'bots.whatsapp.metaCloud.phoneNumberId', 'pn-1');
    setSetting(db, 'bots.telegram.enabled', true);
    setSecret(db, 'ASTERISK_WHATSAPP_META_TOKEN', 'meta-secret');
    setSecret(db, 'ASTERISK_TELEGRAM_BOT_TOKEN', 'tg-token');

    expect(migrate(db)).toBe(1);

    expect(allSettings(db).map(([key]) => key)).toEqual(['bots.telegram.enabled']);
    // The credential is the point: once the key leaves SECRET_KEYS nothing
    // else can read or delete it, so the migration is its only exit.
    expect(getSecret(db, 'ASTERISK_WHATSAPP_META_TOKEN')).toBeUndefined();
    expect(getSecret(db, 'ASTERISK_TELEGRAM_BOT_TOKEN')).toBe('tg-token');
    db.close();
  });

  it('drops plugin settings left behind by an older install', () => {
    const db = openDriver(':memory:');
    migrate(db);
    db.run('DELETE FROM schema_migrations WHERE version = 8');

    setSetting(db, 'plugins.enabled', true);
    setSetting(db, 'plugins.load', ['/srv/plugins/greeter.ts']);
    setSetting(db, 'bots.telegram.enabled', true);

    expect(migrate(db)).toBe(1);

    // No secret half to this one — plugins never had a SECRET_KEYS entry. What
    // the rows still held was a path to a file on disk.
    expect(allSettings(db).map(([key]) => key)).toEqual(['bots.telegram.enabled']);
    db.close();
  });

  it('moves an Ollama install onto the local endpoint instead of stranding it', () => {
    const db = openDriver(':memory:');
    migrate(db);
    db.run('DELETE FROM schema_migrations WHERE version = 9');

    setSetting(db, 'provider', 'ollama');
    setSetting(db, 'ollama.baseUrl', 'http://127.0.0.1:11434');
    setSetting(db, 'ollama.model', 'qwen3.5:9b');
    setSetting(db, 'providerFallback', ['ollama', 'anthropic']);
    setSetting(db, 'bots.telegram.enabled', true);

    expect(migrate(db)).toBe(1);

    // Rewritten, not deleted: a provider value the schema no longer accepts
    // would make ConfigSchema fall back to defaults for the whole section.
    expect(getSetting(db, 'provider')).toBe('openai-compatible');
    // The base URL is deliberately not carried over — Ollama's OpenAI-compatible
    // API lives on a different port and path, so a copied value would point the
    // agent at nothing while looking configured.
    expect(
      allSettings(db)
        .map(([key]) => key)
        .filter((k) => k.startsWith('ollama')),
    ).toEqual([]);
    expect(getSetting(db, 'providerFallback')).toEqual(['anthropic']);
    expect(getSetting(db, 'bots.telegram.enabled')).toBe(true);

    // And the result parses, which is the whole point of rewriting it.
    expect(readConfig(db).provider).toBe('openai-compatible');
    db.close();
  });

  it('reads a config despite settings the schema no longer declares', () => {
    // Belt and braces for the upgrade path: even if a stale row outlives the
    // migration, ConfigSchema strips unknown keys rather than failing to parse.
    const db = fresh();
    setSetting(db, 'bots.whatsapp.enabled', true);

    const config = readConfig(db);
    expect(config.bots.telegram.enabled).toBe(false);
    expect((config.bots as Record<string, unknown>)['whatsapp']).toBeUndefined();
    db.close();
  });
});

describe('settings store', () => {
  it('round-trips JSON values of every shape', () => {
    const db = fresh();
    setSetting(db, 'a.string', 'hello');
    setSetting(db, 'a.number', 42);
    setSetting(db, 'a.bool', true);
    setSetting(db, 'a.array', [1, 2, 3]);

    expect(getSetting(db, 'a.string')).toBe('hello');
    expect(getSetting(db, 'a.number')).toBe(42);
    expect(getSetting(db, 'a.bool')).toBe(true);
    expect(getSetting(db, 'a.array')).toEqual([1, 2, 3]);
    expect(getSetting(db, 'a.missing')).toBeUndefined();
    db.close();
  });

  it('overwrites on repeated set', () => {
    const db = fresh();
    setSetting(db, 'k', 'first');
    setSetting(db, 'k', 'second');
    expect(getSetting(db, 'k')).toBe('second');
    expect(allSettings(db)).toHaveLength(1);
    db.close();
  });

  it('prunes keys outside the keep set', () => {
    const db = fresh();
    setSetting(db, 'keep', 1);
    setSetting(db, 'drop', 2);
    pruneSettings(db, new Set(['keep']));
    expect(allSettings(db).map(([k]) => k)).toEqual(['keep']);
    db.close();
  });

  it('stores secrets separately from settings', () => {
    const db = fresh();
    setSecret(db, 'ANTHROPIC_API_KEY', 'sk-abc');
    expect(getSecret(db, 'ANTHROPIC_API_KEY')).toBe('sk-abc');
    expect(allSettings(db)).toHaveLength(0);
    db.close();
  });

  it('masks secrets without leaking short ones', () => {
    expect(maskSecret('sk-ant-api03-longvalue1234')).toBe('sk-••••••1234');
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('12345678')).toBe('••••••••');
  });
});

describe('object paths', () => {
  it('reads and writes without mutating the source', () => {
    const src = { a: { b: { c: 1 } } };
    const next = setPath(src, 'a.b.c', 2);
    expect(getPath(next, 'a.b.c')).toBe(2);
    expect(getPath(src, 'a.b.c')).toBe(1);
    expect(getPath(src, 'a.missing.c')).toBeUndefined();
  });

  it('creates intermediate objects on write', () => {
    expect(setPath({}, 'x.y.z', true)).toEqual({ x: { y: { z: true } } });
  });

  it('round-trips through flatten/unflatten', () => {
    const obj = { a: 1, b: { c: 'two', d: [3, 4] }, e: null };
    expect(unflatten(flatten(obj))).toEqual(obj);
  });

  it('treats arrays as leaves', () => {
    expect(flatten({ list: [1, 2] })).toEqual([['list', [1, 2]]]);
  });
});

describe('collections', () => {
  it('round-trips a stdio MCP server', () => {
    const db = fresh();
    upsertMcpServer(db, {
      name: 'files',
      transport: 'stdio',
      command: 'mcp-files',
      args: ['--root', '/tmp'],
      env: { DEBUG: '1' },
      enabled: true,
    });
    const [server] = listMcpServers(db);
    expect(server).toMatchObject({
      name: 'files',
      transport: 'stdio',
      command: 'mcp-files',
      args: ['--root', '/tmp'],
      env: { DEBUG: '1' },
      enabled: true,
    });
    db.close();
  });

  it('round-trips an http MCP server and updates in place', () => {
    const db = fresh();
    upsertMcpServer(db, {
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      auth: 'none',
      scopes: [],
      enabled: true,
    });
    upsertMcpServer(db, {
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp2',
      headers: {},
      auth: 'none',
      scopes: [],
      enabled: false,
    });

    const servers = listMcpServers(db);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      url: 'https://example.com/mcp2',
      enabled: false,
    });
    db.close();
  });

  it('deletes MCP servers and reports whether anything matched', () => {
    const db = fresh();
    upsertMcpServer(db, {
      name: 'x',
      transport: 'stdio',
      command: 'c',
      args: [],
      env: {},
      enabled: true,
    });
    expect(deleteMcpServer(db, 'x')).toBe(true);
    expect(deleteMcpServer(db, 'x')).toBe(false);
    expect(listMcpServers(db)).toHaveLength(0);
    db.close();
  });

  it('round-trips hooks including an optional matcher', () => {
    const db = fresh();
    upsertHook(db, {
      name: 'fmt',
      event: 'after_tool',
      matcher: 'Edit',
      command: 'biome check --write',
      timeoutSeconds: 15,
      enabled: true,
    });
    upsertHook(db, {
      name: 'bare',
      event: 'before_turn',
      command: 'echo hi',
      timeoutSeconds: 30,
      enabled: true,
    });

    const hooks = listHooks(db);
    expect(hooks[0]).toMatchObject({ name: 'fmt', matcher: 'Edit', timeoutSeconds: 15 });
    expect(hooks[1]?.matcher).toBeUndefined();
    expect(deleteHook(db, 'fmt')).toBe(true);
    db.close();
  });

  it('rejects an invalid entry before it reaches the table', () => {
    const db = fresh();
    expect(() =>
      upsertHook(db, {
        name: 'bad',
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
        event: 'never_happens' as any,
        command: 'true',
        timeoutSeconds: 30,
        enabled: true,
      }),
    ).toThrow();
    expect(listHooks(db)).toHaveLength(0);
    db.close();
  });
});

describe('config store', () => {
  it('reads schema defaults from an empty database', () => {
    const db = fresh();
    const config = readConfig(db);
    expect(config.provider).toBe('openai-compatible');
    expect(config.mcpServers).toEqual([]);
    db.close();
  });

  it('round-trips a full config including collections', () => {
    const db = fresh();
    const draft = ConfigSchema.parse({
      provider: 'anthropic',
      openaiCompatible: { model: 'custom:7b', contextWindow: 4096 },
      bots: { telegram: { enabled: true, allowedUserIds: [1, 2] } },
      mcpServers: [
        { name: 'a', transport: 'stdio', command: 'run-a', args: ['--x'], env: {}, enabled: true },
      ],
      hooks: [
        { name: 'h', event: 'on_error', command: 'notify', timeoutSeconds: 5, enabled: true },
      ],
    });
    writeConfig(db, draft);

    const back = readConfig(db);
    expect(back).toEqual(draft);
    db.close();
  });

  it('prunes settings for fields removed from a later write', () => {
    const db = fresh();
    writeConfig(db, ConfigSchema.parse({ provider: 'anthropic' }));
    setSetting(db, 'legacy.removed', 'stale');
    writeConfig(db, ConfigSchema.parse({ provider: 'openai-compatible' }));
    expect(allSettings(db).map(([k]) => k)).not.toContain('legacy.removed');
    db.close();
  });

  it('replaces collections wholesale rather than appending', () => {
    const db = fresh();
    writeConfig(
      db,
      ConfigSchema.parse({
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'a' }],
      }),
    );
    writeConfig(
      db,
      ConfigSchema.parse({
        mcpServers: [{ name: 'b', transport: 'stdio', command: 'b' }],
      }),
    );
    expect(readConfig(db).mcpServers.map((s) => s.name)).toEqual(['b']);
    db.close();
  });
});

describe('database handle', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-db-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('reuses one connection per path and creates the file on demand', async () => {
    expect(getDb()).toBe(getDb());
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(home, 'asterisk.db'))).resolves.toBeTruthy();
  });
});
