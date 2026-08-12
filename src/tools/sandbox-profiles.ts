// Argument and profile construction for the sandbox backends.
//
// Pure on purpose: building the argv is where the security-relevant decisions
// live (what is read-only, what is writable, whether the network is reachable),
// and it must be testable without bubblewrap or macOS present.

import { resolve } from 'node:path';

export type SandboxBackend = 'bubblewrap' | 'seatbelt' | 'none';

export interface SandboxPolicy {
  /** Absolute paths the command may write to. Everything else is read-only. */
  writablePaths: readonly string[];
  /** Whether the command can reach the network. */
  network: boolean;
  /** Directory the command starts in. */
  cwd: string;
}

/** Normalises and de-duplicates the writable set, dropping anything unsafe. */
export function normaliseWritablePaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const abs = resolve(trimmed);
    // Making `/` writable would turn the sandbox into an elaborate no-op, and
    // it is an easy thing to end up with by mistake from a blank config value.
    if (abs === '/') continue;
    out.add(abs);
  }
  return [...out].sort();
}

/**
 * bubblewrap argv for running `command` under `policy`.
 *
 * Order matters: `--ro-bind / /` lays down the whole filesystem read-only, and
 * the per-path `--bind` calls after it punch writable holes. Reversing them
 * would leave everything read-only.
 */
export function bubblewrapArgs(policy: SandboxPolicy, command: string): string[] {
  const args = [
    '--ro-bind',
    '/',
    '/',
    // Fresh /dev and /proc rather than the host's: the host /proc exposes
    // every other process on the machine.
    '--dev',
    '/dev',
    '--proc',
    '/proc',
  ];

  for (const path of normaliseWritablePaths(policy.writablePaths)) {
    // --bind rather than --bind-try: a writable path that does not exist is a
    // misconfiguration worth failing loudly on, not one to paper over.
    args.push('--bind', path, path);
  }

  args.push(
    '--chdir',
    policy.cwd,
    '--unshare-pid',
    // Without this a sandboxed process outlives the agent when the turn is
    // aborted, which is how you end up with orphaned builds.
    '--die-with-parent',
    '--new-session',
  );

  if (!policy.network) args.push('--unshare-net');

  args.push('--', 'bash', '-lc', command);
  return args;
}

/**
 * A seatbelt profile for macOS `sandbox-exec`.
 *
 * Untested on this project's CI, which is Linux-only — which is exactly why
 * `sandbox.ts` probes every backend before trusting it rather than assuming
 * the profile does what it reads like it does.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    // Writing to a terminal, /dev/null and the like has to keep working or
    // nothing can report its own output.
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
  ];

  for (const path of normaliseWritablePaths(policy.writablePaths)) {
    lines.push(`(allow file-write* (subpath ${quoteScheme(path)}))`);
  }

  lines.push(policy.network ? '(allow network*)' : '(deny network*)');
  return `${lines.join('\n')}\n`;
}

/** Quotes a path for a seatbelt profile, which uses Scheme string literals. */
function quoteScheme(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
