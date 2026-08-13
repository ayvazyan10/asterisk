// Design tokens for the control panel.
//
// Direction: the panel is the faceplate of a device you own. Asterisk runs on
// your hardware — the daemon has a pid, the model has weights on your disk,
// the database is chmod 600 — so the surface should read as equipment rather
// than as a web app reporting on a datacentre somewhere else.
//
// Three deliberate departures from where this file started (a shadcn port):
//
//   Ground.  Not white and not near-black. A warm blue-grey slate in dark, a
//            warm paper in light. Near-black-plus-one-neon is the single most
//            worn look in dashboard design right now and the previous revision
//            was squarely in it.
//   Colour.  Two accents that mean different things, not one that means
//            "interactive". --signal (amber) is live, running, now.
//            --tide (teal) is configured, stored, at rest. A reader can tell
//            what state a thing is in without reading the label.
//   Voice.   Two type roles that encode who is speaking. Anything the machine
//            owns — paths, config keys, model tags, values, log lines — is
//            monospace. Anything addressed to the person is humanist. The two
//            meet inside a single heading: "Rules" then ~/.asterisk/rules.
//
// No webfont. `default-src 'none'` with no font-src would have to be widened
// to data:, every byte lands in a page that is deliberately one request, and
// a bundled face needs licence care in an Apache-2.0 repo. The character comes
// from composition, colour and structure instead — which is the harder way and
// the honest one given the constraints.

const LIGHT_TOKENS = String.raw`
  --bg:            oklch(96.5% 0.005 85);
  --surface:       oklch(99% 0.003 85);
  --surface-high:  oklch(100% 0 0);
  --border:        oklch(88% 0.007 85);
  --border-strong: oklch(80% 0.010 85);

  --ink:           oklch(24% 0.014 258);
  --ink-dim:       oklch(48% 0.010 258);
  --ink-faint:     oklch(62% 0.008 258);

  --signal:        oklch(58% 0.140 62);
  --signal-ink:    oklch(99% 0.005 85);
  --signal-wash:   oklch(58% 0.140 62 / 0.10);

  --tide:          oklch(50% 0.100 200);
  --tide-wash:     oklch(50% 0.100 200 / 0.10);

  --oxide:         oklch(52% 0.190 25);
  --oxide-wash:    oklch(52% 0.190 25 / 0.10);

  --shadow-tint:   258;
  --shadow-alpha:  0.07;
`;

// Dark is authored, not inverted: --surface rises above --bg here, while in
// light it sits flush and the border does the separating. The accents also
// lighten, because 58% amber on a dark ground is mud.
const DARK_TOKENS = String.raw`
  --bg:            oklch(18% 0.014 258);
  --surface:       oklch(22.5% 0.015 258);
  --surface-high:  oklch(26% 0.016 258);
  --border:        oklch(30% 0.014 258);
  --border-strong: oklch(38% 0.014 258);

  --ink:           oklch(94% 0.006 85);
  --ink-dim:       oklch(70% 0.010 258);
  --ink-faint:     oklch(56% 0.012 258);

  --signal:        oklch(78% 0.155 70);
  --signal-ink:    oklch(18% 0.014 258);
  --signal-wash:   oklch(78% 0.155 70 / 0.14);

  --tide:          oklch(74% 0.100 200);
  --tide-wash:     oklch(74% 0.100 200 / 0.14);

  --oxide:         oklch(66% 0.180 25);
  --oxide-wash:    oklch(66% 0.180 25 / 0.16);

  --shadow-tint:   258;
  --shadow-alpha:  0.4;
`;

/**
 * Three theme states, matching what the toggle in ./app-core.ts can put on the
 * root element: no data-theme follows the OS; data-theme=light|dark is
 * explicit and wins. The media query is guarded with :not([data-theme="light"])
 * rather than relying on source order, so an explicit light choice survives on
 * a machine set to dark.
 */
export const THEME = String.raw`
:root {
  color-scheme: light dark;
${LIGHT_TOKENS}

  /* The rail is the chassis: the same deep slate in both themes, so the panel
     always has a machined edge to sit against. */
  --rail-bg:      oklch(19% 0.015 258);
  --rail-high:    oklch(23% 0.016 258);
  --rail-ink:     oklch(88% 0.006 85);
  --rail-dim:     oklch(60% 0.012 258);
  --rail-border:  oklch(27% 0.014 258);

  --font-human: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-machine: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", "Cascadia Mono", Menlo, monospace;

  /* Tighter than a web app's. Equipment has corners; it does not have pills. */
  --r-sm: 3px;
  --r-md: 5px;
  --r-lg: 8px;

  --t-xs:    0.6875rem;
  --t-sm:    0.8125rem;
  --t-base:  0.9375rem;
  --t-lg:    1.0625rem;
  --t-title: clamp(1.5rem, 1.2rem + 0.9vw, 2rem);

  /* Silkscreen: the tiny wide-tracked machine labels on the rail and on card
     headers. Named for what it is so it is used for that and nothing else. */
  --track-silk: 0.16em;

  --rail: 244px;
  --bar: 52px;

  --dur: 140ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);

  --shadow-1: 0 1px 2px oklch(0% 0 var(--shadow-tint) / var(--shadow-alpha));
  --shadow-2: 0 4px 16px -4px oklch(0% 0 var(--shadow-tint) / var(--shadow-alpha));
  --shadow-3: 0 16px 40px -12px oklch(0% 0 var(--shadow-tint) / var(--shadow-alpha));
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${DARK_TOKENS}
  }
}

:root[data-theme="light"] {
${LIGHT_TOKENS}
}

:root[data-theme="dark"] {
${DARK_TOKENS}
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-human);
  font-size: var(--t-base);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-variant-numeric: tabular-nums;
}

h1, h2, h3, h4, p, figure { margin: 0; }

code, pre, kbd, samp { font-family: var(--font-machine); }

:focus-visible { outline: none; }

button:focus-visible, a:focus-visible, [role="tab"]:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

::selection { background: var(--signal-wash); }

* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--border-strong); border-radius: 999px;
  border: 3px solid transparent; background-clip: content-box;
}
`;
