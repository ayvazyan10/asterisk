// Owner-only filesystem helpers.
//
// Everything Asterisk writes under ~/.asterisk can carry secrets: the database
// holds API keys and bot tokens, persisted tool output holds whatever the agent
// read, conversation transcripts hold both, and the SQLite -wal sidecar holds a
// verbatim copy of recent writes to the database. Node's writeFileSync creates
// files 0666-masked-by-umask, which on a default Linux umask of 022 means
// world-readable — so every one of those became readable by any local user.
//
// These helpers make owner-only the default for that whole tree. chmod failures
// are swallowed deliberately: Windows shares and some FUSE mounts reject chmod
// outright, and refusing to start over file permissions would be worse than
// continuing. `findExposedFiles` exists so the gap surfaces as a `/doctor`
// warning instead of as a silent leak.

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export const OWNER_ONLY_FILE = 0o600;
export const OWNER_ONLY_DIR = 0o700;

/** Group- and other-readable bits. Anything set here means a local leak. */
const EXPOSED_BITS = 0o077;

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // See the module comment: some filesystems reject chmod entirely.
  }
}

/** Creates `dir` and its parents, restricted to the owner. */
export function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  // `mode` only applies to directories mkdirSync actually creates, so an
  // existing directory keeps whatever mode it already had.
  chmodBestEffort(dir, OWNER_ONLY_DIR);
}

/** Writes `data` to `file` with mode 0600, replacing any existing content. */
export function writeOwnerOnly(file: string, data: string): void {
  writeFileSync(file, data, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
  // Same caveat as above: `mode` is only honoured on creation.
  chmodBestEffort(file, OWNER_ONLY_FILE);
}

/**
 * Writes `data` to `file` atomically. A concurrent reader sees either the
 * previous content or the new content, never a half-written file — which is
 * what turned a crash mid-write into a silently emptied conversation.
 */
export function writeOwnerOnlyAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeOwnerOnly(tmp, data);
  renameSync(tmp, file);
}

/** Creates `file` empty with mode 0600 if it does not already exist. */
export function touchOwnerOnly(file: string): void {
  try {
    closeSync(openSync(file, 'a', OWNER_ONLY_FILE));
  } catch {
    // A missing parent directory is the caller's problem; opening the database
    // immediately afterwards will report it with a better message.
    return;
  }
  chmodBestEffort(file, OWNER_ONLY_FILE);
}

/** True if `path` is readable or writable by group or other. */
export function isExposed(path: string): boolean {
  try {
    return (statSync(path).mode & EXPOSED_BITS) !== 0;
  } catch {
    return false;
  }
}

/**
 * Returns paths under `root` that group or other can reach, capped at `limit`
 * so `/doctor` stays fast on a large state directory.
 */
export function findExposedFiles(root: string, limit = 50): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isExposed(dir)) found.push(dir);
    for (const entry of entries) {
      if (found.length >= limit) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isExposed(path)) found.push(path);
    }
  };
  walk(root);
  return found;
}
