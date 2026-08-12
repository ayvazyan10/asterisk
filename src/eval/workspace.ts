// Fixture workspaces — a throwaway directory per scenario, plus the plumbing
// that points the tools' workspace guard at it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { _resetWorkspaceForTesting } from '../tools/workspace.ts';

export interface FixtureWorkspace {
  root: string;
  dispose(): Promise<void>;
}

/**
 * Materialises `files` (keyed by workspace-relative path) into a fresh temp
 * directory. Paths that climb out of the workspace are rejected rather than
 * written — a fixture is data, and data from a scenario file should not be able
 * to reach the rest of the disk by writing `../../.bashrc`.
 */
export async function createFixture(
  files: Readonly<Record<string, string>> = {},
): Promise<FixtureWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'asterisk-eval-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = resolve(root, relative);
    // Same containment test the real guard uses (tools/workspace.ts), including
    // the trailing separator — without it "/tmp/ws-evil" reads as inside "/tmp/ws".
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      await rm(root, { recursive: true, force: true });
      throw new Error(`fixture path escapes the workspace: ${relative}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Runs `fn` with the Write/Edit workspace guard pointed at `root`.
 *
 * `workspaceRoot()` caches the root on first read so a mid-turn `chdir` cannot
 * move the goalposts, which means re-pointing it needs the same reset seam the
 * unit tests use. That is the right call here rather than a contract violation:
 * the eval harness *is* a test harness, and the seam's "production code never
 * calls this" means the REPL and the daemon, neither of which this is.
 *
 * The consequence is that the root is process-global while `fn` runs, so
 * scenarios execute one at a time. runSuite enforces that.
 */
export async function withEvalWorkspace<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env['ASTERISK_WORKSPACE'];
  process.env['ASTERISK_WORKSPACE'] = root;
  _resetWorkspaceForTesting();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env['ASTERISK_WORKSPACE'];
    else process.env['ASTERISK_WORKSPACE'] = previous;
    _resetWorkspaceForTesting();
  }
}

/** Substitutes the one runtime value a prompt can need. Kept to a single token
 *  so the prompt stays something a human can read as the user's actual words. */
export function renderPrompt(prompt: string, workspace: string): string {
  return prompt.split('{{workspace}}').join(workspace);
}
