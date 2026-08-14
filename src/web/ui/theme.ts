// Design tokens for the control panel.
//
// Direction: a console. Near-black ground, one violet accent that means
// "interactive", small dense type, icons on everything that is a destination or
// an action. The reference is the user's own Mission Control app, and the
// borrowing is deliberate down to the ramp — two panels the same person keeps
// open at once should not argue with each other about what a card looks like.
//
// What that replaced, and why the note matters: this file used to hold a warm
// slate-and-amber "equipment" palette, argued for at length on the grounds that
// near-black-plus-one-accent is the most worn look in dashboard design. That is
// still true in general, and it is not the point here. The panel is not
// competing for attention in a gallery; it sits beside another tool, and
// matching that tool is worth more than being distinct from every other
// dashboard.
//
// Three things survive from the old direction because they were right:
//
//   Two type roles.  Anything the machine owns — paths, config keys, model
//                    tags, counts, log lines — is monospace. Anything addressed
//                    to the person is humanist.
//   The chassis.     The rail keeps its own near-black in *both* themes, so the
//                    light theme is a sheet clamped into a dark instrument
//                    rather than a white page with a grey stripe.
//   Colour that means something. --tide is healthy, --warn is degraded,
//                    --oxide is failed. Those three are read without the label.
//
// No webfont. The reference uses Geist; `default-src 'none'` with no font-src
// would have to be widened to data: to carry it, every byte lands in a page
// that is deliberately one request, and a bundled face needs licence care in an
// Apache-2.0 repo. The system stack is close enough at 13px and honest.

const LIGHT_TOKENS = String.raw`
  --bg:            oklch(98% 0 0);
  --surface:       oklch(100% 0 0);
  --surface-high:  oklch(96.8% 0.001 286);
  --border:        oklch(92% 0.003 286);
  --border-strong: oklch(87% 0.004 286);

  --ink:           oklch(14% 0.004 286);
  --ink-dim:       oklch(44% 0.008 286);
  --ink-faint:     oklch(64% 0.010 286);

  --signal:        oklch(51% 0.230 288);
  --signal-ink:    oklch(100% 0 0);
  --signal-wash:   oklch(51% 0.230 288 / 0.10);

  --tide:          oklch(58% 0.140 163);
  --tide-wash:     oklch(58% 0.140 163 / 0.12);

  --warn:          oklch(64% 0.150 70);
  --warn-wash:     oklch(64% 0.150 70 / 0.12);

  --oxide:         oklch(55% 0.210 27);
  --oxide-wash:    oklch(55% 0.210 27 / 0.10);

  --shadow-tint:   286;
  --shadow-alpha:  0.08;
`;

// Dark is the authored one — it is what the reference is — and light is derived
// from it rather than the other way round. The accents lighten because
// violet-600 on near-black is a bruise, and the surface *rises* above the
// ground here while in light it sits flush and the border does the separating.
const DARK_TOKENS = String.raw`
  --bg:            oklch(14.5% 0.002 286);
  --surface:       oklch(17.5% 0.003 286);
  --surface-high:  oklch(21% 0.004 286);
  --border:        oklch(22.5% 0.004 286);
  --border-strong: oklch(28% 0.005 286);

  --ink:           oklch(98.5% 0 0);
  --ink-dim:       oklch(71% 0.013 286);
  --ink-faint:     oklch(47% 0.012 286);

  --signal:        oklch(63% 0.215 293);
  --signal-ink:    oklch(100% 0 0);
  --signal-wash:   oklch(63% 0.215 293 / 0.16);

  --tide:          oklch(77% 0.145 163);
  --tide-wash:     oklch(77% 0.145 163 / 0.14);

  --warn:          oklch(83% 0.150 82);
  --warn-wash:     oklch(83% 0.150 82 / 0.14);

  --oxide:         oklch(70% 0.170 22);
  --oxide-wash:    oklch(70% 0.170 22 / 0.14);

  --shadow-tint:   286;
  --shadow-alpha:  0.5;
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

  /* The chassis — the same near-black in both themes. */
  --rail-bg:      oklch(12.5% 0.002 286);
  --rail-high:    oklch(19% 0.004 286);
  --rail-ink:     oklch(100% 0 0);
  --rail-dim:     oklch(52% 0.012 286);
  --rail-border:  oklch(19.5% 0.004 286);

  --font-human: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-machine: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", "Cascadia Mono", Menlo, monospace;

  /* Softer than the corners this file used to argue for. A console next to
     another console, and that one has radii. */
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;

  --t-2xs:   0.625rem;
  --t-xs:    0.6875rem;
  --t-sm:    0.8125rem;
  --t-base:  0.875rem;
  --t-lg:    1rem;
  --t-title: 1.5rem;

  /* Silkscreen: the tiny wide-tracked machine labels on the rail and on card
     headers. Named for what it is so it is used for that and nothing else. */
  --track-silk: 0.12em;

  --rail: 220px;
  --rail-tight: 60px;
  --bar: 48px;

  --dur: 150ms;
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

/* Icons are decorative beside a label that already says the thing. They take
   the colour of whatever they sit in and never their own. */
.icon { flex: none; display: block; }

:focus-visible { outline: none; }

button:focus-visible, a:focus-visible, [role="tab"]:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

::selection { background: var(--signal-wash); }

* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--border-strong); border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
*::-webkit-scrollbar-thumb:hover { background: var(--ink-faint); background-clip: content-box; }
`;
