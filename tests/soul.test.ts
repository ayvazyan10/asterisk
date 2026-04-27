import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SOUL_TEMPLATE,
  clearSessionSoul,
  loadSouls,
  readSessionSoul,
  sessionSoulPath,
  soulsToPromptSection,
  writeSessionSoul,
} from '../src/soul/loader.ts';

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

  it('writeSessionSoul + loadSouls produce a session block in the right order', () => {
    const session = { id: 'bot:12345', scope: 'telegram' as const };
    writeSessionSoul(session, 'PERSONAL SOUL: call me Levon, reply in Russian.');
    const souls = loadSouls(projectRoot, session);
    expect(souls.map((s) => s.scope)).toEqual(['session']);
    expect(souls[0]?.content).toContain('Levon');
  });

  it('layers user → session → project, in that order', async () => {
    await mkdir(join(userHome, '.asterisk'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'SOUL.md'), 'OPERATOR PERSONA');
    await mkdir(join(projectRoot, '.asterisk'), { recursive: true });
    await writeFile(join(projectRoot, '.asterisk', 'SOUL.md'), 'PROJECT PERSONA');
    const session = { id: 'wa:+374', scope: 'whatsapp' as const };
    writeSessionSoul(session, 'PERSONAL PERSONA');

    const souls = loadSouls(projectRoot, session);
    expect(souls.map((s) => s.scope)).toEqual(['user', 'session', 'project']);
    expect(souls[0]?.content).toBe('OPERATOR PERSONA');
    expect(souls[1]?.content).toBe('PERSONAL PERSONA');
    expect(souls[2]?.content).toBe('PROJECT PERSONA');
  });

  it('clearSessionSoul removes the per-session file', () => {
    const session = { id: 'bot:55', scope: 'telegram' as const };
    writeSessionSoul(session, 'temporary');
    expect(readSessionSoul(session)).toMatch(/temporary/);
    expect(clearSessionSoul(session)).toBe(true);
    expect(readSessionSoul(session)).toBeNull();
    // Idempotent — second call returns false but doesn't throw.
    expect(clearSessionSoul(session)).toBe(false);
  });

  it('sessionSoulPath sanitises chatId punctuation', () => {
    const path = sessionSoulPath({ id: 'bot:+374:99/abc', scope: 'whatsapp' });
    // `:`, `+`, and `/` all become `_` so the filename is portable.
    expect(path).toMatch(/whatsapp-bot__374_99_abc\.md$/);
    expect(path).not.toContain(':');
    expect(path).not.toMatch(/\/bot_/); // session id must not be its own dir
  });

  it('soulsToPromptSection labels the session block as "your soul"', () => {
    const session = { id: 'bot:1', scope: 'telegram' as const };
    writeSessionSoul(session, 'BE TERSE');
    const text = soulsToPromptSection(loadSouls(projectRoot, session));
    expect(text).toMatch(/your soul/);
    expect(text).toContain('BE TERSE');
  });

  it('loadSouls without a session falls back to the old user+project behaviour', async () => {
    await mkdir(join(userHome, '.asterisk'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'SOUL.md'), 'OP');
    const souls = loadSouls(projectRoot);
    expect(souls.map((s) => s.scope)).toEqual(['user']);
  });
});
