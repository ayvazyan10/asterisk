// Workspace boundary guard. Edit / Write refuse to touch files outside
// the workspace root unless the user opts out via ASTERISK_NO_WORKSPACE_GUARD=1.
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
  cachedRoot = resolve(env && env.trim() ? env.trim() : process.cwd());
  return cachedRoot;
}

/** Test-only: reset the cached root. Production code never calls this. */
export function _resetWorkspaceForTesting(): void {
  cachedRoot = null;
}

export function isInsideWorkspace(absPath: string): boolean {
  const root = workspaceRoot();
  if (absPath === root) return true;
  return absPath.startsWith(root + sep);
}

/** Throws ToolResult-shaped err message string when the path is outside
 *  the workspace root. Returns null when allowed (inside the workspace
 *  or guard disabled). Keeps the call site terse. */
export function checkWorkspaceWritable(rawPath: string): string | null {
  // Opt-out for power users / scripts that legitimately need to write
  // outside (e.g. installer flows). Default is enforced.
  if (process.env['ASTERISK_NO_WORKSPACE_GUARD'] === '1') return null;
  const abs = resolve(rawPath);
  if (isInsideWorkspace(abs)) return null;
  const root = workspaceRoot();
  return [
    `refused: ${abs} is outside the workspace (${root}).`,
    'The agent does not write outside its workspace by default. If this',
    'was intentional, ask the user to (a) re-run from the right cwd,',
    '(b) cd into the right directory, or (c) export ASTERISK_NO_WORKSPACE_GUARD=1',
    'to disable this check globally.',
  ].join(' ');
}
