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
//
// `resolveWriteTarget` / `resolvesInside` answer the other half of "is this
// write safe": not what mode the file gets, but where it actually lands. Three
// call sites needed that and each had its own answer — `write-policy.ts` had
// none at all, `web/api/content.ts` had one that missed dangling links, and
// `web/api/skills.ts` had none either. One implementation now, here, because
// `utils/` is the only place both `tools/` and `web/` already reach into.

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const OWNER_ONLY_FILE = 0o600;
export const OWNER_ONLY_DIR = 0o700;

/**
 * Symlink hops and unresolved parent components we are willing to walk before
 * giving up. Linux stops at 40 links; a path deeper than this is either a loop
 * or something the kernel would refuse anyway.
 */
const MAX_LINK_DEPTH = 40;

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The link target, or null when `path` is not a symlink (or is unreadable). */
function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function resolveLinks(absPath: string, depth: number): string {
  const real = realpathOrNull(absPath);
  if (real !== null) return real;

  const parent = dirname(absPath);
  if (parent === absPath || depth >= MAX_LINK_DEPTH) return absPath;

  const leaf = join(resolveLinks(parent, depth + 1), basename(absPath));
  const target = readlinkOrNull(leaf);
  if (target === null) return leaf;
  return resolveLinks(resolve(dirname(leaf), target), depth + 1);
}

/**
 * Where a write to `absPath` would actually land, with every symlink on the way
 * resolved — including a final component that is itself a symlink whose target
 * does not exist yet.
 *
 * `realpathSync` cannot be used alone: it throws for anything that does not
 * exist, and "the file is not there yet" is the ordinary case for a write. The
 * tempting fallback — climb to the deepest *existing* ancestor and check that
 * instead — looks right until the leaf is a dangling symlink, because
 * `existsSync` follows the link, reports false for a missing target, and the
 * climb then approves the parent directory while the write lands wherever the
 * link pointed. `readlink` is what distinguishes the two cases, so that is what
 * this uses.
 *
 * Never throws: an unreadable component resolves lexically, and the caller's
 * containment check is what decides. It is a *pre-flight* answer — see
 * `resolvesInside` for what it can and cannot promise.
 */
export function resolveWriteTarget(absPath: string): string {
  return resolveLinks(absPath, 0);
}

/**
 * True when a write to `absPath` really lands inside `base`.
 *
 * Both sides go through `resolveWriteTarget`, because a base is often reached
 * through a link itself — `/var` on macOS, a bind-mounted home, a workspace the
 * user symlinked into place — and comparing a resolved path against an
 * unresolved root would refuse perfectly ordinary writes.
 *
 * This is TOCTOU-bounded, not TOCTOU-free: a path can become a symlink between
 * this returning true and the write happening. Closing that needs `O_NOFOLLOW`
 * on the open itself, which Node does not expose through `writeFile`. Call it
 * as late as possible, immediately before the write.
 */
export function resolvesInside(base: string, absPath: string): boolean {
  const realBase = resolveWriteTarget(base);
  const real = resolveWriteTarget(absPath);
  return real === realBase || real.startsWith(realBase + sep);
}

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
