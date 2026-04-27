import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSkills, parseSkillMarkdown } from '../src/skills/loader.ts';

describe('parseSkillMarkdown', () => {
  it('parses frontmatter + body', () => {
    const raw = `---\nname: code-review\ndescription: Review the diff\n---\nLook at the diff.`;
    expect(parseSkillMarkdown(raw, 'fallback')).toEqual({
      name: 'code-review',
      description: 'Review the diff',
      prompt: 'Look at the diff.',
    });
  });

  it('falls back to the directory name when frontmatter omits name', () => {
    const raw = `---\ndescription: anon\n---\nbody here`;
    expect(parseSkillMarkdown(raw, 'mydir').name).toBe('mydir');
  });

  it('treats raw markdown without frontmatter as the prompt body', () => {
    expect(parseSkillMarkdown('no frontmatter, just text', 'foo')).toEqual({
      name: 'foo',
      description: '',
      prompt: 'no frontmatter, just text',
    });
  });

  it('strips quotes around frontmatter values', () => {
    const raw = `---\nname: "quoted"\ndescription: 'with quotes'\n---\nbody`;
    const parsed = parseSkillMarkdown(raw, 'fallback');
    expect(parsed.name).toBe('quoted');
    expect(parsed.description).toBe('with quotes');
  });
});

describe('loadSkills', () => {
  let userHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;
  let prevAsterisk: string | undefined;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'asterisk-skills-user-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'asterisk-skills-proj-'));
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

  it('returns the bundled set when no user/project skills are installed', () => {
    const skills = loadSkills(projectRoot);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['batch', 'dream', 'simplify', 'skillify', 'stuck']);
    for (const s of skills) expect(s.scope).toBe('bundled');
  });

  it('discovers user and project skills alongside bundled, tagging scope', async () => {
    await mkdir(join(userHome, '.asterisk', 'skills', 'review'), { recursive: true });
    await writeFile(
      join(userHome, '.asterisk', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review\n---\nDo a review.',
    );
    await mkdir(join(projectRoot, '.asterisk', 'skills', 'release'), { recursive: true });
    await writeFile(
      join(projectRoot, '.asterisk', 'skills', 'release', 'SKILL.md'),
      'Just plain prompt body, no frontmatter',
    );
    const skills = loadSkills(projectRoot);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(byName['review']?.scope).toBe('user');
    expect(byName['review']?.prompt).toBe('Do a review.');
    expect(byName['release']?.scope).toBe('project');
    expect(byName['release']?.prompt).toBe('Just plain prompt body, no frontmatter');
    // Bundled skills still present alongside user + project additions.
    expect(byName['simplify']?.scope).toBe('bundled');
    expect(byName['stuck']?.scope).toBe('bundled');
  });

  it('lets a project-local skill override a bundled skill of the same name', async () => {
    await mkdir(join(projectRoot, '.asterisk', 'skills', 'simplify'), { recursive: true });
    await writeFile(
      join(projectRoot, '.asterisk', 'skills', 'simplify', 'SKILL.md'),
      '---\nname: simplify\ndescription: Project override\n---\nProject body.',
    );
    const skills = loadSkills(projectRoot);
    const simplify = skills.find((s) => s.name === 'simplify');
    expect(simplify?.scope).toBe('project');
    expect(simplify?.description).toBe('Project override');
    expect(simplify?.prompt).toBe('Project body.');
  });

  it('skips empty skill directories but still returns bundled skills', async () => {
    await mkdir(join(userHome, '.asterisk', 'skills', 'empty'), { recursive: true });
    const skills = loadSkills(projectRoot);
    expect(skills.length).toBeGreaterThanOrEqual(5);
    expect(skills.every((s) => s.scope === 'bundled')).toBe(true);
  });
});
