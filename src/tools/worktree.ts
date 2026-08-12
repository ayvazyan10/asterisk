// Git worktree tools — let the agent create/remove an isolated checkout so
// risky changes can be tried in a parallel worktree without touching the
// active branch. Active worktree path is tracked module-level for the
// session; the agent should `cd` into it via Bash.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { currentSessionId } from '../agent/context.ts';
import { type Tool, err, ok } from './types.ts';

interface ActiveWorktree {
  path: string;
  branch: string;
  createdAt: number;
}

const worktreesBySession = new Map<string, ActiveWorktree>();

function getActive(): ActiveWorktree | null {
  return worktreesBySession.get(currentSessionId()) ?? null;
}

function setActive(w: ActiveWorktree | null): void {
  const sid = currentSessionId();
  if (w) worktreesBySession.set(sid, w);
  else worktreesBySession.delete(sid);
}

export function activeWorktree(): ActiveWorktree | null {
  return getActive();
}

const DEFAULT_ROOT = join(
  process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'),
  'worktrees',
);

export const enterWorktreeTool: Tool = {
  name: 'EnterWorktree',
  description:
    'Create a git worktree for an isolated checkout. Defaults: branch = "asterisk/<timestamp>", path = ~/.asterisk/worktrees/<branch>. Agent should `cd` into the returned path with Bash to do work.',
  input_schema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
        description: 'Branch name. Created from current HEAD if it does not exist.',
      },
      path: {
        type: 'string',
        description: 'Worktree path (default ~/.asterisk/worktrees/<branch>).',
      },
      base: {
        type: 'string',
        description: 'Base ref the new branch is created from (default HEAD).',
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const current = getActive();
    if (current) {
      return err(`already in worktree at ${current.path} (call ExitWorktree first)`);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const branch =
      typeof input['branch'] === 'string' && input['branch'].trim()
        ? input['branch'].trim()
        : `asterisk/${ts}`;
    const path =
      typeof input['path'] === 'string' && input['path'].trim()
        ? input['path'].trim()
        : join(DEFAULT_ROOT, branch.replace(/[^a-zA-Z0-9_./-]/g, '_'));
    const base =
      typeof input['base'] === 'string' && input['base'].trim() ? input['base'].trim() : 'HEAD';

    try {
      const { mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(path), { recursive: true });

      // -B: create or reset the branch from `base`. Quietly succeed if branch
      // already exists (and reuses it); otherwise creates fresh.
      const result = await execa('git', ['worktree', 'add', '-B', branch, path, base], {
        reject: false,
        encoding: 'utf8',
      });
      if (result.exitCode !== 0) {
        return err(
          `git worktree add failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        );
      }

      setActive({ path, branch, createdAt: Date.now() });
      return ok(
        [
          '✓ worktree ready',
          `  path:   ${path}`,
          `  branch: ${branch}`,
          `  base:   ${base}`,
          '',
          `Run subsequent commands with \`cd ${path} && …\` via Bash.`,
        ].join('\n'),
      );
    } catch (e) {
      return err(`EnterWorktree failed: ${(e as Error).message}`);
    }
  },
};

export const exitWorktreeTool: Tool = {
  name: 'ExitWorktree',
  description:
    'Remove the active worktree (created by EnterWorktree). Refuses if there are uncommitted changes unless force=true.',
  input_schema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Pass --force to git worktree remove (default false).',
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const current = getActive();
    if (!current) return err('no active worktree');
    const force = input['force'] === true;
    try {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push(current.path);
      const result = await execa('git', args, { reject: false, encoding: 'utf8' });
      if (result.exitCode !== 0) {
        return err(
          `git worktree remove failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        );
      }
      setActive(null);
      return ok(`✓ worktree removed · ${current.path} (branch ${current.branch})`);
    } catch (e) {
      return err(`ExitWorktree failed: ${(e as Error).message}`);
    }
  },
};

export const WORKTREE_TOOLS: Tool[] = [enterWorktreeTool, exitWorktreeTool];
