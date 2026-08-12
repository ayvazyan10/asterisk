// Regression tests for the owner-only guarantee on ~/.asterisk.
//
// The bug these exist for: `chmod 0600` was applied to the database *after*
// `PRAGMA journal_mode = WAL` had already created the -wal sidecar, so the
// sidecar kept the process umask (0644 on a default Linux install) while
// holding a verbatim copy of recent writes — including live bot tokens.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persistOutput } from '../src/agent/output-store.ts';
import { saveConversation } from '../src/agent/persistence.ts';
import { openDriver } from '../src/db/driver.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import { findExposedFiles, writeOwnerOnlyAtomic } from '../src/utils/fs-safe.ts';

const EXPOSED_BITS = 0o077;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function isExposed(path: string): boolean {
  return (statSync(path).mode & EXPOSED_BITS) !== 0;
}

describe('owner-only state files', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'asterisk-perms-'));
    savedHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(() => {
    closeDb();
    if (savedHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('creates the database and its WAL sidecar owner-only', () => {
    const db = getDb();
    // Force a write so the -wal file definitely exists and has content.
    db.exec('CREATE TABLE IF NOT EXISTS perm_probe (v TEXT)');
    db.run('INSERT INTO perm_probe (v) VALUES (?)', ['sk-secret-value']);

    const file = join(home, 'asterisk.db');
    expect(mode(file)).toBe(0o600);
    // The sidecar is the one that leaked. It only exists while a WAL
    // connection is open, which it is here.
    expect(isExposed(`${file}-wal`)).toBe(false);
    expect(isExposed(`${file}-shm`)).toBe(false);
  });

  it('restricts a database opened directly through the driver', () => {
    const file = join(home, 'direct.db');
    const db = openDriver(file);
    db.exec('CREATE TABLE t (v TEXT)');
    db.run('INSERT INTO t (v) VALUES (?)', ['x']);
    expect(mode(file)).toBe(0o600);
    expect(isExposed(`${file}-wal`)).toBe(false);
    db.close();
  });

  it('writes persisted tool output owner-only', () => {
    const marker = persistOutput('Read', 'y'.repeat(9000));
    const path = /persisted to (\S+) —/.exec(marker)?.[1];
    expect(path).toBeDefined();
    expect(mode(path as string)).toBe(0o600);
    expect(isExposed(join(home, 'outputs'))).toBe(false);
  });

  it('gives concurrent large outputs distinct files', () => {
    // Same tool, same millisecond: the timestamp-only filename used to collide
    // and hand the model a path to another tool's content.
    const paths = new Set(
      Array.from({ length: 20 }, () => {
        const marker = persistOutput('Read', 'z'.repeat(9000));
        return /persisted to (\S+) —/.exec(marker)?.[1];
      }),
    );
    expect(paths.size).toBe(20);
  });

  it('writes conversation transcripts owner-only', () => {
    saveConversation('chat-1', [
      { role: 'user', content: [{ type: 'text', text: 'secret question' }] },
    ]);
    expect(mode(join(home, 'conversations', 'chat-1.json'))).toBe(0o600);
    expect(isExposed(join(home, 'conversations'))).toBe(false);
  });

  it('leaves no group- or world-readable file anywhere under the state dir', async () => {
    // Include file-history: copyFileSync carries the source file's mode, so a
    // snapshot of a world-readable file used to stay world-readable.
    const { recordFileChange } = await import('../src/agent/file-history.ts');
    const loose = join(home, 'loose-source.txt');
    writeFileSync(loose, 'API_KEY=sk-secret', { mode: 0o644 });
    recordFileChange(loose, 'Write');
    rmSync(loose, { force: true });

    const db = getDb();
    db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
      'probe',
      'v',
      Date.now(),
    ]);
    persistOutput('Grep', 'w'.repeat(9000));
    saveConversation('chat-2', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(findExposedFiles(home)).toEqual([]);
  });
});

describe('atomic writes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asterisk-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces existing content and tightens an already-loose file', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'old', { mode: 0o644 });
    expect(mode(file)).toBe(0o644);

    writeOwnerOnlyAtomic(file, 'new');

    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind', () => {
    const file = join(dir, 'state.json');
    writeOwnerOnlyAtomic(file, '{}');
    expect(findExposedFiles(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });
});
