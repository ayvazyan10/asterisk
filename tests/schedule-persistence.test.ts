// schedule.ts (ScheduleWakeup/CronCreate/CronList persistence): a corrupted
// line must not take the rest of the file down with it, and writes must be
// atomic (temp file + rename) rather than a direct writeFileSync.
//
// Statically imports the module: scheduleDir() is computed lazily from
// ASTERISK_HOME at call time (not a fixed module-load-time constant), so
// setting the env var per test is enough — no dynamic import juggling
// needed.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCronJobs, readOneShots, writeOneShots } from '../src/tools/schedule.ts';

describe('schedule.ts persistence', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-sched-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('skips a corrupted line instead of throwing and losing every other job', () => {
    const dir = join(home, 'schedule');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'oneshots.jsonl');
    const good1 = JSON.stringify({ id: 'a', prompt: 'first', fireAt: 1, createdAt: 1 });
    const good2 = JSON.stringify({ id: 'b', prompt: 'second', fireAt: 2, createdAt: 2 });
    // A line truncated mid-write — not valid JSON.
    const corrupted = '{"id":"c","prompt":"trunc';
    writeFileSync(file, [good1, corrupted, good2, ''].join('\n'));

    // Old code called JSON.parse on every line with no try/catch, so this
    // would throw and readOneShots() would never return.
    const items = readOneShots();
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('does not throw when the cron file has a corrupted line either', () => {
    const dir = join(home, 'schedule');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'cron.jsonl');
    const good = JSON.stringify({
      id: 'cron_a',
      cron: '* * * * *',
      prompt: 'p',
      enabled: true,
      createdAt: 1,
    });
    writeFileSync(file, `${good}\nnot json at all\n`);

    const items = readCronJobs();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('cron_a');
  });

  it('writes atomically: no stray temp file is left behind, and content round-trips', () => {
    writeOneShots([
      { id: 'x', prompt: 'hello', fireAt: 100, createdAt: 1 },
      { id: 'y', prompt: 'world', fireAt: 200, createdAt: 2 },
    ]);

    const dir = join(home, 'schedule');
    const entries = readdirSync(dir);
    expect(entries).toContain('oneshots.jsonl');
    expect(entries.some((f) => f.includes('.tmp'))).toBe(false);

    const roundTripped = readOneShots();
    expect(roundTripped.map((i) => i.id).sort()).toEqual(['x', 'y']);
  });

  it('creates the schedule file owner-only (0600), not world-readable', () => {
    writeOneShots([{ id: 'z', prompt: 'secret prompt', fireAt: 1, createdAt: 1 }]);
    const file = join(home, 'schedule', 'oneshots.jsonl');
    expect(existsSync(file)).toBe(true);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trip via readOneShots/writeOneShots is stable across calls', () => {
    writeOneShots([{ id: 'first', prompt: 'p1', fireAt: 1, createdAt: 1 }]);
    const after1 = readOneShots();
    writeOneShots(after1);
    const after2 = readOneShots();
    expect(after2).toEqual(after1);
    // Sanity: the raw file really is JSONL, one job per line.
    const raw = readFileSync(join(home, 'schedule', 'oneshots.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });
});
