// Control-panel stylesheet, inlined into the page under a CSP nonce.
//
// Four layers, composed at the bottom:
//
//   theme.ts       tokens — the palette, the two type roles, the metrics
//   components.ts  the component vocabulary
//   star.ts        the signature: the asterisk drawn from live state
//   this file      the shell those sit in
//
// The shell's one structural idea: the rail is the chassis and the view is the
// paper. The rail keeps the same deep slate in both themes, so the panel
// always has a machined edge to work against, and the light theme is a sheet
// clamped into a dark instrument rather than a white page with a grey stripe.

import { COMPONENTS } from './components.ts';
import { STAR } from './star.ts';
import { THEME } from './theme.ts';

/**
 * The page's CSP is `style-src 'nonce-…'`, and a nonce does not authorise
 * `style="…"` attributes — only whole `<style>` elements. Any width computed
 * at render time is therefore a class, quantised into 5% steps. The skeleton
 * placeholders are what use them.
 */
const WIDTH_UTILITIES = Array.from(
  { length: 21 },
  (_, i) => `.w${i * 5} { width: ${i * 5}%; }`,
).join('\n');

const LAYOUT = String.raw`
/* --- shell --------------------------------------------------------------- */

.shell { display: grid; grid-template-columns: var(--rail) 1fr; min-height: 100vh; }

.rail {
  display: flex; flex-direction: column;
  background: var(--rail-bg); color: var(--rail-ink);
  border-right: 1px solid var(--rail-border);
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  /* A faint top-lit sheen, the way an anodised panel catches light. */
  background-image: linear-gradient(var(--rail-high), transparent 220px);
}

.brand {
  display: flex; align-items: center; gap: 0.5rem;
  height: var(--bar); padding: 0 1rem; flex: none;
  border-bottom: 1px solid var(--rail-border);
}
.brand-name {
  font-size: var(--t-sm); font-weight: 600; letter-spacing: 0.01em;
}
.brand-mark { color: var(--signal); }
.brand-meta {
  margin-left: auto; font-family: var(--font-machine);
  font-size: var(--t-xs); color: var(--rail-dim);
}

.nav { flex: 1; padding: 0.5rem 0.5rem 1rem; }
.nav-group {
  padding: 1rem 0.6rem 0.4rem;
  font-family: var(--font-machine); font-size: var(--t-xs);
  letter-spacing: var(--track-silk); text-transform: uppercase;
  color: var(--rail-dim);
}

.nav-item {
  display: flex; align-items: center; gap: 0.5rem;
  width: 100%; padding: 0.4rem 0.6rem;
  border: 0; border-left: 2px solid transparent; border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: transparent; color: var(--rail-dim);
  font-family: var(--font-human); font-size: var(--t-sm);
  text-align: left; cursor: pointer;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease),
              border-color var(--dur) var(--ease);
}
.nav-item:hover { background: var(--rail-high); color: var(--rail-ink); }
.nav-item[aria-current="true"] {
  background: var(--rail-high); color: var(--rail-ink);
  border-left-color: var(--signal); font-weight: 500;
}
.nav-label { flex: 1; min-width: 0; }
.nav-count {
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--rail-dim);
}
.nav-item[aria-current="true"] .nav-count { color: var(--signal); }

.rail-foot { padding: 0.75rem; border-top: 1px solid var(--rail-border); }
.rail-foot .btn { width: 100%; color: var(--rail-dim); border-color: var(--rail-border); background: transparent; }
.rail-foot .btn:hover { color: var(--rail-ink); background: var(--rail-high); border-color: var(--rail-border); }

/* --- the bar -------------------------------------------------------------- */

.main { min-width: 0; display: flex; flex-direction: column; }

.header {
  display: flex; align-items: center; gap: 1.25rem;
  height: var(--bar); padding: 0 1.25rem; flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky; top: 0; z-index: 20;
}
.header-stat { display: flex; align-items: baseline; gap: 0.45rem; min-width: 0; }
.header-stat-label {
  font-family: var(--font-machine); font-size: var(--t-xs);
  letter-spacing: var(--track-silk); text-transform: uppercase;
  color: var(--ink-faint); flex: none;
}
.header-stat-value {
  font-family: var(--font-machine); font-size: var(--t-xs); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.header-spacer { flex: 1; }
.header-actions { display: flex; align-items: center; gap: 0.4rem; flex: none; }

/* --- view ----------------------------------------------------------------- */

.view { padding: 1.5rem 1.25rem 4rem; max-width: 74rem; width: 100%; }

.page-header { margin-bottom: 1.25rem; }
/* The human names the thing; the machine names where it lives. The two voices
   meet on one line, divided by a rule. */
.page-title {
  display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap;
  font-size: var(--t-title); font-weight: 600; letter-spacing: -0.025em;
  line-height: 1.15;
}
.page-subject {
  font-family: var(--font-machine); font-size: var(--t-sm); font-weight: 400;
  letter-spacing: 0; color: var(--ink-faint);
  padding-left: 0.75rem; border-left: 1px solid var(--border-strong);
  align-self: center; word-break: break-all;
}
.page-description {
  margin-top: 0.5rem; font-size: var(--t-sm);
  color: var(--ink-dim); max-width: 66ch; line-height: 1.6;
}

.section-actions { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }

/* The figure is the hero, so it takes the larger column and the panels read
   beside it — an instrument with its readout, rather than a wide graphic
   floating above a pair of cards with empty space either side of it. */
.overview-grid {
  display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 0.875rem; align-items: start;
}
.overview-grid > * { min-width: 0; }
.overview-grid .card + .card { margin-top: 0.875rem; }

/* --- forms ---------------------------------------------------------------- */

.form-grid {
  display: grid; grid-template-columns: 8.5rem 1fr;
  gap: 0.7rem 0.875rem; align-items: center;
}
.form-grid .form-span { grid-column: 1 / -1; }
.form-hint { font-size: var(--t-xs); color: var(--ink-faint); }

/* The editor's left column is narrow; a label column there would leave the
   field a few characters wide. */
.editor-grid .form-grid { grid-template-columns: 1fr; gap: 0.45rem; }

/* --- save bar -------------------------------------------------------------- */

.save-bar {
  position: sticky; bottom: 1rem; z-index: 15;
  display: flex; align-items: center; gap: 0.875rem;
  padding: 0.6rem 0.875rem; margin-top: 0.875rem;
  border: 1px solid var(--tide); border-radius: var(--r-md);
  background: var(--surface-high); box-shadow: var(--shadow-3);
}
.save-bar-count { flex: 1; font-size: var(--t-sm); font-weight: 500; }

/* --- editor ---------------------------------------------------------------- */

.editor-grid { display: grid; grid-template-columns: 16rem 1fr; gap: 0.875rem; align-items: start; }
.file-list { max-height: 55vh; overflow-y: auto; padding: 0.3rem; }
.file-item {
  display: block; width: 100%; padding: 0.35rem 0.5rem;
  border: 0; border-radius: var(--r-sm); background: transparent;
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-dim); text-align: left; cursor: pointer;
  word-break: break-all;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.file-item:hover { background: var(--surface-high); color: var(--ink); }
.file-item[aria-current="true"] { background: var(--signal-wash); color: var(--ink); }

/* --- skills ----------------------------------------------------------------- */

.skill-search { padding: 0.6rem 0.7rem; border-bottom: 1px solid var(--border); }
.skill-list-body { max-height: 46vh; overflow-y: auto; padding: 0.3rem; }

.skill-group {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 0.7rem 0.5rem 0.3rem;
}
.skill-group:first-child { padding-top: 0.3rem; }

.skill-item {
  display: flex; flex-direction: column; gap: 0.1rem;
  width: 100%; padding: 0.4rem 0.5rem;
  border: 0; border-radius: var(--r-sm); background: transparent;
  color: inherit; text-align: left; cursor: pointer;
  transition: background-color var(--dur) var(--ease);
}
.skill-item:hover { background: var(--surface-high); }
.skill-item[aria-current="true"] { background: var(--signal-wash); }
.skill-item-name { font-family: var(--font-machine); font-size: var(--t-sm); }
.skill-item-desc {
  font-size: var(--t-xs); color: var(--ink-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.issue-path {
  font-family: var(--font-machine); font-size: var(--t-xs);
  font-weight: 400; color: var(--ink-faint); overflow-wrap: anywhere;
}
/* The message is prose the author has to act on, so it reads as prose. */
.issue-message {
  margin-top: 0.2rem; font-size: var(--t-sm);
  color: var(--ink-dim); line-height: 1.5;
}

.skill-readonly-desc { font-size: var(--t-sm); color: var(--ink-dim); margin-bottom: 0.75rem; }
.skill-prompt {
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--bg); white-space: pre-wrap; max-height: 34rem;
}

/* --- gate ------------------------------------------------------------------ */

.gate { display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
.gate-card {
  width: 100%; max-width: 29rem; padding: 1.75rem;
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface);
}
.gate-title {
  font-size: var(--t-lg); font-weight: 600; letter-spacing: -0.015em;
}
.gate-text { margin-top: 0.75rem; font-size: var(--t-sm); color: var(--ink-dim); line-height: 1.6; }
.gate-code {
  display: block; margin-top: 0.6rem; padding: 0.55rem 0.7rem;
  font-family: var(--font-machine); font-size: var(--t-xs); color: var(--tide);
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
  word-break: break-all;
}

/* --- responsive ------------------------------------------------------------ */

@media (max-width: 1100px) {
  .overview-grid { grid-template-columns: 1fr; }
}

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .rail {
    position: static; height: auto;
    border-right: 0; border-bottom: 1px solid var(--rail-border);
    background-image: none;
  }
  .nav { display: flex; flex-wrap: wrap; padding: 0.5rem; }
  .nav-group { width: 100%; padding: 0.6rem 0.6rem 0.2rem; }
  .nav-item { width: auto; border-left: 0; border-bottom: 2px solid transparent; border-radius: var(--r-sm); }
  .nav-item[aria-current="true"] { border-left-color: transparent; border-bottom-color: var(--signal); }
  .field { grid-template-columns: 1fr; gap: 0.5rem; }
  .editor-grid { grid-template-columns: 1fr; }
  .header { gap: 1rem; overflow-x: auto; }
  .view { padding: 1.25rem 1rem 3rem; }
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; gap: 0.4rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* --- helpers ---------------------------------------------------------------- */

.mt { margin-top: 0.875rem; }
.mb { margin-bottom: 0.875rem; }
`;

export const STYLES = `${THEME}\n${COMPONENTS}\n${STAR}\n${LAYOUT}\n${WIDTH_UTILITIES}\n`;
