// The resolution reports behind Rules, Agents and Souls.
//
// What these pin down is the gap the pages exist to close: a file can sit in
// the right directory, be perfectly well-formed, and still do nothing. Every
// assertion below is about that gap.

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteDriver } from '../src/db/driver.ts';
import { getDb } from '../src/db/index.ts';
import {
  getAgentDetail,
  getAgentsReport,
  getRulesReport,
  getSoulsReport,
} from '../src/web/api/authored.ts';

let home = '';
let project = '';
let prevHome: string | undefined;
let prevLang: string | undefined;
let cwd = '';
let db: SqliteDriver;

function ctx(params: string[] = []) {
  return {
    db,
    params,
    url: new URL('http://127.0.0.1/api'),
    req: new Request('http://127.0.0.1/api'),
  };
}

async function payload(res: Response | Promise<Response>): Promise<Record<string, never>> {
  return (await (await res).json()) as Record<string, never>;
}

function write(rel: string, body: string): void {
  const abs = join(home, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-authored-'));
  project = await mkdtemp(join(tmpdir(), 'asterisk-authored-proj-'));
  prevHome = process.env['ASTERISK_HOME'];
  prevLang = process.env['ASTERISK_LANG'];
  process.env['ASTERISK_HOME'] = home;
  cwd = process.cwd();
  // The reports read process.cwd() for the project scope and the language.
  process.chdir(project);
  db = getDb();
});

