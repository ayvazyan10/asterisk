import { symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findAgent,
  loadAgents,
  loadAgentsWithIssues,
  parseAgentMarkdown,
} from '../src/agents/loader.ts';

describe('agents loader', () => {
  let userHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'asterisk-agent-user-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'asterisk-agent-proj-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = userHome;
  });

  afterEach(async () => {
    if (prevHome !== undefined) process.env['ASTERISK_HOME'] = prevHome;
    else delete process.env['ASTERISK_HOME'];
    await rm(userHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('exposes the bundled agent set with stable names', () => {
    const agents = loadAgents(projectRoot);
    const names = agents.map((a) => a.name);
    expect(names).toContain('general-purpose');
    expect(names).toContain('explore');
    expect(names).toContain('code-reviewer');
    expect(names).toContain('security-reviewer');
    expect(names).toContain('planner');
    expect(names).toContain('chief-of-staff');
    expect(names).toContain('typescript-reviewer');
    expect(names).toContain('opensource-sanitizer');
    for (const a of agents) {
      expect(a.scope).toBe('bundled');
      expect(a.prompt.length).toBeGreaterThan(50);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('explore is read-only — its allowedTools list excludes Edit / Write', () => {
    const explore = findAgent('explore', projectRoot);
    expect(explore).toBeDefined();
    expect(explore?.allowedTools).toBeDefined();
    expect(explore?.allowedTools).not.toContain('Edit');
    expect(explore?.allowedTools).not.toContain('Write');
    expect(explore?.allowedTools).toContain('Read');
    expect(explore?.allowedTools).toContain('Grep');
  });

  it('user-installed agent overrides bundled by name', async () => {
    await mkdir(join(userHome, 'agents'), { recursive: true });
    await writeFile(
      join(userHome, 'agents', 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: My override\n---\nMy custom prompt body.',
    );
    const a = findAgent('code-reviewer', projectRoot);
    expect(a?.scope).toBe('user');
    expect(a?.description).toBe('My override');
    expect(a?.prompt).toContain('custom prompt body');
  });

  it('project-local agent wins over both user and bundled', async () => {
    await mkdir(join(userHome, 'agents'), { recursive: true });
    await writeFile(
      join(userHome, 'agents', 'planner.md'),
      '---\nname: planner\ndescription: User planner\n---\nU.',
    );
    await mkdir(join(projectRoot, '.asterisk', 'agents'), { recursive: true });
    await writeFile(
      join(projectRoot, '.asterisk', 'agents', 'planner.md'),
      '---\nname: planner\ndescription: Project planner\n---\nP.',
    );
    const a = findAgent('planner', projectRoot);
    expect(a?.scope).toBe('project');
    expect(a?.description).toBe('Project planner');
  });

  it('parseAgentMarkdown reads frontmatter incl. allowedTools + maxTurns', () => {
    const raw = [
      '---',
      'name: foo',
      'description: bar',
      'allowedTools: Read, Grep, Bash',
      'maxTurns: 5',
      '---',
      'body content',
    ].join('\n');
    const parsed = parseAgentMarkdown(raw, 'fallback');
    expect(parsed.name).toBe('foo');
    expect(parsed.description).toBe('bar');
    expect(parsed.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
    expect(parsed.maxTurns).toBe(5);
    expect(parsed.prompt).toBe('body content');
  });

  it('returns unknown lookups as undefined', () => {
    expect(findAgent('does-not-exist', projectRoot)).toBeUndefined();
  });

  it('a broken symlink in agents/ does not crash loadAgents — every other agent still loads', async () => {
    await mkdir(join(userHome, 'agents'), { recursive: true });
    await writeFile(
      join(userHome, 'agents', 'good.md'),
      '---\nname: good\ndescription: Fine.\n---\nBody.',
    );
    // A dangling symlink: readdirSync lists it, but statSync/readFileSync on
    // it throw ENOENT, since fs follows the link to a target that does not
    // exist. This reproduces the reported crash — before the fix, loadAgents
    // itself threw, which took down describeAgent() (src/tools/subagent.ts)
    // and with it every asterisk entrypoint.
    symlinkSync('/nonexistent/target', join(userHome, 'agents', 'broken.md'));

    expect(() => loadAgents(projectRoot)).not.toThrow();
    const agents = loadAgents(projectRoot);
    expect(agents.some((a) => a.name === 'good')).toBe(true);
    // Bundled agents are unaffected too.
    expect(agents.some((a) => a.name === 'general-purpose')).toBe(true);
  });

  it('reports which file was broken via loadAgentsWithIssues', async () => {
    await mkdir(join(userHome, 'agents'), { recursive: true });
    const brokenPath = join(userHome, 'agents', 'broken.md');
    symlinkSync('/nonexistent/target', brokenPath);

    const { agents, issues } = loadAgentsWithIssues(projectRoot);
    expect(agents.some((a) => a.path === brokenPath)).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(brokenPath);
    expect(issues[0]?.message.length).toBeGreaterThan(0);
  });
});
