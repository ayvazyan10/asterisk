// Regression tests for the owner-only guarantee on ~/.asterisk.
//
// The bug these exist for: `chmod 0600` was applied to the database *after*
// `PRAGMA journal_mode = WAL` had already created the -wal sidecar, so the
// sidecar kept the process umask (0644 on a default Linux install) while
// holding a verbatim copy of recent writes — including live bot tokens.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persistOutput } from '../src/agent/output-store.ts';
import { saveConversation } from '../src/agent/persistence.ts';
import { openDriver } from '../src/db/driver.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import {
  findExposedFiles,
  resolveWriteTarget,
  resolvesInside,
  writeOwnerOnlyAtomic,
} from '../src/utils/fs-safe.ts';

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

// Where a write lands, as opposed to what mode it gets. Three call sites share
// this — the file-tools write policy, /api/content and /api/skills — and each
// of them had either no symlink check at all or one that missed the case
// below.
describe('symlink containment', () => {
  let base: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'asterisk-links-'));
    outside = mkdtempSync(join(tmpdir(), 'asterisk-outside-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('follows a dangling final component, which existsSync cannot', () => {
    // The bug this exists for: existsSync goes *through* the link, so for a
    // target that is not there yet it answers false — and a check that then
    // falls back to the parent directory approves a write landing in `outside`.
    symlinkSync(join(outside, 'pwned.md'), join(base, 'evil.md'));

    expect(resolveWriteTarget(join(base, 'evil.md'))).toBe(join(outside, 'pwned.md'));
    expect(resolvesInside(base, join(base, 'evil.md'))).toBe(false);
  });

  it('follows a link whose target does exist', () => {
    writeFileSync(join(outside, 'real.md'), 'x');
    symlinkSync(join(outside, 'real.md'), join(base, 'link.md'));
    expect(resolvesInside(base, join(base, 'link.md'))).toBe(false);
  });

  it('follows a symlinked directory, existing or not', () => {
    symlinkSync(outside, join(base, 'there'));
    symlinkSync(join(outside, 'gone'), join(base, 'missing'));

    expect(resolvesInside(base, join(base, 'there', 'a.md'))).toBe(false);
    expect(resolvesInside(base, join(base, 'missing', 'a.md'))).toBe(false);
  });

  it('follows a relative link target', () => {
    symlinkSync('../..', join(base, 'up'));
    expect(resolvesInside(base, join(base, 'up', 'a.md'))).toBe(false);
  });

  it('resolves a chain of links', () => {
    symlinkSync(join(base, 'second'), join(base, 'first'));
    symlinkSync(join(outside, 'end.md'), join(base, 'second'));
    expect(resolvesInside(base, join(base, 'first'))).toBe(false);
  });

  it('survives a symlink loop instead of recursing forever', () => {
    symlinkSync(join(base, 'b'), join(base, 'a'));
    symlinkSync(join(base, 'a'), join(base, 'b'));
    // The answer does not matter as much as returning one at all.
    expect(typeof resolveWriteTarget(join(base, 'a'))).toBe('string');
  });

  it('keeps ordinary writes working', () => {
    // A file that is not there yet, at a depth that is not there either, is
    // the normal case for a write — it must stay inside.
    expect(resolvesInside(base, join(base, 'a', 'b', 'c.md'))).toBe(true);
    expect(resolvesInside(base, base)).toBe(true);

    mkdirSync(join(base, 'real'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'alias'));
    expect(resolvesInside(base, join(base, 'alias', 'note.md'))).toBe(true);
  });

  it('does not treat a sibling sharing a prefix as inside', () => {
    expect(resolvesInside(base, `${base}-other`)).toBe(false);
  });
});