afterEach(async () => {
  process.chdir(cwd);
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  if (prevLang === undefined) delete process.env['ASTERISK_LANG'];
  else process.env['ASTERISK_LANG'] = prevLang;
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe('GET /api/rules', () => {
  it('reports a language rule as inert when the project is another language', async () => {
    // The whole reason this endpoint exists. rules/python/lint.md is valid,
    // sits where the docs say, and never loads in a TypeScript project —
    // and a file listing cannot tell you that.
    process.env['ASTERISK_LANG'] = 'typescript';
    write('rules/common/style.md', '# Style\nSmall files.\n');
    write('rules/python/lint.md', '# Py\nUse ruff.\n');

    const body = await payload(getRulesReport(ctx()));
    expect(body['lang']).toBe('typescript');
    expect(body['langPinned']).toBe(true);

    const rules = body['rules'] as unknown as { name: string; layer: string }[];
    expect(rules.map((r) => r.name)).toEqual(['style.md']);

    const inert = body['inert'] as unknown as { rel: string; reason: string; category: string }[];
    expect(inert).toHaveLength(1);
    expect(inert[0]?.rel).toMatch(/lint\.md$/);
    expect(inert[0]?.reason).toMatch(/written for python.*reads as typescript/);
    expect(inert[0]?.category).toBe('other-language');
  });

  it('sends the inert category as data — a UI has no reason string to re-derive it from', async () => {
    // The regression this guards against: a UI that classified inert rules
    // by pattern-matching `reason` would silently misclassify every one of
    // these the moment the prose changed. category is set once, in
    // ruleSkipReason(), at the same time as reason — never after the fact.
    process.env['ASTERISK_LANG'] = 'typescript';
    write('rules/python/lint.md', '# Py\nUse ruff.\n'); // by design: other language
    write('rules/common/blank.md', ''); // genuine misconfiguration: empty

    const body = await payload(getRulesReport(ctx()));
    const inert = body['inert'] as unknown as { rel: string; category: string }[];
    const byRel = (suffix: string) => inert.find((i) => i.rel.endsWith(suffix));

    expect(byRel('lint.md')?.category).toBe('other-language');
    expect(byRel('blank.md')?.category).toBe('misconfigured');
    // Every emitted item must carry one of the two known categories — nothing
    // falls through as undefined for the UI to mis-bucket.
    for (const item of inert) {
      expect(['other-language', 'misconfigured']).toContain(item.category);
    }
  });

  it('loads the language layer when it does match', async () => {
    process.env['ASTERISK_LANG'] = 'python';
    write('rules/python/lint.md', '# Py\nUse ruff.\n');

    const body = await payload(getRulesReport(ctx()));
    const rules = body['rules'] as unknown as { name: string; layer: string }[];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.layer).toBe('lang');
    expect(body['inert']).toEqual([]);
  });

  it('distinguishes why each kind of stranded file is stranded', async () => {
    process.env['ASTERISK_LANG'] = 'typescript';
    write('rules/common/empty.md', '');
    write('rules/misc/stray.md', '# Stray\nx\n');
    write('rules/notes/deep/x.md', '# Deep\nx\n');

    const body = await payload(getRulesReport(ctx()));
    const inert = body['inert'] as unknown as { rel: string; reason: string; category: string }[];
    const reasons = inert.map((i) => i.reason);
    expect(reasons.some((r) => /whitespace only/.test(r))).toBe(true);
    expect(reasons.some((r) => /is not a layer/.test(r))).toBe(true);
    expect(reasons.some((r) => /nested too deep/.test(r))).toBe(true);
    // None of these is the other-language case — every one is a genuine
    // misconfiguration, and category says so regardless of which sentence.
    expect(inert.every((i) => i.category === 'misconfigured')).toBe(true);
  });
});

describe('GET /api/agents', () => {
  it('includes the bundled set, which has no files to list', async () => {
    // The old page walked ~/.asterisk/agents and showed nothing else, so every
    // agent the Agent tool can actually dispatch to was invisible.
    const body = await payload(getAgentsReport(ctx()));
    const counts = body['counts'] as unknown as { bundled: number; loaded: number };
    expect(counts.bundled).toBeGreaterThan(20);
    expect(counts.loaded).toBe(counts.bundled);
  });

  it('names a definition of yours that replaces a bundled one', async () => {
    write('agents/explore.md', '---\nname: explore\ndescription: Mine.\n---\n\nDo it.\n');

    const body = await payload(getAgentsReport(ctx()));
    expect(body['shadowed']).toEqual(['explore']);

    const agents = body['agents'] as unknown as { name: string; scope: string }[];
    expect(agents.filter((a) => a.name === 'explore')).toHaveLength(1);
    expect(agents.find((a) => a.name === 'explore')?.scope).toBe('user');
  });

  it('reports a definition with no body, which the loader drops in silence', async () => {
    write('agents/hollow.md', '---\nname: hollow\ndescription: No body.\n---\n');

    const body = await payload(getAgentsReport(ctx()));
    const inert = body['inert'] as unknown as { rel: string; reason: string; category: string }[];
    expect(inert).toHaveLength(1);
    expect(inert[0]?.reason).toMatch(/no prompt body/);
    // Agents have no "written for another language" concept — the one
    // reason loadAgents can report is always a genuine misconfiguration,
    // stated as data rather than left for a reader to infer from the prose.
    expect(inert[0]?.category).toBe('misconfigured');
  });

  it('serves a bundled agent in full, since there is no file to open', async () => {
    const list = await payload(getAgentsReport(ctx()));
    const first = (list['agents'] as unknown as { name: string; scope: string }[]).find(
      (a) => a.scope === 'bundled',
    );
    const one = await payload(getAgentDetail(ctx([first?.name as string])));
    expect(one['editable']).toBe(false);
    expect(String(one['prompt']).length).toBeGreaterThan(50);
  });

  it('404s an agent that does not exist', () => {
    expect(() => getAgentDetail(ctx(['nope']))).toThrow(/no agent named/);
  });
});

describe('GET /api/souls', () => {
  it('reports the layers in effect and the per-chat files separately', async () => {
    // A per-chat soul applies to that chat, never to the panel, so listing
    // them together would claim they are active here.
    write('SOUL.md', 'Operator persona.\n');
    write('souls/unknown-bot_1.md', 'Chat persona.\n');

    const body = await payload(getSoulsReport(ctx()));
    const active = body['active'] as unknown as { scope: string }[];
    expect(active.map((s) => s.scope)).toEqual(['user']);
    expect(body['sessions']).toHaveLength(1);
  });
});
