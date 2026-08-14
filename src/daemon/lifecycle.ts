// Daemon lifecycle — start / stop / restart / status / logs.
// Keeps zero runtime deps for the dispatcher itself; uses Node child_process.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { asteriskPaths, ensurePaths } from './paths.ts';
import { clearPid, statusFromPidFile, writePid, writePidExclusive } from './pidfile.ts';
import { PROJECT_ROOT, entrypointPath } from './project-root.ts';

function daemonEntry(): string {
  return entrypointPath('daemon');
}

export interface LifecycleResult {
  ok: boolean;
  message: string;
}

export async function start(): Promise<LifecycleResult> {
  const paths = asteriskPaths();
  ensurePaths(paths);

  const status = statusFromPidFile(paths.pidFile);
  if (status.running) {
    return { ok: false, message: `daemon already running (pid ${status.pid})` };
  }
  if (status.stale) clearPid(paths.pidFile);

  // Reserve the pidfile before spawning. Checking the status and then spawning
  // left a window in which two `asterisk start` calls both passed the check and
  // both spawned a daemon, orphaning the first one — two bots answering every
  // message, only one of them stoppable. The exclusive create picks a winner;
  // the loser reports "already running" without spawning anything.
  if (!writePidExclusive(paths.pidFile, process.pid)) {
    const winner = statusFromPidFile(paths.pidFile);
    return { ok: false, message: `daemon already starting (pid ${winner.pid ?? 'unknown'})` };
  }

  const out = openSync(paths.daemonLog, 'a');
  const err = openSync(paths.daemonLog, 'a');

  const child = spawn('bun', [daemonEntry()], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: PROJECT_ROOT,
    env: { ...process.env, ASTERISK_DAEMON: '1' },
  });
  child.unref();

  if (!child.pid) {
    clearPid(paths.pidFile);
    return { ok: false, message: 'failed to spawn daemon' };
  }

  // Replace the reservation with the real child pid and its start time.
  writePid(paths.pidFile, child.pid);

  // Give the daemon a moment to crash if it's going to.
  await delay(500);
  const recheck = statusFromPidFile(paths.pidFile);
  if (!recheck.running) {
    clearPid(paths.pidFile);
    return { ok: false, message: 'daemon exited shortly after start; check logs' };
  }
  return { ok: true, message: `daemon started (pid ${child.pid})` };
}

export async function stop(): Promise<LifecycleResult> {
  const paths = asteriskPaths();
  const status = statusFromPidFile(paths.pidFile);
  if (!status.running) {
    if (status.stale) {
      clearPid(paths.pidFile);
      return { ok: true, message: 'cleared stale pid file' };
    }
    return { ok: true, message: 'daemon not running' };
  }

  const pid = status.pid as number;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, message: `kill SIGTERM failed: ${(e as Error).message}` };
  }

  for (let i = 0; i < 10; i++) {
    await delay(500);
    if (!statusFromPidFile(paths.pidFile).running) {
      clearPid(paths.pidFile);
      return { ok: true, message: `daemon stopped (pid ${pid})` };
    }
  }

  // Hard stop after 5s.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await delay(200);
  clearPid(paths.pidFile);
  return { ok: true, message: `daemon force-killed (pid ${pid})` };
}

export async function restart(): Promise<LifecycleResult> {
  const stopRes = await stop();
  if (!stopRes.ok) return stopRes;
  return start();
}

export function status(): LifecycleResult {
  const paths = asteriskPaths();
  const s = statusFromPidFile(paths.pidFile);
  if (s.running) {
    let logSize = 0;
    try {
      logSize = statSync(paths.daemonLog).size;
    } catch {}
    return {
      ok: true,
      message: `running (pid ${s.pid}) — log ${paths.daemonLog} (${logSize} bytes)`,
    };
  }
  if (s.stale) {
    return { ok: true, message: `not running (stale pid file at ${paths.pidFile})` };
  }
  return { ok: true, message: 'not running' };
}

export function logs(lines: number): LifecycleResult {
  const paths = asteriskPaths();
  if (!existsSync(paths.daemonLog)) {
    return { ok: true, message: '(no log file yet)' };
  }
  const text = readFileSync(paths.daemonLog, 'utf8');
  const all = text.split('\n');
  const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
  return { ok: true, message: tail };
}
