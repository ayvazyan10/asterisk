import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { logs, start, status, stop } from '../src/daemon/lifecycle.ts';
import { asteriskPaths } from '../src/daemon/paths.ts';
import { statusFromPidFile } from '../src/daemon/pidfile.ts';

describe('daemon lifecycle', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevHeartbeat: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-daemon-'));
    prevHome = process.env['ASTERISK_HOME'];
    prevHeartbeat = process.env['ASTERISK_HEARTBEAT_MS'];
    process.env['ASTERISK_HOME'] = home;
    // Fast heartbeat so the test exercises the logger path quickly.
    process.env['ASTERISK_HEARTBEAT_MS'] = '200';
  });

  afterEach(async () => {
    await stop().catch(() => {});
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    if (prevHeartbeat === undefined) delete process.env['ASTERISK_HEARTBEAT_MS'];
    else process.env['ASTERISK_HEARTBEAT_MS'] = prevHeartbeat;
    await rm(home, { recursive: true, force: true });
  });

  it('start writes a pid file, status reports running, stop clears it', async () => {
    const startRes = await start();
    expect(startRes.ok).toBe(true);

    const paths = asteriskPaths();
    const s = statusFromPidFile(paths.pidFile);
    expect(s.running).toBe(true);
    expect(s.pid).toBeGreaterThan(0);

    const statusRes = status();
    expect(statusRes.message).toMatch(/running \(pid \d+\)/);

    // Wait for at least one heartbeat to land in the log.
    await delay(500);
    const tail = logs(20);
    expect(tail.message).toMatch(/heartbeat|asterisk daemon starting/);

    const stopRes = await stop();
    expect(stopRes.ok).toBe(true);
    const after = statusFromPidFile(paths.pidFile);
    expect(after.running).toBe(false);
  }, 15_000);

  it('refuses to double-start', async () => {
    const first = await start();
    expect(first.ok).toBe(true);
    const second = await start();
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already running/);
    await stop();
  }, 15_000);

  it('reports not-running cleanly when no daemon was started', () => {
    const s = status();
    expect(s.message).toBe('not running');
  });
});
