// The component vocabulary.
//
// Class names are unchanged from the revision before this one — .btn-default,
// .badge-success, .card and the rest — because the markup that builds them is
// sound and only the look is being replaced. What changed is everything
// visual: tighter corners, flatter surfaces, and colour that carries meaning
// rather than emphasis.
//
// The colour rule, applied consistently below:
//
//   --signal   live right now   daemon up, bot connected, server enabled
//   --tide     a quantity at rest   file counts, database size, stored things
//   --ink-faint   off, absent, nothing there
//   --oxide    destructive or failed
//
// So a reader can tell a running thing from a merely-configured thing without
// reading either label. That is the point of spending two accents instead of
// one.

export const COMPONENTS = String.raw`
/* --- silkscreen ---------------------------------------------------------
   The tiny wide-tracked machine label, as found printed beside a socket on a
   piece of equipment. Used only for structural labels — sidebar groups and
   card headers — never for content. */

.silk {
  font-family: var(--font-machine);
  font-size: var(--t-xs);
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

.btn-default {
  background: var(--signal); border-color: var(--signal); color: var(--signal-ink);
  font-weight: 600;
}
.btn-default:hover { filter: brightness(1.07); }

.btn-outline { border-color: var(--border-strong); background: var(--surface); }
.btn-outline:hover { border-color: var(--signal); background: var(--signal-wash); }

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

.btn-sm { height: 1.75rem; padding: 0 0.55rem; font-size: var(--t-xs); }

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

.badge {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.1rem 0.4rem; border-radius: var(--r-sm);
  border: 1px solid transparent;
  font-family: var(--font-machine); font-size: var(--t-xs); line-height: 1.4;
  white-space: nowrap;
}
.badge-dot::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: currentColor; flex: none;
}

/* live right now */
.badge-success { color: var(--signal); background: var(--signal-wash); }
/* a quantity at rest */
.badge-secondary { color: var(--tide); background: var(--tide-wash); }
/* off, absent */
.badge-muted { color: var(--ink-faint); background: var(--surface-high); }
.badge-destructive { color: var(--oxide); background: var(--oxide-wash); }
.badge-outline { color: var(--ink-dim); border-color: var(--border); }

/* --- card ----------------------------------------------------------------
   Flat, hairline-bounded, with a silkscreened header. No drop shadow: the
   surface is a panel, and panels do not float. */

.card {
  background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-lg);
  overflow: hidden;
}
.card + .card { margin-top: 0.875rem; }

.card-header {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.7rem 1rem;
  background: var(--surface-high);
}
.card-title {
  font-family: var(--font-machine); font-size: var(--t-xs);
  letter-spacing: var(--track-silk); text-transform: uppercase;
  color: var(--ink-dim); font-weight: 500;
}
.card-divided > .card-header { border-bottom: 1px solid var(--border); }
.card-content { padding: 1rem; }

/* --- list rows ----------------------------------------------------------- */

.list-row {
  display: flex; align-items: center; gap: 0.875rem;
  padding: 0.75rem 1rem; border-top: 1px solid var(--border);
  transition: background-color var(--dur) var(--ease);
}
.list-row:first-child { border-top: 0; }
.list-row:hover { background: var(--surface-high); }
.list-row-grow { flex: 1; min-width: 0; }
.list-row-title { font-size: var(--t-sm); font-weight: 500; }
/* anywhere, not break-all: this line carries a path in one row and a sentence
   in the next, and break-all split "included" across two lines. */
.list-row-detail {
  font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-faint); overflow-wrap: anywhere; margin-top: 0.15rem;
}

/* --- settings field ------------------------------------------------------ */

.field {
  display: grid; grid-template-columns: minmax(15rem, 1fr) minmax(16rem, 1fr);
  gap: 1.25rem; align-items: start;
  padding: 0.85rem 1rem; border-top: 1px solid var(--border);
}
.field:first-child { border-top: 0; }
.field:hover { background: var(--surface-high); }
.field-path {
  display: block; font-family: var(--font-machine); font-size: var(--t-xs);
  color: var(--ink-faint); margin-top: 0.15rem; overflow-wrap: anywhere;
}
.field-help {
  font-size: var(--t-xs); color: var(--ink-dim);
  margin-top: 0.35rem; max-width: 52ch; line-height: 1.55;
}
.field-control { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.field-control .input, .field-control .select { flex: 1 1 10rem; width: auto; min-width: 0; }
.field-control .btn { flex: none; }
/* A staged edit is pending, not live — it gets the resting accent. */
.field-dirty { background: var(--tide-wash); }
.field-dirty:hover { background: var(--tide-wash); }

/* --- tabs ---------------------------------------------------------------- */

.tabs-list {
  display: inline-flex; align-items: center;
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  overflow: hidden;
}
.tabs-trigger {
  height: 2rem; padding: 0 0.8rem; border: 0; border-right: 1px solid var(--border-strong);
  background: var(--surface); color: var(--ink-dim);
  font-family: var(--font-human); font-size: var(--t-sm); font-weight: 500;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.tabs-trigger:last-child { border-right: 0; }
.tabs-trigger:hover { color: var(--ink); }
.tabs-trigger[aria-selected="true"] { background: var(--signal-wash); color: var(--ink); }

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
`;
