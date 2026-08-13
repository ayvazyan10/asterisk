// Skill endpoints — the panel's view of what `loadSkills` actually sees.
//
// The other content kinds are files on disk and nothing more, so the generic
// /api/content routes serve them. Skills are not: a skill is a *directory*
// holding a SKILL.md, it carries validated frontmatter, it arrives from three
// scopes that override each other by name, and 29 of them are compiled into
// the binary with no file to list. Reading `skills/` as a flat file tree — the
// only thing the panel could do before this — showed none of that, and its
// "new file" form led straight into `skills/foo.md`, which the loader refuses
// with "a skill is a directory".
//
// So these routes hand back exactly what the loader resolved plus the issues
// it collected, which is the same material `/skills validate` prints.
//
// Writes are confined to user scope. Bundled skills have no file, and project
// skills live under the working directory rather than the Asterisk home —
// a different write boundary than this panel has any business crossing.

import { existsSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BUNDLED_SKILLS } from '../../skills/bundled.ts';
import { type Skill, loadSkillsWithIssues } from '../../skills/loader.ts';
import { NAME_PATTERN, SKILL_FILE, validateSkill } from '../../skills/schema.ts';
import { ensureOwnerOnlyDir, writeOwnerOnly } from '../../utils/fs-safe.ts';
import { type Handler, HttpError, audit, json, readJsonObject } from '../http.ts';

function asteriskHome(): string {
  return process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
}

function userSkillsRoot(): string {
  return join(asteriskHome(), 'skills');
}

/**
 * The directory a named user skill lives in. The name pattern is the whole
 * defence here: it admits one token of letters, digits, '.', '_' and '-', so
 * nothing that reaches join() can contain a separator or start with a dot.
 */
function userSkillDir(name: string): string {
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    throw new HttpError(
      `"${name}" is not a usable skill name — letters, digits, '.', '_' and '-' only`,
    );
  }
  return join(userSkillsRoot(), name);
}

function summarise(skill: Skill): Omit<Skill, 'prompt'> & { editable: boolean } {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    path: skill.path,
    editable: skill.scope === 'user',
  };
}

/**
 * Everything the panel needs to render the section in one call: the resolved
 * set, the problems found while resolving it, and the state of the bundled
 * set — which is checked in memory because a bad bundled skill is a shipping
 * bug rather than a user error.
 */
export const getSkills: Handler = () => {
  const load = loadSkillsWithIssues();
  const bundledIssues = BUNDLED_SKILLS.flatMap((s) => validateSkill(s));

  return json({
    root: userSkillsRoot(),
    skills: load.skills.map(summarise),
    issues: load.issues,
    counts: {
      loaded: load.skills.length,
      errors: load.issues.filter((i) => i.severity === 'error').length,
      warnings: load.issues.filter((i) => i.severity === 'warning').length,
      bundled: BUNDLED_SKILLS.length,
    },
    bundledIssues,
  });
};

/** One skill with its prompt. Resolution order decides which one a name means. */
export const getSkill: Handler = ({ params }) => {
  const name = params[0] ?? '';
  const skill = loadSkillsWithIssues().skills.find((s) => s.name === name);
  if (!skill) throw new HttpError(`no skill named "${name}"`, 404);
  return json({ ...summarise(skill), prompt: skill.prompt });
};

/**
 * Writes `<home>/skills/<name>/SKILL.md`. The frontmatter name is always the
 * directory name — a skill whose declared name differs from its directory
 * shadows anything else called that, and the loader warns about it. Not
 * offering the choice is simpler than explaining it.
 */
export const putSkill: Handler = async ({ db, params, req }) => {
  const name = params[0] ?? '';
  const dir = userSkillDir(name);
  const body = await readJsonObject(req);

  const description = body['description'];
  const prompt = body['prompt'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new HttpError('"description" is required — one line saying when to reach for this skill');
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpError('"prompt" is required — it is what the skill actually does');
  }
  if (description.length > 500) {
    throw new HttpError('"description" must be 500 characters or fewer');
  }
  // A description spanning lines would end the `key: value` line early and
  // leave the rest of it sitting in the frontmatter block as garbage.
  if (/[\r\n]/.test(description)) {
    throw new HttpError('"description" must be a single line');
  }

  const content = `---\nname: ${name}\ndescription: ${description.trim()}\n---\n\n${prompt.trim()}\n`;
  ensureOwnerOnlyDir(dir);
  writeOwnerOnly(join(dir, SKILL_FILE), content);
  audit(db, 'skill.write', name, { bytes: content.length });

  return json({ ok: true, name, bytes: content.length });
};

/** Removes a user skill's directory. Only ever a directory this module named. */
export const deleteSkill: Handler = ({ db, params }) => {
  const name = params[0] ?? '';
  const dir = userSkillDir(name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new HttpError(`no user skill named "${name}"`, 404);
  }
  // Refuse anything that is not recognisably a skill directory, so a
  // mis-shaped request can never take a tree of unrelated files with it.
  if (!existsSync(join(dir, SKILL_FILE))) {
    throw new HttpError(`"${name}" has no ${SKILL_FILE} — refusing to remove it`, 409);
  }
  rmSync(dir, { recursive: true });
  audit(db, 'skill.delete', name);
  return json({ ok: true });
};
