// Design tokens for the control panel.
//
// The token *names* are shadcn/ui's, deliberately: `--background`,
// `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`, and
// a `--radius` scale. Anyone who has read a shadcn theme can read this one,
// and a component rule below can be compared against its upstream counterpart
// without translating a private vocabulary first.
//
// What is NOT shadcn is the delivery: no Tailwind, no React, no Radix. The
// panel ships as one inlined stylesheet under a CSP nonce (see ../server.ts),
// so the design system is ported rather than installed. The values are
// shadcn's neutral base; `--primary` and `--ring` carry Asterisk's amber
// instead of shadcn's near-black/near-white, which is the one deliberate
// departure — the panel should still read as Asterisk.
//
// Light and dark are both authored. Dark is not an inversion: `--card` lifts
// *above* `--background` in dark and sits flush with it in light, which is how
// shadcn separates surfaces in each mode.

const LIGHT_TOKENS = String.raw`
  --background:            oklch(100% 0 0);
  --foreground:            oklch(14.5% 0 0);

  --card:                  oklch(100% 0 0);
  --card-foreground:       oklch(14.5% 0 0);
  --popover:               oklch(100% 0 0);
  --popover-foreground:    oklch(14.5% 0 0);

  --primary:               oklch(72% 0.155 70);
  --primary-foreground:    oklch(14.5% 0 0);

  --secondary:             oklch(97% 0 0);
  --secondary-foreground:  oklch(20.5% 0 0);

  --muted:                 oklch(97% 0 0);
  --muted-foreground:      oklch(55.6% 0 0);

  --accent:                oklch(97% 0 0);
  --accent-foreground:     oklch(20.5% 0 0);

  --destructive:           oklch(57.7% 0.245 27.3);
  --destructive-foreground:oklch(98.5% 0 0);

  --success:               oklch(60% 0.145 155);
  --warning:               oklch(68% 0.15 75);

  --border:                oklch(92.2% 0 0);
  --input:                 oklch(92.2% 0 0);
  --ring:                  oklch(72% 0.155 70);

  --surface:               oklch(98.4% 0 0);
  --shadow-color:          0 0 0;
`;

// Dark is authored, not derived. `--card` and `--popover` sit a step *above*
// `--background` here so a card reads as raised; in light they are flush with
// it and the border does the separating.
const DARK_TOKENS = String.raw`
  --background:            oklch(14.5% 0 0);
  --foreground:            oklch(98.5% 0 0);

  --card:                  oklch(20.5% 0 0);
  --card-foreground:       oklch(98.5% 0 0);
  --popover:               oklch(20.5% 0 0);
  --popover-foreground:    oklch(98.5% 0 0);

  --primary:               oklch(72% 0.155 70);
  --primary-foreground:    oklch(14.5% 0 0);

  --secondary:             oklch(26.9% 0 0);
  --secondary-foreground:  oklch(98.5% 0 0);

  --muted:                 oklch(26.9% 0 0);
  --muted-foreground:      oklch(70.8% 0 0);

  --accent:                oklch(26.9% 0 0);
  --accent-foreground:     oklch(98.5% 0 0);

  --destructive:           oklch(70.4% 0.191 22.2);
  --destructive-foreground:oklch(14.5% 0 0);

  --success:               oklch(70% 0.15 155);
  --warning:               oklch(75% 0.145 75);

  --border:                oklch(100% 0 0 / 10%);
  --input:                 oklch(100% 0 0 / 15%);
  --ring:                  oklch(72% 0.155 70);

  --surface:               oklch(17.5% 0 0);
  --shadow-color:          0 0 0;
`;

/**
 * Three theme states, matching what the toggle in ../ui/app-core.ts can put on
 * the root element:
 *
 *   no data-theme  → follow the OS (`prefers-color-scheme`)
 *   data-theme=light / data-theme=dark → explicit, wins over the OS
 *
 * The media query is guarded with `:not([data-theme="light"])` rather than
 * relying on source order, so an explicit light choice survives on a machine
 * set to dark.
 */
export const THEME = String.raw`
:root {
  color-scheme: light dark;
${LIGHT_TOKENS}
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, monospace;

  /* shadcn's default radius, and the derived steps its components use. */
  --radius: 0.5rem;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --text-xs:   0.75rem;
  --text-sm:   0.875rem;
  --text-base: 0.9375rem;
  --text-lg:   1.125rem;
  --text-xl:   1.5rem;
  --text-stat: 1.875rem;

  --sidebar: 260px;
  --header: 56px;

  --duration: 150ms;
  --ease: cubic-bezier(0.4, 0, 0.2, 1);

  --shadow-sm: 0 1px 2px 0 oklch(var(--shadow-color) / 0.05);
  --shadow-md: 0 4px 6px -1px oklch(var(--shadow-color) / 0.1),
               0 2px 4px -2px oklch(var(--shadow-color) / 0.1);
  --shadow-lg: 0 10px 15px -3px oklch(var(--shadow-color) / 0.1),
               0 4px 6px -4px oklch(var(--shadow-color) / 0.1);
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
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1, h2, h3, h4, p, figure { margin: 0; }

code, pre, kbd, samp { font-family: var(--font-mono); font-size: 0.9em; }

:focus-visible { outline: none; }

/* shadcn's focus treatment: a ring offset from the element by the page
   background, so it reads clearly on both surfaces and both themes. Inputs
   opt out in ./components.ts — a field gets a tighter 1px ring on its own
   border, which is how shadcn distinguishes typing from activating. */
button:focus-visible, a:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
}

::selection { background: color-mix(in oklch, var(--primary) 30%, transparent); }

/* Scrollbars tuned to the surface rather than left at the OS default, which
   is jarringly bright against the dark theme. */
* { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--border); border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
*::-webkit-scrollbar-thumb:hover { background: var(--muted-foreground); background-clip: content-box; }
`;
