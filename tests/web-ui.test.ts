// The control panel's render layer.
//
// These are cheap, pure tests over strings — but they cover the failure modes
// this particular UI actually has, which are not the ones a component test
// would find:
//
//   - The client is a `String.raw` template. `tsc` sees a string, so a stray
//     backtick or a typo inside it type-checks cleanly and then fails to parse
//     in the browser. One such bug shipped during the shadcn redesign and only
//     surfaced when the page was loaded. `new Function(...)` is the guard.
//   - The page's CSP is `style-src 'nonce-…'`, which does not authorise
//     `style="…"` attributes. A single inline style silently loses its styling
//     in production while looking fine in any test that does not check.
//   - Light and dark are authored separately, so a token added to one and
//     forgotten in the other degrades quietly to the wrong colour.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { settingsRegistry } from '../src/config/introspect.ts';
import { CONTENT_KINDS } from '../src/web/api/content.ts';
import { APP_AUTHORED } from '../src/web/ui/app-authored.ts';
import { APP_CONNECTORS } from '../src/web/ui/app-connectors.ts';
import { APP_CORE } from '../src/web/ui/app-core.ts';
import { APP_LOGS } from '../src/web/ui/app-logs.ts';
import { APP_SETTINGS } from '../src/web/ui/app-settings.ts';
import { APP_SKILLS } from '../src/web/ui/app-skills.ts';
import { APP_STAR } from '../src/web/ui/app-star.ts';
import { APP_VIEWS } from '../src/web/ui/app-views.ts';
import { COMPONENTS } from '../src/web/ui/components.ts';
import { APP_ICONS } from '../src/web/ui/icons.ts';
import { renderIndexHtml } from '../src/web/ui/index.ts';
import { STYLES } from '../src/web/ui/styles.ts';

// The same concatenation ./index.ts inlines, in the same order. Every module
// belongs here: the checks below are about the script the browser runs, and a
// module left out is a module none of them cover.
const CLIENT = [
  APP_ICONS,
  APP_CORE,
  APP_STAR,
  APP_SETTINGS,
  APP_LOGS,
  APP_SKILLS,
  APP_AUTHORED,
  APP_CONNECTORS,
  APP_VIEWS,
].join('\n');

/** A top-level `const NAME = [ … ];` array literal, as source text. */
function arrayLiteral(name: string): string {
  const start = CLIENT.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`no ${name} in the client`);
  const end = CLIENT.indexOf('\n];', start);
  return CLIENT.slice(start, end);
}

function idsIn(name: string): string[] {
  return [...arrayLiteral(name).matchAll(/id: '([a-z]+)'/g)].map((m) => m[1] as string);
}

/**
 * Source text of a top-level `function name(...) { ... }` in the client,
 * brace-matched so a nested object literal in the body doesn't truncate it
 * early. Lets a test actually run a pure helper out of the client script
 * instead of pattern-matching its source.
 */
function functionSource(name: string): string {
  const marker = `function ${name}(`;
  const start = CLIENT.indexOf(marker);
  if (start === -1) throw new Error(`no function ${name} in the client`);
  const open = CLIENT.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < CLIENT.length) {
    if (CLIENT[i] === '{') depth++;
    else if (CLIENT[i] === '}') depth--;
    i++;
  }
  return CLIENT.slice(start, i);
}

