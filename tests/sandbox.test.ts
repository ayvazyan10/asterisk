// The sandbox confines what a command can change once it is allowed to run.
//
// Two layers here. The profile builders are pure and always tested. The
// containment tests actually spawn a sandboxed process and are skipped where
// no backend exists — a skip is honest, whereas asserting confinement on a
// machine that cannot confine would be a test that passes by not running.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import {
  type SandboxPolicy,
  bubblewrapArgs,
  normaliseWritablePaths,
  seatbeltProfile,
} from '../src/tools/sandbox-profiles.ts';
import { defaultWritablePaths, sandboxStatus, wrapCommand } from '../src/tools/sandbox.ts';

const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  writablePaths: ['/work'],
  network: true,
  cwd: '/work',
  ...over,
});

describe('normaliseWritablePaths', () => {
  it('resolves, sorts and de-duplicates', () => {
    expect(normaliseWritablePaths(['/b', '/a', '/a', '/c/../a'])).toEqual(['/a', '/b']);
  });

  it('drops blanks', () => {
    expect(normaliseWritablePaths(['', '   ', '/a'])).toEqual(['/a']);
  });

  it('refuses to make the root writable', () => {
    // A blank or mistyped config value must not quietly turn the sandbox into
    // an elaborate no-op.
    expect(normaliseWritablePaths(['/'])).toEqual([]);
    expect(normaliseWritablePaths(['/', '/work'])).toEqual(['/work']);
  });
});

describe('bubblewrapArgs', () => {
  it('binds the filesystem read-only before punching writable holes', () => {
    const args = bubblewrapArgs(policy(), 'echo hi');
    const roIndex = args.indexOf('--ro-bind');
    const bindIndex = args.indexOf('--bind');
    expect(roIndex).toBeGreaterThanOrEqual(0);
    expect(bindIndex).toBeGreaterThan(roIndex);
    // Reversed, everything would stay read-only and nothing would work.
    expect(args.slice(roIndex, roIndex + 3)).toEqual(['--ro-bind', '/', '/']);
  });

  it('makes each writable path writable', () => {
    const args = bubblewrapArgs(policy({ writablePaths: ['/work', '/tmp'] }), 'echo hi');
    expect(args.join(' ')).toContain('--bind /tmp /tmp');
    expect(args.join(' ')).toContain('--bind /work /work');
  });

  it('gives the command a private /dev and /proc', () => {
    // The host /proc would expose every other process on the machine.
    const args = bubblewrapArgs(policy(), 'echo hi');
    expect(args).toContain('--proc');
    expect(args).toContain('--dev');
  });

  it('unshares the network only when the policy denies it', () => {
    expect(bubblewrapArgs(policy({ network: true }), 'x')).not.toContain('--unshare-net');
    expect(bubblewrapArgs(policy({ network: false }), 'x')).toContain('--unshare-net');
  });

  it('dies with its parent so an aborted turn leaves nothing running', () => {
    expect(bubblewrapArgs(policy(), 'x')).toContain('--die-with-parent');
  });

  it('passes the command through bash as the final argument', () => {
    const args = bubblewrapArgs(policy(), 'echo "hi there"');
    expect(args.slice(-3)).toEqual(['bash', '-lc', 'echo "hi there"']);
    // Everything before `--` is bubblewrap's; nothing of the command leaks in.
    expect(args.indexOf('--')).toBe(args.length - 4);
  });
});

describe('seatbeltProfile', () => {
  it('denies by default and allows reads', () => {
    const profile = seatbeltProfile(policy());
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
  });

  it('allows writes only under the writable subpaths', () => {
    const profile = seatbeltProfile(policy({ writablePaths: ['/work'] }));
    expect(profile).toContain('(allow file-write* (subpath "/work"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/"))');
  });

  it('reflects the network policy', () => {
    expect(seatbeltProfile(policy({ network: false }))).toContain('(deny network*)');
    expect(seatbeltProfile(policy({ network: true }))).toContain('(allow network*)');
  });

  it('escapes quotes in paths rather than breaking out of the literal', () => {
    const profile = seatbeltProfile(policy({ writablePaths: ['/we"ird'] }));
    expect(profile).toContain('\\"');
  });
});

describe('defaultWritablePaths', () => {
  it('covers the workspace and /tmp, and nothing else', () => {
    const paths = defaultWritablePaths();
    expect(paths).toContain('/tmp');
    expect(paths.length).toBe(2);
  });

  it('leaves ~/.asterisk read-only', () => {
    // The agent writes its database in-process, outside the sandbox. Keeping
    // it read-only here means a shell command cannot rewrite the secret store
    // or the permission grants that let it run.
    const home = process.env['ASTERISK_HOME'];
    if (home) expect(defaultWritablePaths()).not.toContain(home);
  });
});

// --- real containment -------------------------------------------------------

const status = await sandboxStatus();
const confined = status.backend !== 'none';
const describeConfined = confined ? describe : describe.skip;

describe('sandbox detection', () => {
  it('explains its choice either way', () => {
    expect(status.reason).toBeTruthy();
    expect(['bubblewrap', 'seatbelt', 'none']).toContain(status.backend);
  });

  it('only reports a backend it has probed', () => {
    // The probe is the whole point: a sandbox that silently does not sandbox
    // is worse than none, because it moves the user from cautious to confident.
    if (confined) expect(status.reason).toContain('probe');
  });
});

describeConfined(`containment via ${status.backend}`, () => {
  const outside = mkdtempSync(join(tmpdir(), 'asterisk-sbtest-'));
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  async function run(command: string, over: Partial<SandboxPolicy> = {}) {
    const wrapped = await wrapCommand(command, {
      writablePaths: [process.cwd()],
      network: false,
      cwd: process.cwd(),
      ...over,
    });
    try {
      return await execa(wrapped.file, wrapped.args, {
        reject: false,
        all: true,
        timeout: 20_000,
      });
    } finally {
      wrapped.cleanup?.();
    }
  }

  it('still lets a command read the filesystem', async () => {
    const r = await run('head -c 20 package.json');
    expect(r.exitCode).toBe(0);
  });

  it('lets a command write inside the writable set', async () => {
    const r = await run('touch ./.sandbox-write-probe && rm -f ./.sandbox-write-probe');
    expect(r.exitCode).toBe(0);
  });

  it('refuses a write outside the writable set', async () => {
    const target = join(outside, 'breach');
    const r = await run(`touch ${JSON.stringify(target)}`);
    expect(r.exitCode).not.toBe(0);
    expect(String(r.all)).toMatch(/read-only|not permitted|denied/i);
  });

  it('refuses a write to a system path', async () => {
    const r = await run('touch /etc/asterisk-breach');
    expect(r.exitCode).not.toBe(0);
  });

  it('blocks the network when the policy denies it', async () => {
    const r = await run('getent hosts github.com', { network: false });
    expect(r.exitCode).not.toBe(0);
  });
});
