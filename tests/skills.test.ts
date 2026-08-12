import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSkills, loadSkillsWithIssues, parseSkillMarkdown } from '../src/skills/loader.ts';
import { formatSkillReport, skillIssueSummary } from '../src/skills/report.ts';

describe('parseSkillMarkdown', () => {
  it('parses frontmatter + body', () => {
    const raw = '---\nname: code-review\ndescription: Review the diff\n---\nLook at the diff.';
    expect(parseSkillMarkdown(raw, 'fallback')).toEqual({
      name: 'code-review',
      description: 'Review the diff',
      prompt: 'Look at the diff.',
    });
  });

  it('falls back to the directory name when frontmatter omits name', () => {
    const raw = '---\ndescription: anon\n---\nbody here';
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
    expect(names).toEqual([
      'ai-regression-testing',
      'audit-memory',
      'batch',
      'cloud-infrastructure-security',
      'data-scraper-agent',
      'debug',
      'dep-audit',
      'dream',
      'eval-harness',
      'feature',
      'loop',
      'mcp-server-patterns',
      'pr-review',
      'prompt-optimizer',
      'prp-commit',
      'prp-implement',
      'prp-plan',
      'prp-pr',
      'regex-vs-llm-structured-text',
      'release-notes',
      'santa-loop',
      'schedule',
      'security-scan',
      'simplify',
      'skill-stocktake',
      'skillify',
      'stuck',
      'verify',
      'youtube-summarizer',
    ]);
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

describe('loadSkillsWithIssues', () => {
  let userHome: string;
  let projectRoot: string;
  let userSkills: string;
  let prevHome: string | undefined;
  let prevAsterisk: string | undefined;

  const write = async (dir: string, body: string): Promise<string> => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, body);
    return file;
  };

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'asterisk-skillcheck-user-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'asterisk-skillcheck-proj-'));
    userSkills = join(userHome, '.asterisk', 'skills');
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

  it('reports a clean tree with no issues', async () => {
    await write(join(userSkills, 'review'), '---\nname: review\ndescription: Review\n---\nDo it.');
    const { skills, issues } = loadSkillsWithIssues(projectRoot);
    expect(issues).toEqual([]);
    expect(skills.find((s) => s.name === 'review')?.scope).toBe('user');
  });

  it('flags a skill directory with no SKILL.md and keeps loading the rest', async () => {
    await mkdir(join(userSkills, 'hollow'), { recursive: true });
    await write(join(userSkills, 'real'), '---\nname: real\ndescription: Real\n---\nBody.');
    const { skills, issues } = loadSkillsWithIssues(projectRoot);
    expect(skills.some((s) => s.name === 'real')).toBe(true);
    expect(issues).toEqual([
      {
        severity: 'error',
        path: join(userSkills, 'hollow'),
        skill: 'hollow',
        message: 'has no SKILL.md — that file is what makes it a skill',
      },
    ]);
  });

  it('flags a loose markdown file with the layout it should have used', async () => {
    await mkdir(userSkills, { recursive: true });
    await writeFile(join(userSkills, 'frontend.md'), '# not a skill directory');
    const { issues } = loadSkillsWithIssues(projectRoot);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(
      `a skill is a directory — move this to ${join(userSkills, 'frontend', 'SKILL.md')}`,
    );
  });

  it('drops an invalid SKILL.md instead of half-loading it', async () => {
    const file = await write(
      join(userSkills, 'broken'),
      '---\nname: broken\ndescription: Unclosed\nDo the thing.',
    );
    const { skills, issues } = loadSkillsWithIssues(projectRoot);
    expect(skills.some((s) => s.name === 'broken')).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(file);
    expect(issues[0]?.message).toMatch(/never closed/);
  });

  it('rejects the second of two skills claiming one name in the same scope', async () => {
    const first = await write(join(userSkills, 'alpha'), '---\nname: dup\ndescription: A\n---\nA.');
    await write(join(userSkills, 'beta'), '---\nname: dup\ndescription: B\n---\nB.');
    const { skills, issues } = loadSkillsWithIssues(projectRoot);
    expect(skills.filter((s) => s.name === 'dup')).toHaveLength(1);
    expect(skills.find((s) => s.name === 'dup')?.description).toBe('A');
    const duplicate = issues.filter((i) => i.message.startsWith('duplicate skill name'));
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.path).toBe(join(userSkills, 'beta', 'SKILL.md'));
    expect(duplicate[0]?.message).toContain(first);
  });

  it('treats a user skill shadowing a bundled one as the documented override', async () => {
    await write(
      join(userSkills, 'simplify'),
      '---\nname: simplify\ndescription: Mine\n---\nMy version.',
    );
    const { skills, issues } = loadSkillsWithIssues(projectRoot);
    // Overriding across scopes is the point of the resolution order, so it
    // must not be reported as a problem.
    expect(issues).toEqual([]);
    const simplify = skills.filter((s) => s.name === 'simplify');
    expect(simplify).toHaveLength(1);
    expect(simplify[0]?.scope).toBe('user');
    expect(simplify[0]?.description).toBe('Mine');
  });

  it('reports an unreadable SKILL.md rather than throwing', async () => {
    // A directory where the file should be: readable by stat, fatal to read,
    // and reproducible whatever uid the tests run as.
    await mkdir(join(userSkills, 'weird', 'SKILL.md'), { recursive: true });
    const { skills, issues } = loadSkillsWithIssues(projectRoot);
    expect(skills.every((s) => s.scope === 'bundled')).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/cannot be read: /);
  });

  it('ignores dot-entries in the skills root', async () => {
    await mkdir(join(userSkills, '.git'), { recursive: true });
    await writeFile(join(userSkills, '.DS_Store'), 'junk');
    expect(loadSkillsWithIssues(projectRoot).issues).toEqual([]);
  });

  it('keeps loadSkills as the issue-free view of the same load', async () => {
    await mkdir(join(userSkills, 'hollow'), { recursive: true });
    await write(join(userSkills, 'real'), '---\nname: real\ndescription: Real\n---\nBody.');
    expect(loadSkills(projectRoot)).toEqual(loadSkillsWithIssues(projectRoot).skills);
  });
});

describe('skill reporting', () => {
  it('summarises errors and warnings for the /skills footer', () => {
    expect(skillIssueSummary([])).toBeNull();
    const summary = skillIssueSummary([
      { severity: 'error', path: '/a/SKILL.md', skill: 'a', message: 'boom' },
      { severity: 'warning', path: '/b/SKILL.md', skill: 'b', message: 'hmm' },
    ]);
    expect(summary).toBe('! 1 not loaded, 1 warning — run /skills validate');
  });

  it('formats a report that names every broken file and clears the bundled set', () => {
    const report = formatSkillReport({
      skills: [],
      issues: [
        { severity: 'warning', path: '/b/SKILL.md', skill: 'b', message: 'unknown key' },
        { severity: 'error', path: '/a/SKILL.md', skill: 'a', message: 'has no SKILL.md' },
      ],
    });
    expect(report).toContain('1 error · 1 warning');
    expect(report).toContain('/a/SKILL.md');
    expect(report).toContain('/b/SKILL.md');
    // Errors sort ahead of warnings — the unrunnable skill is the headline.
    expect(report.indexOf('/a/SKILL.md')).toBeLessThan(report.indexOf('/b/SKILL.md'));
    expect(report).toContain('bundled skills: all valid');
  });

  it('says so plainly when nothing is wrong', () => {
    const report = formatSkillReport({ skills: [], issues: [] });
    expect(report).toContain('0 errors · 0 warnings');
    expect(report).toContain('No problems found in user or project skills.');
  });
});
