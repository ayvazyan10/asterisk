// Control-panel stylesheet, inlined into the page under a CSP nonce.
//
// Visual direction: a technical instrument panel. Dense rows, hairline rules,
// monospace for anything the machine owns (paths, keys, values), and a single
// amber signal colour carrying state. Light and dark are both deliberate
// rather than one being an inversion of the other.

/**
 * The page's CSP is `style-src 'nonce-…'`, and a nonce does not authorise
 * `style="…"` attributes — only whole `<style>` elements. Everything the UI
 * needs is therefore a class, including the bar widths, which are quantised
 * into 2% steps and emitted as `.w0`…`.w100` below.
 */
const WIDTH_UTILITIES = Array.from(
  { length: 51 },
  (_, i) => `.w${i * 2} { width: ${i * 2}%; }`,
).join('\n');

const BASE_STYLES = String.raw`
:root {
  color-scheme: light dark;

  --graphite-950: oklch(17% 0.006 260);
  --graphite-900: oklch(21% 0.007 260);
  --graphite-850: oklch(25% 0.008 260);
  --graphite-700: oklch(42% 0.010 260);
  --graphite-400: oklch(64% 0.012 260);
  --bone-100:     oklch(97.5% 0.004 85);
  --bone-200:     oklch(94% 0.006 85);
  --bone-300:     oklch(88% 0.008 85);

  --signal:       oklch(72% 0.155 70);
  --signal-dim:   oklch(72% 0.155 70 / 0.14);
  --ok:           oklch(68% 0.15 155);
  --danger:       oklch(62% 0.20 25);

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, monospace;

  --text-xs:   0.6875rem;
  --text-sm:   0.8125rem;
  --text-base: 0.9375rem;
  --text-lg:   1.25rem;
  --text-readout: clamp(1.75rem, 1.2rem + 1.6vw, 2.75rem);

  --rail: 232px;
  --radius: 3px;
  --duration: 140ms;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);

  --bg:        var(--bone-100);
  --bg-raised: white;
  --bg-sunken: var(--bone-200);
  --rule:      var(--bone-300);
  --ink:       var(--graphite-900);
  --ink-muted: var(--graphite-700);
  --ink-faint: oklch(58% 0.010 260);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:        var(--graphite-950);
    --bg-raised: var(--graphite-900);
    --bg-sunken: oklch(14% 0.006 260);
    --rule:      var(--graphite-850);
    --ink:       oklch(93% 0.004 85);
    --ink-muted: var(--graphite-400);
    --ink-faint: oklch(52% 0.012 260);
  }
}

:root[data-theme="light"] {
  --bg: var(--bone-100); --bg-raised: white; --bg-sunken: var(--bone-200);
  --rule: var(--bone-300); --ink: var(--graphite-900);
  --ink-muted: var(--graphite-700); --ink-faint: oklch(58% 0.010 260);
}
:root[data-theme="dark"] {
  --bg: var(--graphite-950); --bg-raised: var(--graphite-900);
  --bg-sunken: oklch(14% 0.006 260); --rule: var(--graphite-850);
  --ink: oklch(93% 0.004 85); --ink-muted: var(--graphite-400);
  --ink-faint: oklch(52% 0.012 260);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* --- shell ------------------------------------------------------------ */

.shell { display: grid; grid-template-columns: var(--rail) 1fr; min-height: 100vh; }

.rail {
  border-right: 1px solid var(--rule);
  background: var(--bg-sunken);
  display: flex; flex-direction: column;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}

.brand {
  padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid var(--rule);
}
.brand h1 {
  margin: 0; font-size: var(--text-base); font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase;
}
.brand h1 span { color: var(--signal); }
.brand .meta {
  margin-top: 0.25rem; font-family: var(--font-mono);
  font-size: var(--text-xs); color: var(--ink-faint);
}

.nav { padding: 0.75rem 0.5rem; display: flex; flex-direction: column; gap: 1px; flex: 1; }
.nav-group {
  padding: 0.9rem 0.75rem 0.35rem; font-size: var(--text-xs);
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint);
}
.nav button {
  all: unset; cursor: pointer; display: flex; align-items: center;
  justify-content: space-between; gap: 0.5rem;
  padding: 0.4rem 0.75rem; border-radius: var(--radius);
  font-size: var(--text-sm); color: var(--ink-muted);
  transition: background var(--duration) var(--ease), color var(--duration) var(--ease);
}
.nav button:hover { background: var(--bg-raised); color: var(--ink); }
.nav button:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.nav button[aria-current="true"] {
  background: var(--signal-dim); color: var(--ink); font-weight: 500;
  box-shadow: inset 2px 0 0 var(--signal);
}
.nav .count {
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--ink-faint); font-variant-numeric: tabular-nums;
}

.rail-foot { padding: 0.75rem; border-top: 1px solid var(--rule); }

.main { min-width: 0; display: flex; flex-direction: column; }

.topbar {
  display: flex; align-items: center; gap: 1.5rem;
  padding: 0.75rem 1.75rem; border-bottom: 1px solid var(--rule);
  background: var(--bg-raised); position: sticky; top: 0; z-index: 5;
}
.topbar .stat { display: flex; align-items: baseline; gap: 0.4rem; font-size: var(--text-sm); }
.topbar .stat b {
  font-weight: 500; font-size: var(--text-xs); text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ink-faint);
}
.topbar .stat code { font-family: var(--font-mono); font-size: var(--text-sm); }
.topbar .spacer { flex: 1; }

.view { padding: 1.75rem; max-width: 1100px; }
.view > header { margin-bottom: 1.5rem; }
.view > header h2 {
  margin: 0; font-size: var(--text-lg); font-weight: 600; letter-spacing: -0.01em;
}
.view > header p { margin: 0.25rem 0 0; color: var(--ink-muted); font-size: var(--text-sm); max-width: 62ch; }

/* --- readouts (overview) ---------------------------------------------- */

.readouts {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  border: 1px solid var(--rule); border-radius: var(--radius);
  background: var(--bg-raised); overflow: hidden; margin-bottom: 1.75rem;
}
.readout { padding: 1rem 1.15rem; border-right: 1px solid var(--rule); }
.readout:last-child { border-right: 0; }
.readout b {
  display: block; font-size: var(--text-xs); font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-faint);
}
.readout .value {
  font-family: var(--font-mono); font-size: var(--text-readout);
  line-height: 1.1; font-variant-numeric: tabular-nums; margin-top: 0.35rem;
}
.readout .value.sm { font-size: var(--text-lg); }
.readout .value.on  { color: var(--ok); }
.readout .value.off { color: var(--ink-faint); }

/* --- rows -------------------------------------------------------------- */

.panel {
  border: 1px solid var(--rule); border-radius: var(--radius);
  background: var(--bg-raised); overflow: hidden; margin-bottom: 1.5rem;
}
.panel > h3 {
  margin: 0; padding: 0.7rem 1.15rem; border-bottom: 1px solid var(--rule);
  background: var(--bg-sunken); font-size: var(--text-xs); font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-muted);
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
}

.row {
  display: grid; grid-template-columns: minmax(220px, 1fr) minmax(240px, 1.1fr);
  gap: 1.5rem; align-items: start;
  padding: 0.85rem 1.15rem; border-bottom: 1px solid var(--rule);
}
.row:last-child { border-bottom: 0; }
.row:hover { background: color-mix(in oklch, var(--signal) 4%, transparent); }
.row .label { font-size: var(--text-sm); font-weight: 500; }
.row .path {
  display: block; font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--ink-faint); margin-top: 0.1rem; word-break: break-all;
}
.row .help { font-size: var(--text-xs); color: var(--ink-muted); margin-top: 0.3rem; max-width: 52ch; }
.row .control { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
/* The field takes the slack; its buttons stay on the same line beside it. */
.row .control input, .row .control select { flex: 1 1 11rem; width: auto; min-width: 0; }
.row .control button { flex: 0 0 auto; }
.row.dirty { background: var(--signal-dim); }

/* --- controls ---------------------------------------------------------- */

input[type="text"], input[type="number"], input[type="password"], select, textarea {
  font-family: var(--font-mono); font-size: var(--text-sm);
  color: var(--ink); background: var(--bg); width: 100%;
  border: 1px solid var(--rule); border-radius: var(--radius);
  padding: 0.35rem 0.5rem;
  transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
}
input:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-dim);
}
input[aria-invalid="true"] { border-color: var(--danger); }
textarea { resize: vertical; min-height: 22rem; line-height: 1.6; }

.toggle {
  all: unset; cursor: pointer; flex: none;
  width: 38px; height: 21px; border-radius: 999px;
  background: var(--rule); position: relative;
  transition: background var(--duration) var(--ease);
}
.toggle::after {
  content: ""; position: absolute; top: 3px; left: 3px;
  width: 15px; height: 15px; border-radius: 50%; background: var(--bg-raised);
  transition: transform var(--duration) var(--ease);
}
.toggle[aria-pressed="true"] { background: var(--signal); }
.toggle[aria-pressed="true"]::after { transform: translateX(17px); }
.toggle:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

button.btn {
  all: unset; cursor: pointer; flex: none;
  padding: 0.35rem 0.8rem; border-radius: var(--radius);
  border: 1px solid var(--rule); background: var(--bg);
  font-size: var(--text-sm); color: var(--ink); text-align: center;
  transition: border-color var(--duration) var(--ease), background var(--duration) var(--ease),
              transform var(--duration) var(--ease);
}
button.btn:hover { border-color: var(--signal); background: var(--signal-dim); }
button.btn:active { transform: translateY(1px); }
button.btn:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
button.btn.primary { background: var(--signal); border-color: var(--signal); color: var(--graphite-950); font-weight: 500; }
button.btn.primary:hover { filter: brightness(1.08); }
button.btn.danger:hover { border-color: var(--danger); background: color-mix(in oklch, var(--danger) 12%, transparent); }
button.btn[disabled] { opacity: 0.4; cursor: not-allowed; }
button.btn.sm { font-size: var(--text-xs); padding: 0.2rem 0.5rem; }

.actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

/* --- status chips ------------------------------------------------------ */

.chip {
  display: inline-flex; align-items: center; gap: 0.35rem;
  font-family: var(--font-mono); font-size: var(--text-xs);
  padding: 0.1rem 0.45rem; border-radius: 999px;
  border: 1px solid var(--rule); color: var(--ink-muted);
}
.chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip.on  { color: var(--ok); border-color: color-mix(in oklch, var(--ok) 40%, transparent); }
.chip.off { color: var(--ink-faint); }
.chip.bad { color: var(--danger); border-color: color-mix(in oklch, var(--danger) 40%, transparent); }

/* --- list rows (mcp, hooks, tokens, files) ----------------------------- */

.item {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.7rem 1.15rem; border-bottom: 1px solid var(--rule);
}
.item:last-child { border-bottom: 0; }
.item:hover { background: color-mix(in oklch, var(--signal) 4%, transparent); }
.item .name { font-weight: 500; font-size: var(--text-sm); }
.item .detail {
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--ink-faint); word-break: break-all;
}
.item .grow { flex: 1; min-width: 0; }

.empty { padding: 2rem 1.15rem; text-align: center; color: var(--ink-faint); font-size: var(--text-sm); }

pre.log {
  margin: 0; padding: 1rem 1.15rem; overflow-x: auto;
  font-family: var(--font-mono); font-size: var(--text-xs);
  line-height: 1.65; background: var(--bg-sunken); max-height: 65vh;
}

/* --- editor ------------------------------------------------------------ */

.editor-grid { display: grid; grid-template-columns: 280px 1fr; gap: 1.25rem; align-items: start; }
.file-list { max-height: 70vh; overflow-y: auto; }
.file-list button {
  all: unset; cursor: pointer; display: block; width: 100%;
  padding: 0.4rem 1.15rem; font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--ink-muted); word-break: break-all;
}
.file-list button:hover { background: var(--signal-dim); color: var(--ink); }
.file-list button[aria-current="true"] { background: var(--signal-dim); color: var(--ink); box-shadow: inset 2px 0 0 var(--signal); }
.file-list button:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }

/* --- forms in panels --------------------------------------------------- */

.form-grid {
  display: grid; grid-template-columns: 150px 1fr; gap: 0.6rem 1rem;
  align-items: center; padding: 1.15rem;
}
.form-grid label { font-size: var(--text-sm); color: var(--ink-muted); }
.form-grid .span { grid-column: 1 / -1; }

/* --- toast ------------------------------------------------------------- */

.toasts {
  position: fixed; bottom: 1.25rem; right: 1.25rem; z-index: 50;
  display: flex; flex-direction: column; gap: 0.5rem; max-width: min(420px, 90vw);
}
.toast {
  border: 1px solid var(--rule); border-left: 3px solid var(--signal);
  background: var(--bg-raised); border-radius: var(--radius);
  padding: 0.6rem 0.9rem; font-size: var(--text-sm);
  box-shadow: 0 8px 24px oklch(0% 0 0 / 0.18);
  animation: slide-in var(--duration) var(--ease);
}
.toast.bad { border-left-color: var(--danger); }
.toast.good { border-left-color: var(--ok); }
.toast .detail { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-muted); margin-top: 0.25rem; }

@keyframes slide-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}

.sticky-save {
  position: sticky; bottom: 0; z-index: 4;
  display: flex; align-items: center; gap: 1rem;
  padding: 0.75rem 1.15rem; margin-top: -1px;
  border: 1px solid var(--signal); border-radius: var(--radius);
  background: var(--bg-raised); box-shadow: 0 -6px 20px oklch(0% 0 0 / 0.12);
}
.sticky-save .count { font-family: var(--font-mono); font-size: var(--text-sm); flex: 1; }

/* --- gate (unauthenticated) -------------------------------------------- */

.gate { display: grid; place-items: center; min-height: 100vh; padding: 2rem; }
.gate .card {
  border: 1px solid var(--rule); border-radius: var(--radius);
  background: var(--bg-raised); padding: 2rem; max-width: 32rem;
}
.gate h1 { margin: 0 0 0.75rem; font-size: var(--text-lg); letter-spacing: 0.1em; text-transform: uppercase; }
.gate p { color: var(--ink-muted); font-size: var(--text-sm); }
.gate code {
  display: block; font-family: var(--font-mono); font-size: var(--text-xs);
  background: var(--bg-sunken); padding: 0.6rem 0.75rem; border-radius: var(--radius);
  margin-top: 0.75rem; word-break: break-all;
}

@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--rule); }
  .nav { flex-direction: row; flex-wrap: wrap; }
  .row { grid-template-columns: 1fr; gap: 0.5rem; }
  .editor-grid { grid-template-columns: 1fr; }
  .view { padding: 1.15rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}

/* --- usage chart + layout helpers (no inline styles; see CSP note) ------ */

.bar-row { gap: 0.75rem; }
.bar-label { width: 3.5rem; flex: none; }
.bar-track {
  flex: 1; height: 10px; border-radius: 2px; overflow: hidden;
  background: var(--bg-sunken);
}
.bar-fill { height: 100%; background: var(--signal); }
.bar-tokens { width: 5rem; text-align: right; flex: none; }
.bar-cost { width: 6rem; text-align: right; flex: none; }

.pad { padding: 1.15rem; }
.mt { margin-top: 0.75rem; }
.mb { margin-bottom: 1rem; }
.mt-lg { margin-top: 1.25rem; }
.accent { color: var(--signal); }
`;

export const STYLES = `${BASE_STYLES}\n${WIDTH_UTILITIES}\n`;
