import { describe, expect, it } from 'vitest';

import { BUNDLED_SKILLS } from '../src/skills/bundled.ts';
import {
  type SkillValidation,
  scanFrontmatter,
  validateSkill,
  validateSkillSource,
} from '../src/skills/schema.ts';

const PATH = '/tmp/skills/demo/SKILL.md';

function check(raw: string, fallbackName = 'demo'): SkillValidation {
  return validateSkillSource(raw, { path: PATH, fallbackName });
}

function messages(result: SkillValidation, severity: 'error' | 'warning'): string[] {
  return result.issues.filter((i) => i.severity === severity).map((i) => i.message);
}

describe('validateSkillSource — well-formed input', () => {
  it('accepts frontmatter + body and reports nothing', () => {
    const result = check(
      '---\nname: code-review\ndescription: Review the diff\n---\nLook.',
      'code-review',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill).toEqual({
      name: 'code-review',
      description: 'Review the diff',
      prompt: 'Look.',
    });
    expect(result.issues).toEqual([]);
  });

  it('inherits the directory name when frontmatter omits one', () => {
    const result = check('---\ndescription: Anonymous\n---\nbody', 'my-dir');
    expect(result.ok && result.skill.name).toBe('my-dir');
    expect(result.issues).toEqual([]);
  });

  it('keeps a quoted number a string instead of failing the type check', () => {
    const result = check('---\nname: y2k\ndescription: "2000"\n---\nbody', 'y2k');
    expect(result.ok && result.skill.description).toBe('2000');
  });

  it('reads a CRLF file and a leading BOM', () => {
    const crlf = check('---\r\nname: demo\r\ndescription: Windows\r\n---\r\nbody line');
    expect(crlf.ok && crlf.skill.description).toBe('Windows');
    const bom = check('﻿---\nname: demo\ndescription: Byte order mark\n---\nbody');
    expect(bom.ok && bom.skill.description).toBe('Byte order mark');
  });
});

describe('validateSkillSource — errors that stop a skill loading', () => {
  it('rejects a frontmatter block that is never closed', () => {
    // The old parser fell through to "no frontmatter" and shipped the keys as
    // prompt text, which is how a missing `---` became a silent half-load.
    const result = check('---\nname: demo\ndescription: Broken\nDo the thing.');
    expect(result.ok).toBe(false);
    expect(messages(result, 'error').join()).toMatch(/never closed/);
  });

  it('rejects frontmatter lines that are not `key: value`, naming the line', () => {
    const result = check('---\nname: demo\ndescription: >\n  folded text\n---\nbody');
    expect(result.ok).toBe(false);
    expect(messages(result, 'error').join()).toMatch(/line 4: "folded text" is not/);
  });

  it('requires a description once frontmatter exists', () => {
    const result = check('---\nname: demo\n---\nbody');
    expect(result.ok).toBe(false);
    expect(messages(result, 'error')).toEqual([
      'description is required — one line saying when to reach for this skill',
    ]);
  });

  it('rejects non-string values for name and description', () => {
    const list = check('---\nname: demo\ndescription: [one, two]\n---\nbody');
    expect(list.ok).toBe(false);
    expect(messages(list, 'error').join()).toMatch(/description must be text/);

    const numeric = check('---\nname: 42\ndescription: Numeric name\n---\nbody');
    expect(numeric.ok).toBe(false);
    expect(messages(numeric, 'error').join()).toMatch(/name must be text/);

    const map = check('---\nname: demo\ndescription: {a: 1}\n---\nbody');
    expect(map.ok).toBe(false);
    expect(messages(map, 'error').join()).toMatch(/description must be text/);
  });

  it('rejects a name that is not a single token', () => {
    const result = check('---\nname: my skill\ndescription: Spaces\n---\nbody');
    expect(result.ok).toBe(false);
    expect(messages(result, 'error').join()).toMatch(/name may only contain/);
  });

  it('rejects empty values and over-long ones', () => {
    const blank = check('---\nname: demo\ndescription:\n---\nbody');
    expect(blank.ok).toBe(false);
    expect(messages(blank, 'error').join()).toMatch(/description must not be empty/);

    const long = check(`---\nname: demo\ndescription: ${'x'.repeat(501)}\n---\nbody`);
    expect(long.ok).toBe(false);
    expect(messages(long, 'error').join()).toMatch(/description must be 500 characters or fewer/);
  });

  it('rejects a file with frontmatter but no prompt body', () => {
    const result = check('---\nname: demo\ndescription: Empty\n---\n');
    expect(result.ok).toBe(false);
    expect(messages(result, 'error').join()).toMatch(/no prompt body/);
  });

  it('names the offending file on every issue', () => {
    const result = check('---\nname: demo\n---\n');
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) expect(issue.path).toBe(PATH);
  });
});

describe('validateSkillSource — warnings that still load', () => {
  it('warns when there is no frontmatter at all', () => {
    const result = check('just a prompt', 'plain');
    expect(result.ok).toBe(true);
    expect(result.ok && result.skill).toEqual({
      name: 'plain',
      description: '',
      prompt: 'just a prompt',
    });
    expect(messages(result, 'warning').join()).toMatch(/no frontmatter/);
  });

  it('warns about keys nothing reads', () => {
    const result = check('---\nname: demo\ndescription: Fine\nallowedTools: Read\n---\nbody');
    expect(result.ok).toBe(true);
    expect(messages(result, 'warning').join()).toMatch(/unknown key 'allowedtools'/);
  });

  it('warns on a duplicate key and keeps the last value', () => {
    const result = check('---\nname: demo\ndescription: First\ndescription: Second\n---\nbody');
    expect(result.ok && result.skill.description).toBe('Second');
    expect(messages(result, 'warning').join()).toMatch(/duplicate key 'description'/);
  });

  it('warns when the declared name does not match the directory', () => {
    const result = check('---\nname: other\ndescription: Copied\n---\nbody', 'my-dir');
    expect(result.ok && result.skill.name).toBe('other');
    expect(messages(result, 'warning').join()).toMatch(/does not match its directory "my-dir"/);
  });
});

describe('scanFrontmatter', () => {
  it('treats only the first closing --- as the delimiter', () => {
    const scan = scanFrontmatter('---\nname: demo\n---\nbody\n\n---\n\nmore body');
    expect(scan.delimited && scan.terminated).toBe(true);
    expect(scan.body).toBe('body\n\n---\n\nmore body');
  });

  it('ignores comments and blank lines inside the block', () => {
    const scan = scanFrontmatter('---\n# a comment\n\nname: demo\n---\nbody');
    expect(scan.unparsable).toEqual([]);
    expect([...scan.fields.keys()]).toEqual(['name']);
  });
});

describe('validateSkill (in-memory skills)', () => {
  it('passes every bundled skill', () => {
    const failures = BUNDLED_SKILLS.flatMap((s) =>
      validateSkill(s).map((i) => `${s.name}: ${i.message}`),
    );
    expect(failures).toEqual([]);
    expect(BUNDLED_SKILLS).toHaveLength(29);
  });

  it('catches a bundled-shaped skill with an empty description or body', () => {
    const base = { scope: 'bundled' as const, path: 'bundled:broken', prompt: 'do it' };
    expect(validateSkill({ ...base, name: 'broken', description: '' })).toHaveLength(1);
    expect(validateSkill({ ...base, name: 'broken', description: 'ok', prompt: '  ' })).toEqual([
      expect.objectContaining({ message: 'no prompt body', severity: 'error' }),
    ]);
  });
});
