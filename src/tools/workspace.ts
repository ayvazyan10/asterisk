// The workspace root, and what "inside it" means.
//
// The write check that used to live here moved to write-policy.ts, which is
// now the single answer for both the in-process file tools and the sandboxed
// shell. They were two policies that disagreed — the shell could write /tmp
// and Write/Edit could not — and the disagreement pushed the agent toward
// Bash, the more capable tool. This module keeps only the root itself, which
// plenty of other code needs.
//
// Why: agents sometimes go off-prompt and start modifying files in
// unrelated directories (notably Asterisk's own installed source under
// ~/.local/share/asterisk or /home/<user>/projects/asterisk). The guard
// prevents that without changing the model's behaviour — it just refuses
// the call with a clear error so the agent can re-route.

import { resolve, sep } from 'node:path';

let cachedRoot: string | null = null;

/** The workspace root is the cwd at process start (or ASTERISK_WORKSPACE
 *  if set explicitly). Cached so a process.chdir() mid-turn can't move
 *  the goalposts under the agent. */
export function workspaceRoot(): string {
  if (cachedRoot !== null) return cachedRoot;
  const env = process.env['ASTERISK_WORKSPACE'];
  cachedRoot = resolve(env?.trim() ? env.trim() : process.cwd());
  return cachedRoot;
}

/**
 * Drops the cached root so the next call re-reads `ASTERISK_WORKSPACE`.
 *
 * Was documented as test-only, which stopped being true when the eval harness
 * started calling it: `asterisk eval` ships in `dist/eval.js` and re-points the
 * guard at a temp fixture. The `_` prefix stays as a warning — the REPL, the
 * daemon and the bots must never call this, because moving the boundary
 * mid-conversation would silently widen where the agent may write.
 */
export function _resetWorkspaceForTesting(): void {
  cachedRoot = null;
}

export function isInsideWorkspace(absPath: string): boolean {
  const root = workspaceRoot();
  if (absPath === root) return true;
  return absPath.startsWith(root + sep);
}
