// Skills — reusable workflows defined as a SKILL.md per directory. The
// frontmatter declares name + description; the body is the prompt that
// gets injected as a user message when the skill is invoked.
//
// Resolution order (later overrides earlier on name match):
//   bundled (src/skills/bundled.ts) → user (~/.asterisk/skills/<name>/SKILL.md)
//   → project (<cwd>/.asterisk/skills/<name>/SKILL.md)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BUNDLED_SKILLS } from './bundled.ts';

export interface Skill {
  name: string;
  description: string;
  prompt: string;
  scope: 'user' | 'project' | 'bundled';
  path: string;
}

export function loadSkills(cwd: string = process.cwd()): Skill[] {
  const byName = new Map<string, Skill>();

  // 1. Bundled (lowest priority).
  for (const s of BUNDLED_SKILLS) byName.set(s.name, s);

  // 2. User-global.
  // 3. Project-local — listed last so it wins on name collision.
  const userRoot = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  const dirs: { scope: 'user' | 'project'; root: string }[] = [
    { scope: 'user', root: join(userRoot, 'skills') },
    { scope: 'project', root: join(cwd, '.asterisk', 'skills') },
  ];

  for (const { scope, root } of dirs) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root).sort()) {
      const skillDir = join(root, entry);
      if (!statSync(skillDir).isDirectory()) continue;
      const file = join(skillDir, 'SKILL.md');
      if (!existsSync(file)) continue;
      const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'), entry);
      if (!parsed.prompt) continue;
      byName.set(parsed.name, { ...parsed, scope, path: file });
    }
  }

  // Stable ordering: bundled first, then user, then project — within each
  // scope, alphabetical by name.
  const ordered = [...byName.values()].sort((a, b) => {
    const scopeOrder: Record<Skill['scope'], number> = {
      bundled: 0,
      user: 1,
      project: 2,
    };
    if (scopeOrder[a.scope] !== scopeOrder[b.scope]) {
      return scopeOrder[a.scope] - scopeOrder[b.scope];
    }
    return a.name.localeCompare(b.name);
  });
  return ordered;
}

interface ParsedSkill {
  name: string;
  description: string;
  prompt: string;
}

export function parseSkillMarkdown(raw: string, fallbackName: string): ParsedSkill {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!fmMatch) {
    return { name: fallbackName, description: '', prompt: raw.trim() };
  }
  const fmBlock = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(t);
    if (m) {
      const key = (m[1] ?? '').toLowerCase();
      const value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
      fm[key] = value;
    }
  }
  return {
    name: fm['name'] ?? fallbackName,
    description: fm['description'] ?? '',
    prompt: body.trim(),
  };
}
