// The SKILL.md contract — the one place the file format is defined.
//
// A skill is a directory holding a single SKILL.md: frontmatter between two
// `---` lines, then the prompt body. Two keys are recognised because two keys
// are consumed: `name` is what the resolution order dedupes on and what
// `/skill <name>` takes, `description` is the line the picker shows. Nothing
// else is read anywhere, so an unrecognised key is reported rather than
// quietly honoured — that is how `descriptoin:` used to become an empty
// description.
//
// Frontmatter is deliberately not full YAML. Skills in the wild were written
// against a line scanner, and pulling in a YAML parser for two strings would
// trade a dependency for a stricter grammar nobody asked for. What changed is
// that lines the scanner cannot read are now reported instead of dropped.
//
// Severity is about consequence, not tone:
//   error   — the skill does not load; something is missing or ambiguous
//   warning — it loads, but the author will be surprised by it later

import { z } from 'zod';

import type { Skill } from './loader.ts';

/** The only filename a skill directory is searched for. */
export const SKILL_FILE = 'SKILL.md';

/**
 * One token, so `/skill <name>` stays unambiguous and a name can never carry a
 * path separator into a join(). Exported because the control panel creates and
 * deletes skill directories by name, and that is the check standing between a
 * request body and an rm on a resolved path — it must be this pattern and not
 * a second, looser copy of it. Note the leading class excludes '.', so '..'
 * cannot match.
 */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME = 64;
// Descriptions render as a single line in the `/skill` picker; the longest
// bundled one is ~110 chars, so this is a guard rail, not a target.
const MAX_DESCRIPTION = 500;

