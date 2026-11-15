// Design tokens for the control panel.
//
// Direction: a star atlas. Asterisk is Greek for "little star", and the panel
// borrows the two materials of an old celestial chart — the night it describes
// and the paper it is printed on.
//
//   The sky.    The rail is a deep indigo night in BOTH themes, with the
//               emblem in starlight at the top of it. The light theme is a
//               printed chart laid beside the sky, not a white page with a
//               grey stripe; the dark theme is the sky itself.
//   The paper.  Light content sits on a cool, faintly blue atlas paper with
//               prussian ink — never warm cream, never pure white.
//   Starlight.  One gold, --star, spent almost nowhere: the emblem, and the
//               backend that is answering right now. When the eye finds gold
//               it has found the thing that is live.
//   Ink.        --signal is the interactive colour, an ultramarine that
//               lightens to periwinkle at night. Primary buttons at night are
//               light fills with dark ink, which is what lets the fill and
//               the text role share one hue and both clear AA.
//
// Colour that means something survives from the previous direction because it
// was right: --tide is healthy, --warn is degraded, --oxide is failed or
// destructive, --ink-faint is absent. Those are read without the label.
//
// Type has three roles. A serif from the system's Palatino family names
// things — page titles, the answering backend, the wordmark — the way a
// chart's legend is set. The system sans carries everything addressed to the
// person. Monospace is reserved for what the machine owns: paths, keys, model
// ids, counts in a log. No webfont: the page is one request, works offline,
// and `default-src 'none'` has no font-src to load one from.

const LIGHT_TOKENS = String.raw`
  --bg:            oklch(96.4% 0.009 255);
  --surface:       oklch(99.2% 0.003 255);
  --surface-high:  oklch(94.6% 0.012 258);
  --border:        oklch(89.5% 0.014 260);
  /* The edge a form control needs to be found by: >= 3:1 against
     --surface-high, the closest surface it sits on (WCAG 1.4.11). */
  --border-strong: oklch(57% 0.025 262);

  --ink:           oklch(23% 0.055 268);
  --ink-dim:       oklch(40% 0.045 266);
  /* >= 4.5:1 on --surface-high, the brightest neighbour it is ever set on
     (.badge-muted). Checked by tests/web-ui.test.ts. */
  --ink-faint:     oklch(48% 0.035 264);

  --signal:        oklch(48% 0.19 268);
  --signal-ink:    oklch(99% 0 0);
  --signal-wash:   oklch(48% 0.19 268 / 0.10);
  /* The fill role of --signal, under --signal-ink. On paper the two roles
     agree; at night they split — see the dark block. */
  --signal-strong: oklch(48% 0.19 268);

  /* Starlight. On paper it is the ochre of a printed star rather than the
     glow of a real one, so it holds up as a mark on a light ground. */
  --star:          oklch(68% 0.145 72);
  --star-wash:     oklch(68% 0.145 72 / 0.16);

  /* .badge-success sets --tide on --tide-wash, so the floor is that pair
     composited over --surface-high, not --tide alone. */
  --tide:          oklch(45% 0.115 168);
  --tide-wash:     oklch(45% 0.115 168 / 0.12);

  --warn:          oklch(60% 0.14 62);
  --warn-wash:     oklch(60% 0.14 62 / 0.14);

  --oxide:         oklch(52% 0.19 25);
  --oxide-wash:    oklch(52% 0.19 25 / 0.10);

  --shadow-tint:   265;
  --shadow-alpha:  0.10;
`;

// Night. The ground is indigo rather than black — the sky the rail already is,
// a step darker — so the two themes are one place at two times of day.
const DARK_TOKENS = String.raw`
  --bg:            oklch(16.5% 0.03 268);
  --surface:       oklch(20% 0.034 268);
  --surface-high:  oklch(24% 0.038 268);
  --border:        oklch(28.5% 0.036 268);
  --border-strong: oklch(56% 0.04 266);

  --ink:           oklch(95.5% 0.012 260);
  --ink-dim:       oklch(80% 0.025 262);
  --ink-faint:     oklch(70% 0.03 264);

  --signal:        oklch(78% 0.115 272);
  /* Dark ink on a light periwinkle fill: the one arrangement in which the
     fill and the text role of the same hue both clear 4.5:1 at night. */
  --signal-ink:    oklch(18% 0.04 270);
  --signal-wash:   oklch(78% 0.115 272 / 0.16);
  --signal-strong: oklch(80% 0.11 272);

  --star:          oklch(84% 0.135 85);
  --star-wash:     oklch(84% 0.135 85 / 0.14);

  --tide:          oklch(80% 0.13 165);
  --tide-wash:     oklch(80% 0.13 165 / 0.14);

  --warn:          oklch(84% 0.13 75);
  --warn-wash:     oklch(84% 0.13 75 / 0.14);

  --oxide:         oklch(72% 0.16 22);
  --oxide-wash:    oklch(72% 0.16 22 / 0.14);

  --shadow-tint:   270;
  --shadow-alpha:  0.45;
`;

/**
 * Three theme states, matching what the toggle in ./app-views.ts can put on the
 * root element: no data-theme follows the OS; data-theme=light|dark is
 * explicit and wins. The media query is guarded with :not([data-theme="light"])
 * rather than relying on source order, so an explicit light choice survives on
 * a machine set to dark.
 */
export const THEME = String.raw`
:root {
  color-scheme: light dark;
${LIGHT_TOKENS}

  /* The sky — the same night in both themes. */
  --rail-bg:      oklch(19.5% 0.045 270);
  --rail-high:    oklch(26% 0.05 270);
  --rail-ink:     oklch(97% 0.01 260);
  /* >= 4.5:1 on --rail-high, the brighter of its two backgrounds. */
  --rail-dim:     oklch(77% 0.035 265);
  --rail-border:  oklch(27.5% 0.045 270);
  --rail-star:    oklch(84% 0.135 85);
  --rail-signal:  oklch(78% 0.115 272);

  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052,
                  "Book Antiqua", Georgia, serif;
  --font-human: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-machine: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace;

  /* Radius follows rank: a control, a panel, the one hero. */
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 14px;
  --r-xl: 20px;

  /* A classical scale (11 12 13 14 16 21 28 36), not a ratio — at these
     sizes the steps a reader can tell apart matter more than the maths. */
  --t-2xs:   0.6875rem;
  --t-xs:    0.75rem;
  --t-sm:    0.8125rem;
  --t-base:  0.875rem;
  --t-lg:    1rem;
  --t-xl:    1.3125rem;
  --t-title: 1.75rem;
  --t-hero:  2.25rem;

  --rail: 232px;
  --rail-tight: 64px;
  --bar: 52px;

  --dur: 160ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);

  --shadow-1: 0 1px 2px oklch(0% 0 var(--shadow-tint) / var(--shadow-alpha));
  --shadow-2: 0 6px 18px -6px oklch(0% 0 var(--shadow-tint) / var(--shadow-alpha));
  --shadow-3: 0 18px 44px -14px oklch(0% 0 var(--shadow-tint) / var(--shadow-alpha));
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

button:focus-visible, a:focus-visible, [role="tab"]:focus-visible, summary:focus-visible {
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
