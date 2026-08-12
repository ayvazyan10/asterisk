// Sandbox backend selection, verification, and command wrapping.
//
// The permission gate in bash-gate.ts decides *whether* a command runs. This
// decides what it can reach once it does. The two are independent: an approved
// command is still confined, and a read-only allowlisted command is still
// confined, because "allowlisted" is a statement about intent and this is a
// statement about capability.
//
// The load-bearing idea here is that a backend is not trusted until it has
// proved itself. `verifyBackend` runs a probe that tries to write somewhere it
// must not be able to, and rejects the backend unless the write fails. A
// sandbox that silently does not sandbox is worse than none at all — it moves
// the user from cautious to confident without moving the security — and the
// macOS profile in particular cannot be exercised by this project's CI, which
// is Linux-only. Probing turns "we believe this works" into "this machine has
// demonstrated it works".

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import {
  type SandboxBackend,
  type SandboxPolicy,
  bubblewrapArgs,
  normaliseWritablePaths,
  seatbeltProfile,
} from './sandbox-profiles.ts';
import { workspaceRoot } from './workspace.ts';

export type { SandboxBackend, SandboxPolicy } from './sandbox-profiles.ts';

export interface WrappedCommand {
  file: string;
  args: string[];
  backend: SandboxBackend;
  /** Cleanup for any temporary profile written to disk. */
  cleanup?: () => void;
}

export interface SandboxStatus {
  backend: SandboxBackend;
  /** Plain-language account of why this backend, for `/doctor`. */
  reason: string;
}

const PROBE_TIMEOUT_MS = 10_000;

let cachedStatus: SandboxStatus | null = null;

/** Test-only: forget the probe result so a different environment is re-detected. */
export function _resetSandboxForTesting(): void {
  cachedStatus = null;
}

/**
 * The writable set a command gets unless configuration overrides it.
 *
 * Deliberately short. `~/.asterisk` is *not* in it: the agent writes its
 * database, outputs and file history in-process, outside the sandbox, so a
 * shell command has no reason to write there — and leaving it read-only means
 * a command cannot rewrite the secret store or the permission grants that
 * decided it was allowed to run.
 *
 * Reads are not restricted. This confines what a command can change, not what
 * it can see; see the sandbox section of the README.
 */
export function defaultWritablePaths(): string[] {
  return normaliseWritablePaths([
    workspaceRoot(),
    // Already world-writable on any Unix, so confining it buys nothing and
    // breaks every workflow that uses mktemp across two commands.
    '/tmp',
  ]);
}

async function binaryExists(file: string): Promise<boolean> {
  try {
    const r = await execa('command', ['-v', file], { shell: true, reject: false, timeout: 5000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Runs two probes through `backend` and reports whether it is usable.
 *
 * Both halves are required, and the positive one is not decoration. A backend
 * that cannot start at all fails every command, including the write that is
 * supposed to be refused — so a negative-only probe reads total breakage as
 * perfect confinement. That is not hypothetical: GitHub's runners have
 * bubblewrap installed but cannot create user namespaces, so every invocation
 * dies with "setting up uid map: Permission denied", and the earlier probe
 * cheerfully certified it.
 */
async function verifyBackend(backend: Exclude<SandboxBackend, 'none'>): Promise<boolean> {
  const outside = mkdtempSync(join(tmpdir(), 'asterisk-probe-'));
  const policy: SandboxPolicy = {
    // Deliberately excludes `outside`, and excludes /tmp so the probe target is
    // genuinely off-limits rather than caught by the usual /tmp bind.
    writablePaths: [workspaceRoot()],
    network: false,
    cwd: workspaceRoot(),
  };

  const run = async (command: string): Promise<number | null> => {
    const wrapped = wrapWithBackend(backend, policy, command);
    try {
      const result = await execa(wrapped.file, wrapped.args, {
        reject: false,
        timeout: PROBE_TIMEOUT_MS,
      });
      return result.exitCode ?? null;
    } finally {
      wrapped.cleanup?.();
    }
  };

  try {
    // Positive control: the backend can run something harmless.
    if ((await run('exit 0')) !== 0) return false;
    // Negative control: a write outside the writable set is refused.
    if ((await run(`touch ${JSON.stringify(join(outside, 'breach'))}`)) === 0) return false;
    return true;
  } catch {
    return false;
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

/**
 * Picks a backend for this machine and proves it works. Cached: the probe
 * spawns a process, and the answer cannot change within one run.
 */
export async function sandboxStatus(): Promise<SandboxStatus> {
  if (cachedStatus) return cachedStatus;

  const candidates: Array<{ backend: Exclude<SandboxBackend, 'none'>; binary: string }> =
    process.platform === 'darwin'
      ? [{ backend: 'seatbelt', binary: 'sandbox-exec' }]
      : [{ backend: 'bubblewrap', binary: 'bwrap' }];

  for (const { backend, binary } of candidates) {
    if (!(await binaryExists(binary))) {
      cachedStatus = {
        backend: 'none',
        reason: `${binary} is not installed, so commands run unconfined`,
      };
      return cachedStatus;
    }
    if (!(await verifyBackend(backend))) {
      cachedStatus = {
        backend: 'none',
        reason: `${binary} is installed but failed a containment probe on this machine, so it is not being trusted`,
      };
      return cachedStatus;
    }
    cachedStatus = { backend, reason: `${binary} passed a containment probe` };
    return cachedStatus;
  }

  cachedStatus = {
    backend: 'none',
    reason: `no sandbox backend exists for ${process.platform}`,
  };
  return cachedStatus;
}

/** Builds the wrapped invocation for a known-good backend. */
function wrapWithBackend(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  command: string,
): WrappedCommand {
  if (backend === 'bubblewrap') {
    return { file: 'bwrap', args: bubblewrapArgs(policy, command), backend };
  }

  if (backend === 'seatbelt') {
    const dir = mkdtempSync(join(tmpdir(), 'asterisk-sb-'));
    const file = join(dir, 'profile.sb');
    writeFileSync(file, seatbeltProfile(policy), { mode: 0o600 });
    return {
      file: 'sandbox-exec',
      args: ['-f', file, 'bash', '-lc', command],
      backend,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  return { file: 'bash', args: ['-lc', command], backend: 'none' };
}

/**
 * Wraps `command` for execution under the active backend.
 *
 * Callers run `file` with `args` exactly as they would have run bash, and must
 * call `cleanup` when the process has exited.
 */
export async function wrapCommand(command: string, policy: SandboxPolicy): Promise<WrappedCommand> {
  const status = await sandboxStatus();
  return wrapWithBackend(status.backend, policy, command);
}
