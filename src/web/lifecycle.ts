// Control-panel process lifecycle — start in the background, stop, free the port.
//
// The panel used to run in the caller's terminal, which meant it could not be
// left running without `nohup … &`, and freeing the port meant hunting for a
// pid. It is now a managed background process, modelled on the daemon: the
// same exclusive pid-file reservation (so two `asterisk web` calls cannot
// orphan a server), the same SIGTERM → poll → SIGKILL stop, and its own
// pid file so the two never stop each other.
//
// The child is this same entrypoint re-invoked with `--foreground`; it writes
// `web.json` once the bind succeeds, and that file appearing is the signal
// that startup worked. A bind failure therefore shows up as "the file never
// arrived", and the reason is already in the log the child inherited.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import type { LifecycleResult } from '../daemon/lifecycle.ts';
import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { clearPid, statusFromPidFile, writePid, writePidExclusive } from '../daemon/pidfile.ts';
import { PROJECT_ROOT, entrypointPath } from '../daemon/project-root.ts';
import { touchOwnerOnly } from '../utils/fs-safe.ts';
import { type WebFlags, childArgv } from './cli-args.ts';
import { clearWebState, readWebState } from './runtime-state.ts';

/** How long to wait for the child to bind before calling it a failed start. */
const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

function webEntry(): string {
  return entrypointPath('web');
}

/** Last few lines of the panel log — the child's own error message on a failed bind. */
function logTail(lines: number): string {
  const { webLog } = asteriskPaths();
  if (!existsSync(webLog)) return '';
  try {
    const all = readFileSync(webLog, 'utf8').trimEnd().split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch {
    return '';
  }
}

export interface StartWebResult extends LifecycleResult {
  url?: string;
}

export async function startWebPanel(flags: WebFlags): Promise<StartWebResult> {
  const paths = asteriskPaths();
  ensurePaths(paths);

  const status = statusFromPidFile(paths.webPidFile);
  if (status.running) {
    const running = readWebState();
    const where = running ? ` — ${running.url}` : '';
    return { ok: false, message: `control panel already running (pid ${status.pid})${where}` };
  }
  if (status.stale) clearPid(paths.webPidFile);

  // Reserve the pid file before spawning, so a second `asterisk web` in the
  // same instant loses cleanly instead of starting a server nothing can stop.
  if (!writePidExclusive(paths.webPidFile, process.pid)) {
    const winner = statusFromPidFile(paths.webPidFile);
    return {
      ok: false,
      message: `control panel already starting (pid ${winner.pid ?? 'unknown'})`,
    };
  }

  // A leftover record from a previous run would otherwise satisfy the wait
  // below immediately, and the reported URL would be the old one.
  clearWebState();

  // openSync('a') would create the log 0644; the panel's startup lines name
  // hosts and ports, and nothing under ~/.asterisk is meant to be world-readable.
  touchOwnerOnly(paths.webLog);
  const out = openSync(paths.webLog, 'a');
  const err = openSync(paths.webLog, 'a');

  const child = spawn('bun', [webEntry(), ...childArgv(flags)], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: PROJECT_ROOT,
    env: { ...process.env, ASTERISK_WEB_BACKGROUND: '1' },
  });
  child.unref();

  if (!child.pid) {
    clearPid(paths.webPidFile);
    return { ok: false, message: 'failed to spawn the control panel' };
  }

  // Replace the reservation with the real child pid and its start time.
  writePid(paths.webPidFile, child.pid);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readWebState();
    if (state && state.pid === child.pid) {
      return { ok: true, message: `control panel started (pid ${child.pid})`, url: state.url };
    }
    if (!statusFromPidFile(paths.webPidFile).running) break;
    await delay(POLL_INTERVAL_MS);
  }

  // Either it exited or it never bound. Either way it is not serving, so the
  // pid file must not outlive the attempt.
  clearPid(paths.webPidFile);
  clearWebState();
  const tail = logTail(5);
  return {
    ok: false,
    message: tail
      ? `control panel failed to start:\n${tail}`
      : `control panel failed to start; check ${paths.webLog}`,
  };
}

export async function stopWebPanel(): Promise<LifecycleResult> {
  const paths = asteriskPaths();
  const status = statusFromPidFile(paths.webPidFile);
  if (!status.running) {
    clearWebState();
    if (status.stale) {
      clearPid(paths.webPidFile);
      return { ok: true, message: 'cleared stale control-panel pid file' };
    }
    return { ok: true, message: 'control panel not running' };
  }

  const state = readWebState();
  const pid = status.pid as number;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, message: `kill SIGTERM failed: ${(e as Error).message}` };
  }

  const freed = state ? `, port ${state.port} free` : '';
  for (let i = 0; i < 20; i++) {
    await delay(250);
    if (!statusFromPidFile(paths.webPidFile).running) {
      clearPid(paths.webPidFile);
      clearWebState();
      return { ok: true, message: `control panel stopped (pid ${pid})${freed}` };
    }
  }

  // Hard stop after 5s.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await delay(200);
  clearPid(paths.webPidFile);
  clearWebState();
  return { ok: true, message: `control panel force-killed (pid ${pid})${freed}` };
}
