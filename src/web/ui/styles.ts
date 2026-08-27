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
// paper. The rail keeps the same near-black in both themes, so the panel always
// has a machined edge to work against, and the light theme is a sheet clamped
// into a dark instrument rather than a white page with a grey stripe.
//
// The rail collapses to icons. Not decoration — the panel is meant to sit open
// beside a terminal, and 220px of it is navigation the user has already learnt.

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

.shell {
  display: grid; grid-template-columns: var(--rail) 1fr; min-height: 100vh;
  /* Without this, a grid whose rows are shorter than its own min-height
     stretches every auto-sized row to fill the rest — invisible while .rail
     was a fixed 100vh column, but below 900px it drops to a single static
     row sized by its own content, and a short page (Hooks, nothing
     configured) let that row's leftover height inflate the rail: each nav
     chip in the strip below rendered 177px tall on real content that needed
     about 50. align-content: start leaves the extra height where a short
     page already puts it — after the content — instead of stretching into it. */
  align-content: start;
  transition: grid-template-columns var(--dur) var(--ease);
}
.shell[data-rail="tight"] { grid-template-columns: var(--rail-tight) 1fr; }

.rail {
  display: flex; flex-direction: column;
  background: var(--rail-bg); color: var(--rail-ink);
  border-right: 1px solid var(--rail-border);
  position: sticky; top: 0; height: 100vh; overflow: hidden;
}

.brand {
  display: flex; align-items: center; gap: 0.6rem;
  height: var(--bar); padding: 0 0.9rem; flex: none;
  border-bottom: 1px solid var(--rail-border);
}
.brand-name {
  font-size: var(--t-sm); font-weight: 700; letter-spacing: -0.01em;
  white-space: nowrap;
}
.brand-mark { color: var(--signal); flex: none; }
.brand-meta {
  margin-left: auto; font-family: var(--font-machine);
  font-size: var(--t-2xs); color: var(--rail-dim); white-space: nowrap;
}
[data-rail="tight"] .brand { justify-content: center; padding: 0; }
[data-rail="tight"] .brand-name, [data-rail="tight"] .brand-meta { display: none; }

.nav { flex: 1; padding: 0.65rem 0.55rem 1rem; overflow-y: auto; }
.nav-group {
  padding: 0.75rem 0.5rem 0.4rem;
  font-size: var(--t-2xs); font-weight: 500;
  letter-spacing: var(--track-silk); text-transform: uppercase;
  color: var(--rail-dim); white-space: nowrap;
}
.nav-group:first-child { padding-top: 0.15rem; }
/* Collapsed, the group headings become the hairlines that separated them.
   Padding has to go with the height: overflow clips to the padding box, so
   0-height with padding left the label showing inside it. */
[data-rail="tight"] .nav-group {
  height: 0; padding: 0; overflow: hidden;
  border-top: 1px solid var(--rail-border); margin: 0.45rem 0.3rem;
}
[data-rail="tight"] .nav-group:first-child { border-top: 0; margin-top: 0; }

.nav-item {
  position: relative;
  display: flex; align-items: center; gap: 0.6rem;
  width: 100%; padding: 0.42rem 0.55rem; margin-bottom: 1px;
  border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--rail-dim);
  font-family: var(--font-human); font-size: var(--t-sm);
  text-align: left; cursor: pointer; white-space: nowrap;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.nav-item:hover { background: var(--rail-high); color: var(--rail-ink); }
.nav-item[aria-current="true"] { background: var(--rail-high); color: var(--rail-ink); font-weight: 500; }
/* The marker is the accent's one job on the rail: which page am I on. */
.nav-item[aria-current="true"]::before {
  content: ""; position: absolute; left: -0.55rem; top: 50%;
  width: 2px; height: 1rem; margin-top: -0.5rem;
  border-radius: 999px; background: var(--signal);
}
.nav-item .icon { color: var(--rail-dim); transition: color var(--dur) var(--ease); }
.nav-item:hover .icon, .nav-item[aria-current="true"] .icon { color: var(--rail-ink); }

.nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nav-count {
  flex: none; padding: 0.05rem 0.35rem; border-radius: 999px;
  background: var(--rail-high); color: var(--rail-dim);
  font-family: var(--font-machine); font-size: var(--t-2xs);
}
.nav-item[aria-current="true"] .nav-count { color: var(--rail-ink); }
[data-rail="tight"] .nav-item { justify-content: center; padding: 0.5rem 0; }
[data-rail="tight"] .nav-label, [data-rail="tight"] .nav-count { display: none; }
[data-rail="tight"] .nav-item[aria-current="true"]::before { left: 0; }

.rail-foot { padding: 0.5rem; border-top: 1px solid var(--rail-border); flex: none; }
.rail-foot .btn {
  width: 100%; justify-content: flex-start; gap: 0.55rem;
  color: var(--rail-dim); border-color: transparent; background: transparent;
  font-size: var(--t-xs);
}
.rail-foot .btn:hover { color: var(--rail-ink); background: var(--rail-high); border-color: transparent; }
[data-rail="tight"] .rail-foot .btn { justify-content: center; }
[data-rail="tight"] .rail-foot .btn span { display: none; }

