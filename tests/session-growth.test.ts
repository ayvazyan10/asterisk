// monitor.ts and worktree.ts must not accumulate one Map entry per session
// forever — same growth bound tasks.ts and entrypoints/daemon.ts already
// apply (see tests/tasks.test.ts for the tasks.ts case).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import {
  MAX_MONITOR_SESSIONS,
  _resetMonitorsForTesting,
  _sessionCountForTesting,
  monitorTool,
} from '../src/tools/monitor.ts';
import {
  MAX_WORKTREE_SESSIONS,
  _resetWorktreesForTesting,
  _setActiveForTesting,
  activeWorktree,
} from '../src/tools/worktree.ts';

describe('monitor.ts session growth', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-mon-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
    _resetMonitorsForTesting();
  });

  afterEach(async () => {
    _resetMonitorsForTesting();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('caps idle-session growth instead of accumulating one Map entry per session forever', async () => {
    // `action:'list'` touches the per-session Map without spawning
    // anything, so this stays fast and side-effect free. On the old,
    // uncapped Map, the size would just keep climbing to sessionCount.
    const sessionCount = MAX_MONITOR_SESSIONS + 1;
    for (let i = 0; i < sessionCount; i++) {
      await runWithSession({ id: `mon-sess-${i}`, scope: 'unknown' }, () =>
        monitorTool.execute({ action: 'list' }),
      );
    }

    expect(_sessionCountForTesting()).toBeLessThanOrEqual(MAX_MONITOR_SESSIONS);
  });

  it('never evicts a session with a still-running monitor, even when it is oldest', async () => {
    let monitorId = '';
    await runWithSession({ id: 'mon-sess-live', scope: 'unknown' }, async () => {
      const started = await monitorTool.execute({ action: 'start', command: 'sleep 30' });
      expect(started.isError).toBe(false);
      const match = started.output.match(/started monitor (\S+)/);
      monitorId = match?.[1] ?? '';
      expect(monitorId).not.toBe('');
    });

    try {
      // Push well past the cap with idle sessions created *after* the live
      // one, so the live session is the oldest and the first eviction
      // candidate under a naive LRU.
      for (let i = 0; i < MAX_MONITOR_SESSIONS + 1; i++) {
        await runWithSession({ id: `mon-sess-idle-${i}`, scope: 'unknown' }, () =>
          monitorTool.execute({ action: 'list' }),
        );
      }

      const stillThere = await runWithSession({ id: 'mon-sess-live', scope: 'unknown' }, () =>
        monitorTool.execute({ action: 'tail', id: monitorId }),
      );
      expect(stillThere.isError).toBe(false);
      expect(stillThere.output).toContain('running');
    } finally {
      // Clean up the real background process regardless of the outcome.
      await runWithSession({ id: 'mon-sess-live', scope: 'unknown' }, () =>
        monitorTool.execute({ action: 'stop', id: monitorId }),
      );
    }
  });
});

describe('worktree.ts session growth', () => {
  beforeEach(() => {
    _resetWorktreesForTesting();
  });

  afterEach(() => {
    _resetWorktreesForTesting();
  });

  it('caps growth: the oldest session is evicted, not kept forever', async () => {
    // _setActiveForTesting exercises the same setActive()/LRU path
    // EnterWorktree uses, without a real git checkout per session. On the
    // old, uncapped Map, `wt-sess-0` would still have its entry after this
    // loop.
    const sessionCount = MAX_WORKTREE_SESSIONS + 1;
    for (let i = 0; i < sessionCount; i++) {
      await runWithSession({ id: `wt-sess-${i}`, scope: 'unknown' }, async () => {
        _setActiveForTesting({ path: `/tmp/wt-${i}`, branch: `b-${i}`, createdAt: Date.now() });
      });
    }

    const first = await runWithSession({ id: 'wt-sess-0', scope: 'unknown' }, () =>
      Promise.resolve(activeWorktree()),
    );
    expect(first).toBeNull();

    const last = await runWithSession({ id: `wt-sess-${sessionCount - 1}`, scope: 'unknown' }, () =>
      Promise.resolve(activeWorktree()),
    );
    expect(last?.branch).toBe(`b-${sessionCount - 1}`);
  });
});
