// Where the agent may write — one answer, for both halves of the boundary.
//
// There were two, and they disagreed. `Bash` runs under bubblewrap with the
// workspace and /tmp writable plus anything in `sandbox.writablePaths`.
// `Write` and `Edit` run in-process, where no child-process sandbox reaches
// them, and were bounded by a separate workspace guard that allowed the
// workspace and nothing else.
//
// Both now ask this module, and share the workspace plus everything in
// `sandbox.writablePaths` — one setting, one answer, no drift.
//
// They differ in exactly one place, and the difference is the point rather
// than a leftover: `/tmp` is writable by the shell and not by the file tools.
// The first draft of this module unified them on the grounds that refusing
// `/tmp` to `Write` merely pushed the agent toward `Bash`, which could do it
// anyway. That reasoning was wrong. `touch /tmp/x` is not on the read-only
// allowlist, so the Bash route costs a consent prompt; an ordinary `Write`
// costs nothing.
// Granting the file tools `/tmp` would not have removed an inconsistency, it
// would have removed the approval step that stood in the way — so the shell
// keeps its scratch space and the file tools stay bounded by what the user
// actually named.
//
// Consent for protected writes and secret reads is checked by the registry's
// execution wrapper, using the path classification below. Ordinary workspace
// writes still need no approval; this module also keeps their writable set.
//
// Two things the writable-set check deliberately does not do:
//
//   * It does not confine reading. Read and Bash separately require consent
//     before reading the Asterisk home, which can contain secrets.
//   * It does not make the in-process tools as safe as the sandboxed ones.
//     A path check is a check; bubblewrap is a kernel boundary. Code running
//     in this process can bypass this function by not calling it. What is
//     shared here is the policy, not the enforcement strength.
//
// One thing it emphatically does do, since it did not before: resolve
// symlinks. `resolve()` is pure string arithmetic and `writeFile` is not, so a
// link inside the workspace — the kind that arrives with any cloned repository
// — made "inside the writable set" mean nothing at all. `link -> ~/.ssh` plus
// a Write to `<workspace>/link/authorized_keys` passed this check and landed in
// the real `~/.ssh`. The sandbox does not cover that: Write and Edit run in
// this process, as the note above says. `resolvesInside` is the answer, shared
// with the panel's content and skills endpoints, which had the same hole.

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { loadConfig } from '../config/load.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { PROJECT_ROOT } from '../daemon/project-root.ts';
import { resolveWriteTarget, resolvesInside } from '../utils/fs-safe.ts';
import { normaliseWritablePaths } from './sandbox-profiles.ts';
import { workspaceRoot } from './workspace.ts';

/** Set when the user has turned the in-process guard off entirely. */
export function inProcessGuardDisabled(): boolean {
  return process.env['ASTERISK_NO_WORKSPACE_GUARD'] === '1';
}

/**
 * Scratch space the sandboxed shell gets on top of the shared set.
 *
 * World-writable on any Unix, so confining the shell to it protects nothing
 * and breaks every workflow using `mktemp` across two commands — and a shell
 * command reaching for it has already passed the permission gate.
 */
const SHELL_SCRATCH = ['/tmp'];

/** Paths named in configuration, shared by both scopes. */
function configuredPaths(): readonly string[] {
  try {
    return loadConfig().config.sandbox.writablePaths;
  } catch {
    // Unreadable configuration falls back to the built-in set rather than to
    // an empty one: an agent that cannot write to its own workspace is not a
    // safer agent, it is a broken one.
    return [];
  }
}

/**
 * Every path the given scope may write to, absolute and de-duplicated.
 *
 * `shell` adds `/tmp`; `file-tools` does not. See the header for why that is
 * deliberate rather than an oversight.
 */
export function writablePaths(scope: 'file-tools' | 'shell' = 'file-tools'): string[] {
  const extra = scope === 'shell' ? SHELL_SCRATCH : [];
  return normaliseWritablePaths([workspaceRoot(), ...extra, ...configuredPaths()]);
}

/**
 * True when `absPath` sits inside one of the writable roots, as a string.
 *
 * Lexical on purpose — it answers "does this path spell out something inside a
 * root", which is the question the refusal message needs in order to tell a
 * path that was never allowed from one that was allowed until a symlink was
 * followed. `checkWritable` is the function that decides.
 */
export function isWritablePath(
  absPath: string,
  roots: readonly string[] = writablePaths(),
): boolean {
  return roots.some((root) => absPath === root || absPath.startsWith(root + sep));
}

/** Includes the default home even with an override: it can still hold secrets.
 *  Check both the spelling and the destination, including dangling symlinks. */
export function isAsteriskHomePath(rawPath: string): boolean {
  const abs = resolve(rawPath);
  const roots = [resolve(asteriskPaths().root), join(homedir(), '.asterisk')];
  return isWritablePath(abs, roots) || roots.some((root) => resolvesInside(root, abs));
}

/** Sensitive write targets require consent even inside a writable workspace. */
export function protectedWriteReason(rawPath: string): string | null {
  const abs = resolve(rawPath);
  const paths = [abs, resolveWriteTarget(abs)];
  if (paths.some((path) => /(?:^|\/)\.git\/(?:config$|hooks(?:\/|$))/.test(path))) {
    return 'Git configuration and hooks can execute commands';
  }
  if (isAsteriskHomePath(abs)) return 'the Asterisk home holds secrets and permission grants';
  if (isWritablePath(abs, [PROJECT_ROOT]) || resolvesInside(PROJECT_ROOT, abs)) {
    return 'the Asterisk install directory contains the running assistant';
  }
  return null;
}

/**
 * True when a write to `absPath` lands inside a writable root for real, with
 * every symlink on the way followed the way `writeFile` will follow it.
 */
function landsInsideWritable(absPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => resolvesInside(root, absPath));
}

/**
 * Returns an error message when `rawPath` may not be written, or null.
 *
 * The message names the roots, because "refused" without them leaves the agent
 * guessing and the usual next move is to try again somewhere equally wrong. A
 * path that only escaped via a symlink is called out separately: "outside the
 * writable set" is baffling advice for a path that visibly starts with the
 * workspace, and the agent's next move would be to try the same thing again.
 *
 * The check is deliberately as late as this module can put it, but the tools
 * call it before their own `mkdir`/`writeFile`, so a path that becomes a
 * symlink in between is still not covered. See `resolvesInside`.
 */
export function checkWritable(rawPath: string): string | null {
  if (inProcessGuardDisabled()) return null;

  const abs = resolve(rawPath);
  const roots = writablePaths();
  if (landsInsideWritable(abs, roots)) return null;

  const escaped = isWritablePath(abs, roots)
    ? [`refused: ${abs} resolves to ${resolveWriteTarget(abs)} through a symlink,`, 'which is']
    : [`refused: ${abs} is`];

  return [
    ...escaped,
    'outside the writable set.',
    `Writable: ${roots.join(', ')}.`,
    'Ask the user to re-run from the right directory, add the path to',
    'sandbox.writablePaths, or export ASTERISK_NO_WORKSPACE_GUARD=1 — which',
    'disables this check for the in-process file tools only; Bash stays',
    'confined by the sandbox and still needs approval to run.',
  ].join(' ');
}