/* --- the bar -------------------------------------------------------------- */

.main { min-width: 0; display: flex; flex-direction: column; }

.header {
  display: flex; align-items: center; gap: 0.5rem;
  height: var(--bar); padding: 0 1rem; flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  position: sticky; top: 0; z-index: 20;
}

/* Where am I — the reference's breadcrumb, and the panel has exactly two
   levels to show, so it is a breadcrumb and not a title. */
.crumbs { display: flex; align-items: center; gap: 0.4rem; font-size: var(--t-sm); min-width: 0; }
.crumb-root { color: var(--ink-faint); }
.crumb-sep { color: var(--ink-faint); }
.crumb-leaf {
  color: var(--ink); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.header-spacer { flex: 1; }
.header-actions { display: flex; align-items: center; gap: 0.4rem; flex: none; }

/* The status pill: a dot whose colour is the whole message, and a line of
   text that repeats it for anyone who cannot use the colour. */
.status-pill {
  display: flex; align-items: center; gap: 0.45rem;
  height: 2rem; padding: 0 0.7rem;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface); font-size: var(--t-xs); color: var(--ink-dim);
  white-space: nowrap;
}
.status-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--ink-faint); }
.status-pill[data-state="ok"] .status-dot { background: var(--tide); }
.status-pill[data-state="warn"] .status-dot { background: var(--warn); }
.status-pill[data-state="bad"] .status-dot { background: var(--oxide); }
.status-value {
  font-family: var(--font-machine); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; max-width: 22ch;
}

/* --- view ----------------------------------------------------------------- */

.view { padding: 1.5rem 1.5rem 4rem; max-width: 76rem; width: 100%; }

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

/* --- settings --------------------------------------------------------------
   An index and a body, not an accordion. The index is sticky and narrow; the
   body carries every field the schema has, under headings that stay put while
   their own section is on screen. */

.settings-layout {
  display: grid; grid-template-columns: 13rem minmax(0, 1fr);
  gap: 1.5rem; align-items: start;
}

.toc {
  position: sticky; top: calc(var(--bar) + 3.5rem);
  display: flex; flex-direction: column; gap: 1px;
  max-height: calc(100vh - var(--bar) - 5rem); overflow-y: auto;
}
.toc-item {
  position: relative;
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.55rem; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-faint);
  font-family: var(--font-human); font-size: var(--t-sm);
  text-align: left; cursor: pointer; width: 100%;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.toc-item:hover { background: var(--surface-high); color: var(--ink); }
.toc-item[aria-current="true"] { color: var(--ink); font-weight: 500; }
.toc-item[aria-current="true"]::before {
  content: ""; position: absolute; left: -0.5rem; top: 50%;
  width: 2px; height: 0.9rem; margin-top: -0.45rem;
  border-radius: 999px; background: var(--signal);
}
.toc-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-count {
  font-family: var(--font-machine); font-size: var(--t-2xs);
  color: var(--ink-faint); flex: none;
}
/* Staged edits are the one thing worth pulling the eye back to a section for. */
.toc-staged {
  flex: none; padding: 0.02rem 0.35rem; border-radius: 999px;
  background: var(--tide-wash); color: var(--tide);
  font-family: var(--font-machine); font-size: var(--t-2xs);
}

/* Each section is its own card, and deliberately NOT one container with the
   sections inside it: an overflow:hidden wrapper is a scroll container, and a
   sticky heading inside one resolves its top inset against that box instead of
   the viewport — which put every heading 48px *below* its own first row. */
.settings-body { display: flex; flex-direction: column; gap: 0.75rem; }

.settings-section {
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface);
}
.settings-section-head {
  position: sticky; top: var(--bar); z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.6rem 1rem;
  background: var(--surface-high); border-bottom: 1px solid var(--border);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
}
/* The heading is the readable name — the index carries it too, and shouting it
   would throw away the humanising that turns openaiCompatible into a title. */
.settings-section-name {
  font-size: var(--t-sm); font-weight: 600; color: var(--ink);
  letter-spacing: -0.01em;
}
.settings-section .field:last-child { border-radius: 0 0 var(--r-lg) var(--r-lg); }
.settings-section-count {
  font-family: var(--font-machine); font-size: var(--t-2xs); color: var(--ink-faint);
}

@media (max-width: 1100px) {
  .settings-layout { grid-template-columns: 1fr; }
  /* Sticking a full-width index to the top of a narrow window costs more than
     it gives, so it becomes a strip of chips that scrolls with the page. */
  .toc {
    position: static; flex-direction: row; flex-wrap: wrap; max-height: none;
    gap: 0.3rem; margin-bottom: 0.25rem;
  }
  .toc-item { width: auto; border: 1px solid var(--border); }
  .toc-item[aria-current="true"] { border-color: var(--signal); }
  .toc-item[aria-current="true"]::before { display: none; }
  .field { grid-template-columns: 1fr; gap: 0.5rem; }
  .field-control { justify-content: flex-start; }
}

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

