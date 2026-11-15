// Control-panel stylesheet, inlined into the page under a CSP nonce.
//
// Four layers, composed at the bottom:
//
//   theme.ts       tokens — the palette, the type roles, the metrics
//   components.ts  the component vocabulary
//   star.ts        the signature: the backends drawn as a constellation
//   this file      the shell those sit in
//
// The shell's one structural idea: the rail is the night sky and the view is
// the chart. The rail keeps the same indigo in both themes, with the emblem in
// starlight at its head, so the light theme is a printed chart laid beside the
// sky rather than a white page with a grey stripe.
//
// The rail collapses to icons. Not decoration — the panel is meant to sit open
// beside a terminal, and 232px of it is navigation the user has already learnt.

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
     stretches every auto-sized row to fill the rest — below 900px the rail
     drops to a single static row, and a short page let that row's leftover
     height inflate every nav chip in it. align-content: start leaves the
     extra height after the content instead. */
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
  height: 4rem; padding: 0 1.1rem; flex: none;
}
.brand-mark { width: 1.6rem; height: 1.6rem; flex: none; color: var(--rail-star); }
.brand-name {
  font-family: var(--font-display); font-size: 1.2rem; font-weight: 600;
  letter-spacing: -0.01em; white-space: nowrap;
}
.brand-meta {
  margin-left: auto; font-family: var(--font-machine);
  font-size: var(--t-2xs); color: var(--rail-dim); white-space: nowrap;
}
[data-rail="tight"] .brand { justify-content: center; padding: 0; }
[data-rail="tight"] .brand-name, [data-rail="tight"] .brand-meta { display: none; }

.nav { flex: 1; padding: 0.25rem 0.65rem 1rem; overflow-y: auto; }
.nav-group {
  padding: 1rem 0.6rem 0.35rem;
  font-size: var(--t-xs); font-weight: 600; color: var(--rail-dim); white-space: nowrap;
}

.nav-item, .nav-more {
  position: relative;
  display: flex; align-items: center; gap: 0.7rem;
  width: 100%; padding: 0.5rem 0.65rem; margin-bottom: 2px;
  border: 0; border-radius: var(--r-md);
  background: transparent; color: var(--rail-dim);
  font-family: var(--font-human); font-size: var(--t-base);
  text-align: left; cursor: pointer; white-space: nowrap;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.nav-item:hover, .nav-more:hover { background: var(--rail-high); color: var(--rail-ink); }
.nav-item[aria-current] { background: var(--rail-high); color: var(--rail-ink); font-weight: 600; }
/* The marker is the accent's one job on the rail: which page am I on. */
.nav-item[aria-current]::before {
  content: ""; position: absolute; left: -0.65rem; top: 50%;
  width: 3px; height: 1.1rem; margin-top: -0.55rem;
  border-radius: 0 999px 999px 0; background: var(--rail-signal);
}
.nav-item .icon { color: var(--rail-dim); transition: color var(--dur) var(--ease); }
.nav-item:hover .icon, .nav-item[aria-current] .icon { color: var(--rail-ink); }

/* The disclosure in front of the advanced pages: quieter than a page, and
   it reads as a heading you can open rather than a destination. */
.nav-more {
  margin-top: 1rem; padding-top: 0.4rem; padding-bottom: 0.4rem;
  font-size: var(--t-xs); font-weight: 600;
}
.nav-more:disabled { cursor: default; background: transparent; color: var(--rail-dim); }

.nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nav-count {
  flex: none; min-width: 1.4rem; padding: 0.05rem 0.4rem; border-radius: 999px;
  background: var(--rail-high); color: var(--rail-dim); text-align: center;
  font-size: var(--t-2xs); font-weight: 600;
}
.nav-item[aria-current] .nav-count { background: var(--rail-bg); color: var(--rail-ink); }
/* The skills page borrows the pill for its scope counts, on paper. */
.skill-group .nav-count { background: var(--surface-high); color: var(--ink-faint); }
[data-rail="tight"] .nav-item, [data-rail="tight"] .nav-more { justify-content: center; padding: 0.55rem 0; }
[data-rail="tight"] .nav-label, [data-rail="tight"] .nav-count { display: none; }
[data-rail="tight"] .nav-item[aria-current]::before { left: -0.65rem; }

.rail-foot { padding: 0.6rem; border-top: 1px solid var(--rail-border); flex: none; }
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
  display: flex; align-items: center; gap: 0.6rem;
  height: var(--bar); padding: 0 1.5rem 0 2.5rem; flex: none;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklch, var(--bg) 88%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  position: sticky; top: 0; z-index: 20;
}

