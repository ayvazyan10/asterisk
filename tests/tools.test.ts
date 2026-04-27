import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editTool } from '../src/tools/edit.ts';
import { globTool } from '../src/tools/glob.ts';
import { readTool } from '../src/tools/read.ts';
import { BUILTIN_TOOLS, getTool, listTools, setExtraTools, toolDefinitions } from '../src/tools/registry.ts';
import { writeTool } from '../src/tools/write.ts';

describe('tool registry', () => {
  it('exposes the full set of built-in tools', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'Agent',
        'AskUserQuestion',
        'Bash',
        'BrowserClick',
        'BrowserClose',
        'BrowserNavigate',
        'BrowserPress',
        'BrowserScreenshot',
        'BrowserSnapshot',
        'BrowserType',
        'BrowserWait',
        'CronCreate',
        'CronDelete',
        'CronList',
        'Edit',
        'EnterPlanMode',
        'EnterWorktree',
        'ExitPlanMode',
        'ExitWorktree',
        'Glob',
        'Grep',
        'Monitor',
        'PushNotification',
        'Read',
        'RemoteTrigger',
        'ScheduleWakeup',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskStop',
        'TaskUpdate',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    );
  });

  it('toolDefinitions includes input_schema for every tool', () => {
    for (const def of toolDefinitions()) {
      expect(def.input_schema.type).toBe('object');
    }
  });

  it('getTool returns the right entry or undefined', () => {
    expect(getTool('Read')?.name).toBe('Read');
    expect(getTool('Nope')).toBeUndefined();
  });

  it('setExtraTools merges into the live tool list', () => {
    const extra = {
      name: 'TestExtra',
      description: 'just a test',
      input_schema: { type: 'object', properties: {}, additionalProperties: true } as const,
      execute: async () => ({ output: 'ok', isError: false }),
    };
    setExtraTools([extra]);
    expect(listTools().some((t) => t.name === 'TestExtra')).toBe(true);
    expect(getTool('TestExtra')?.name).toBe('TestExtra');
    setExtraTools([]);
    expect(listTools().some((t) => t.name === 'TestExtra')).toBe(false);
  });
});

describe('Read / Write / Edit / Glob', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'asterisk-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Write creates a file then Read returns it numbered', async () => {
    const path = join(dir, 'a.txt');
    const w = await writeTool.execute({ path, content: 'one\ntwo\n' });
    expect(w.isError).toBe(false);

    const r = await readTool.execute({ path });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('1\tone');
    expect(r.output).toContain('2\ttwo');
  });

  it('Read enforces 1MB cap', async () => {
    const path = join(dir, 'huge.bin');
    await writeFile(path, Buffer.alloc(2_000_000, 0x41));
    const r = await readTool.execute({ path });
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/too large/);
  });

  it('Edit replaces a unique substring', async () => {
    const path = join(dir, 'b.txt');
    await writeFile(path, 'hello world');
    const e = await editTool.execute({ path, oldString: 'world', newString: 'asterisk' });
    expect(e.isError).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('hello asterisk');
  });

  it('Edit refuses non-unique substring without replaceAll', async () => {
    const path = join(dir, 'c.txt');
    await writeFile(path, 'aa\naa\n');
    const e = await editTool.execute({ path, oldString: 'aa', newString: 'b' });
    expect(e.isError).toBe(true);
    expect(e.output).toMatch(/not unique/);
  });

  it('Edit with replaceAll changes every occurrence', async () => {
    const path = join(dir, 'd.txt');
    await writeFile(path, 'aa\naa\n');
    const e = await editTool.execute({ path, oldString: 'aa', newString: 'b', replaceAll: true });
    expect(e.isError).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('b\nb\n');
  });

  it('Glob finds files', async () => {
    await writeFile(join(dir, 'one.ts'), '');
    await writeFile(join(dir, 'two.ts'), '');
    const g = await globTool.execute({ pattern: '*.ts', cwd: dir });
    expect(g.isError).toBe(false);
    expect(g.output.split('\n').sort()).toEqual(['one.ts', 'two.ts']);
  });
});