/** Body of a top-level CSS rule, by selector. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function customProperties(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));
}

/** The `oklch(L% C H [/ A])` value a custom property is declared with, in a token block. */
function tokenOklch(block: string, name: string): { l: number; c: number; h: number; a: number } {
  const re = new RegExp(
    `${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*/\\s*([\\d.]+))?\\s*\\)`,
  );
  const m = block.match(re);
  if (!m) throw new Error(`no oklch(...) value for ${name}`);
  return {
    l: Number(m[1]),
    c: Number(m[2]),
    h: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * oklch(L% C H) -> sRGB, 0-255 per channel, gamut-clipped. Same matrices
 * Chrome's CSS Color 4 implementation uses (Björn Ottosson's OKLab
 * reference), verified against the live-rendered page with Playwright's
 * canvas-paint-and-read-back technique before these tokens were chosen --
 * see the theme.ts comments this test locks in.
 */
function oklchToRgb({ l, c, h }: { l: number; c: number; h: number }): [number, number, number] {
  const L = l / 100;
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [lc, mc, sc] = [l_ ** 3, m_ ** 3, s_ ** 3];

  const lin = [
    +4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
  const gamma = (v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return lin.map((v) => Math.round(gamma(v) * 255)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two sRGB colours, 1:1 to 21:1. */
function contrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const [l1, l2] = [relativeLuminance(rgb1), relativeLuminance(rgb2)];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite a translucent colour over an opaque one, source-over. */
function compositeOver(
  src: [number, number, number],
  alpha: number,
  dst: [number, number, number],
): [number, number, number] {
  return src.map((c, i) => Math.round(c * alpha + (dst[i] as number) * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/**
 * Body of an `@media` block, brace-matched rather than stopping at the first
 * `}` — a media block holds several nested rules, so `ruleBody`'s naive
 * first-close-brace search would return only the first rule inside it.
 * `from` narrows to a block starting at or after that offset, for a
 * condition (like the coarse-pointer query) that appears more than once
 * because two source files each contribute their own block under it.
 */
function mediaBody(css: string, atRule: string, from = 0): string {
  const start = css.indexOf(atRule, from);
  if (start === -1) throw new Error(`no ${atRule} block from offset ${from}`);
  const open = css.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(open + 1, i - 1);
}

describe('the client script', () => {
  it('is assembled from every module the page inlines', () => {
    // CLIENT above is written by hand, and a module missing from it is a
    // module none of these checks cover — which is how the log reader briefly
    // escaped them. Read what index.ts actually interpolates and compare.
    const src = readFileSync(new URL('../src/web/ui/index.ts', import.meta.url), 'utf8');
    const inlined = [...src.matchAll(/\$\{(APP_[A-Z_]+)\}/g)].map((m) => m[1] as string);
    expect(new Set(inlined)).toEqual(
      new Set([
        'APP_ICONS',
        'APP_CORE',
        'APP_STAR',
        'APP_SETTINGS',
        'APP_LOGS',
        'APP_SKILLS',
        'APP_AUTHORED',
        'APP_CONNECTORS',
        'APP_VIEWS',
      ]),
    );
  });

  it('dispatches every data-attribute it puts on a control', () => {
    // The panel has one delegated click listener, and a button whose attribute
    // is not in its selector is simply dead — no error, no console entry, just
    // nothing happening. Adding an action means adding it in two places, and
    // this is what notices when only one of them happened.
    const emitted = new Set([...CLIENT.matchAll(/data-([a-z0-9-]+)="/g)].map((m) => m[1]));
    const selected = new Set([...CLIENT.matchAll(/\[data-([a-z0-9-]+)\]/g)].map((m) => m[1]));
    // These carry a value for a handler that already matched on something
    // else, or are read by CSS; none is used to find an element.
    const carriers = new Set(['field', 'secret', 'state', 'rail', 'open', 'theme']);
    expect([...emitted].filter((a) => !selected.has(a) && !carriers.has(a as string))).toEqual([]);
  });

  it('never asks for a value through prompt()', () => {
    // A prompt() cannot be copied out of, and the two it replaced were showing
    // the user a redirect URI and a console URL they had to carry elsewhere by
    // hand. confirm() stays — a yes/no has nothing to take away from it.
    const calls = CLIENT.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(calls).not.toMatch(/(?<![.\w])prompt\s*\(/);
  });

  it('opens an outbound link in a new tab, and an in-page one in place', () => {
    // The tag is built by concatenation, so the attributes are spread across
    // string literals — look at the window after the tag rather than at one
    // literal. A `#tab` href is this page's own router and must navigate in
    // place; anything else points at somebody else's site.
    const anchors = [...CLIENT.matchAll(/<a\b/g)];
    expect(anchors.length).toBeGreaterThan(0);
    let outbound = 0;
    let inPage = 0;
    for (const m of anchors) {
      const tag = CLIENT.slice(m.index, m.index + 200);
      if (/href="#/.test(tag)) {
        inPage++;
        expect(tag).not.toContain('target="_blank"');
      } else {
        outbound++;
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noopener noreferrer"');
      }
    }
    expect(outbound).toBeGreaterThan(0);
    // No floor on in-page links: the panel's only ones were on a page that has
    // since been removed. The rule is about how one behaves, not that one exists.
    expect(inPage).toBeGreaterThanOrEqual(0);
  });

  it('parses as JavaScript', () => {
    // The whole reason this test exists: the script lives inside a template
    // literal, so nothing else in the toolchain ever parses it.
    expect(() => new Function(CLIENT)).not.toThrow();
  });

  it('defines a view and a loader for every hand-written tab', () => {
    // VIEWS and LOADERS are keyed by tab id; a sidebar entry with no matching
    // view silently falls back to the overview, which looks like a dead link.
    const hardCoded = idsIn('TABS');
    expect(hardCoded.length).toBeGreaterThan(4);
    for (const tab of hardCoded) {
      expect(CLIENT).toContain(`${tab}: view`);
      expect(CLIENT).toContain(`${tab}: load`);
    }
  });

  it('registers the content kinds by derivation rather than by hand', () => {
    // The kind tabs are added in a loop over CONTENT_KINDS. If that loop is
    // ever unrolled, the test above stops covering them and this one says so.
    expect(CLIENT).toMatch(/for \(const k of CONTENT_KINDS\)/);
    expect(CLIENT).toContain('VIEWS[k.id]');
    expect(CLIENT).toContain('LOADERS[k.id]');
    expect(idsIn('TABS')).not.toContain('rules');
  });

  it('offers a sidebar destination for every kind the API serves', () => {
    // A kind added to the API but not to the sidebar is unreachable from the
    // panel, with nothing anywhere to point that out.
    expect(idsIn('CONTENT_KINDS').sort()).toEqual([...CONTENT_KINDS].sort());
  });

  /** ids from every `*_TABS` record table on the page — TABS itself excepted. */
  function recordIds(): Set<string> {
    const tables = [...CLIENT.matchAll(/const (\w+_TABS) = \[/g)].map((m) => m[1] as string);
    return new Set(tables.filter((t) => t !== 'TABS').flatMap(idsIn));
  }

  /** `{ secrets: () => secretsPanel(), … }` from a named panel table. */
  function panelTable(name: string): Map<string, string> {
    const at = CLIENT.indexOf(`const ${name} = {`);
    if (at === -1) throw new Error(`no ${name} in the client`);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n};', at));
    return new Map(
      [...body.matchAll(/(\w+): \(\) => (\w+)\(\)/g)].map((m) => [m[1] as string, m[2] as string]),
    );
  }

  it('renders a panel for each record a multi-record page offers', () => {
    // Record sub-tabs are not router tabs — they switch a panel inside one
    // view, so they need an entry in a *_PANELS table rather than in VIEWS.
    // A record added without one falls back to the first panel in silence.
    for (const [tabs, panels] of [
      ['LOG_TABS', 'LOG_PANELS'],
      ['CREDENTIAL_TABS', 'CREDENTIAL_PANELS'],
    ]) {
      const table = panelTable(panels as string);
      expect([...table.keys()]).toEqual(idsIn(tabs as string));
      for (const fn of table.values()) expect(CLIENT).toContain(`function ${fn}(`);
    }
    expect(idsIn('LOG_TABS')).toEqual(['daemon', 'audit', 'doctor']);
    expect(idsIn('CREDENTIAL_TABS')).toEqual(['secrets', 'tokens']);
  });

  it('gives every multi-record page somewhere to keep the choice', () => {
    // The segmented controls share one handler, which finds the state field
    // through RECORD_STATE. A page missing from it renders a control that does
    // nothing when clicked.
    const body = CLIENT.slice(CLIENT.indexOf('const RECORD_STATE = {'));
    const pages = [...body.slice(0, body.indexOf('};')).matchAll(/(\w+): '(\w+)'/g)];
    expect(pages.map((m) => m[1]).sort()).toEqual(['credentials', 'logs']);
    for (const [, page, field] of pages) {
      expect(idsIn('TABS')).toContain(page);
      expect(CLIENT).toContain(`${field}:`);
    }
  });

  it('redirects a tab that moved instead of dropping it on the overview', () => {
    // A destination that became a record inside another page leaves hashes
    // behind in browser history. Each one must name a tab that still exists,
    // and must not still be a tab itself or goto() would recurse.
    const table = CLIENT.slice(CLIENT.indexOf('const MOVED_TABS = {'));
    const moved = [
      ...table
        .slice(0, table.indexOf('\n};'))
        .matchAll(/(\w+): \{ tab: '(\w+)', record: '(\w+)' \}/g),
    ];
    expect(moved.length).toBeGreaterThan(2);
    for (const [, from, to, record] of moved) {
      expect(idsIn('TABS')).not.toContain(from);
      expect(idsIn('TABS')).toContain(to);
      expect(recordIds()).toContain(record);
    }
  });

  it('emits no inline style attributes', () => {
    // `style-src 'nonce-…'` authorises <style> elements, not style attributes.
    // Anything positional must be a class — see the width utilities.
    expect(CLIENT).not.toMatch(/style="/);
  });

  it('routes rendered values through the escaper', () => {
    // Not a proof, but it pins the invariant that the helper exists and is
    // used far more often than innerHTML is assigned.
    const escapes = CLIENT.match(/esc\(/g)?.length ?? 0;
    expect(escapes).toBeGreaterThan(50);
  });
});

describe('the header model chip', () => {
  it('never renders the old placeholder that said nothing at all', () => {
    expect(CLIENT).not.toContain('(auto-detected)');
  });

  it('gives each of the three states its own honest wording', () => {
    // See resolveStatusModel() in src/web/api/system.ts for the shapes this
    // renders: a detected model, a configured pin, or null.
    expect(CLIENT).toContain('function modelChip(model)');
    expect(CLIENT).toMatch(/no model detected/);
    expect(CLIENT).toContain("model.source === 'detected'");
    expect(CLIENT).toMatch(/\(pinned\)/);
  });

  it('carries the state as a title as well as the label, for a chip too narrow to say more', () => {
    const at = CLIENT.indexOf('class="status-value"');
    expect(at).toBeGreaterThan(-1);
    expect(CLIENT.slice(at, at + 80)).toContain('title="');
  });
});

describe('the system figure', () => {
  it('gives spokes role="button", not role="link" — Enter and Space both activate a button', () => {
    expect(CLIENT).not.toMatch(/role="link"/);
    expect(CLIENT).toMatch(/role="button" tabindex="0"/);
  });

  it('wires a delegated keydown listener so Enter and Space activate a focused spoke', () => {
    // An SVG <g> does not synthesise a click from the keyboard the way a real
    // <button> does — this is the fallback, delegated like the click listener
    // rather than attached per-element, and scoped to role="button" so it
    // never double-fires goto() for a data-tab control that already is one.
    const at = CLIENT.indexOf("addEventListener('keydown'");
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n});', at));
    expect(body).toContain("ev.key !== 'Enter'");
    expect(body).toContain("ev.key !== ' '");
    expect(body).toContain('[role="button"][data-tab]');
    expect(body).toContain('goto(t.dataset.tab)');
  });

  it('gives the provider spoke enough budget that neither real provider id is cut mid-word', () => {
    // The two provider ids are 'openai-compatible' (18 chars) and 'anthropic'.
    // The old 16-char budget truncated the longer one to "openai-compatib…".
    const m = CLIENT.match(/clip\(s\.provider,\s*(\d+)\)/);
    expect(m).toBeTruthy();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual('openai-compatible'.length);
  });

  it('carries the untruncated reading as a native tooltip and an aria-label', () => {
    expect(CLIENT).toContain("'<title>' + esc(spoke.title) + '</title>'");
    expect(CLIENT).toContain('aria-label="\' + esc(spoke.title) + \'"');
  });

  it('reads the connectors count from the status payload, like every other counted tab', () => {
    const at = CLIENT.indexOf("id: 'connectors'");
    expect(at).toBeGreaterThan(-1);
    const section = CLIENT.slice(at, CLIENT.indexOf('},', at));
    expect(section).toContain('state.status.counts.connectedConnectors');
    expect(section).not.toContain('state.loaded.has');
  });
});

describe('inert content: told apart by why, not painted red on sight', () => {
  it('branches on the category field the API sends, not on the wording of the reason sentence', () => {
    // Behavioural, not textual: this actually runs splitInert() extracted
    // from the client source against fixture data, the way authored.ts
    // actually shapes it — category alongside reason, from one place. A
    // reason that reads like the old "written for " string match would have
    // caught it, but whose category is 'misconfigured', must NOT land in the
    // dormant bucket: that is the trap this change removes, proven by
    // actually running the code rather than restating its source.
    interface InertItem {
      rel: string;
      reason: string;
      category: string;
    }
    type SplitInert = (items: InertItem[]) => { design: InertItem[]; broken: InertItem[] };
    const splitInert = new Function(
      `${functionSource('splitInert')}; return splitInert;`,
    )() as SplitInert;

    const items: InertItem[] = [
      { rel: 'python/lint.md', reason: 'entirely reworded prose', category: 'other-language' },
      { rel: 'notes/deep/x.md', reason: 'nested too deep', category: 'misconfigured' },
      { rel: 'hollow.md', reason: 'no prompt body', category: 'misconfigured' },
      // Reads exactly like the retired string match would have caught, but
      // is not category: 'other-language'.
      { rel: 'trap.md', reason: 'written for nobody in particular', category: 'misconfigured' },
    ];

    const { design, broken } = splitInert(items);
    expect(design.map((i) => i.rel)).toEqual(['python/lint.md']);
    expect(broken.map((i) => i.rel)).toEqual(['notes/deep/x.md', 'hollow.md', 'trap.md']);
  });

  it('leads Rules with what is in effect, and Agents with what is available, before either inert list', () => {
    const rulesAt = CLIENT.indexOf('function viewRules()');
    expect(rulesAt).toBeGreaterThan(-1);
    const rulesBody = CLIENT.slice(rulesAt, CLIENT.indexOf('\n// --- agents', rulesAt));
    const inEffect = rulesBody.indexOf("'In effect, in load order'");
    const rulesInert = rulesBody.indexOf('inertCard(d.inert)');
    expect(inEffect).toBeGreaterThan(-1);
    expect(rulesInert).toBeGreaterThan(inEffect);

    const agentsAt = CLIENT.indexOf('function viewAgents()');
    expect(agentsAt).toBeGreaterThan(-1);
    const agentsBody = CLIENT.slice(agentsAt, CLIENT.indexOf('\n// --- souls', agentsAt));
    const grid = agentsBody.indexOf('editor-grid');
    const agentsInert = agentsBody.indexOf('inertCard(d.inert)');
    expect(grid).toBeGreaterThan(-1);
    expect(agentsInert).toBeGreaterThan(grid);
  });

  it("badges Rules' summary with real counts instead of one destructive badge for every inert file", () => {
    const at = CLIENT.indexOf('function viewRules()');
    const body = CLIENT.slice(at, CLIENT.indexOf('\n// --- agents', at));
    expect(body).toContain('splitInert(d.inert)');
    expect(body).toContain("' for another language'");
  });

  it("collapses rules written for a different language behind a native disclosure, and keeps a genuine misconfiguration in the doctor panel's red", () => {
    expect(CLIENT).toContain('<details class="dormant">');
    expect(CLIENT).toContain('<summary class="dormant-summary">');
    // The row helper still reaches for check-bad — Skills' and the doctor
    // panel's own red — for anything that is not the language-mismatch case.
    expect(CLIENT).toContain("bad ? ' check-bad' : ' check-dim'");
    expect(CLIENT).toContain("(bad ? '✗' : '–')");
  });

  it('marks the current agent row and file row with aria-current="page", not a stringified boolean', () => {
    const agentGroupsAt = CLIENT.indexOf('function agentGroups(d)');
    expect(agentGroupsAt).toBeGreaterThan(-1);
    const agentGroupsBody = CLIENT.slice(
      agentGroupsAt,
      CLIENT.indexOf('\nfunction viewAgents', agentGroupsAt),
    );
    expect(agentGroupsBody).toContain('aria-current="page"');
    expect(agentGroupsBody).not.toMatch(/aria-current="'\s*\+/);

    const fileListAt = CLIENT.indexOf('function viewContentBody(kind)');
    expect(fileListAt).toBeGreaterThan(-1);
    const fileListBody = CLIENT.slice(
      fileListAt,
      CLIENT.indexOf('\nasync function openFile', fileListAt),
    );
    expect(fileListBody).toContain('aria-current="page"');
    expect(fileListBody).not.toMatch(/aria-current="'\s*\+/);
  });

  it('gives Hooks a real empty state — what a hook is and the action that adds one — instead of a lone sentence above dead space', () => {
    expect(CLIENT).toContain('function emptyState(title, body, action)');
    const at = CLIENT.indexOf('function viewHooks()');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function saveHook', at));
    expect(body).toContain('emptyState(');
    expect(body).toContain('No hooks yet');
    expect(body).toContain('data-expand="hook-add"');
  });

  it('caps the agent list the same way the skill list is capped, so a short detail panel is not stretched by a runaway sibling', () => {
    // .agent-list-body had no such rule at all — the list grew to fit all 27
    // bundled agents (1239px measured) and dragged the grid row with it.
    const rule = ruleBody(STYLES, '.agent-list-body {');
    expect(rule).toContain('max-height: 46vh');
    expect(rule).toContain('overflow-y: auto');
  });

  it("styles the inert-by-design disclosure as neither the doctor panel's red nor its green", () => {
    expect(ruleBody(STYLES, '.check-dim .check-mark {')).toContain('var(--ink-faint)');
    expect(STYLES).toContain('.dormant {');
    expect(STYLES).toContain('.dormant[open] .dormant-summary .icon { transform: rotate(90deg); }');
  });

  it('defines the informative empty state used by Hooks', () => {
    expect(STYLES).toContain('.empty-state {');
    expect(STYLES).toContain('.empty-state-title {');
    expect(STYLES).toContain('.empty-state-action {');
  });
});

describe('the stylesheet', () => {
  it('gives dark every palette token light defines', () => {
    // Type scale, radii, timings, the rail's own colours and layout metrics
    // are declared once and are the same in both themes by design. Everything
    // else is palette, and a palette token present in one theme and absent
    // from the other silently resolves to the wrong colour.
    const structural = /^--(rail|bar$|font-|r-|t-|track-|dur$|ease$|shadow-\d)/;
    const light = customProperties(ruleBody(STYLES, ':root {'));
    const dark = customProperties(ruleBody(STYLES, ':root[data-theme="dark"] {'));

    const missing = [...light].filter((t) => !structural.test(t) && !dark.has(t));
    expect(missing).toEqual([]);
  });

  it('fills the primary button with --signal-strong, not --signal', () => {
    // The two roles need opposite lightness: as a fill under white
    // --signal-ink text the token has to be darker than it does as text on
    // the page (.log-warn, .link). In dark theme --signal as a fill measured
    // 3.83:1, under the 4.5:1 floor, while its text role was already passing
    // -- so the fill got its own token. A revert to var(--signal) here fails
    // silently in the browser, which is what this test is for.
    const rule = ruleBody(COMPONENTS, '.btn-default {');
    expect(rule).toContain('var(--signal-strong)');
    expect(rule).not.toMatch(/background:\s*var\(--signal\)/);
  });

  it('keeps the muted-text and boundary tokens above their WCAG AA floor', () => {
    // Locks in the contrast fix: --ink-faint, --border-strong, --rail-dim and
    // --tide (paired with --tide-wash, its own background in .badge-success)
    // all measured under AA in both themes -- see theme.ts for the live
    // numbers. --surface-high is each one's tightest real background (the
    // closest neighbour in lightness -- e.g. .badge-muted puts --ink-faint
    // directly on it), so that is the floor checked here, not --surface or
    // --bg, which are easier.
    const AA_TEXT = 4.5; // WCAG 1.4.3, text under 18.66px/14pt-bold
    const AA_UI = 3; // WCAG 1.4.11, a form control's own boundary

    const light = ruleBody(STYLES, ':root {');
    const dark = ruleBody(STYLES, ':root[data-theme="dark"] {');
    const lightSurfaceHigh = oklchToRgb(tokenOklch(light, '--surface-high'));
    const darkSurfaceHigh = oklchToRgb(tokenOklch(dark, '--surface-high'));

    expect(
      contrastRatio(oklchToRgb(tokenOklch(light, '--ink-faint')), lightSurfaceHigh),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(
      contrastRatio(oklchToRgb(tokenOklch(dark, '--ink-faint')), darkSurfaceHigh),
    ).toBeGreaterThanOrEqual(AA_TEXT);

    expect(
      contrastRatio(oklchToRgb(tokenOklch(light, '--border-strong')), lightSurfaceHigh),
    ).toBeGreaterThanOrEqual(AA_UI);
    expect(
      contrastRatio(oklchToRgb(tokenOklch(dark, '--border-strong')), darkSurfaceHigh),
    ).toBeGreaterThanOrEqual(AA_UI);

    // --rail-dim is declared once, shared by both themes -- checked against
    // --rail-high, its own pill background in .nav-count.
    const railHigh = oklchToRgb(tokenOklch(light, '--rail-high'));
    expect(
      contrastRatio(oklchToRgb(tokenOklch(light, '--rail-dim')), railHigh),
    ).toBeGreaterThanOrEqual(AA_TEXT);

    // --tide as .badge-success's text, against --tide-wash composited over
    // --surface-high -- the pairing that actually renders, not --tide alone.
    for (const [block, surfaceHigh] of [
      [light, lightSurfaceHigh],
      [dark, darkSurfaceHigh],
    ] as const) {
      const tide = tokenOklch(block, '--tide');
      const wash = tokenOklch(block, '--tide-wash');
      const washedBg = compositeOver(oklchToRgb(wash), wash.a, surfaceHigh);
      expect(contrastRatio(oklchToRgb(tide), washedBg)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('lets an explicit light choice survive an OS set to dark', () => {
    // The media query is guarded rather than relying on source order; without
    // the guard, a user on a dark desktop could not choose light.
    expect(STYLES).toContain(':root:not([data-theme="light"])');
  });

  it('defines every button and badge variant the client can emit', () => {
    const variants = [
      ...[...CLIENT.matchAll(/variant: '([\w-]+)'/g)].map((m) => `btn-${m[1]}`),
      ...[...CLIENT.matchAll(/badge badge-' \+ \(variant \|\| '([\w-]+)'\)/g)].map(
        (m) => `badge-${m[1]}`,
      ),
    ];
    expect(variants.length).toBeGreaterThan(3);
    for (const v of new Set(variants)) expect(STYLES).toContain(`.${v}`);
  });

  it('quantises the width utilities the skeletons use', () => {
    // Anchored to the class attribute: a bare /\bw\d+\b/ also matched the `w3`
    // in the SVG namespace URL the icon builder emits.
    const used = [...CLIENT.matchAll(/class="[^"]*?\bw(\d+)\b/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const w of used) expect(STYLES).toContain(`.w${w} {`);
  });
});

describe('responsive layout at 375px', () => {
  it('lets the editor grid track shrink below a nowrap description', () => {
    // Regression for skills/agents overflowing the body 193-201px at 375px:
    // a grid item's automatic minimum size is its subtree's min-content,
    // and .skill-item-desc's white-space: nowrap made that the whole
    // description string. min-width: 0 on the grid item turns that off, the
    // same fix .overview-grid > * already uses.
    expect(STYLES).toContain('.overview-grid > * { min-width: 0; }');
    expect(STYLES).toContain('.editor-grid > * { min-width: 0; }');
  });

  it('still ellipsises the skill description on one line rather than wrapping or hard-clipping it', () => {
    const body = ruleBody(STYLES, '.skill-item-desc {');
    expect(body).toContain('white-space: nowrap');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('overflow: hidden');
  });

  it('turns the rail into a single scrolling strip below 640px instead of wrapped rows', () => {
    const media = mediaBody(STYLES, '@media (max-width: 640px)');
    expect(media).toContain('.nav {');
    const nav = ruleBody(media, '.nav {');
    expect(nav).toContain('flex-wrap: nowrap');
    expect(nav).toContain('overflow-x: auto');
    // The strip must scroll inside .nav, never carry the page's own body
    // past the viewport — overflow-y is capped shut so only the x axis moves.
    expect(nav).toContain('overflow-y: hidden');
  });

  it('keeps every destination in the strip reachable — nothing in it is display: none', () => {
    const media = mediaBody(STYLES, '@media (max-width: 640px)');
    expect(media).not.toMatch(/\.nav-item[^{]*\{\s*[^}]*display:\s*none/);
    // The group headings are allowed to disappear — they are labels, not
    // destinations — but the 11 buttons they used to separate must remain.
    expect(ruleBody(media, '.nav-group {')).toContain('display: none');
  });

  it('gives the log message its own row and priority over the fixed time/level columns', () => {
    const media = mediaBody(STYLES, '@media (max-width: 640px)');
    const logLine = ruleBody(media, '.log-line {');
    expect(logLine).toContain('grid-template-columns: auto 1fr');
    const logMsg = ruleBody(media, '.log-msg {');
    expect(logMsg).toContain('grid-column: 1 / -1');
  });

  it('raises .btn, .input/.select, .tabs-trigger and the icon-button width to 44px under a coarse pointer or a narrow viewport, and nowhere else', () => {
    const atRule = '@media (pointer: coarse), (max-width: 768px)';
    const componentsTouch = mediaBody(COMPONENTS, atRule);
    expect(componentsTouch).toContain('.btn { min-height: 2.75rem; }');
    expect(componentsTouch).toContain('.btn-icon { width: 2.75rem; }');
    expect(componentsTouch).toMatch(/\.input,\s*\.select\s*\{\s*min-height: 2\.75rem;/);
    // A short pill like "All" needs a width floor too, or the taller box
    // stays exactly as narrow as it was.
    expect(ruleBody(componentsTouch, '.tabs-trigger {')).toContain('min-width: 2.75rem');

    // 2.75rem is 44px at the 16px root this panel assumes throughout.
    // Unscoped, .btn is still the dense 2rem/32px it was — the gate above is
    // what keeps 1440px untouched.
    expect(COMPONENTS).toContain('height: 2rem; padding: 0 0.7rem; white-space: nowrap;');
  });

  it("grows the switch's hit area instead of the rocker itself, since 44px would stop it looking like a switch", () => {
    const atRule = '@media (pointer: coarse), (max-width: 768px)';
    const componentsTouch = mediaBody(COMPONENTS, atRule);
    expect(componentsTouch).toContain('.switch { position: relative; }');
    const before = ruleBody(componentsTouch, '.switch::before {');
    expect(before).toContain('width: 2.75rem');
    expect(before).toContain('height: 2.75rem');
    expect(before).toContain('position: absolute');
    // The rocker's own footprint is untouched — only the invisible pseudo grew.
    expect(ruleBody(STYLES, '.switch {\n  display: inline-flex')).toContain(
      'width: 2.1rem; height: 1.1rem;',
    );
  });

  it('raises the rail, settings-index and file-list buttons to 44px under the same gate', () => {
    const atRule = '@media (pointer: coarse), (max-width: 768px)';
    // The components.ts block above owns .btn/.input/.switch; this is the
    // second block, contributed by styles.ts for the page-chrome buttons —
    // both land in STYLES, so the search has to skip past the first one.
    const from = STYLES.indexOf(atRule) + atRule.length;
    const layoutTouch = mediaBody(STYLES, atRule, from);
    expect(layoutTouch).toMatch(
      /\.nav-item,\s*\.toc-item,\s*\.file-item\s*\{\s*min-height: 2\.75rem;/,
    );
    expect(layoutTouch).toContain('.skill-item { min-height: 2.75rem;');
  });

  it('does not let the grid stretch a short auto row to fill the min-height it was only there to floor', () => {
    // Regression found while verifying the nav strip above: .shell keeps
    // min-height: 100vh so a short page still fills the viewport, but a grid
    // with leftover block-axis space stretches auto rows into it by default.
    // Invisible while .rail's row was tall on its own (the old wrapped
    // chips); once the strip made it short, a page with little content below
    // it (Hooks, nothing configured) inflated every nav-item in it to
    // 177px tall. align-content: start leaves the extra height where a short
    // page already puts it — after .main's content — instead of stretching
    // into .rail.
    const shell = ruleBody(STYLES, '.shell {');
    expect(shell).toContain('min-height: 100vh');
    expect(shell).toContain('align-content: start');
  });

  it('lets a row with four actions wrap them below the detail text instead of squeezing it to nothing', () => {
    // Pre-existing, not caused by this pass's changes (reproduces against
    // the unmodified file), but surfaced by the same 375px screenshot pass:
    // an OAuth-connected MCP server's row (Reconnect/Disconnect/Disable/
    // Delete) left .list-row-grow — and the URL in it — 0px wide, rendered
    // as overflow-wrap: anywhere breaking every character onto its own line.
    const listRow = ruleBody(STYLES, '.list-row {');
    expect(listRow).toContain('flex-wrap: wrap');
    const actions = ruleBody(STYLES, '.list-row > .section-actions {');
    // 0 0 auto: it must not grow at the detail text's expense in the common
    // (two-button) row, and must not shrink either — flex-wrap on the
    // parent is what sends it to its own line when it doesn't fit.
    expect(actions).toContain('flex: 0 0 auto');
  });
});

describe('renderIndexHtml', () => {
  const nonce = 'test-nonce-value';

  it('serves the locked page when unauthenticated, with no app script', () => {
    const html = renderIndexHtml({ nonce, authenticated: false });
    expect(html).toContain('needs an access token');
    // The client is what talks to /api; shipping it to an unauthenticated
    // visitor would be handing over the panel's whole surface area.
    expect(html).not.toContain('const state =');
    expect(html).not.toContain('<div class="shell">');
  });

  it('serves the panel when authenticated', () => {
    const html = renderIndexHtml({ nonce, authenticated: true });
    expect(html).toContain('<div class="shell">');
    expect(html).toContain('const state =');
    expect(html).toContain('Asterisk control panel');
  });

  it('carries the nonce on every style and script element', () => {
    for (const authenticated of [true, false]) {
      const html = renderIndexHtml({ nonce, authenticated });
      const tags = html.match(/<(style|script)\b[^>]*>/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it('escapes a nonce that would otherwise break out of the attribute', () => {
    // The nonce is generated server-side and is base64, so this is defence in
    // depth rather than a live hole — but it is one substitution away from
    // being an injection point, and the escaping is free.
    const html = renderIndexHtml({ nonce: 'a"><script>alert(1)</script>', authenticated: true });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('emits no inline style attributes', () => {
    for (const authenticated of [true, false]) {
      const html = renderIndexHtml({ nonce, authenticated });
      // The favicon is a data: URI containing SVG markup with fill attributes;
      // strip it before looking, or it reads as a false positive.
      expect(html.replace(/href="data:[^"]*"/g, '')).not.toMatch(/style="/);
    }
  });

  it('leaves the theme unset so the OS preference wins on first paint', () => {
    // The client restores an explicit choice from localStorage; until then the
    // page must not assert a theme, or a dark-desktop user gets a white flash.
    expect(renderIndexHtml({ nonce, authenticated: true })).toContain('data-theme=""');
  });
});

describe('heading levels: one h1 per view, h2 nested under it', () => {
  it('gives every view a real h1 from pageHeader, not an h2', () => {
    // Every view calls this exactly once at the top of what it returns
    // (checked by grep across app-core/app-settings/app-skills/app-authored/
    // app-views/app-connectors: 15 call sites, one per view render), so this
    // is the only heading-producing function that needs to change to give
    // every tab exactly one h1.
    const at = CLIENT.indexOf('pageHeader(title, description, subject) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n  },', at));
    expect(body).toContain('<h1 class="page-title">');
    expect(body).toContain('</h1>');
  });

  it('nests card titles one level under the page h1', () => {
    const at = CLIENT.indexOf('card(title, body, opts) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n  },', at));
    expect(body).toContain('<h2 class="card-title">');
  });

  it('never leaves the old h2 page-title or h3 card-title in the shipped script', () => {
    // Locks the migration in both directions: an h1 that regressed back to h2
    // would re-create the "no h1 at all" defect, and a stray h3 would open a
    // level-2 gap under the new h1.
    expect(CLIENT).not.toContain('<h2 class="page-title">');
    expect(CLIENT).not.toContain('<h3 class="card-title">');
  });

  it('keeps the settings section heading at h2, level with card titles rather than the page h1', () => {
    expect(CLIENT).toContain('<h2 class="settings-section-name">');
  });

  it('renders the rail brand as a plain div, never a competing h1', () => {
    // pageHeader's h1 changes with every tab; a static "Asterisk" h1 beside
    // it would leave two h1s on the page, or one that never describes what
    // is actually on screen. See the comment on pageHeader() in app-core.ts.
    const html = renderIndexHtml({ nonce: 'test-nonce-value', authenticated: true });
    expect(html).toContain('<div class="brand-name">Asterisk</div>');
    expect(html).not.toMatch(/<h1[^>]*>Asterisk/);
  });
});

describe('list semantics for genuine collections', () => {
  it('offers ui.list() as an opt-in wrapper, not a real <ul> the stylesheet has no reset for', () => {
    const at = CLIENT.indexOf('list(rowsHtml, label) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n  },', at));
    expect(body).toContain('role="list"');
    expect(body).not.toContain('<ul');
  });

  it('keeps listRow\'s role="listitem" opt-in, off by default for the unlike-facts rows it also renders', () => {
    const at = CLIENT.indexOf('listRow(title, detail, actions, leading, listItem) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n  },', at));
    expect(body).toContain("(listItem ? ' role=\"listitem\"' : '')");
  });

  it('wraps the Problems list in role="list", with each row as a listitem', () => {
    const rowAt = CLIENT.indexOf('function skillIssueRow(issue, root) {');
    expect(rowAt).toBeGreaterThan(-1);
    const rowBody = CLIENT.slice(rowAt, CLIENT.indexOf('\nfunction skillIssuesCard', rowAt));
    expect(rowBody).toContain('<div class="list-row" role="listitem">');

    const cardAt = CLIENT.indexOf('function skillIssuesCard(data) {');
    const cardBody = CLIENT.slice(cardAt, CLIENT.indexOf('\nfunction matchingSkills', cardAt));
    expect(cardBody).toContain('ui.list(');
  });

  it('wraps each scope of the Skills list in its own role="list", with buttons kept inside a listitem wrapper rather than losing role="button"', () => {
    const at = CLIENT.indexOf('function skillGroups(data) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction skillListCard', at));
    expect(body).toContain('ui.list(');
    expect(body).toContain('<div role="listitem"><button class="skill-item"');
  });
});

describe('aria-current: never the literal string "false"', () => {
  it('omits aria-current from an inactive nav item instead of stringifying the boolean', () => {
    const at = CLIENT.indexOf('function renderSidebar()');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction healthOf', at));
    // The old bug: `'aria-current="' + current + '"'` wrote the literal
    // string "false" on every one of the other tabs.
    expect(body).not.toMatch(/aria-current="'\s*\+\s*current\s*\+/);
    expect(body).toContain('aria-current="page"');
  });

  it('omits aria-current from an inactive settings TOC item, at render time and when the scroll observer moves it', () => {
    const indexAt = CLIENT.indexOf('function settingsIndex(groups)');
    expect(indexAt).toBeGreaterThan(-1);
    const indexBody = CLIENT.slice(indexAt, CLIENT.indexOf('\nfunction settingsSections', indexAt));
    expect(indexBody).not.toMatch(/aria-current="'\s*\+\s*\(state\.settingsSection/);
    expect(indexBody).toContain('aria-current="page"');

    const watchAt = CLIENT.indexOf('function watchSettingsSections()');
    expect(watchAt).toBeGreaterThan(-1);
    const watchBody = CLIENT.slice(
      watchAt,
      CLIENT.indexOf('\nfunction fieldErrorsFromDetail', watchAt),
    );
    expect(watchBody).not.toContain("item.setAttribute('aria-current', String(");
    expect(watchBody).toContain("item.removeAttribute('aria-current')");
  });

  it('marks the current skill row aria-current="page" — styles.ts\'s .skill-item rule already matches it', () => {
    const at = CLIENT.indexOf('function skillGroups(data) {');
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction skillListCard', at));
    expect(body).not.toMatch(/aria-current="'\s*\+/);
    expect(body).toContain('aria-current="page"');

    // Guards the precondition every one of these rows relies on: styles.ts
    // matches on the attribute's PRESENCE, so the token can be the correct
    // one without the highlight depending on which word it is. A rule that
    // pins a value here would make the next correct token a silent
    // regression — which is how "true" got entrenched in the first place.
    expect(STYLES).not.toMatch(/\[aria-current="(true|page)"\]/);
    expect(ruleBody(STYLES, '.skill-item[aria-current] {').length).toBeGreaterThan(0);
  });
});

describe('toast severity: an error interrupts, success does not', () => {
  it('marks an error toast role="alert"/aria-live="assertive", and a success one role="status"/"polite"', () => {
    const at = CLIENT.indexOf('function toast(message, kind, detail)');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function api', at));
    expect(body).toContain("setAttribute('role', bad ? 'alert' : 'status')");
    expect(body).toContain("setAttribute('aria-live', bad ? 'assertive' : 'polite')");
  });

  it('keeps the toasts host as the container-level default, role="status"/"polite"', () => {
    const html = renderIndexHtml({ nonce: 'test-nonce-value', authenticated: true });
    expect(html).toContain('<div class="toasts" role="status" aria-live="polite"></div>');
  });

  it('wraps every api() call in guard() or an equivalent try/catch that toasts, so a failure always reaches the user rather than only the console', () => {
    const allApiRefs = (CLIENT.match(/\bapi\(/g) || []).length;
    const definition = (CLIENT.match(/async function api\(path, options\)/g) || []).length;
    const guarded = (CLIENT.match(/guard\(\(\) => api\(/g) || []).length;
    expect(definition).toBe(1);
    // applySettings() is the one deliberate exception: it calls api()
    // directly, outside guard(), specifically so it can read the raw error's
    // per-field detail (see fieldErrorsFromDetail in app-settings.ts) — but
    // its own try/catch still toasts on failure, so the invariant that
    // matters (a failure always reaches the user, never only the console)
    // holds without going through guard() by name.
    const unguarded = allApiRefs - definition - guarded;
    expect(unguarded).toBe(1);
    expect(guarded).toBeGreaterThan(10);

    const at = CLIENT.indexOf('async function applySettings() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nconst LOG_LEVELS', at));
    expect(body).toContain('try {');
    expect(body).toContain('await api(');
    expect(body).toMatch(/catch \(e\) \{[\s\S]*toast\(/);
  });
});

describe('Settings: validation is associated with the field, not left only in a toast', () => {
  it('has no scalar setting that is genuinely required — every field has a schema default or is optional', () => {
    // Grounds the reasoning in fieldControlId/fieldErrorId's comment in
    // app-settings.ts: required/aria-required has nothing honest to attach
    // to on this generated page. If a field is ever added to ConfigSchema
    // with neither a .default() nor .optional(), this is what notices.
    const missing = settingsRegistry().filter((f) => f.default === undefined && !f.optional);
    expect(missing).toEqual([]);
  });

  it('renders each field\'s control with aria-describedby pointing at an always-present, initially empty role="alert" node', () => {
    const rowAt = CLIENT.indexOf('function fieldRow(field) {');
    expect(rowAt).toBeGreaterThan(-1);
    const rowBody = CLIENT.slice(rowAt, CLIENT.indexOf('\nfunction control', rowAt));
    expect(rowBody).toContain('<div id="\' + esc(errId) + \'" role="alert"></div>');

    const controlAt = CLIENT.indexOf('function control(field, value, id, errId) {');
    expect(controlAt).toBeGreaterThan(-1);
    const controlBody = CLIENT.slice(
      controlAt,
      CLIENT.indexOf('\nfunction showFieldError', controlAt),
    );
    expect(controlBody).toContain('aria-describedby="\' + esc(errId) + \'"');
    // Present on all four control kinds (switch, select, number, text/array),
    // not just the plain text-input fallback.
    expect((controlBody.match(/describedBy/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it('reports a parse failure next to the field before the toast-only path even runs', () => {
    const uncheckedAt = CLIENT.indexOf('function parseFieldValueUnchecked(field, raw) {');
    expect(uncheckedAt).toBeGreaterThan(-1);

    const wrapperAt = CLIENT.indexOf('function parseFieldValue(field, raw) {');
    expect(wrapperAt).toBeGreaterThan(uncheckedAt);
    const wrapperBody = CLIENT.slice(wrapperAt, CLIENT.indexOf('\nfunction findField', wrapperAt));
    expect(wrapperBody).toContain('parseFieldValueUnchecked(field, raw)');
    expect(wrapperBody).toContain('showFieldError(field.path, e.message)');
    expect(wrapperBody).toContain('throw e');
  });

  it("clears a field's error the moment a valid edit is staged", () => {
    const at = CLIENT.indexOf('function stageEdit(path, value) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction renderSaveBar', at));
    expect(body).toContain('clearFieldError(path)');
  });

  it("maps PATCH /settings' per-field 422 detail back onto the fields that failed, and drops the shape it cannot map", () => {
    const at = CLIENT.indexOf('function fieldErrorsFromDetail(detail) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function applySettings', at));
    expect(body).toContain('JSON.parse(detail)');
    expect(body).toContain("typeof message === 'string' && findField(path)");
  });

  it('shows every field the server rejected and focuses the first one, instead of leaving focus on Apply', () => {
    const at = CLIENT.indexOf('async function applySettings() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nconst LOG_LEVELS', at));
    expect(body).toContain('fieldErrorsFromDetail(e.detail)');
    expect(body).toContain('showFieldError(path, fieldErrors[path])');
    expect(body).toContain('focusField(paths[0])');
    // Still toasts too — the inline message is in addition to, not instead
    // of, the existing feedback.
    expect(body).toContain("toast(e.message, 'bad', e.detail)");
    expect(body).toContain("toast('Settings applied', 'good')");
  });
});

describe('Skills: the New skill form marks its two required fields and reports failures accessibly', () => {
  it('marks name and description required and aria-required, each wired to its own error node', () => {
    const at = CLIENT.indexOf('function skillCreateCard() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction viewSkills', at));
    for (const field of ['skill-name', 'skill-description']) {
      expect(body).toContain(`id="${field}"`);
      expect(body).toContain('required aria-required="true"');
      expect(body).toContain(`aria-describedby="${field}-error"`);
      expect(body).toContain(`<div id="${field}-error" role="alert">`);
    }
  });

  it('reports a missing field next to it and moves focus to the first one missing, not just a toast', () => {
    const at = CLIENT.indexOf('async function createSkill() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction relativeTo', at));
    expect(body).toContain("setSkillFormError('name', name ? '' : 'A name is required.')");
    expect(body).toContain(
      "setSkillFormError('description', description ? '' : 'A description is required.')",
    );
    expect(body).toContain("$('#skill-' + (name ? 'description' : 'name')).focus()");
  });
});

describe('list semantics: the genuine collections in app-views.ts and app-connectors.ts', () => {
  it('wraps the MCP servers list in role="list" via ui.list(), with each row a listitem', () => {
    const at = CLIENT.indexOf('function viewMcp() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction parsePairs', at));
    expect(body).toContain('ui.list(state.mcp.map((s) => ui.listRow(');
    expect(body).toContain("'MCP servers'");
    // listItem is listRow's 5th argument — confirms the opt-in was actually
    // passed, not just that ui.list() wraps an unmarked stack of divs.
    expect(body).toMatch(/ui\.stateBadge\(s\.enabled\),\s*\n\s*true\s*\n\s*\)\)\.join/);
  });

  it('wraps the Hooks list in role="list() via ui.list(), with each row a listitem', () => {
    const at = CLIENT.indexOf('function viewHooks() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function saveHook', at));
    expect(body).toContain('ui.list(state.hooks.map((h) => ui.listRow(');
    expect(body).toContain("'Hooks'");
    expect(body).toMatch(/ui\.stateBadge\(h\.enabled\),\s*\n\s*true\s*\n\s*\)\)\.join/);
    // The empty state (no hooks configured yet) is untouched — emptyState()
    // is not a collection and must not gain role="list".
    expect(body).toContain('emptyState(');
  });

  it('wraps the Connectors table in role="list() via ui.list(), with each row a listitem', () => {
    const at = CLIENT.indexOf('function connectorRows() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction copyField', at));
    expect(body).toContain('ui.list(shown.map((c) => ui.listRow(');
    expect(body).toContain("'Connectors'");
    expect(body).toMatch(/'<div class="connector-mark">.*<\/div>',\s*\n\s*true\s*\n\s*\)\)\.join/);
  });

  it('leaves the popular-connector cards unwrapped — a CSS grid, not a list-row flow', () => {
    // Documented judgement call: connectorCards() renders '.connector-cards',
    // a CSS grid keyed off its DIRECT children (repeat(auto-fit, ...)) in
    // components.ts. ui.list() always inserts one more wrapping div, which
    // would leave the grid container with a single child and collapse the
    // responsive layout. Every one of these connectors is also reachable,
    // fully row-marked, through connectorRows() above.
    const at = CLIENT.indexOf('function connectorCards() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction setConnectorFormError', at));
    expect(body).not.toContain('ui.list(');
    expect(body).not.toContain('role="listitem"');
  });

  it('wraps the Stored keys list in role="list", marking each row a listitem directly (not built through listRow)', () => {
    const at = CLIENT.indexOf('function secretsPanel() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n// --- content editor', at));
    expect(body).toContain('role="listitem"');
    expect(body).toContain("ui.list(rows, 'Stored keys')");
  });

  it('wraps the Issued tokens list in role="list() via ui.list(), with each row a listitem', () => {
    const at = CLIENT.indexOf('function tokensPanel() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction viewCredentials', at));
    expect(body).toContain('ui.list(state.tokens.map((t) => ui.listRow(');
    expect(body).toContain("'Issued tokens'");
  });

  it('wraps the Audit trail list in role="list() via ui.list(), with each row a listitem', () => {
    const at = CLIENT.indexOf('function auditPanel() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n// --- data loading', at));
    expect(body).toContain('ui.list(entries.map((a) => ui.listRow(');
    expect(body).toContain("'Audit trail'");
  });

  it('wraps each content kind\'s file list in role="list", buttons kept inside a listitem wrapper rather than losing role="button"', () => {
    const at = CLIENT.indexOf('function viewContentBody(kind) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function openFile', at));
    expect(body).toContain('ui.list(entry.files.map((f) => {');
    expect(body).toContain("label + ' files'");
    expect(body).toContain('<div role="listitem"><button class="file-item"');
    // aria-current="page" must survive the wrap — see the aria-current
    // describe block elsewhere in this file for why the literal string
    // "false" must never appear here.
    expect(body).toContain('aria-current="page"');
  });

  it("does not turn Overview's unlike-facts rows (Daemon / Telegram bridge / Database / Settings backup) into a list", () => {
    // Overview lives in app-core.ts, which this project is not touching this
    // round — this guards the invariant from the outside: viewOverview()'s
    // four ui.listRow() calls must still omit the listItem argument, because
    // they are four different facts about the install, not four of a kind.
    const at = CLIENT.indexOf('function viewOverview() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n\n', CLIENT.indexOf('overview-grid', at)));
    expect(body).not.toContain('ui.list(');
    const listRowCalls = body.match(/ui\.listRow\(/g) || [];
    expect(listRowCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('MCP and Hooks add-forms report empty-submit failures accessibly', () => {
  it('marks MCP name and command/URL required and aria-required, each wired to its own error node', () => {
    const at = CLIENT.indexOf('function viewMcp() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction parsePairs', at));
    for (const field of ['mcp-name', 'mcp-command']) {
      expect(body).toContain(`id="${field}"`);
      expect(body).toContain('required aria-required="true"');
      expect(body).toContain(`aria-describedby="${field}-error"`);
      expect(body).toContain(`<div id="${field}-error" role="alert"></div>`);
    }
    // Transport, auth and env all carry usable defaults server-side and stay
    // unmarked — only the two fields the schema actually rejects empty.
    expect(body).not.toContain('id="mcp-transport" required');
    expect(body).not.toContain('id="mcp-env" required');
  });

  it('reports a missing MCP field next to it and moves focus to the first one missing, not just a toast', () => {
    const at = CLIENT.indexOf('async function saveMcp() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n// --- hooks', at));
    expect(body).toContain("setAddFormError('mcp-name', name ? '' : 'A name is required.')");
    expect(body).toContain(
      "setAddFormError('mcp-command', target ? '' : 'A command or URL is required.')",
    );
    expect(body).toContain("$('#mcp-' + (name ? 'command' : 'name')).focus()");
    // Still toasts too — in addition to, not instead of, the inline message.
    expect(body).toContain("toast('Name and command/URL are required', 'bad')");
  });

  it('marks Hook name and command required and aria-required, each wired to its own error node', () => {
    const at = CLIENT.indexOf('function viewHooks() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function saveHook', at));
    for (const field of ['hook-name', 'hook-command']) {
      expect(body).toContain(`id="${field}"`);
      expect(body).toContain('required aria-required="true"');
      expect(body).toContain(`aria-describedby="${field}-error"`);
      expect(body).toContain(`<div id="${field}-error" role="alert"></div>`);
    }
    // Event always carries a value from the <select>, matcher is genuinely
    // optional, and timeout defaults to 30 — none of the three are marked.
    expect(body).not.toContain('id="hook-event" required');
    expect(body).not.toContain('id="hook-matcher" required');
    expect(body).not.toContain('id="hook-timeout" required');
  });

  it('reports a missing Hook field next to it and moves focus to the first one missing, not just a toast', () => {
    const at = CLIENT.indexOf('async function saveHook() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\n// --- secrets', at));
    expect(body).toContain("setAddFormError('hook-name', hook.name ? '' : 'A name is required.')");
    expect(body).toContain(
      "setAddFormError('hook-command', hook.command ? '' : 'A command is required.')",
    );
    expect(body).toContain("$('#hook-' + (hook.name ? 'command' : 'name')).focus()");
    expect(body).toContain("toast('Name and command are required', 'bad')");
  });
});

describe('Connectors: the setup panel and custom-add form report empty-submit failures accessibly', () => {
  it('marks the token field required, wired to its own error node', () => {
    const at = CLIENT.indexOf('function connectorSetupPanel() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction viewConnectors', at));
    expect(body).toContain('id="setup-token"');
    expect(body).toContain('required aria-required="true"');
    expect(body).toContain('aria-describedby="setup-token-error"');
    expect(body).toContain('<div id="setup-token-error" role="alert"></div>');

    expect(body).toContain('id="setup-client-id"');
    expect(body).toContain('aria-describedby="setup-client-id-error"');
    expect(body).toContain('<div id="setup-client-id-error" role="alert"></div>');

    // The client secret stays genuinely optional — an authorization server
    // taking a public client with PKCE issues none.
    expect(body).not.toContain('id="setup-client-secret" required');
  });

  it('reports a missing token or client ID next to the field and moves focus there', () => {
    const at = CLIENT.indexOf('async function saveConnectorSetup() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function addCustomConnector', at));
    expect(body).toContain(
      "setConnectorFormError('setup-token', token ? '' : 'An access token is required.')",
    );
    expect(body).toContain("$('#setup-token').focus()");
    expect(body).toContain(
      "setConnectorFormError('setup-client-id', clientId ? '' : 'A client ID is required.')",
    );
    expect(body).toContain("$('#setup-client-id').focus()");
  });

  it("marks the custom-add form's name and URL required, each wired to its own error node", () => {
    const at = CLIENT.indexOf('function viewConnectors() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nasync function loadConnectors', at));
    for (const field of ['connector-name', 'connector-url']) {
      expect(body).toContain(`id="${field}"`);
      expect(body).toContain('required aria-required="true"');
      expect(body).toContain(`aria-describedby="${field}-error"`);
      expect(body).toContain(`<div id="${field}-error" role="alert"></div>`);
    }
  });

  it('reports a missing name/URL or a malformed URL next to the field and moves focus there', () => {
    const at = CLIENT.indexOf('async function addCustomConnector() {');
    expect(at).toBeGreaterThan(-1);
    const body = CLIENT.slice(at, CLIENT.indexOf('\nfunction addPanel', at));
    expect(body).toContain(
      "setConnectorFormError('connector-name', name ? '' : 'A name is required.')",
    );
    expect(body).toContain(
      "!url ? 'A URL is required.' : badUrl ? 'URL must start with http:// or https://.' : ''",
    );
    expect(body).toContain("$('#connector-' + (name ? 'url' : 'name')).focus()");
  });
});
