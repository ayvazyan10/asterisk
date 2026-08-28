// Write/Edit TOCTOU: `checkWritable` runs once up front, but the actual
// write must go through a second, much later check (openForWriteGuarded's
// O_NOFOLLOW-open-then-reverify) rather than trusting the first one across
// every await in between. See the header comments in edit.ts/write.ts.
//
// A genuine concurrent race (something swapping the symlink in the exact
// window between the two checks) is not something a deterministic unit
// test can exercise. What IS deterministic, and is exactly what a won race
// would look like from openForWriteGuarded's point of view, is: (a) a
// symlink that is legitimately inside the writable set must still work —
// proving the O_NOFOLLOW/ELOOP fallback doesn't just refuse every symlink
// outright — and (b) a symlink whose target is outside the writable set
// must be refused, through the same `checkWritable` call the fallback path
// re-runs.

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editTool } from '../src/tools/edit.ts';
import { _resetWorkspaceForTesting } from '../src/tools/workspace.ts';
import { writeTool } from '../src/tools/write.ts';

describe('Write/Edit TOCTOU guard', () => {
  let workspace: string;
  let outside: string;
  let prevWorkspace: string | undefined;
  let prevGuard: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'asterisk-toctou-in-'));
    outside = await mkdtemp(join(tmpdir(), 'asterisk-toctou-out-'));
    prevWorkspace = process.env['ASTERISK_WORKSPACE'];
    prevGuard = process.env['ASTERISK_NO_WORKSPACE_GUARD'];
    process.env['ASTERISK_WORKSPACE'] = workspace;
    delete process.env['ASTERISK_NO_WORKSPACE_GUARD'];
    _resetWorkspaceForTesting();
  });

  afterEach(async () => {
    if (prevWorkspace === undefined) delete process.env['ASTERISK_WORKSPACE'];
    else process.env['ASTERISK_WORKSPACE'] = prevWorkspace;
    if (prevGuard === undefined) delete process.env['ASTERISK_NO_WORKSPACE_GUARD'];
    else process.env['ASTERISK_NO_WORKSPACE_GUARD'] = prevGuard;
    _resetWorkspaceForTesting();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('Write follows a symlink that legitimately points inside the workspace', async () => {
    const target = join(workspace, 'real.txt');
    await writeFile(target, 'original');
    const link = join(workspace, 'link.txt');
    await symlink(target, link);

    const w = await writeTool.execute({ path: link, content: 'updated via symlink' });
    expect(w.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('updated via symlink');
  });

  it('Edit follows a symlink that legitimately points inside the workspace', async () => {
    const target = join(workspace, 'real2.txt');
    await writeFile(target, 'hello world');
    const link = join(workspace, 'link2.txt');
    await symlink(target, link);

    const e = await editTool.execute({ path: link, oldString: 'world', newString: 'asterisk' });
    expect(e.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('hello asterisk');
  });

  it('Write refuses a symlink whose target resolves outside the workspace', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'do not touch');
    const link = join(workspace, 'escape.txt');
    await symlink(secret, link);

    const w = await writeTool.execute({ path: link, content: 'pwned' });
    expect(w.isError).toBe(true);
    expect(await readFile(secret, 'utf8')).toBe('do not touch');
  });

  it('Edit refuses a symlink whose target resolves outside the workspace', async () => {
    const secret = join(outside, 'secret2.txt');
    await writeFile(secret, 'do not touch either');
    const link = join(workspace, 'escape2.txt');
    await symlink(secret, link);

    const e = await editTool.execute({
      path: link,
      oldString: 'do not touch',
      newString: 'pwned',
    });
    expect(e.isError).toBe(true);
    expect(await readFile(secret, 'utf8')).toBe('do not touch either');
  });
});
