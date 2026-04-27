import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editTool } from '../src/tools/edit.ts';
import { writeTool } from '../src/tools/write.ts';
import { _resetWorkspaceForTesting, isInsideWorkspace, workspaceRoot } from '../src/tools/workspace.ts';

describe('workspace guard', () => {
  let workspace: string;
  let outside: string;
  let prevWorkspace: string | undefined;
  let prevGuard: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'asterisk-wg-in-'));
    outside = await mkdtemp(join(tmpdir(), 'asterisk-wg-out-'));
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

  it('workspaceRoot reads ASTERISK_WORKSPACE when set', () => {
    expect(workspaceRoot()).toBe(resolve(workspace));
  });

  it('isInsideWorkspace true for workspace root and children', () => {
    expect(isInsideWorkspace(workspace)).toBe(true);
    expect(isInsideWorkspace(join(workspace, 'a.txt'))).toBe(true);
    expect(isInsideWorkspace(join(workspace, 'sub', 'deep', 'b.txt'))).toBe(true);
  });

  it('isInsideWorkspace false for sibling tempdirs', () => {
    expect(isInsideWorkspace(outside)).toBe(false);
    expect(isInsideWorkspace(join(outside, 'a.txt'))).toBe(false);
  });

  it('Write inside the workspace succeeds', async () => {
    const r = await writeTool.execute({ path: join(workspace, 'in.txt'), content: 'ok' });
    expect(r.isError).toBe(false);
  });

  it('Write outside the workspace is refused with the guard message', async () => {
    const r = await writeTool.execute({ path: join(outside, 'out.txt'), content: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/refused/);
    expect(r.output).toContain(outside);
    expect(r.output).toMatch(/outside the workspace/);
  });

  it('Edit outside the workspace is refused before touching the file', async () => {
    const path = join(outside, 'target.txt');
    await writeFile(path, 'original');
    const r = await editTool.execute({ path, oldString: 'original', newString: 'mutated' });
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/refused/);
    // File should be untouched.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('ASTERISK_NO_WORKSPACE_GUARD=1 disables the check', async () => {
    process.env['ASTERISK_NO_WORKSPACE_GUARD'] = '1';
    const r = await writeTool.execute({ path: join(outside, 'allowed.txt'), content: 'sure' });
    expect(r.isError).toBe(false);
  });
});
