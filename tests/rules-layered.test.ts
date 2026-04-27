import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectProjectLang, loadRules } from '../src/rules/loader.ts';

describe('rules — layered + language-aware', () => {
  let userHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;
  let prevLang: string | undefined;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'asterisk-rules-u-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'asterisk-rules-p-'));
    prevHome = process.env['ASTERISK_HOME'];
    prevLang = process.env['ASTERISK_LANG'];
    process.env['ASTERISK_HOME'] = userHome;
    delete process.env['ASTERISK_LANG'];
  });

  afterEach(async () => {
    if (prevHome !== undefined) process.env['ASTERISK_HOME'] = prevHome;
    else delete process.env['ASTERISK_HOME'];
    if (prevLang !== undefined) process.env['ASTERISK_LANG'] = prevLang;
    else delete process.env['ASTERISK_LANG'];
    await rm(userHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('detectProjectLang infers TS from package.json + tsconfig.json', async () => {
    await writeFile(join(projectRoot, 'package.json'), '{}');
    await writeFile(join(projectRoot, 'tsconfig.json'), '{}');
    expect(detectProjectLang(projectRoot)).toBe('typescript');
  });

  it('detectProjectLang infers Python from pyproject.toml', async () => {
    await writeFile(join(projectRoot, 'pyproject.toml'), '');
    expect(detectProjectLang(projectRoot)).toBe('python');
  });

  it('detectProjectLang honours ASTERISK_LANG override', async () => {
    process.env['ASTERISK_LANG'] = 'go';
    await writeFile(join(projectRoot, 'package.json'), '{}');
    expect(detectProjectLang(projectRoot)).toBe('golang');
  });

  it('layered: common + matched-language rules are loaded; mismatched ones skipped', async () => {
    process.env['ASTERISK_LANG'] = 'python';
    await mkdir(join(userHome, 'rules', 'common'), { recursive: true });
    await mkdir(join(userHome, 'rules', 'python'), { recursive: true });
    await mkdir(join(userHome, 'rules', 'rust'), { recursive: true });
    await writeFile(join(userHome, 'rules', 'common', 'style.md'), 'COMMON_STYLE');
    await writeFile(join(userHome, 'rules', 'python', 'pep8.md'), 'PYTHON_PEP8');
    await writeFile(join(userHome, 'rules', 'rust', 'ownership.md'), 'RUST_OWNERSHIP');

    const rules = loadRules(projectRoot);
    const contents = rules.map((r) => r.content);
    expect(contents).toContain('COMMON_STYLE');
    expect(contents).toContain('PYTHON_PEP8');
    expect(contents).not.toContain('RUST_OWNERSHIP');
  });

  it('flat rules under ~/.asterisk/rules/*.md still load (backward compat)', async () => {
    await mkdir(join(userHome, 'rules'), { recursive: true });
    await writeFile(join(userHome, 'rules', 'flat.md'), 'FLAT_RULE');
    const rules = loadRules(projectRoot);
    expect(rules.map((r) => r.content)).toContain('FLAT_RULE');
    const flat = rules.find((r) => r.content === 'FLAT_RULE');
    expect(flat?.layer).toBe('flat');
  });

  it('project-layer rules override user-layer on the same name', async () => {
    process.env['ASTERISK_LANG'] = 'typescript';
    await mkdir(join(userHome, 'rules', 'common'), { recursive: true });
    await mkdir(join(projectRoot, '.asterisk', 'rules', 'common'), { recursive: true });
    await writeFile(join(userHome, 'rules', 'common', 'style.md'), 'USER_STYLE');
    await writeFile(
      join(projectRoot, '.asterisk', 'rules', 'common', 'style.md'),
      'PROJECT_STYLE',
    );
    const rules = loadRules(projectRoot);
    const styles = rules.filter((r) => r.name === 'style.md');
    // Both load because they're at different paths — but project comes
    // later, so a downstream prompt composer that prefers the latest
    // section in case of overlap will pick the project version.
    const lastStyle = styles[styles.length - 1];
    expect(lastStyle?.scope).toBe('project');
    expect(lastStyle?.content).toBe('PROJECT_STYLE');
  });

  it('returns empty array when there are no rules anywhere', () => {
    expect(loadRules(projectRoot)).toEqual([]);
  });
});