/* Fixed, not sticky. Sticky worked while Settings was an accordion and the
   page was one screen tall; with every field on the page the bar sat at the
   bottom of 3000px of document, so the count of what you had staged was only
   visible once you had scrolled past everything you might still want to
   change. It follows the rail's width because it spans the reading column. */
.save-bar {
  position: fixed; z-index: 30;
  left: calc(var(--rail) + 1.5rem); right: 1.5rem; bottom: 1rem;
  max-width: 76rem;
  display: flex; align-items: center; gap: 0.875rem;
  padding: 0.6rem 0.875rem;
  border: 1px solid var(--tide); border-radius: var(--r-md);
  background: var(--surface-high); box-shadow: var(--shadow-3);
}
.shell[data-rail="tight"] .save-bar { left: calc(var(--rail-tight) + 1.5rem); }
.save-bar-count { flex: 1; font-size: var(--t-sm); font-weight: 500; }

/* --- editor ---------------------------------------------------------------- */

.editor-grid { display: grid; grid-template-columns: 16rem 1fr; gap: 0.875rem; align-items: start; }
/* Without this a nowrap description inside (.skill-item-desc, below) hands its
   min-content width up through the grid item to the track itself — the same
   failure mode .overview-grid > * already guards against. */
.editor-grid > * { min-width: 0; }
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

/* Position in a load order, where the number is information: later layers
   override earlier ones, so the sequence is the point of the list. */
.order-mark {
  flex: none; width: 1.4rem;
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-faint); text-align: right;
}

.agent-meta {
  display: grid; grid-template-columns: 4rem 1fr;
  gap: 0.4rem 0.75rem; align-items: baseline; margin-top: 0.75rem;
}
.agent-meta > div { display: flex; flex-wrap: wrap; gap: 0.25rem; }

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
  /* minmax(0, 1fr), not 1fr: a plain 1fr track still floors itself at the
     item's automatic minimum size, which is its subtree's min-content — and
     the strip .nav becomes below 640px (further down) is a non-wrapping row
     whose min-content is all eleven destinations laid out in one line. The
     0 floor is what lets .nav's own overflow-x:auto actually take effect
     instead of the rail (and the whole shell with it) growing to fit. */
  .shell, .shell[data-rail="tight"] { grid-template-columns: minmax(0, 1fr); }
  .rail {
    position: static; height: auto; overflow: visible;
    border-right: 0; border-bottom: 1px solid var(--rail-border);
  }
  .nav { display: flex; flex-wrap: wrap; padding: 0.5rem; overflow: visible; }
  .nav-group { width: 100%; padding: 0.6rem 0.5rem 0.2rem; }
  .nav-item { width: auto; margin-bottom: 0; }
  /* The left marker has nothing to hang off in a wrapped row. */
  .nav-item[aria-current="true"]::before { display: none; }
  .nav-item[aria-current="true"] { box-shadow: inset 0 -2px 0 var(--signal); }
  /* Collapsing a rail that is already a strip of chips does nothing. */
  .rail-foot { display: none; }
  .editor-grid { grid-template-columns: 1fr; }
  .header { gap: 0.5rem; overflow-x: auto; }
  .status-pill .status-value, .crumb-root, .crumb-sep { display: none; }
  .view { padding: 1.25rem 1rem 3rem; }
  .save-bar, .shell[data-rail="tight"] .save-bar { left: 1rem; right: 1rem; }
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; gap: 0.4rem; }

  /* The 900px fallback above still wraps the rail into rows of chips — three
     of them at 768px, 260px of the screen. On a phone that becomes 342px,
     42% of the viewport, before any content. Below 640 the rail stops
     wrapping and becomes one strip you swipe instead: every destination is
     still one tap away, the current one still carries its underline, and
     the scroll lives inside .nav, never the page. */
  .nav {
    flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity;
    padding: 0.4rem 0.6rem;
  }
  .nav-group { display: none; }
  .nav-item { flex: none; scroll-snap-align: start; padding: 0.5rem 0.7rem; }

  /* .log-line's 8.9rem + 3.2rem time/level columns are ~194px of a 343px
     phone content width — over half the line for the two fields read least.
     The message becomes its own row so it gets what is left of the width
     instead of what is left after two fixed columns. */
  .log-line {
    grid-template-columns: auto 1fr; grid-template-rows: auto auto;
    row-gap: 0.1rem; column-gap: 0.5rem;
  }
  .log-time { grid-column: 1; grid-row: 1; }
  .log-level { grid-column: 2; grid-row: 1; justify-self: start; }
  .log-msg { grid-column: 1 / -1; grid-row: 2; }
}

/* --- touch targets -----------------------------------------------------
   44x44 is the floor a coarse pointer needs; 1440px density is not built for
   it and should not have to be. Gate on the pointer or the viewport so a
   mouse on a wide screen never sees this. */
@media (pointer: coarse), (max-width: 768px) {
  .nav-item, .toc-item, .file-item { min-height: 2.75rem; }
  .file-item { display: flex; align-items: center; }
  .skill-item { min-height: 2.75rem; justify-content: center; }
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