.crumb-leaf {
  font-size: var(--t-sm); font-weight: 600; color: var(--ink-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}

.header-spacer { flex: 1; }
.header-actions { display: flex; align-items: center; gap: 0.15rem; flex: none; }

/* The status pill: a dot whose colour is the whole message, the words that
   repeat it, and the model the primary backend is serving. */
.status-pill {
  display: flex; align-items: center; gap: 0.5rem; min-width: 0;
  height: 2rem; padding: 0 0.8rem;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); font-size: var(--t-xs); color: var(--ink-dim);
  white-space: nowrap;
}
.status-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; background: var(--ink-faint); }
.status-pill[data-state="ok"] .status-dot { background: var(--tide); }
.status-pill[data-state="warn"] .status-dot { background: var(--warn); }
.status-pill[data-state="bad"] .status-dot { background: var(--oxide); }
.status-value {
  font-family: var(--font-machine); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; max-width: 26ch;
  padding-left: 0.5rem; border-left: 1px solid var(--border);
}

/* --- view ----------------------------------------------------------------- */

.view { padding: 2.25rem 2.5rem 5rem; max-width: 80rem; width: 100%; }

.page-header { margin-bottom: 1.75rem; }
/* The human names the thing in the chart's serif; when a page has a machine
   half — the folder it reads — it follows in mono after a rule. */
.page-title {
  display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap;
  font-family: var(--font-display);
  font-size: var(--t-title); font-weight: 600; letter-spacing: -0.015em;
  line-height: 1.15;
}
.page-subject {
  font-family: var(--font-machine); font-size: var(--t-sm); font-weight: 400;
  letter-spacing: 0; color: var(--ink-faint);
  padding-left: 0.75rem; border-left: 1px solid var(--border-strong);
  align-self: center; word-break: break-all;
}
.page-description {
  margin-top: 0.5rem; font-size: var(--t-base);
  color: var(--ink-dim); max-width: 64ch; line-height: 1.6;
}

.section-actions { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }

/* Two panels under the constellation: the background service, and the reach
   Asterisk has into other things. */
.overview-grid {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem; align-items: start;
}
.overview-grid > * { min-width: 0; }
.overview-grid .card + .card { margin-top: 0; }

/* --- settings --------------------------------------------------------------
   An index and a body, not an accordion. The index is sticky and narrow; the
   body carries the everyday fields, then Advanced when asked for. */

.settings-layout {
  display: grid; grid-template-columns: 13rem minmax(0, 1fr);
  gap: 1.75rem; align-items: start;
}

.toc {
  position: sticky; top: calc(var(--bar) + 3.75rem);
  display: flex; flex-direction: column; gap: 1px;
  max-height: calc(100vh - var(--bar) - 5rem); overflow-y: auto;
}
.toc-heading {
  padding: 0.9rem 0.6rem 0.3rem;
  font-size: var(--t-xs); font-weight: 600; color: var(--ink-faint);
}
.toc-item {
  position: relative;
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.38rem 0.6rem; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-dim);
  font-family: var(--font-human); font-size: var(--t-sm);
  text-align: left; cursor: pointer; width: 100%;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.toc-item:hover { background: var(--surface-high); color: var(--ink); }
.toc-item[aria-current] { color: var(--ink); font-weight: 600; }
.toc-item[aria-current]::before {
  content: ""; position: absolute; left: -0.5rem; top: 50%;
  width: 3px; height: 1rem; margin-top: -0.5rem;
  border-radius: 999px; background: var(--signal);
}
.toc-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-count { font-size: var(--t-2xs); color: var(--ink-faint); flex: none; }
/* Staged edits are the one thing worth pulling the eye back to a section for. */
.toc-staged {
  flex: none; padding: 0.02rem 0.4rem; border-radius: 999px;
  background: var(--signal-wash); color: var(--signal);
  font-size: var(--t-2xs); font-weight: 600;
}

