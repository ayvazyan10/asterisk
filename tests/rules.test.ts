import { symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRules, loadRulesWithIssues, rulesToPromptSection } from '../src/rules/loader.ts';

describe('rules loader', () => {
  let userHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;
  let prevAsterisk: string | undefined;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'asterisk-rules-user-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'asterisk-rules-proj-'));
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

  it('returns empty when no rules anywhere', () => {
    expect(loadRules(projectRoot)).toEqual([]);
  });

  it('loads user rules from ~/.asterisk/rules/*.md', async () => {
    const dir = join(userHome, '.asterisk', 'rules');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tone.md'), '# Tone\nBe concise.');
    const rules = loadRules(projectRoot);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe('tone.md');
    expect(rules[0]?.scope).toBe('user');
    expect(rules[0]?.content).toContain('Be concise.');
  });

  it('loads project rules from <cwd>/.asterisk/rules/*.md and ASTERISK.md', async () => {
    await mkdir(join(projectRoot, '.asterisk', 'rules'), { recursive: true });
    await writeFile(join(projectRoot, '.asterisk', 'rules', 'style.md'), '## Style\nUse TS.');
    await writeFile(join(projectRoot, 'ASTERISK.md'), '# Project\nStrict mode.');
    const rules = loadRules(projectRoot);
    expect(rules.map((r) => r.name).sort()).toEqual(['ASTERISK.md', 'style.md']);
    expect(rules.every((r) => r.scope === 'project')).toBe(true);
  });

  it('rulesToPromptSection composes labelled blocks', async () => {
    await mkdir(join(userHome, '.asterisk', 'rules'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'rules', 'a.md'), 'rule A');
    await mkdir(join(projectRoot, '.asterisk', 'rules'), { recursive: true });
    await writeFile(join(projectRoot, '.asterisk', 'rules', 'b.md'), 'rule B');
    const rules = loadRules(projectRoot);
    const text = rulesToPromptSection(rules);
    expect(text).toMatch(/# Rules/);
    expect(text).toMatch(/user\/a\.md/);
    expect(text).toMatch(/project\/b\.md/);
    expect(text.indexOf('rule A')).toBeLessThan(text.indexOf('rule B'));
  });

  it('skips empty rule files', async () => {
    await mkdir(join(userHome, '.asterisk', 'rules'), { recursive: true });
    await writeFile(join(userHome, '.asterisk', 'rules', 'empty.md'), '   \n\n');
    expect(loadRules(projectRoot)).toEqual([]);
  });

  it('a broken symlink in rules/ does not crash loadRules — every other rule still loads', async () => {
    const dir = join(userHome, '.asterisk', 'rules');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'good.md'), 'GOOD_RULE');
    // A dangling symlink: readdirSync lists it, but statSync on it throws
    // ENOENT since fs follows the link to a target that does not exist.
    // Before the fix this was an unhandled throw out of loadRules() — and
    // loadRules runs fresh on every turn (repl/App.tsx, entrypoints/daemon.ts,
    // tools/subagent.ts, mcp/server.ts), so every single message would fail.
    symlinkSync('/nonexistent/target', join(dir, 'broken.md'));

    expect(() => loadRules(projectRoot)).not.toThrow();
    const rules = loadRules(projectRoot);
    expect(rules.some((r) => r.content === 'GOOD_RULE')).toBe(true);
  });

  it('reports which file was broken via loadRulesWithIssues', async () => {
    const dir = join(userHome, '.asterisk', 'rules');
    await mkdir(dir, { recursive: true });
    const brokenPath = join(dir, 'broken.md');
    symlinkSync('/nonexistent/target', brokenPath);

    const { rules, issues } = loadRulesWithIssues(projectRoot);
    expect(rules.some((r) => r.path === brokenPath)).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(brokenPath);
    expect(issues[0]?.message.length).toBeGreaterThan(0);
  });
});
