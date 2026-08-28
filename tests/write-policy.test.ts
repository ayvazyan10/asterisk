// One writable set for both halves of the boundary.
//
// There used to be two, built separately, and `sandbox.writablePaths` governed
// only one of them — so a user who widened the boundary for the shell was
// silently not widening it for `Write` and `Edit`. They share one module now.
//
// They still differ on `/tmp`, and that is the deliberate part these tests
// pin. The first attempt removed the difference on the grounds that refusing
// `/tmp` to `Write` only pushed the agent to `Bash`. That reasoning was wrong:
// `touch /tmp/x` is off the read-only allowlist, so the Bash route costs an
// approval prompt and `Write` costs nothing. Unifying would have deleted a
// consent step rather than an inconsistency.

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import { editTool } from '../src/tools/edit.ts';
import { defaultWritablePaths } from '../src/tools/sandbox.ts';
import { _resetWorkspaceForTesting, workspaceRoot } from '../src/tools/workspace.ts';
import { checkWritable, isWritablePath, writablePaths } from '../src/tools/write-policy.ts';
import { writeTool } from '../src/tools/write.ts';

let home: string;
let workspace: string;
let prevHome: string | undefined;
let prevWorkspace: string | undefined;
let prevGuard: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-wp-home-'));
  workspace = await mkdtemp(join(tmpdir(), 'asterisk-wp-ws-'));
  prevHome = process.env['ASTERISK_HOME'];
  prevWorkspace = process.env['ASTERISK_WORKSPACE'];
  prevGuard = process.env['ASTERISK_NO_WORKSPACE_GUARD'];
  process.env['ASTERISK_HOME'] = home;
  process.env['ASTERISK_WORKSPACE'] = workspace;
  delete process.env['ASTERISK_NO_WORKSPACE_GUARD'];
  _resetWorkspaceForTesting();
});