/* Each section is its own panel, and deliberately NOT one container with the
   sections inside it: an overflow:hidden wrapper is a scroll container, and a
   sticky heading inside one resolves its top inset against that box instead
   of the viewport. */
.settings-body { display: flex; flex-direction: column; gap: 0.9rem; }

.settings-section {
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface);
}
.settings-section-head {
  /* Under the bar AND the sticky search row above the page, or the heading
     slides behind the search row instead of pinning beneath it. */
  position: sticky; top: calc(var(--bar) + 3.2rem); z-index: 10;
  display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
  padding: 0.75rem 1.1rem 0.6rem;
  background: var(--surface); border-bottom: 1px solid var(--border);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
}
.settings-section-name {
  font-family: var(--font-display); font-size: var(--t-lg); font-weight: 600;
  color: var(--ink); letter-spacing: -0.005em;
}
.settings-section .field:last-child { border-radius: 0 0 var(--r-lg) var(--r-lg); }
.settings-section-count { font-size: var(--t-xs); color: var(--ink-faint); }

/* The way into the rest of the schema: a full-width row, so it reads as the
   next thing on the page rather than a button floating beside it. */
.advanced-toggle {
  display: flex; align-items: center; gap: 0.75rem; width: 100%;
  padding: 0.9rem 1.1rem; margin: 0.4rem 0;
  border: 1px dashed var(--border-strong); border-radius: var(--r-lg);
  background: transparent; color: var(--ink);
  font-family: var(--font-human); text-align: left; cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.advanced-toggle:hover { background: var(--surface); border-color: var(--signal); }
.advanced-toggle .icon { color: var(--ink-faint); }
.advanced-toggle-text { display: flex; flex-direction: column; min-width: 0; }
.advanced-toggle-title { font-size: var(--t-sm); font-weight: 600; }
.advanced-toggle-detail { font-size: var(--t-xs); color: var(--ink-faint); }

@media (max-width: 1100px) {
  .settings-layout { grid-template-columns: 1fr; }
  /* Sticking a full-width index to the top of a narrow window costs more than
     it gives, so it becomes a strip of chips that scrolls with the page. */
  .toc {
    position: static; flex-direction: row; flex-wrap: wrap; max-height: none;
    gap: 0.3rem; margin-bottom: 0.25rem;
  }
  .toc-heading { width: 100%; padding: 0.4rem 0 0; }
  .toc-item { width: auto; border: 1px solid var(--border); background: var(--surface); }
  .toc-item[aria-current] { border-color: var(--signal); }
  .toc-item[aria-current]::before { display: none; }
  .field { grid-template-columns: 1fr; gap: 0.5rem; }
  .field-control { justify-content: flex-start; }
  /* The search row wraps to an unknown height here; a heading pinned to a
     guessed offset would sit on top of it. */
  .settings-section-head { position: static; }
}

/* --- forms ---------------------------------------------------------------- */

.form-grid {
  display: grid; grid-template-columns: 8.5rem 1fr;
  gap: 0.75rem 0.9rem; align-items: center;
}
.form-grid .form-span { grid-column: 1 / -1; }
.form-hint { font-size: var(--t-xs); color: var(--ink-faint); }

/* The editor's left column is narrow; a label column there would leave the
   field a few characters wide. */
.editor-grid .form-grid { grid-template-columns: 1fr; gap: 0.45rem; }

/* --- save bar -------------------------------------------------------------- */

/* Fixed, not sticky: with every field on the page the bar would otherwise sit
   at the bottom of a long document. It follows the rail's width because it
   spans the reading column. */
.save-bar {
  position: fixed; z-index: 30;
  left: calc(var(--rail) + 2.5rem); right: 2.5rem; bottom: 1.25rem;
  max-width: 75rem;
  display: flex; align-items: center; gap: 0.9rem;
  padding: 0.6rem 0.75rem 0.6rem 1.1rem;
  border: 1px solid var(--signal); border-radius: var(--r-lg);
  background: var(--surface); box-shadow: var(--shadow-3);
}
.shell[data-rail="tight"] .save-bar { left: calc(var(--rail-tight) + 2.5rem); }
.save-bar-count { flex: 1; font-size: var(--t-sm); font-weight: 600; }

/* --- editor ---------------------------------------------------------------- */

.editor-grid { display: grid; grid-template-columns: 17rem 1fr; gap: 1rem; align-items: start; }
/* Without this a nowrap description inside (.skill-item-desc, below) hands its
   min-content width up through the grid item to the track itself. */
.editor-grid > * { min-width: 0; }
.file-list { max-height: 55vh; overflow-y: auto; padding: 0.35rem; }
.file-item {
  display: block; width: 100%; padding: 0.4rem 0.55rem;
  border: 0; border-radius: var(--r-sm); background: transparent;
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-dim); text-align: left; cursor: pointer;
  word-break: break-all;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.file-item:hover { background: var(--surface-high); color: var(--ink); }
.file-item[aria-current] { background: var(--signal-wash); color: var(--ink); }

/* --- skills ----------------------------------------------------------------- */

.skill-search { padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--border); }
.skill-list-body { max-height: 46vh; overflow-y: auto; padding: 0.35rem; }
/* Agents' counterpart to .skill-list-body above. Without a height cap this
   grew to the full 27-bundled-agent list and dragged the grid row with it. */
