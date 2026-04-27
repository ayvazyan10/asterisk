import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SOUL_TEMPLATE, loadSouls, soulsToPromptSection } from '../src/soul/loader.ts';

describe('soul loader', () => {
  let userHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;
  let prevAsterisk: string | undefined;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'asterisk-soul-user-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'asterisk-soul-proj-'));
    prevHome = process.env['HOME'];
    prevAsterisk = process.env['ASTERISK_HOME'];
    process.env['HOME'] = userHome;
    process.env['ASTERISK_HOME'] = join(userHome, '.asterisk');
  });

  afterEach(async () => {
    if (prevHome !== undefined) process.env['HOME'] = prevHome;
    else delete process.env['HOME'];
    if (prevAsterisk !== undefined) process.env['ASTERISK_HOME'] = prevAsterisk;
    else delete process.env['ASTERISK_HOME'];
    await rm(userHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns empty when no SOUL.md anywhere', () => {
    expect(loadSouls(projectRoot)).toEqual([]);
  });

  it('loads a user-global SOUL.md', async () => {
    await mkdir(join(userHome, '.asterisk'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'SOUL.md'), '# Be terse and direct.');
    const souls = loadSouls(projectRoot);
    expect(souls).toHaveLength(1);
    expect(souls[0]?.scope).toBe('user');
    expect(souls[0]?.content).toContain('terse and direct');
  });

  it('loads project SOUL from .asterisk/SOUL.md', async () => {
    await mkdir(join(projectRoot, '.asterisk'), { recursive: true });
    await writeFile(join(projectRoot, '.asterisk', 'SOUL.md'), '## Project rules\nUse TS strict.');
    const souls = loadSouls(projectRoot);
    expect(souls.find((s) => s.scope === 'project')?.content).toContain('TS strict');
  });

  it('falls back to <project>/SOUL.md when .asterisk/SOUL.md is absent', async () => {
    await writeFile(join(projectRoot, 'SOUL.md'), '## Repo persona');
    const souls = loadSouls(projectRoot);
    expect(souls.find((s) => s.scope === 'project')?.content).toContain('Repo persona');
  });

  it('loads both user and project at once, user first', async () => {
    await mkdir(join(userHome, '.asterisk'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'SOUL.md'), 'USER');
    await mkdir(join(projectRoot, '.asterisk'), { recursive: true });
    await writeFile(join(projectRoot, '.asterisk', 'SOUL.md'), 'PROJECT');
    const souls = loadSouls(projectRoot);
    expect(souls.map((s) => s.scope)).toEqual(['user', 'project']);
    expect(souls[0]?.content).toBe('USER');
    expect(souls[1]?.content).toBe('PROJECT');
  });

  it('skips empty files', async () => {
    await mkdir(join(userHome, '.asterisk'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'SOUL.md'), '   \n\n');
    expect(loadSouls(projectRoot)).toEqual([]);
  });

  it('soulsToPromptSection composes a labelled block', async () => {
    await mkdir(join(userHome, '.asterisk'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'SOUL.md'), 'USER PERSONA');
    const souls = loadSouls(projectRoot);
    const text = soulsToPromptSection(souls);
    expect(text).toMatch(/# Soul/);
    expect(text).toMatch(/user soul/);
    expect(text).toContain('USER PERSONA');
  });

  it('soulsToPromptSection returns empty string when no souls', () => {
    expect(soulsToPromptSection([])).toBe('');
  });

  it('default template mentions persona + user sections', () => {
    expect(DEFAULT_SOUL_TEMPLATE).toMatch(/You \(the assistant\)/);
    expect(DEFAULT_SOUL_TEMPLATE).toMatch(/Me \(the user\)/);
  });
});
