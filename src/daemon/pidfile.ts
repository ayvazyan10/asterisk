// PID file management.
//
// Two failure modes this guards against, both of which bit before:
//
//   1. Two `asterisk start` invocations in the same second both saw "not
//      running", both spawned a daemon, and the second overwrote the pidfile.
//      The first daemon was then orphaned forever — two bots answering every
//      message, and only one of them stoppable. Reserving the pidfile with an
//      exclusive create makes the loser of that race lose cleanly.
//
//   2. `kill(pid, 0)` only asks whether *a* process holds that pid. After a
//      crash the OS reuses pids, so a stale pidfile could name a live and
//      entirely unrelated process — and `asterisk stop` would SIGTERM it. The
//      pidfile therefore records the process start time alongside the pid; a
//      pid can be reused, but not a pid *and* a start time.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { OWNER_ONLY_FILE } from '../utils/fs-safe.ts';

export interface PidStatus {
  running: boolean;
  pid: number | null;
  stale: boolean;
  /** The inspected record's start-time token; what clearPidIfUnchanged compares. */
  startTime?: string | null;
}

interface PidRecord {
  pid: number;
  /** Opaque start-time token, or null on platforms that do not expose one. */
  startTime: string | null;
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

/**
 * Reads the kernel's start time for `pid`.
 *
 * Linux only: field 22 of /proc/<pid>/stat, in clock ticks since boot. Returns
 * null elsewhere, in which case the reuse check simply degrades to the old
 * kill(pid, 0) behaviour rather than rejecting a valid pidfile.
 */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces and
    // parentheses, so fields are counted from the last ')' rather than by
    // splitting the whole line. The first token after it is field 3 (state),
    // which puts field 22 at index 19.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return tail[19] ?? null;
  } catch {
    return null;
  }
}

function serialise(pid: number): string {
  const startTime = processStartTime(pid);
  return startTime === null ? `${pid}\n` : `${pid}\n${startTime}\n`;
}

function readRecord(pidFile: string): PidRecord | null {
  if (!existsSync(pidFile)) return null;
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf8');
  } catch {
    return null;
  }
  const [pidLine, startLine] = raw.split('\n');
  const pid = Number.parseInt((pidLine ?? '').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const startTime = (startLine ?? '').trim();
  return { pid, startTime: startTime === '' ? null : startTime };
}

export function readPid(pidFile: string): number | null {
  return readRecord(pidFile)?.pid ?? null;
}

export function statusFromPidFile(pidFile: string): PidStatus {
  const record = readRecord(pidFile);
  if (record === null) return { running: false, pid: null, stale: false };
  if (!isAlive(record.pid)) {
    return { running: false, pid: record.pid, stale: true, startTime: record.startTime };
  }

  // The pid is live — but is it still the process we started? A mismatch means
  // the pid was recycled and this file is stale, not that a daemon is running.
  if (record.startTime !== null) {
    const current = processStartTime(record.pid);
    if (current !== null && current !== record.startTime) {
      return { running: false, pid: record.pid, stale: true, startTime: record.startTime };
    }
  }
  return { running: true, pid: record.pid, stale: false };
}

export function writePid(pidFile: string, pid: number): void {
  writeFileSync(pidFile, serialise(pid), { mode: OWNER_ONLY_FILE });
}

/**
 * Creates the pidfile only if it does not already exist.
 *
 * Returns false when another process got there first, which the caller must
 * treat as "already running" rather than retrying — that is the whole point of
 * the exclusive create.
 */
export function writePidExclusive(pidFile: string, pid: number): boolean {
  try {
    writeFileSync(pidFile, serialise(pid), { flag: 'wx', mode: OWNER_ONLY_FILE });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

export function clearPid(pidFile: string): void {
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

/**
 * Removes the pidfile only if it still holds the record that was inspected.
 *
 * A plain clear-then-reserve is a race: two starters both see the same stale
 * file, the first clears it and writes its reservation, and the second's clear
 * deletes that fresh reservation. The start time is compared as well as the
 * pid: the fresh reservation can carry the very pid the stale record named,
 * once the OS has recycled it.
 */
export function clearPidIfUnchanged(pidFile: string, inspected: PidStatus): void {
  const record = readRecord(pidFile);
  if (record === null || record.pid !== inspected.pid) return;
  if (record.startTime !== (inspected.startTime ?? null)) return;
  clearPid(pidFile);
}
