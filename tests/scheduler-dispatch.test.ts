// Regression coverage for the cron double-dispatch bug: src/daemon/scheduler.ts
// used to persist a cron job's lastRunAt only *after* every dispatch for the
// tick had settled, and setInterval never waited for a previous tick to
// finish before starting the next one. A dispatch that outlived one tick
// interval — routine, since Bash alone can run for up to 15 minutes — was
// therefore re-fired by every intervening tick.
//
// This file deliberately has no static import of scheduler.ts or
// tools/schedule.ts: both resolve ASTERISK_HOME once, at module load, into a
// fixed on-disk path (src/tools/schedule.ts's SCHEDULE_DIR). A static import
// at the top of the file would fix that path to whatever ASTERISK_HOME
// happens to be before beforeAll runs — not the temp dir this suite needs.
// Every import here is therefore a dynamic `await import(...)`, done only
// after ASTERISK_HOME is pointed at a throwaway directory. Vitest isolates
// the module registry per test file by default, so this has no effect on
// tests/scheduler.test.ts, which imports the same module for its pure
// cronMatches/expandCronField tests.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('scheduler — cron dedup across a dispatch that outlives one tick', () => {
  let home: string;
  let prevHome: string | undefined;
  let createScheduler: typeof import('../src/daemon/scheduler.ts').createScheduler;
  let writeCronJobs: typeof import('../src/tools/schedule.ts').writeCronJobs;
  let readCronJobs: typeof import('../src/tools/schedule.ts').readCronJobs;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'asterisk-sched-dispatch-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
    ({ createScheduler } = await import('../src/daemon/scheduler.ts'));
    ({ writeCronJobs, readCronJobs } = await import('../src/tools/schedule.ts'));
  });

  afterAll(() => {
    if (prevHome !== undefined) process.env['ASTERISK_HOME'] = prevHome;
    else delete process.env['ASTERISK_HOME'];
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    writeCronJobs([]);
  });

  it('does not re-fire a "* * * * *" job while its dispatch is still running', async () => {
    writeCronJobs([
      {
        id: 'slow-job',
        cron: '* * * * *',
        prompt: 'do the thing',
        enabled: true,
        createdAt: Date.now(),
      },
    ]);

    let dispatchCount = 0;
    let concurrentInFlight = 0;
    let maxConcurrentInFlight = 0;
    let releaseDispatch: (() => void) | undefined;

    const scheduler = createScheduler({
      intervalMs: 10, // tick far faster than the dispatch below resolves
      log: () => {},
      dispatch: async () => {
        dispatchCount += 1;
        concurrentInFlight += 1;
        maxConcurrentInFlight = Math.max(maxConcurrentInFlight, concurrentInFlight);
        await new Promise<void>((resolveDispatch) => {
          releaseDispatch = resolveDispatch;
        });
        concurrentInFlight -= 1;
      },
    });
    scheduler.start();

    // Wait for the first dispatch to actually start.
    const dispatchStartDeadline = Date.now() + 2000;
    while (dispatchCount === 0 && Date.now() < dispatchStartDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(dispatchCount).toBe(1);

    // Let many tick intervals elapse (10ms interval, 200ms wait — ~20 ticks)
    // while the single dispatch above is still awaiting its release.
    await new Promise((r) => setTimeout(r, 200));
    scheduler.stop();
    releaseDispatch?.();
    // Give the in-flight dispatch's continuation (and the tick that started
    // it) a turn to finish before asserting.
    await new Promise((r) => setTimeout(r, 20));

    expect(dispatchCount).toBe(1);
    expect(maxConcurrentInFlight).toBe(1);

    const persisted = readCronJobs();
    expect(persisted[0]?.lastRunAt).toBeGreaterThan(0);
  });
});
