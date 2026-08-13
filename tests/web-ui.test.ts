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

import { describe, expect, it } from 'vitest';

import { CONTENT_KINDS } from '../src/web/api/content.ts';
import { APP_CORE } from '../src/web/ui/app-core.ts';
import { APP_VIEWS } from '../src/web/ui/app-views.ts';
import { renderIndexHtml } from '../src/web/ui/index.ts';
import { STYLES } from '../src/web/ui/styles.ts';

const CLIENT = `${APP_CORE}\n${APP_VIEWS}`;

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
    // view, so they need panels rather than entries in VIEWS.
    expect(idsIn('LOG_TABS')).toEqual(['daemon', 'audit']);
    expect(CLIENT).toContain('function daemonLogPanel(');
    expect(CLIENT).toContain('function auditPanel(');
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
    // Type scale, radii, timings and layout metrics are declared once and are
    // the same in both themes by design. Everything else is palette, and a
    // palette token present in one theme and absent from the other is a bug.
    const structural = /^--(font|text|radius|shadow|sidebar|header|duration|ease)/;
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
    for (const w of [...CLIENT.matchAll(/\bw(\d+)\b/g)].map((m) => m[1])) {
      expect(STYLES).toContain(`.w${w} {`);
    }
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
