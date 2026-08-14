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

  it('opens every link it renders in a new tab without handing over the opener', () => {
    // The tag is built by concatenation, so the attributes are spread across
    // string literals — look at the window after the tag rather than at one
    // literal. Every href here points at somebody else's site.
    const anchors = [...CLIENT.matchAll(/<a\b/g)];
    expect(anchors.length).toBeGreaterThan(0);
    for (const m of anchors) {
      const tag = CLIENT.slice(m.index, m.index + 200);
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noopener noreferrer"');
    }
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

  it('renders a panel for each record the Logs tab offers', () => {
    // The log sub-tabs are not router tabs — they switch a panel inside one
    // view, so they need entries in LOG_PANELS rather than in VIEWS.
    const ids = idsIn('LOG_TABS');
    expect(ids).toEqual(['daemon', 'audit', 'doctor']);

    const table = CLIENT.slice(CLIENT.indexOf('const LOG_PANELS = {'));
    const panels = new Map(
      [...table.slice(0, table.indexOf('\n};')).matchAll(/(\w+): \(\) => (\w+)\(\)/g)].map((m) => [
        m[1] as string,
        m[2] as string,
      ]),
    );
    expect([...panels.keys()]).toEqual(ids);
    for (const fn of panels.values()) expect(CLIENT).toContain(`function ${fn}(`);
  });

  it('redirects a tab that moved instead of dropping it on the overview', () => {
    // A destination that became a record inside another page leaves hashes
    // behind in browser history. Each one must name a tab that still exists,
    // and must not still be a tab itself or goto() would recurse.
    const table = CLIENT.slice(CLIENT.indexOf('const MOVED_TABS = {'));
    const moved = [
      ...table
        .slice(0, table.indexOf('};'))
        .matchAll(/(\w+): \{ tab: '(\w+)', record: '(\w+)' \}/g),
    ];
    expect(moved.length).toBeGreaterThan(0);
    for (const [, from, to, record] of moved) {
      expect(idsIn('TABS')).not.toContain(from);
      expect(idsIn('TABS')).toContain(to);
      expect(idsIn('LOG_TABS')).toContain(record);
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