afterEach(async () => {
  closeDb();
  for (const [key, value] of [
    ['ASTERISK_HOME', prevHome],
    ['ASTERISK_WORKSPACE', prevWorkspace],
    ['ASTERISK_NO_WORKSPACE_GUARD', prevGuard],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetWorkspaceForTesting();
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function withWritablePaths(paths: string[]): void {
  const config = ConfigSchema.parse({});
  saveConfig({ ...config, sandbox: { ...config.sandbox, writablePaths: paths } });
}

describe('writablePaths', () => {
  it('covers the workspace for the file tools', () => {
    expect(writablePaths('file-tools')).toContain(workspaceRoot());
  });

  it('gives the shell /tmp and the file tools none', () => {
    // Not an oversight. `touch /tmp/x` is off the read-only allowlist, so the
    // shell route costs an approval prompt; Write costs nothing. Handing /tmp
    // to the file tools would delete that consent step, not remove an
    // inconsistency.
    expect(writablePaths('shell')).toContain('/tmp');
    expect(writablePaths('file-tools')).not.toContain('/tmp');
  });

  it('honours sandbox.writablePaths, so one setting governs both halves', () => {
    withWritablePaths(['/opt/shared']);
    expect(writablePaths()).toContain('/opt/shared');
  });

  it('never lets configuration make the root writable', () => {
    // A blank or mistyped value must not quietly turn the boundary off.
    withWritablePaths(['/']);
    expect(writablePaths()).not.toContain('/');
  });

  it('de-duplicates a path already covered by the defaults', () => {
    withWritablePaths(['/tmp']);
    expect(writablePaths('shell').filter((p) => p === '/tmp')).toHaveLength(1);
  });
});

describe('the two halves agree', () => {
  it('gives the sandbox the shell scope, exactly', () => {
    withWritablePaths(['/opt/shared']);
    expect(defaultWritablePaths()).toEqual(writablePaths('shell'));
  });

  it('shares every configured path between the two scopes', () => {
    // The part that must not drift: one setting governs both. Only /tmp is
    // allowed to differ.
    withWritablePaths(['/opt/one', '/opt/two']);
    const shell = writablePaths('shell');
    for (const path of writablePaths('file-tools')) expect(shell).toContain(path);
    expect(shell.filter((p) => !writablePaths('file-tools').includes(p))).toEqual(['/tmp']);
  });
});

describe('checkWritable', () => {
  it('allows a path inside the workspace', () => {
    expect(checkWritable(join(workspace, 'src', 'a.ts'))).toBeNull();
  });

  it('allows the workspace root itself', () => {
    expect(checkWritable(workspace)).toBeNull();
  });

  it('still refuses /tmp to the file tools', () => {
    // The shell gets it; Write does not, because Write has no approval step in
    // front of it.
    expect(checkWritable('/tmp/scratch.txt')).not.toBeNull();
  });

  it('refuses a path outside every writable root', () => {
    const message = checkWritable('/etc/passwd');
    expect(message).not.toBeNull();
    expect(message).toContain('/etc/passwd');
  });

  it('names the writable roots in the refusal', () => {
    // "Refused" with no roots leaves the agent guessing, and the usual next
    // move is to try somewhere equally wrong.
    const message = checkWritable('/etc/passwd') ?? '';
    expect(message).toContain(workspaceRoot());
    expect(message).toContain('sandbox.writablePaths');
  });

  it('is not fooled by traversal back out of the workspace', () => {
    expect(checkWritable(join(workspace, '..', '..', 'etc', 'x.ts'))).not.toBeNull();
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    // `${root}-other` starts with the root as a string but is a different
    // directory — a prefix check without the separator would allow it.
    expect(isWritablePath('/work-other/x.ts', ['/work'])).toBe(false);
    expect(isWritablePath('/work/x.ts', ['/work'])).toBe(true);
  });

  it('allows a configured path', () => {
    withWritablePaths([home]);
    expect(checkWritable(join(home, 'notes.md'))).toBeNull();
  });

  it('is disabled by ASTERISK_NO_WORKSPACE_GUARD, for the file tools only', () => {
    process.env['ASTERISK_NO_WORKSPACE_GUARD'] = '1';
    expect(checkWritable('/etc/passwd')).toBeNull();
    // The escape hatch is in-process only; the sandbox's set is unchanged, so
    // Bash stays confined.
    expect(writablePaths()).not.toContain('/etc');
  });
});

// The hole these close: `resolve()` is string arithmetic and `writeFile` is
// not. A symlink inside the workspace — the kind any cloned repository can
// bring with it — made "the path starts with the workspace" mean nothing, and
// Write/Edit run in this process where no sandbox is watching.
describe('symlinks out of the workspace', () => {
  it('refuses a write that leaves the workspace through a symlink', async () => {
    await mkdir(join(home, 'ssh'), { recursive: true });
    await symlink(join(home, 'ssh'), join(workspace, 'link'));

    const message = checkWritable(join(workspace, 'link', 'authorized_keys'));
    expect(message).not.toBeNull();
    // "outside the writable set" alone is baffling advice for a path that
    // visibly starts with the workspace, so the refusal says what happened.
    expect(message).toContain('symlink');
    expect(message).toContain('resolves to');
  });

  it('refuses a write through a dangling symlink', async () => {
    // The target does not exist yet, which is what an existsSync-based check
    // reports as "nothing there" while writeFile happily creates it.
    await symlink(join(home, 'pwned.md'), join(workspace, 'evil.md'));
    expect(checkWritable(join(workspace, 'evil.md'))).not.toBeNull();
  });

  it('refuses a write through a symlinked directory that does not exist yet', async () => {
    await symlink(join(home, 'nowhere'), join(workspace, 'out'));
    expect(checkWritable(join(workspace, 'out', 'notes.md'))).not.toBeNull();
  });

  it('allows a symlink that stays inside the workspace', async () => {
    await mkdir(join(workspace, 'real'), { recursive: true });
    await symlink(join(workspace, 'real'), join(workspace, 'alias'));
    expect(checkWritable(join(workspace, 'alias', 'a.ts'))).toBeNull();
  });

  it('still allows a file that does not exist yet, at any depth', () => {
    expect(checkWritable(join(workspace, 'a', 'b', 'c', 'new.ts'))).toBeNull();
  });

  it('stops Write and Edit themselves, not only the policy function', async () => {
    await mkdir(join(home, 'ssh'), { recursive: true });
    await symlink(join(home, 'ssh'), join(workspace, 'link'));
    const target = join(workspace, 'link', 'authorized_keys');

    const written = await writeTool.execute({ path: target, content: 'ssh-rsa AAAA' });
    expect(written.isError).toBe(true);
    await expect(readFile(join(home, 'ssh', 'authorized_keys'), 'utf8')).rejects.toThrow();

    const edited = await editTool.execute({ path: target, oldString: 'a', newString: 'b' });
    expect(edited.isError).toBe(true);
  });

  it('leaves an ordinary write inside the workspace working', async () => {
    const result = await writeTool.execute({ path: join(workspace, 'notes.md'), content: 'hi' });
    expect(result.isError).toBe(false);
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('hi');
  });
});

describe('isWritablePath', () => {
  it('matches a root exactly and by containment', () => {
    expect(isWritablePath('/tmp', ['/tmp'])).toBe(true);
    expect(isWritablePath('/tmp/a/b', ['/tmp'])).toBe(true);
  });

  it('does not match a sibling sharing a prefix', () => {
    expect(isWritablePath('/tmpfoo', ['/tmp'])).toBe(false);
  });

  it('is false for an empty root set', () => {
    expect(isWritablePath('/tmp/a', [])).toBe(false);
  });
});
