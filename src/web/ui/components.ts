// The component vocabulary.
//
// Class names have survived two redesigns now — .btn-default, .badge-success,
// .card and the rest — because the markup that builds them was sound both
// times and only the look was being replaced. Keeping them is what lets a
// change this size touch four files instead of fifteen.
//
// The colour rule, applied consistently below:
//
//   --signal   interactive   the primary action, the current page, focus
//   --tide     healthy, running, present
//   --warn     degraded — working, but not as intended
//   --oxide    failed or destructive
//   --ink-faint   off, absent, nothing there
//
// A reader can tell a running thing from a stopped one without reading either
// label, which is what the accents are being spent on.
//
// Type roles: structural labels — card headers, rail groups, silkscreen — are
// sans, small, semibold and tracked. Monospace is reserved for what the machine
// owns: paths, keys, counts, model tags, log lines. A heading is not machine
// output, and setting it in mono said it was.

export const COMPONENTS = String.raw`
/* --- silkscreen ---------------------------------------------------------
   The tiny wide-tracked machine label, as found printed beside a socket on a
   piece of equipment. Used only for structural labels — sidebar groups and
   card headers — never for content. */

.silk {
  font-size: var(--t-2xs);
  font-weight: 600;
  letter-spacing: var(--track-silk);
  text-transform: uppercase;
  color: var(--ink-faint);
}

/* --- button ------------------------------------------------------------- */

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
  height: 2rem; padding: 0 0.7rem; white-space: nowrap;
  border: 1px solid transparent; border-radius: var(--r-sm);
  background: transparent; color: inherit;
  font-family: var(--font-human); font-size: var(--t-sm); font-weight: 500;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease),
              color var(--dur) var(--ease);
}
.btn:disabled { pointer-events: none; opacity: 0.38; }

/* --signal-strong, not --signal: as a *fill* under white --signal-ink text the
   token needs to be darker than it does as text on the page, and in dark theme
   no single lightness serves both (--signal as fill measured 3.83:1 against the
   4.5:1 floor). See the --signal-strong comment in theme.ts. */
.btn-default {
  background: var(--signal-strong); border-color: var(--signal-strong); color: var(--signal-ink);
  font-weight: 600;
}
.btn-default:hover { filter: brightness(1.07); }

.btn-outline { border-color: var(--border); background: var(--surface); color: var(--ink-dim); }
.btn-outline:hover { border-color: var(--border-strong); background: var(--surface-high); color: var(--ink); }

.btn-secondary { background: var(--surface-high); border-color: var(--border); }
.btn-secondary:hover { border-color: var(--border-strong); }

.btn-ghost { color: var(--ink-dim); }
.btn-ghost:hover { background: var(--surface-high); color: var(--ink); }

.btn-destructive { background: var(--oxide); border-color: var(--oxide); color: white; font-weight: 600; }
.btn-destructive:hover { filter: brightness(1.07); }

/* Quiet destructive, for the Delete that repeats in every row of a list. */
.btn-destructive-ghost { color: var(--oxide); }
.btn-destructive-ghost:hover { background: var(--oxide-wash); }

/* Destructive among outline peers — Stop beside Start and Restart. */
.btn-outline-destructive { border-color: var(--border-strong); background: var(--surface); color: var(--oxide); }
.btn-outline-destructive:hover { border-color: var(--oxide); background: var(--oxide-wash); }

/* Square when the label is an icon and nothing else. */
.btn-sm { height: 1.75rem; padding: 0 0.55rem; font-size: var(--t-xs); }
.btn-icon { width: 2rem; padding: 0; }
.btn-icon.btn-sm { width: 1.75rem; }

/* --- fields ------------------------------------------------------------- */

.input, .select, .textarea {
  width: 100%; color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  font-family: var(--font-machine); font-size: var(--t-sm);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.input, .select { height: 2rem; padding: 0 0.55rem; }
.textarea {
  padding: 0.7rem 0.85rem; min-height: 26rem; resize: vertical;
  line-height: 1.7; font-size: var(--t-sm);
}
.input::placeholder, .textarea::placeholder { color: var(--ink-faint); }

.input:focus-visible, .select:focus-visible, .textarea:focus-visible {
  outline: none; border-color: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-wash);
}
.input:disabled, .select:disabled { opacity: 0.5; cursor: not-allowed; }
.input[aria-invalid="true"] { border-color: var(--oxide); }
.input[aria-invalid="true"]:focus-visible { box-shadow: 0 0 0 3px var(--oxide-wash); }

.select {
  appearance: none; cursor: pointer; padding-right: 1.7rem;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 0.85rem) 56%, calc(100% - 0.6rem) 56%;
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}

.label { font-size: var(--t-sm); font-weight: 500; color: var(--ink); }

/* --- switch --------------------------------------------------------------
   A rocker, not a pill: square ends and a short throw, so it reads as a panel
   switch rather than a phone setting. */

.switch {
  display: inline-flex; align-items: center; flex: none;
  width: 2.1rem; height: 1.1rem; padding: 2px;
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  background: var(--bg); cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.switch::after {
  content: ""; display: block;
  width: 0.85rem; height: 100%; border-radius: 2px;
  background: var(--ink-faint);
  transition: transform var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.switch[aria-checked="true"] { border-color: var(--signal); background: var(--signal-wash); }
.switch[aria-checked="true"]::after { transform: translateX(0.95rem); background: var(--signal); }

/* --- badge -------------------------------------------------------------- */

/* Pills, tinted, with a rim of their own colour — a status you read at a
   glance rather than a chip you read a word off. */
.badge {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.05rem 0.45rem; border-radius: 999px;
  border: 1px solid transparent;
  font-family: var(--font-machine); font-size: var(--t-2xs); line-height: 1.6;
  white-space: nowrap;
}
.badge-dot::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: currentColor; flex: none;
}

/* running, healthy */
.badge-success { color: var(--tide); background: var(--tide-wash); border-color: var(--tide-wash); }
/* a quantity at rest */
.badge-secondary { color: var(--ink-dim); background: var(--surface-high); border-color: var(--border); }
/* off, absent */
.badge-muted { color: var(--ink-faint); background: var(--surface-high); border-color: transparent; }
.badge-destructive { color: var(--oxide); background: var(--oxide-wash); border-color: var(--oxide-wash); }
.badge-outline { color: var(--ink-dim); border-color: var(--border); }

/* --- card ----------------------------------------------------------------
   Flat, hairline-bounded, header separated by a rule rather than a fill. No
   drop shadow: the surface is a panel, and panels do not float. */

.card {
  background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-lg);
  overflow: hidden;
  transition: border-color var(--dur) var(--ease);
}
.card:hover { border-color: var(--border-strong); }
.card + .card { margin-top: 0.875rem; }

.card-header {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.65rem 1rem;
}
.card-title {
  font-size: var(--t-2xs); font-weight: 600;
  letter-spacing: var(--track-silk); text-transform: uppercase;
  color: var(--ink-faint);
}
.card-divided > .card-header { border-bottom: 1px solid var(--border); }
.card-content { padding: 1rem; }

/* --- list rows ----------------------------------------------------------- */

.list-row {
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 0.875rem;
  padding: 0.75rem 1rem; border-top: 1px solid var(--border);
  transition: background-color var(--dur) var(--ease);
}
.list-row:first-child { border-top: 0; }
.list-row:hover { background: var(--surface-high); }
.list-row-grow { flex: 1; min-width: 0; }
/* A row with four actions (a connected OAuth server can Reconnect,
   Disconnect, Disable and Delete) has nothing left to give .list-row-grow
   at 375px — flex-wrap lets .section-actions drop to its own line instead
   of the detail text collapsing to a 0-width column of single characters. */
.list-row > .section-actions { flex: 0 0 auto; justify-content: flex-end; }
.list-row-title { font-size: var(--t-sm); font-weight: 500; }
/* anywhere, not break-all: this line carries a path in one row and a sentence
   in the next, and break-all split "included" across two lines. */
.list-row-detail {
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-faint); overflow-wrap: anywhere; margin-top: 0.15rem;
}

/* --- settings field ------------------------------------------------------
   Name and key on one line, description under it, control in a fixed column on
   the right. The row this replaced stacked three lines and let the control
   float across half the window, which is what made forty settings feel like a
   thousand. */

.field {
  display: grid; grid-template-columns: minmax(0, 1fr) 21rem;
  gap: 1.5rem; align-items: center;
  padding: 0.6rem 1rem; border-top: 1px solid var(--border);
  transition: background-color var(--dur) var(--ease);
}
.field:first-child { border-top: 0; }
.field:hover { background: var(--surface-high); }
.field-text { min-width: 0; }
.field-name {
  font-size: var(--t-sm); font-weight: 500; color: var(--ink);
  margin-right: 0.5rem;
}
/* The key you would type into the CLI, beside the name rather than under it. */
.field-path {
  font-family: var(--font-machine); font-size: var(--t-2xs);
  color: var(--ink-faint); overflow-wrap: anywhere;
}
.field-help {
  font-size: var(--t-xs); color: var(--ink-dim);
  margin-top: 0.1rem; max-width: 68ch; line-height: 1.5;
}
/* A grid, not a flex row: the reset button appears on some rows and not
   others, and letting it shrink the input gave the column a ragged right edge
   where every value should start at the same x. */
.field-control {
  display: grid; grid-template-columns: minmax(0, 1fr) 3.6rem;
  align-items: center; gap: 0.4rem;
}
.field-control .input, .field-control .select { width: 100%; min-width: 0; }
.field-control .btn { justify-self: start; }
/* Rows that carry more than one action — Save beside Clear — cannot use the
   two-cell grid, which puts the third control on a line of its own. */
.field-control-row { display: flex; justify-content: flex-end; }
.field-control-row .input { flex: 1 1 auto; }
.switch-cell { display: flex; align-items: center; gap: 0.5rem; }
.switch-state {
  font-family: var(--font-machine); font-size: var(--t-2xs);
  color: var(--ink-faint);
}
/* A staged edit is pending, not live — it gets the resting accent. */
.field-dirty { background: var(--tide-wash); }
.field-dirty:hover { background: var(--tide-wash); }

/* --- tabs ---------------------------------------------------------------- */

.tabs-list {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px; border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--bg);
}
.tabs-trigger {
  height: 1.75rem; padding: 0 0.7rem; border: 0; border-radius: calc(var(--r-sm) - 2px);
  background: transparent; color: var(--ink-faint);
  font-family: var(--font-human); font-size: var(--t-xs); font-weight: 500;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.tabs-trigger:hover { color: var(--ink); }
.tabs-trigger[aria-selected="true"] { background: var(--surface-high); color: var(--ink); }

/* --- toolbar --------------------------------------------------------------
   The filter row above a long page. Sticky under the bar, because on a page
   worth filtering you are usually scrolled away from the top when you decide
   to filter it. */

.toolbar {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  padding: 0.6rem 0; margin-bottom: 0.75rem;
  position: sticky; top: var(--bar); z-index: 12;
  background: var(--bg);
}
.toolbar .input { flex: 1 1 16rem; max-width: 26rem; }
.toolbar-spacer { flex: 1; }
/* Inside a card the row is part of the panel, not the page. */
.toolbar-inset {
  position: static; margin: 0; padding: 0.6rem 0.75rem;
  background: var(--surface-high); border-bottom: 1px solid var(--border);
}

/* A secret an environment variable has taken over. */
.field-shadowed { background: var(--oxide-wash); }

/* --- diagnostics ------------------------------------------------------------ */

.check {
  display: flex; align-items: flex-start; gap: 0.75rem;
  padding: 0.75rem 1rem; border-top: 1px solid var(--border);
}
.check:first-child { border-top: 0; }
/* --success was never a token in any revision of theme.ts, so this colour
   resolved to nothing and the mark inherited body text. */
.check-mark { color: var(--tide); flex: none; line-height: 1.4; display: flex; }
.check-bad .check-mark { color: var(--oxide); }
.check-name { font-size: var(--t-sm); font-weight: 500; }
.check-detail {
  margin-top: 0.15rem; font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-dim); overflow-wrap: anywhere;
}
.check-bad { background: var(--oxide-wash); }

/* --- log reader -------------------------------------------------------------- */

.log-scroll { max-height: 62vh; overflow-y: auto; }
.log { font-family: var(--font-machine); font-size: var(--t-xs); line-height: 1.6; }

.log-line {
  display: grid; grid-template-columns: 8.9rem 3.2rem 1fr; gap: 0.75rem;
  padding: 0.2rem 0.75rem;
}
.log-line:hover { background: var(--surface-high); }
.log-time { color: var(--ink-faint); white-space: nowrap; }
/* Repeated on every line, so it recedes: the times are what you scan, the date
   is what you check. */
.log-date { opacity: 0.6; }
.log-level { text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); }
.log-msg { color: var(--ink); overflow-wrap: anywhere; }
.log-extra { color: var(--ink-faint); }

.log-warn { color: var(--signal); }
.log-error, .log-fatal { color: var(--oxide); }
.log-line.is-warn { background: color-mix(in oklch, var(--signal) 7%, transparent); }
.log-line.is-error { background: var(--oxide-wash); }
/* Output from a subprocess that never went through pino. */
.log-line.is-raw .log-msg { color: var(--ink-dim); }

/* --- empty / skeleton ----------------------------------------------------- */

.empty {
  padding: 2rem 1rem; text-align: center;
  font-size: var(--t-sm); color: var(--ink-faint);
}
.file-list .empty { padding: 1rem 0.75rem; }

.skeleton {
  background: var(--surface-high); border-radius: var(--r-sm);
  animation: pulse 1.8s var(--ease) infinite;
}
.skeleton-line { height: 0.75rem; margin: 0.55rem 0; }
.skeleton-row { padding: 0.75rem 1rem; border-top: 1px solid var(--border); }
.skeleton-row:first-child { border-top: 0; }

@keyframes pulse { 50% { opacity: 0.45; } }

/* --- toast ---------------------------------------------------------------- */

.toasts {
  position: fixed; bottom: 1rem; right: 1rem; z-index: 100;
  display: flex; flex-direction: column; gap: 0.5rem;
  max-width: min(25rem, calc(100vw - 2rem));
}
.toast {
  display: flex; flex-direction: column; gap: 0.2rem;
  padding: 0.7rem 0.85rem;
  background: var(--surface-high); border: 1px solid var(--border-strong);
  border-left: 2px solid var(--ink-faint); border-radius: var(--r-sm);
  box-shadow: var(--shadow-3); font-size: var(--t-sm);
  animation: toast-in var(--dur) var(--ease);
}
.toast-title { font-weight: 500; }
.toast-detail {
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-dim); overflow-wrap: anywhere;
}
.toast-success { border-left-color: var(--signal); }
.toast-error { border-left-color: var(--oxide); }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(0.4rem); }
  to   { opacity: 1; transform: none; }
}

/* --- code ----------------------------------------------------------------- */

.code-block {
  margin: 0; padding: 0.9rem 1rem; overflow-x: auto;
  font-family: var(--font-machine); font-size: var(--t-xs);
  line-height: 1.75; max-height: 62vh; color: var(--ink-dim);
}
.code-inline {
  font-family: var(--font-machine); font-size: 0.9em;
  color: var(--tide); word-break: break-all;
}

/* --- connectors ----------------------------------------------------------- */

/* A monogram, not a logo. Brand marks would mean shipping and licensing a
   dozen images, and the CSP forbids loading any of them from their origin —
   so the first letter on a neutral surface it is. */
.connector-mark {
  flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: var(--r-sm);
  display: grid; place-items: center;
  background: var(--surface-high); border: 1px solid var(--border);
  font-family: var(--font-machine); font-size: var(--t-sm); font-weight: 600;
  color: var(--ink-dim); text-transform: uppercase;
}

/* Popular services, before they are added. Auto-fit rather than a fixed count
   so the row reflows on a narrow window instead of overflowing the card. */
.connector-cards {
  display: grid; gap: 0.75rem; margin-bottom: 1.25rem;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
}
.connector-card {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.85rem 0.9rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-md);
  transition: border-color var(--dur) var(--ease);
}
.connector-card:hover { border-color: var(--border-strong); }
.connector-card-body { min-width: 0; flex: 1 1 auto; }
.connector-card-name { font-size: var(--t-sm); font-weight: 600; }
.connector-card-detail {
  font-size: var(--t-xs); color: var(--ink-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Setting a connector up by hand: values the user has to carry to somebody
   else's console. They are readonly inputs rather than text because a value
   you must paste elsewhere has to be selectable, copyable and whole — text
   that ellipsises or a line inside an alert() is neither. */
.copy-row { display: flex; gap: 0.4rem; align-items: center; }
.copy-row .input { flex: 1 1 auto; font-family: var(--font-machine); font-size: var(--t-xs); }
.copy-row .input[readonly] { background: var(--bg); }
.link {
  color: var(--signal); text-decoration: underline;
  text-underline-offset: 0.15em; border-radius: var(--r-sm);
}
.link:hover { text-decoration-thickness: 2px; }
.link:focus-visible {
  outline: none; box-shadow: 0 0 0 3px var(--signal-wash);
}

/* --- touch targets ---------------------------------------------------------
   Every .btn, field and tab here is 28-32px tall — right for the 1440px
   density this vocabulary is built around, and a miss for a finger. Gate on
   the pointer or the viewport, never both unconditionally, so a mouse on a
   wide screen never sees a bigger button than it asked for. */
@media (pointer: coarse), (max-width: 768px) {
  .btn { min-height: 2.75rem; }
  .btn-icon { width: 2.75rem; }
  .btn-icon.btn-sm { width: 2.75rem; }
  .input, .select { min-height: 2.75rem; }
  /* A short label like "All" pads out to only ~36px wide even at the taller
     height — width needs its own floor, not just height. */
  .tabs-trigger { min-height: 2.75rem; min-width: 2.75rem; }

  /* A rocker can't grow to 44px and stay a rocker, so the hit area grows
     instead of the control: an invisible square centred on it, the usual
     trick for a control that cannot grow visually without losing what makes
     it legible as itself. */
  .switch { position: relative; }
  .switch::before {
    content: ""; position: absolute; top: 50%; left: 50%;
    width: 2.75rem; height: 2.75rem; transform: translate(-50%, -50%);
  }
}
`;
