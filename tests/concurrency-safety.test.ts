// Concurrency invariants for the two pieces of state three Asterisk processes
// share: the SQLite file and the daemon pidfile.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDriver } from '../src/db/driver.ts';
import { latestVersion, migrate } from '../src/db/migrations.ts';
import {
  clearPid,
  processStartTime,
  readPid,
  statusFromPidFile,
  writePid,
  writePidExclusive,
} from '../src/daemon/pidfile.ts';

describe('migrations under concurrent startup', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asterisk-migrate-'));
    file = join(dir, 'shared.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a second connection migrate the same fresh file without crashing', () => {
    // The real scenario: REPL, daemon and `asterisk web` all opening a
    // brand-new database at once. Reading the applied set outside the
    // transaction let every one of them see an empty set and then race to run
    // CREATE TABLE, so two of the three died with "table already exists".
    const a = openDriver(file);
    const b = openDriver(file);

    const appliedByA = migrate(a);
    const appliedByB = migrate(b);

    expect(appliedByA).toBe(latestVersion());
    // B observes A's work and has nothing left to do.
    expect(appliedByB).toBe(0);

    a.close();
    b.close();
  });

  it('is idempotent across repeated calls on one connection', () => {
    const db = openDriver(file);
    expect(migrate(db)).toBe(latestVersion());
    expect(migrate(db)).toBe(0);
    expect(migrate(db)).toBe(0);
    db.close();
  });

  it('rolls back a failed transaction without leaving a partial schema', () => {
    const db = openDriver(file);
    migrate(db);
    expect(() =>
      db.transaction(() => {
        db.exec('CREATE TABLE rollback_probe (v TEXT)');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const found = db.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE name = 'rollback_probe'",
    );
    expect(found?.n).toBe(0);
    db.close();
  });
});

describe('pidfile', () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asterisk-pid-'));
    pidFile = join(dir, 'asterisk.pid');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reserves exclusively so a second starter loses the race', () => {
    expect(writePidExclusive(pidFile, process.pid)).toBe(true);
    // Second `asterisk start` in the same second: it must not spawn.
    expect(writePidExclusive(pidFile, process.pid + 1)).toBe(false);
    // The winner's pid is intact.
    expect(readPid(pidFile)).toBe(process.pid);
  });

  it('writes the pidfile owner-only', () => {
    writePid(pidFile, process.pid);
    expect(statSync(pidFile).mode & 0o777).toBe(0o600);
  });

  it('reports a live, matching process as running', () => {
    writePid(pidFile, process.pid);
    expect(statusFromPidFile(pidFile)).toMatchObject({ running: true, pid: process.pid });
  });

  it('reports a missing pidfile as not running', () => {
    expect(statusFromPidFile(pidFile)).toEqual({ running: false, pid: null, stale: false });
  });

  it('treats a recycled pid as stale rather than as our daemon', () => {
    // A pid that is alive but whose recorded start time does not match: exactly
    // what a post-crash pid reuse looks like. Without the start-time check
    // `asterisk stop` would send SIGTERM to this unrelated process.
    const startTime = processStartTime(process.pid);
    if (startTime === null) return; // platform without /proc — check degrades
    writeFileSync(pidFile, `${process.pid}\n${Number(startTime) + 999}\n`);

    expect(statusFromPidFile(pidFile)).toMatchObject({ running: false, stale: true });
  });

  it('accepts a legacy pidfile that has no start time recorded', () => {
    writeFileSync(pidFile, `${process.pid}\n`);
    expect(statusFromPidFile(pidFile)).toMatchObject({ running: true, pid: process.pid });
  });

  it('records the start time alongside the pid', () => {
    writePid(pidFile, process.pid);
    const lines = readFileSync(pidFile, 'utf8').trim().split('\n');
    if (processStartTime(process.pid) !== null) {
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe(processStartTime(process.pid));
    }
  });

  it('frees the reservation once cleared', () => {
    expect(writePidExclusive(pidFile, process.pid)).toBe(true);
    clearPid(pidFile);
    expect(writePidExclusive(pidFile, process.pid)).toBe(true);
  });

  it('ignores a garbage pidfile instead of throwing', () => {
    writeFileSync(pidFile, 'not-a-pid\n');
    expect(readPid(pidFile)).toBeNull();
    expect(statusFromPidFile(pidFile).running).toBe(false);
  });
});
