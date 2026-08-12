// Skills — reusable workflows defined as a SKILL.md per directory. The
// frontmatter declares name + description; the body is the prompt that
// gets injected as a user message when the skill is invoked. The format
// itself lives in ./schema.ts.
//
// Resolution order (later overrides earlier on name match):
//   bundled (src/skills/bundled.ts) → user (~/.asterisk/skills/<name>/SKILL.md)
//   → project (<cwd>/.asterisk/skills/<name>/SKILL.md)
//
// Discovery never throws and never loses a whole scope to one bad file: a
// broken skill is dropped from the result and explained in `issues`, which
// `/skills validate` prints. Every one of those cases used to be a bare
// `continue`, so a typo in a SKILL.md looked exactly like never having
// written it.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BUNDLED_SKILLS } from './bundled.ts';
import {
  SKILL_FILE,
  type SkillIssue,
  type SkillSource,
  scanFrontmatter,
  validateSkillSource,
} from './schema.ts';

export interface Skill {
  name: string;
  description: string;
  prompt: string;
  scope: 'user' | 'project' | 'bundled';
  path: string;
}

export interface SkillLoad {
  skills: Skill[];
  issues: SkillIssue[];
}

export function loadSkills(cwd: string = process.cwd()): Skill[] {
  return loadSkillsWithIssues(cwd).skills;
}

export function loadSkillsWithIssues(cwd: string = process.cwd()): SkillLoad {
  const byName = new Map<string, Skill>();
  const issues: SkillIssue[] = [];

  // 1. Bundled (lowest priority).
  for (const s of BUNDLED_SKILLS) byName.set(s.name, s);

  // 2. User-global.
  // 3. Project-local — listed last so it wins on name collision.
  const userRoot = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  const dirs: { scope: 'user' | 'project'; root: string }[] = [
    { scope: 'user', root: join(userRoot, 'skills') },
    { scope: 'project', root: join(cwd, '.asterisk', 'skills') },
  ];
  for (const { scope, root } of dirs) collectScope(root, scope, byName, issues);

  return { skills: sortSkills([...byName.values()]), issues };
}

function collectScope(
  root: string,
  scope: 'user' | 'project',
  byName: Map<string, Skill>,
  issues: SkillIssue[],
): void {
  if (!isDirectory(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch (err) {
    issues.push(pathIssue(root, `cannot be read: ${reason(err)}`));
    return;
  }
  // A name collision is only a mistake inside one scope; across scopes it is
  // the documented override, so this map is per-root and first entry wins.
  const claimed = new Map<string, string>();
  for (const entry of entries) {
    const loaded = loadEntry(root, entry, issues);
    if (!loaded) continue;
    const owner = claimed.get(loaded.name);
    if (owner) {
      issues.push({
        severity: 'error',
        path: loaded.path,
        skill: loaded.name,
        message: `duplicate skill name — ${owner} already claims it and wins; rename one of them`,
      });
      continue;
    }
    claimed.set(loaded.name, loaded.path);
    byName.set(loaded.name, { ...loaded, scope });
  }
}

/** One directory entry → a validated skill, or nothing plus an explanation. */
function loadEntry(
  root: string,
  entry: string,
  issues: SkillIssue[],
): (SkillSource & { path: string }) | undefined {
  // Dot entries are editor and VCS debris, never a deliberate skill.
  if (entry.startsWith('.')) return undefined;
  const skillDir = join(root, entry);
  let isDir: boolean;
  try {
    isDir = statSync(skillDir).isDirectory();
  } catch (err) {
    issues.push(pathIssue(skillDir, `cannot be inspected: ${reason(err)}`));
    return undefined;
  }
  if (!isDir) {
    // A loose markdown file is a skill someone expected to work. Anything
    // else in here (README, notes) is not worth complaining about.
    if (entry.toLowerCase().endsWith('.md')) {
      const stem = entry.replace(/\.md$/i, '');
      issues.push(
        pathIssue(
          skillDir,
          `a skill is a directory — move this to ${join(root, stem, SKILL_FILE)}`,
        ),
      );
    }
    return undefined;
  }

  const file = join(skillDir, SKILL_FILE);
  if (!existsSync(file)) {
    issues.push(pathIssue(skillDir, `has no ${SKILL_FILE} — that file is what makes it a skill`));
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    issues.push(pathIssue(file, `cannot be read: ${reason(err)}`, entry));
    return undefined;
  }

  const result = validateSkillSource(raw, { path: file, fallbackName: entry });
  issues.push(...result.issues);
  return result.ok ? { ...result.skill, path: file } : undefined;
}

function sortSkills(skills: Skill[]): Skill[] {
  // Stable ordering: bundled first, then user, then project — within each
  // scope, alphabetical by name.
  const scopeOrder: Record<Skill['scope'], number> = { bundled: 0, user: 1, project: 2 };
  return skills.sort((a, b) => {
    if (scopeOrder[a.scope] !== scopeOrder[b.scope]) {
      return scopeOrder[a.scope] - scopeOrder[b.scope];
    }
    return a.name.localeCompare(b.name);
  });
}

function pathIssue(path: string, message: string, skill?: string): SkillIssue {
  return { severity: 'error', path, skill: skill ?? basename(path), message };
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Frontmatter parse with no opinions, for callers that only want the fields.
 * Anything that cares whether a SKILL.md is *valid* wants validateSkillSource.
 */
export function parseSkillMarkdown(raw: string, fallbackName: string): SkillSource {
  const scan = scanFrontmatter(raw);
  // An unclosed block is not frontmatter here: this signature has nowhere to
  // report the problem, so it keeps the lenient reading (whole file = prompt).
  const usable = scan.delimited && scan.terminated;
  const field = (key: string): string => (usable ? (scan.fields.get(key)?.text ?? '') : '');
  return {
    name: field('name') || fallbackName,
    description: field('description'),
    prompt: usable ? scan.body : raw.trim(),
  };
}
