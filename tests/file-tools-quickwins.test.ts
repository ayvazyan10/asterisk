import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getFileHistory, recordFileChange } from '../src/agent/file-history.ts';
import '../src/tools/registry.ts';
import { editTool } from '../src/tools/edit.ts';
import { globTool } from '../src/tools/glob.ts';
import { readTool } from '../src/tools/read.ts';
import { toolSearchTool } from '../src/tools/tool-search.ts';
import { writeTool } from '../src/tools/write.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
let home: string;
let prevHome: string | undefined;
let prevAsteriskHome: string | undefined;
let prevGuard: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asterisk-quickwins-'));
  home = await mkdtemp(join(tmpdir(), 'asterisk-quickwins-home-'));
  prevHome = process.env['HOME'];
  prevAsteriskHome = process.env['ASTERISK_HOME'];
  prevGuard = process.env['ASTERISK_NO_WORKSPACE_GUARD'];
  process.env['HOME'] = home;
  process.env['ASTERISK_HOME'] = home;
  process.env['ASTERISK_NO_WORKSPACE_GUARD'] = '1';
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = prevHome;
  if (prevAsteriskHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevAsteriskHome;
  if (prevGuard === undefined) delete process.env['ASTERISK_NO_WORKSPACE_GUARD'];
  else process.env['ASTERISK_NO_WORKSPACE_GUARD'] = prevGuard;
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

// First, because the retention sweep runs only on the first recording in a
// process: any earlier recordFileChange call would consume it.
describe('file history retention', () => {
  it('deletes backups older than seven days on the first recording', () => {
    const historyDir = join(home, 'file-history');
    mkdirSync(historyDir, { recursive: true });
    const oldBackup = join(historyDir, 'old-backup');
    const recentBackup = join(historyDir, 'recent-backup');
    writeFileSync(oldBackup, 'old');
    writeFileSync(recentBackup, 'recent');
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);
    utimesSync(oldBackup, eightDaysAgo, eightDaysAgo);

    const source = join(dir, 'source.txt');
    writeFileSync(source, 'content');
    recordFileChange(source, 'Write');

    expect(existsSync(oldBackup)).toBe(false);
    expect(existsSync(recentBackup)).toBe(true);
  });

  it('deletes the backup file when the snapshot list evicts its oldest entry', () => {
    const source = join(dir, 'evict.txt');
    writeFileSync(source, 'version 1');
    recordFileChange(source, 'Write');
    const first = getFileHistory(source).at(-1);
    expect(first).toBeDefined();

    for (let i = 0; i < 200; i++) recordFileChange(source, 'Write');

    expect(existsSync(first?.backupPath ?? '')).toBe(false);
  });
});

describe('Read', () => {
  it('refuses a directory instead of trying to read it as a file', async () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);

    const result = await readTool.execute({ path: sub });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not a regular file');
  });

  it('refuses a file containing NUL bytes in its first 8192 bytes', async () => {
    const path = join(dir, 'binary.dat');
    await writeFile(path, Buffer.from([0x61, 0x00, 0x62]));

    const result = await readTool.execute({ path });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('binary file (contains NUL bytes); refusing to read as text');
  });

  it('does not add a phantom empty line when the file ends with a newline', async () => {
    const path = join(dir, 'two-lines.txt');
    await writeFile(path, 'one\ntwo\n');

    const result = await readTool.execute({ path });

    expect(result.isError).toBe(false);
    expect(result.output.split('\n')).toEqual(['    1\tone', '    2\ttwo']);
  });

  it('says the offset is past the end when no lines are in range', async () => {
    const path = join(dir, 'short.txt');
    await writeFile(path, 'one\ntwo\n');

    const result = await readTool.execute({ path, offset: 10 });

    expect(result.isError).toBe(false);
    expect(result.output).toBe('(offset 10 is past end of file; file has 2 lines)');
  });
});

describe('Edit', () => {
  it('rejects identical oldString and newString before recording a snapshot', async () => {
    const path = join(dir, 'unchanged.txt');
    await writeFile(path, 'unchanged');

    const result = await editTool.execute({
      path,
      oldString: 'unchanged',
      newString: 'unchanged',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('oldString and newString are identical; nothing to change');
    expect(await readFile(path, 'utf8')).toBe('unchanged');
    expect(getFileHistory(path)).toEqual([]);
  });
});

describe('Write', () => {
  it('reports UTF-8 bytes written rather than the character count', async () => {
    const path = join(dir, 'unicode.txt');

    const result = await writeTool.execute({ path, content: 'héllo' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('wrote 6 bytes');
  });
});

describe('Glob', () => {
  it('says how many matches were cut when the list is truncated', async () => {
    for (let i = 0; i < 1001; i++) {
      writeFileSync(join(dir, `file-${String(i).padStart(4, '0')}.txt`), '');
    }

    const result = await globTool.execute({ pattern: '*.txt', cwd: dir });

    expect(result.isError).toBe(false);
    const lines = result.output.split('\n');
    expect(lines).toHaveLength(1001);
    expect(lines.at(-1)).toBe('[truncated: showing 1000 of 1001 matches]');
  });
});

describe('ToolSearch', () => {
  it('names requested tools that do not exist', async () => {
    const result = await toolSearchTool.execute({ query: 'select:Bash,NoSuchTool' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('"name":"Bash"');
    expect(result.output).toContain('not found: NoSuchTool');
  });

  it('reports only the missing names when no requested tool exists', async () => {
    const result = await toolSearchTool.execute({ query: 'select:Nope,Missing' });

    expect(result.isError).toBe(false);
    expect(result.output).toBe('not found: Nope, Missing');
  });
});
