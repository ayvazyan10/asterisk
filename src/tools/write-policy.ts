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
// allowlist, so the Bash route costs a consent prompt; `Write` costs nothing.
// Granting the file tools `/tmp` would not have removed an inconsistency, it
// would have removed the approval step that stood in the way — so the shell
// keeps its scratch space and the file tools stay bounded by what the user
// actually named.
//
// Two things this deliberately does not do:
//
//   * It does not restrict reading. The sandbox does not either — it confines
//     what a command can change, not what it can see — and a read policy that
//     disagreed with the sandbox would reintroduce exactly the split this
//     module exists to remove.
//   * It does not make the in-process tools as safe as the sandboxed ones.
//     A path check is a check; bubblewrap is a kernel boundary. Code running
//     in this process can bypass this function by not calling it. What is
//     shared here is the policy, not the enforcement strength.

import { resolve, sep } from 'node:path';

import { loadConfig } from '../config/load.ts';
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

/** True when `absPath` sits inside one of the writable roots. */
export function isWritablePath(
  absPath: string,
  roots: readonly string[] = writablePaths(),
): boolean {
  return roots.some((root) => absPath === root || absPath.startsWith(root + sep));
}

/**
 * Returns an error message when `rawPath` may not be written, or null.
 *
 * The message names the roots, because "refused" without them leaves the agent
 * guessing and the usual next move is to try again somewhere equally wrong.
 */
export function checkWritable(rawPath: string): string | null {
  if (inProcessGuardDisabled()) return null;

  const abs = resolve(rawPath);
  const roots = writablePaths();
  if (isWritablePath(abs, roots)) return null;

  return [
    `refused: ${abs} is outside the writable set.`,
    `Writable: ${roots.join(', ')}.`,
    'Ask the user to re-run from the right directory, add the path to',
    'sandbox.writablePaths, or export ASTERISK_NO_WORKSPACE_GUARD=1 — which',
    'disables this check for the in-process file tools only; Bash stays',
    'confined by the sandbox and still needs approval to run.',
  ].join(' ');
}
