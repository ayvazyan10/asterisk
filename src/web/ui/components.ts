// shadcn/ui component shapes, ported to plain CSS classes.
//
// Each block below corresponds to one upstream shadcn component, and the
// geometry is taken from it: the 36px default control height, the 8px/6px
// radius pair, the `border-input` + `ring` focus treatment, the
// `muted-foreground` secondary text, the 500-weight labels. Class names follow
// the component rather than the page, so `.btn-destructive` means the same
// thing everywhere it appears.
//
// Two upstream behaviours are deliberately not reproduced:
//
//   - Radix's floating layer (Popover, DropdownMenu, Select) positions itself
//     by writing inline styles. Under this panel's CSP that is neither
//     available nor needed, so the select stays a native <select> and the
//     tooltip is a CSS-only hover affordance.
//   - Tailwind's arbitrary-value escape hatch has no equivalent. Anything that
//     would have been a one-off utility is a named class here instead.

export const COMPONENTS = String.raw`
/* --- button ------------------------------------------------------------ */

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
  white-space: nowrap; border-radius: var(--radius-md);
  font-family: inherit; font-size: var(--text-sm); font-weight: 500;
  height: 2.25rem; padding: 0 1rem;
  border: 1px solid transparent; background: transparent; color: inherit;
  cursor: pointer; text-decoration: none;
  transition: background-color var(--duration) var(--ease),
              border-color var(--duration) var(--ease),
              color var(--duration) var(--ease),
              opacity var(--duration) var(--ease);
}
.btn:disabled { pointer-events: none; opacity: 0.5; }

.btn-default {
  background: var(--primary); color: var(--primary-foreground);
  box-shadow: var(--shadow-sm);
}
.btn-default:hover { background: color-mix(in oklch, var(--primary) 90%, transparent); }

.btn-secondary {
  background: var(--secondary); color: var(--secondary-foreground);
  box-shadow: var(--shadow-sm);
}
.btn-secondary:hover { background: color-mix(in oklch, var(--secondary) 80%, transparent); }

.btn-outline {
  border-color: var(--input); background: var(--background); color: var(--foreground);
  box-shadow: var(--shadow-sm);
}
.btn-outline:hover { background: var(--accent); color: var(--accent-foreground); }

.btn-ghost { color: var(--foreground); }
.btn-ghost:hover { background: var(--accent); color: var(--accent-foreground); }

.btn-destructive {
  background: var(--destructive); color: var(--destructive-foreground);
  box-shadow: var(--shadow-sm);
}
.btn-destructive:hover { background: color-mix(in oklch, var(--destructive) 90%, transparent); }

/* Destructive as a quiet action — used for row-level Delete/Revoke, where a
   filled red button in every row would shout over the content it acts on. */
.btn-destructive-ghost { color: var(--destructive); }
.btn-destructive-ghost:hover {
  background: color-mix(in oklch, var(--destructive) 12%, transparent);
  color: var(--destructive);
}

/* Destructive sitting among outline peers — the daemon's Stop next to Start
   and Restart. A ghost there would read as the least important of the three
   rather than the most consequential. */
.btn-outline-destructive {
  border-color: var(--input); background: var(--background);
  color: var(--destructive); box-shadow: var(--shadow-sm);
}
.btn-outline-destructive:hover {
  background: color-mix(in oklch, var(--destructive) 12%, transparent);
  border-color: color-mix(in oklch, var(--destructive) 40%, transparent);
}

.btn-sm { height: 2rem; padding: 0 0.75rem; font-size: var(--text-xs); border-radius: var(--radius-sm); }

/* --- input / select / textarea ----------------------------------------- */

.input, .select, .textarea {
  display: flex; width: 100%;
  border-radius: var(--radius-md); border: 1px solid var(--input);
  background: var(--background); color: var(--foreground);
  font-family: inherit; font-size: var(--text-sm);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
}
.input, .select { height: 2.25rem; padding: 0 0.75rem; }
.textarea { padding: 0.5rem 0.75rem; min-height: 24rem; resize: vertical; line-height: 1.65; }

.input::placeholder, .textarea::placeholder { color: var(--muted-foreground); }

.input:focus-visible, .select:focus-visible, .textarea:focus-visible {
  outline: none; border-color: var(--ring);
  box-shadow: 0 0 0 1px var(--ring);
}
.input:disabled, .select:disabled, .textarea:disabled { cursor: not-allowed; opacity: 0.5; }
.input[aria-invalid="true"] { border-color: var(--destructive); }
.input[aria-invalid="true"]:focus-visible { box-shadow: 0 0 0 1px var(--destructive); }

/* Paths, keys and values are the machine's words — monospace marks them as
   quoted rather than authored. */
.input-mono, .textarea { font-family: var(--font-mono); }

.select {
  appearance: none; cursor: pointer; padding-right: 2rem;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 1rem) 55%, calc(100% - 0.7rem) 55%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}

.label {
  font-size: var(--text-sm); font-weight: 500; line-height: 1;
  color: var(--foreground);
}

/* --- switch ------------------------------------------------------------ */

.switch {
  display: inline-flex; align-items: center; flex: none;
  width: 2.25rem; height: 1.25rem; padding: 0;
  border-radius: 999px; border: 2px solid transparent;
  background: var(--input); cursor: pointer;
  transition: background-color var(--duration) var(--ease);
}
.switch::after {
  content: ""; display: block;
  width: 1rem; height: 1rem; border-radius: 50%;
  background: var(--background); box-shadow: var(--shadow-sm);
  transition: transform var(--duration) var(--ease);
}
.switch[aria-checked="true"] { background: var(--primary); }
.switch[aria-checked="true"]::after { transform: translateX(1rem); }

/* --- badge ------------------------------------------------------------- */

.badge {
  display: inline-flex; align-items: center; gap: 0.3rem;
  border-radius: var(--radius-md); border: 1px solid transparent;
  padding: 0.125rem 0.5rem;
  font-size: var(--text-xs); font-weight: 600; line-height: 1.25rem;
  white-space: nowrap;
}
.badge-secondary { background: var(--secondary); color: var(--secondary-foreground); }
.badge-outline { border-color: var(--border); color: var(--foreground); }
.badge-success {
  background: color-mix(in oklch, var(--success) 15%, transparent);
  color: var(--success);
  border-color: color-mix(in oklch, var(--success) 30%, transparent);
}
.badge-destructive {
  background: color-mix(in oklch, var(--destructive) 15%, transparent);
  color: var(--destructive);
  border-color: color-mix(in oklch, var(--destructive) 30%, transparent);
}
.badge-muted { background: var(--muted); color: var(--muted-foreground); }

/* A dot before the label reads as a status lamp; badges that are counts or
   plain labels opt out by omitting the modifier. */
.badge-dot::before {
  content: ""; width: 0.375rem; height: 0.375rem;
  border-radius: 50%; background: currentColor; flex: none;
}

/* --- card -------------------------------------------------------------- */

.card {
  border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: var(--card); color: var(--card-foreground);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.card + .card { margin-top: 1rem; }

.card-header {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 1.25rem 1.5rem;
}
.card-title { font-size: var(--text-sm); font-weight: 600; letter-spacing: -0.006em; }
.card-content { padding: 0 1.5rem 1.5rem; }
.card-divided > .card-header { border-bottom: 1px solid var(--border); }

/* --- stat card (dashboard overview) ------------------------------------ */

.stat-grid {
  display: grid; gap: 1rem; margin-bottom: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}
.stat-card {
  border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: var(--card); box-shadow: var(--shadow-sm);
  padding: 1.25rem 1.5rem;
}
.stat-label {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  font-size: var(--text-sm); font-weight: 500; color: var(--muted-foreground);
}
.stat-value {
  margin-top: 0.5rem; font-size: var(--text-stat); font-weight: 600;
  letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums;
}
.stat-value-sm { font-size: var(--text-xl); }
.stat-hint { margin-top: 0.25rem; font-size: var(--text-xs); color: var(--muted-foreground); }
.stat-value-success { color: var(--success); }
.stat-value-muted { color: var(--muted-foreground); }

/* --- list rows --------------------------------------------------------- */

.list-row {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.875rem 1.5rem; border-top: 1px solid var(--border);
  transition: background-color var(--duration) var(--ease);
}
.list-row:first-child { border-top: 0; }
.list-row:hover { background: color-mix(in oklch, var(--muted) 50%, transparent); }
.list-row-grow { flex: 1; min-width: 0; }
.list-row-title { font-size: var(--text-sm); font-weight: 500; }
.list-row-detail {
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--muted-foreground); word-break: break-all; margin-top: 0.125rem;
}

/* --- settings field row ------------------------------------------------ */

.field {
  display: grid; grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.05fr);
  gap: 1.5rem; align-items: start;
  padding: 1rem 1.5rem; border-top: 1px solid var(--border);
  transition: background-color var(--duration) var(--ease);
}
.field:first-child { border-top: 0; }
.field:hover { background: color-mix(in oklch, var(--muted) 50%, transparent); }
.field-path {
  display: block; font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--muted-foreground); margin-top: 0.25rem; word-break: break-all;
}
.field-help {
  font-size: var(--text-xs); color: var(--muted-foreground);
  margin-top: 0.375rem; max-width: 54ch; line-height: 1.5;
}
.field-control { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.field-control .input, .field-control .select { flex: 1 1 11rem; width: auto; min-width: 0; }
.field-control .btn { flex: none; }
.field-dirty { background: color-mix(in oklch, var(--primary) 8%, transparent); }
.field-dirty:hover { background: color-mix(in oklch, var(--primary) 12%, transparent); }

/* --- empty / skeleton --------------------------------------------------- */

.empty {
  padding: 2.5rem 1.5rem; text-align: center;
  font-size: var(--text-sm); color: var(--muted-foreground);
}
/* The content tab stacks one card per kind, most of them empty on a fresh
   install. Full-height empty states there turn the column into scrollback. */
.file-list .empty { padding: 1rem 0.75rem; }

.skeleton {
  background: var(--muted); border-radius: var(--radius-md);
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
.skeleton-line { height: 0.875rem; margin: 0.6rem 0; }
.skeleton-row { padding: 0.875rem 1.5rem; border-top: 1px solid var(--border); }
.skeleton-row:first-child { border-top: 0; }

@keyframes pulse { 50% { opacity: 0.5; } }

/* --- toast ------------------------------------------------------------- */

.toasts {
  position: fixed; bottom: 1rem; right: 1rem; z-index: 100;
  display: flex; flex-direction: column; gap: 0.5rem;
  max-width: min(26rem, calc(100vw - 2rem));
}
.toast {
  display: flex; flex-direction: column; gap: 0.25rem;
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--popover); color: var(--popover-foreground);
  padding: 0.875rem 1rem; box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  animation: toast-in var(--duration) var(--ease);
}
.toast-title { font-weight: 500; }
.toast-detail {
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--muted-foreground); word-break: break-all;
}
.toast-success { border-left: 3px solid var(--success); }
.toast-error { border-left: 3px solid var(--destructive); }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(0.5rem); }
  to   { opacity: 1; transform: none; }
}

/* --- code block -------------------------------------------------------- */

.code-block {
  margin: 0; padding: 1rem 1.5rem; overflow-x: auto;
  font-family: var(--font-mono); font-size: var(--text-xs);
  line-height: 1.7; background: var(--surface);
  max-height: 65vh; color: var(--foreground);
}
.code-inline {
  font-family: var(--font-mono); font-size: 0.85em;
  background: var(--muted); color: var(--foreground);
  padding: 0.125rem 0.375rem; border-radius: var(--radius-sm);
}
`;