.agent-list-body { max-height: 46vh; overflow-y: auto; padding: 0.35rem; }

.skill-group {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 0.75rem 0.55rem 0.3rem;
}
.skill-group:first-child { padding-top: 0.35rem; }

.skill-item {
  display: flex; flex-direction: column; gap: 0.1rem;
  width: 100%; padding: 0.45rem 0.55rem;
  border: 0; border-radius: var(--r-sm); background: transparent;
  color: inherit; text-align: left; cursor: pointer;
  transition: background-color var(--dur) var(--ease);
}
.skill-item:hover { background: var(--surface-high); }
.skill-item[aria-current] { background: var(--signal-wash); }
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

/* --- inert, by design -------------------------------------------------------
   .check-bad (components.ts) is "this is broken": red mark, red wash. A rule
   written for a language this project is not never earns that — it is the
   layered-rules feature working — so its row keeps the .check shape with a
   quiet dash, and the whole list sits behind a native <details>, collapsed. */
.check-dim .check-mark { color: var(--ink-faint); }

.dormant {
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface); overflow: hidden;
}
.card + .dormant, .dormant + .card, .dormant + .dormant { margin-top: 1rem; }
.dormant-summary {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.75rem 1.1rem; cursor: pointer; list-style: none;
  color: var(--ink-faint); font-size: var(--t-sm);
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.dormant-summary::-webkit-details-marker { display: none; }
.dormant-summary:hover { background: var(--surface-high); color: var(--ink-dim); }
.dormant-summary:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
/* The chevron rotates open rather than a layout property animating. */
.dormant-summary .icon { transition: transform var(--dur) var(--ease); }
.dormant[open] .dormant-summary .icon { transform: rotate(90deg); }
.dormant-body { border-top: 1px solid var(--border); }

/* --- informative empty state -------------------------------------------------
   .empty is the quiet one-liner for a list that is merely between items. A
   page that is blank because nothing has been added *yet* says what the
   thing is and hands over the action that fills it. */
.empty-state { padding: 1.25rem 1.1rem; max-width: 42rem; }
.empty-state-title { font-family: var(--font-display); font-size: var(--t-lg); font-weight: 600; color: var(--ink); }
.empty-state-body { margin-top: 0.35rem; font-size: var(--t-sm); color: var(--ink-dim); line-height: 1.6; }
.empty-state-action { margin-top: 0.9rem; }

/* --- gate ------------------------------------------------------------------ */

.gate { display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
.gate-card {
  width: 100%; max-width: 30rem; padding: 2rem;
  border: 1px solid var(--border); border-radius: var(--r-xl);
  background: var(--surface);
}
.gate-mark { width: 2.5rem; height: 2.5rem; color: var(--star); display: block; margin-bottom: 1rem; }
.gate-title {
  font-family: var(--font-display); font-size: var(--t-title); font-weight: 600; letter-spacing: -0.015em;
}
.gate-text { margin-top: 0.75rem; font-size: var(--t-sm); color: var(--ink-dim); line-height: 1.6; }
.gate-code {
  display: block; margin-top: 0.6rem; padding: 0.6rem 0.75rem;
  font-family: var(--font-machine); font-size: var(--t-xs); color: var(--ink);
  background: var(--surface-high); border: 1px solid var(--border); border-radius: var(--r-sm);
  word-break: break-all;
}

/* --- responsive ------------------------------------------------------------ */

@media (max-width: 1100px) {
  .view { padding: 1.75rem 1.5rem 4rem; }
  .header { padding-left: 1.5rem; }
  .save-bar { left: calc(var(--rail) + 1.5rem); right: 1.5rem; }
}

@media (max-width: 900px) {
  /* minmax(0, 1fr), not 1fr: a plain 1fr track still floors itself at the
     item's min-content, which for the strip .nav becomes below 640px is all
     its destinations in one line. The 0 floor lets .nav scroll instead. */
  .shell, .shell[data-rail="tight"] { grid-template-columns: minmax(0, 1fr); }
  .rail {
    position: static; height: auto; overflow: visible;
    border-right: 0; border-bottom: 1px solid var(--rail-border);
  }
  .brand { height: 3.25rem; }
  [data-rail="tight"] .brand { justify-content: flex-start; padding: 0 1.1rem; }
  [data-rail="tight"] .brand-name, [data-rail="tight"] .brand-meta { display: block; }
  .nav { display: flex; flex-wrap: wrap; padding: 0 0.6rem 0.6rem; overflow: visible; gap: 0.2rem; }
  .nav-group { width: 100%; padding: 0.4rem 0.5rem 0.2rem; }
  .nav-item, .nav-more, [data-rail="tight"] .nav-item, [data-rail="tight"] .nav-more {
    width: auto; margin: 0; padding: 0.45rem 0.7rem; justify-content: flex-start;
  }
  [data-rail="tight"] .nav-label, [data-rail="tight"] .nav-count { display: inline; }
  .nav-more { margin-top: 0; }
  /* The left marker has nothing to hang off in a wrapped row. */
  .nav-item[aria-current]::before { display: none; }
  .nav-item[aria-current] { box-shadow: inset 0 -2px 0 var(--rail-signal); }
  /* Collapsing a rail that is already a strip of chips does nothing. */
  .rail-foot { display: none; }
  .editor-grid { grid-template-columns: 1fr; }
  .overview-grid { grid-template-columns: 1fr; }
  .header { gap: 0.5rem; padding: 0 0.75rem 0 1rem; }
  .status-pill .status-value { display: none; }
  .view { padding: 1.5rem 1rem 3rem; }
  .save-bar, .shell[data-rail="tight"] .save-bar { left: 1rem; right: 1rem; }
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; gap: 0.4rem; }
  .page-title { font-size: 1.5rem; }

  /* Below 640 the rail stops wrapping and becomes one strip you swipe:
     every destination is still one tap away, the current one still carries
     its underline, and the scroll lives inside .nav, never the page. */
  .nav {
    flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity;
    padding: 0 0.6rem 0.5rem;
  }
  .nav-group { display: none; }
  .nav-item, .nav-more { flex: none; scroll-snap-align: start; }
  /* The page's own h1 already names it; the bar keeps the daemon's state. */
  .crumb-leaf { display: none; }

  /* Nine section chips wrapped into four rows were a screen of their own.
     One strip you swipe, like the rail above it. */
  .toc { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 0.25rem; }
  .toc-heading { display: none; }
  .toc-item { flex: none; }

  /* .log-line's fixed time/level columns are over half a phone's width.
     The message becomes its own row so it gets the whole line. */
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
  .nav-more { min-height: 2.75rem; }
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

.mt { margin-top: 1rem; }
.mb { margin-bottom: 1rem; }
`;

export const STYLES = `${THEME}\n${COMPONENTS}\n${STAR}\n${LAYOUT}\n${WIDTH_UTILITIES}\n`;