export const SkillFrontmatterSchema = z.object({
  // Optional here, not absent from the format: a SKILL.md that omits `name`
  // inherits its directory name, which is what most hand-written skills do.
  name: z
    .string({ invalid_type_error: 'must be text, not a list, number or map' })
    .trim()
    .min(1, 'must not be empty')
    .max(MAX_NAME, `must be ${MAX_NAME} characters or fewer`)
    .regex(
      NAME_PATTERN,
      "may only contain letters, digits, '.', '_' and '-' — no spaces or slashes",
    )
    .optional(),
  description: z
    .string({
      required_error: 'is required — one line saying when to reach for this skill',
      invalid_type_error: 'must be text, not a list, number or map',
    })
    .trim()
    .min(1, 'must not be empty')
    .max(MAX_DESCRIPTION, `must be ${MAX_DESCRIPTION} characters or fewer`),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// Derived, so adding a key to the schema teaches the unknown-key check about
// it in the same edit.
const KNOWN_KEYS = new Set(Object.keys(SkillFrontmatterSchema.shape));

export interface SkillIssue {
  severity: 'error' | 'warning';
  /** The SKILL.md, or the directory when the file itself is what is missing. */
  path: string;
  /** Skill name, or the directory name when the file never got that far. */
  skill: string;
  message: string;
}

/** What a valid SKILL.md yields, before the loader stamps scope + path on it. */
export interface SkillSource {
  name: string;
  description: string;
  prompt: string;
}

export type SkillValidation =
  | { ok: true; skill: SkillSource; issues: SkillIssue[] }
  | { ok: false; issues: SkillIssue[] };

interface FrontmatterField {
  key: string;
  /** Value as text, with one layer of surrounding quotes removed. */
  text: string;
  /** Same value as the scalar it looks like, so wrong types can be caught. */
  value: unknown;
  /** 1-based line number, for error messages that can be jumped to. */
  line: number;
}

export interface FrontmatterScan {
  /** The file opens with a `---` line. */
  delimited: boolean;
  /** The opening `---` is closed. False means the whole file is frontmatter. */
  terminated: boolean;
  fields: Map<string, FrontmatterField>;
  body: string;
  /** Lines inside the block that are neither `key: value`, comment nor blank. */
  unparsable: { line: number; text: string }[];
  duplicateKeys: string[];
}

const KEY_LINE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

export function scanFrontmatter(raw: string): FrontmatterScan {
  // A BOM ahead of the opening `---` would hide the frontmatter entirely and
  // silently turn the keys into prompt text.
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/);
  const empty = (over: Partial<FrontmatterScan>): FrontmatterScan => ({
    delimited: false,
    terminated: false,
    fields: new Map(),
    body: '',
    unparsable: [],
    duplicateKeys: [],
    ...over,
  });

  if ((lines[0] ?? '').trim() !== '---') return empty({ body: lines.join('\n').trim() });

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return empty({ delimited: true });

  const scan = empty({ delimited: true, terminated: true });
  scan.body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  for (let i = 1; i < end; i++) {
    const text = (lines[i] ?? '').trim();
    if (!text || text.startsWith('#')) continue;
    const m = KEY_LINE.exec(text);
    if (!m) {
      scan.unparsable.push({ line: i + 1, text });
      continue;
    }
    const key = (m[1] ?? '').toLowerCase();
    const rawValue = (m[2] ?? '').trim();
    if (scan.fields.has(key)) scan.duplicateKeys.push(key);
    scan.fields.set(key, {
      key,
      text: rawValue.replace(/^['"]|['"]$/g, ''),
      value: scalarValue(rawValue),
      line: i + 1,
    });
  }
  return scan;
}

// Enough YAML scalar sniffing to tell a string from a thing that is not one.
// Quoted stays text (`description: '2026'` is a description, not a number).
function scalarValue(raw: string): unknown {
  const quoted = /^"([\s\S]*)"$|^'([\s\S]*)'$/.exec(raw);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (raw === 'null' || raw === '~') return null;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  // Only the *kind* matters — the schema rejects any non-string outright.
  if (raw.startsWith('{') && raw.endsWith('}')) return {};
  return raw;
}

export interface ValidateOptions {
  /** Absolute path of the SKILL.md, quoted back in every issue. */
  path: string;
  /** Directory name — the name a skill inherits when frontmatter omits one. */
  fallbackName: string;
}

export function validateSkillSource(raw: string, opts: ValidateOptions): SkillValidation {
  const scan = scanFrontmatter(raw);
  const declared = scan.fields.get('name');
  const name =
    typeof declared?.value === 'string' && declared.text ? declared.text : opts.fallbackName;
  const issues: SkillIssue[] = [];
  const add = (severity: SkillIssue['severity'], message: string): void => {
    issues.push({ severity, path: opts.path, skill: name, message });
  };

  if (!scan.delimited) {
    add(
      'warning',
      'no frontmatter — the whole file is the prompt, the name comes from the ' +
        'directory and the skill shows up with no description. Add a `---` block.',
    );
  } else if (!scan.terminated) {
    add(
      'error',
      'frontmatter is never closed — add a `---` line after the last key, ' +
        'otherwise the keys read as prompt text',
    );
  } else {
    for (const issue of frontmatterIssues(scan)) add(issue.severity, issue.message);
    if (declared?.text && declared.text !== opts.fallbackName) {
      add(
        'warning',
        `name "${declared.text}" does not match its directory "${opts.fallbackName}" — ` +
          `/skill uses the frontmatter name, and it shadows any other skill called "${declared.text}"`,
      );
    }
  }

  const prompt = scan.delimited && scan.terminated ? scan.body : raw.trim();
  if (!prompt) add('error', 'no prompt body — everything after the closing `---` is the prompt');

  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };
  const description = scan.fields.get('description');
  return {
    ok: true,
    skill: { name, description: description?.text ?? '', prompt },
    issues,
  };
}

/** Frontmatter block checks: shape first, then the schema over typed values. */
function frontmatterIssues(
  scan: FrontmatterScan,
): { severity: SkillIssue['severity']; message: string }[] {
  const out: { severity: SkillIssue['severity']; message: string }[] = [];
  const flat = 'flat keys only, no lists, nested maps or `|`/`>` blocks';
  for (const bad of scan.unparsable) {
    out.push({
      severity: 'error',
      message: `line ${bad.line}: "${truncate(bad.text)}" is not \`key: value\` — SKILL.md frontmatter is ${flat}`,
    });
  }
  for (const key of scan.duplicateKeys) {
    out.push({ severity: 'warning', message: `duplicate key '${key}' — the last one wins` });
  }
  for (const key of scan.fields.keys()) {
    if (KNOWN_KEYS.has(key)) continue;
    out.push({
      severity: 'warning',
      message: `unknown key '${key}' — SKILL.md reads ${[...KNOWN_KEYS].join(' and ')}, nothing else`,
    });
  }

  const candidate: Record<string, unknown> = {};
  for (const [key, field] of scan.fields) {
    if (KNOWN_KEYS.has(key)) candidate[key] = field.value;
  }
  const parsed = SkillFrontmatterSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      out.push({ severity: 'error', message: formatZodIssue(issue) });
    }
  }
  return out;
}

/** Check an in-memory skill — used for the bundled set, which has no files. */
export function validateSkill(skill: Skill): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const at = (message: string): SkillIssue => ({
    severity: 'error',
    path: skill.path,
    skill: skill.name,
    message,
  });
  const parsed = SkillFrontmatterSchema.safeParse({
    name: skill.name,
    description: skill.description,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(at(formatZodIssue(issue)));
  }
  if (!skill.prompt.trim()) issues.push(at('no prompt body'));
  return issues;
}

function formatZodIssue(issue: z.ZodIssue): string {
  return `${issue.path.join('.') || 'frontmatter'} ${issue.message}`;
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
