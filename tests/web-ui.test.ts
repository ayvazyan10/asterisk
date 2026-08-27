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
