// PID file management — atomic-ish write + stale detection via kill -0.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface PidStatus {
  running: boolean;
  pid: number | null;
  stale: boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function statusFromPidFile(pidFile: string): PidStatus {
  const pid = readPid(pidFile);
  if (pid === null) return { running: false, pid: null, stale: false };
  if (isAlive(pid)) return { running: true, pid, stale: false };
  return { running: false, pid, stale: true };
}

export function writePid(pidFile: string, pid: number): void {
  writeFileSync(pidFile, `${pid}\n`, { mode: 0o644 });
}

export function clearPid(pidFile: string): void {
  if (existsSync(pidFile)) unlinkSync(pidFile);
}
