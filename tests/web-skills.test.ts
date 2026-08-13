// The skills endpoints.
//
// These drive the handlers directly rather than over HTTP, the way
// tests/web.test.ts does — the routing is covered there, and what matters here
// is the boundary between a request body and a directory on disk.

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteDriver } from '../src/db/driver.ts';
import { getDb } from '../src/db/index.ts';
import { deleteSkill, getSkill, getSkills, putSkill } from '../src/web/api/skills.ts';

let home = '';
let prevHome: string | undefined;
let db: SqliteDriver;

function ctx(params: string[] = [], body?: unknown) {
  return {
    db,
    params,
    url: new URL('http://127.0.0.1/api/skills'),
    req: new Request('http://127.0.0.1/api/skills', {
      method: body === undefined ? 'GET' : 'PUT',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

async function payload(res: Response | Promise<Response>): Promise<Record<string, never>> {
  return (await (await res).json()) as Record<string, never>;
}

/** Writes a skill directory the way a person would, by hand. */
function writeSkill(name: string, contents: string): void {
  mkdirSync(join(home, 'skills', name), { recursive: true });
  writeFileSync(join(home, 'skills', name, 'SKILL.md'), contents);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-web-skills-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
  db = getDb();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('GET /api/skills', () => {
  it('reports the bundled set even with nothing on disk', async () => {
    const body = await payload(getSkills(ctx()));
    expect(body['counts']).toMatchObject({ errors: 0, warnings: 0 });
    expect((body['counts'] as unknown as { bundled: number }).bundled).toBeGreaterThan(20);
    // Every bundled skill is checked against the same schema in memory; a
    // failure here is a shipping bug, not something a user did.
    expect(body['bundledIssues']).toEqual([]);
  });

  it('surfaces the loose-file mistake the old panel used to create', async () => {
    // `skills/<x>.md` is what a flat file tree invites, and the loader refuses
    // it. Before this endpoint the panel showed the file and said nothing.
    mkdirSync(join(home, 'skills'), { recursive: true });
    writeFileSync(join(home, 'skills', 'deploy.md'), '# deploy\n');

    const body = await payload(getSkills(ctx()));
    const issues = body['issues'] as unknown as { severity: string; message: string }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toMatch(/a skill is a directory/);
  });

  it('reports a frontmatter typo as a warning and the missing key as an error', async () => {
    writeSkill('broken', '---\ndescriptoin: typo\n---\n\nbody\n');

    const body = await payload(getSkills(ctx()));
    const issues = body['issues'] as unknown as { severity: string; message: string }[];
    expect(issues.some((i) => i.severity === 'warning' && /unknown key/.test(i.message))).toBe(
      true,
    );
    expect(issues.some((i) => i.severity === 'error' && /description/.test(i.message))).toBe(true);
  });

  it('marks only user skills editable', async () => {
    writeSkill('mine', '---\nname: mine\ndescription: Mine.\n---\n\nDo it.\n');

    const body = await payload(getSkills(ctx()));
    const skills = body['skills'] as unknown as {
      name: string;
      scope: string;
      editable: boolean;
    }[];
    expect(skills.find((s) => s.name === 'mine')).toMatchObject({ scope: 'user', editable: true });
    // Bundled skills have no file to write back to.
    expect(skills.filter((s) => s.scope === 'bundled').every((s) => !s.editable)).toBe(true);
  });
});

describe('PUT /api/skills/:name', () => {
  it('writes a SKILL.md the loader then resolves', async () => {
    const res = await payload(
      putSkill(ctx(['release'], { description: 'Cut a release.', prompt: 'bump, tag, push' })),
    );
    expect(res['ok']).toBe(true);

    const one = await payload(getSkill(ctx(['release'])));
    expect(one).toMatchObject({ name: 'release', description: 'Cut a release.', scope: 'user' });
    expect(one['prompt']).toBe('bump, tag, push');
  });

  it('names the skill after its directory', async () => {
    // A frontmatter name that differs from the directory shadows anything else
    // called that, and the loader warns about it. Not offering the choice is
    // simpler than explaining it, so the write always agrees with itself.
    await putSkill(ctx(['release'], { description: 'Cut a release.', prompt: 'go' }));
    const body = await payload(getSkills(ctx()));
    expect(body['issues']).toEqual([]);
  });

  it('refuses a name that would escape the skills directory', async () => {
    await expect(putSkill(ctx(['../../etc'], { description: 'no', prompt: 'no' }))).rejects.toThrow(
      /not a usable skill name/,
    );
  });

  it('refuses a description spanning lines', async () => {
    // It is written as one `key: value` line, so a newline would leave the
    // remainder sitting in the frontmatter block as garbage.
    await expect(putSkill(ctx(['x'], { description: 'one\ntwo', prompt: 'body' }))).rejects.toThrow(
      /single line/,
    );
  });

  it('requires both a description and a prompt', async () => {
    await expect(putSkill(ctx(['x'], { prompt: 'body' }))).rejects.toThrow(/description/);
    await expect(putSkill(ctx(['x'], { description: 'd' }))).rejects.toThrow(/prompt/);
  });
});

// getSkill and deleteSkill are synchronous handlers — the Handler contract
// allows either — so they throw rather than returning a rejected promise.
describe('DELETE /api/skills/:name', () => {
  it('removes the skill and its directory', async () => {
    await putSkill(ctx(['gone'], { description: 'Temporary.', prompt: 'x' }));
    expect(await payload(deleteSkill(ctx(['gone'])))).toEqual({ ok: true });
    expect(() => getSkill(ctx(['gone']))).toThrow(/no skill named/);
  });

  it('refuses a directory that is not a skill', () => {
    // The name guard already bars traversal; this is the second gate, so a
    // mis-shaped request can never take a tree of unrelated files with it.
    mkdirSync(join(home, 'skills', 'notaskill', 'src'), { recursive: true });
    writeFileSync(join(home, 'skills', 'notaskill', 'src', 'keep.txt'), 'important');

    expect(() => deleteSkill(ctx(['notaskill']))).toThrow(/refusing to remove/);
  });

  it('refuses a name that would escape the skills directory', () => {
    expect(() => deleteSkill(ctx(['..']))).toThrow(/not a usable skill name/);
  });
});
