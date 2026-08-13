// Control-panel stylesheet, inlined into the page under a CSP nonce.
//
// Three layers, composed at the bottom of this file:
//
//   theme.ts       design tokens (shadcn's names, Asterisk's amber)
//   components.ts  shadcn component shapes as plain CSS classes
//   this file      the application shell those components sit in
//
// Visual direction: shadcn's dashboard — a quiet sidebar, cards on a plain
// ground, one accent doing the signalling, and generous vertical rhythm. The
// panel used to be styled as a dense instrument readout; the redesign trades
// that density for shadcn's calmer hierarchy, which suits a settings surface
// where most rows are read once and changed rarely.

import { COMPONENTS } from './components.ts';
import { THEME } from './theme.ts';

/**
 * The page's CSP is `style-src 'nonce-…'`, and a nonce does not authorise
 * `style="…"` attributes — only whole `<style>` elements. Any width computed
 * at render time is therefore a class, quantised into 5% steps and emitted as
 * `.w0`…`.w100`. The skeleton placeholders are what use them today.
 */
const WIDTH_UTILITIES = Array.from(
  { length: 21 },
  (_, i) => `.w${i * 5} { width: ${i * 5}%; }`,
).join('\n');

const LAYOUT = String.raw`
/* --- shell ------------------------------------------------------------- */

.shell { display: grid; grid-template-columns: var(--sidebar) 1fr; min-height: 100vh; }

.sidebar {
  display: flex; flex-direction: column;
  background: var(--surface); border-right: 1px solid var(--border);
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}

.brand {
  display: flex; flex-direction: column; gap: 0.125rem;
  padding: 1rem 1rem 0.875rem;
  height: var(--header); justify-content: center;
  border-bottom: 1px solid var(--border);
}
.brand-name {
  font-size: var(--text-sm); font-weight: 600; letter-spacing: -0.01em;
  display: flex; align-items: center; gap: 0.125rem;
}
.brand-mark { color: var(--primary); }
.brand-meta {
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--muted-foreground);
}

.nav { flex: 1; padding: 0.75rem 0.5rem; display: flex; flex-direction: column; gap: 0.125rem; }
.nav-group {
  padding: 0.875rem 0.75rem 0.375rem;
  font-size: var(--text-xs); font-weight: 500;
  color: var(--muted-foreground);
}
.nav-group:first-child { padding-top: 0.25rem; }

.nav-item {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  width: 100%; padding: 0.5rem 0.75rem;
  border: 0; border-radius: var(--radius-md); background: transparent;
  font-family: inherit; font-size: var(--text-sm); font-weight: 500;
  color: var(--muted-foreground); text-align: left; cursor: pointer;
  transition: background-color var(--duration) var(--ease), color var(--duration) var(--ease);
}
.nav-item:hover { background: var(--accent); color: var(--accent-foreground); }
.nav-item[aria-current="true"] {
  background: color-mix(in oklch, var(--primary) 14%, transparent);
  color: var(--foreground);
}
.nav-count {
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--muted-foreground); font-variant-numeric: tabular-nums;
}

.sidebar-footer { padding: 0.75rem; border-top: 1px solid var(--border); }
.sidebar-footer .btn { width: 100%; }

/* --- header ------------------------------------------------------------ */

.main { min-width: 0; display: flex; flex-direction: column; }

.header {
  display: flex; align-items: center; gap: 1.5rem;
  height: var(--header); padding: 0 1.5rem; flex: none;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklch, var(--background) 80%, transparent);
  backdrop-filter: blur(8px);
  position: sticky; top: 0; z-index: 20;
}
.header-stat { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-sm); min-width: 0; }
.header-stat-label { color: var(--muted-foreground); }
.header-stat-value {
  font-family: var(--font-mono); font-size: var(--text-xs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.header-spacer { flex: 1; }
.header-actions { display: flex; align-items: center; gap: 0.5rem; flex: none; }

/* --- view -------------------------------------------------------------- */

.view { padding: 1.75rem 1.5rem 4rem; max-width: 72rem; width: 100%; }

.page-header { margin-bottom: 1.5rem; }
.page-title {
  font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.02em;
}
.page-description {
  margin-top: 0.375rem; font-size: var(--text-sm);
  color: var(--muted-foreground); max-width: 68ch; line-height: 1.6;
}

.section-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

/* --- forms inside cards ------------------------------------------------ */

.form-grid {
  display: grid; grid-template-columns: 9.5rem 1fr;
  gap: 0.875rem 1rem; align-items: center;
}
.form-grid .form-span { grid-column: 1 / -1; }
.form-hint { font-size: var(--text-xs); color: var(--muted-foreground); }

/* --- settings save bar -------------------------------------------------- */

.save-bar {
  position: sticky; bottom: 1rem; z-index: 15;
  display: flex; align-items: center; gap: 1rem;
  padding: 0.75rem 1rem; margin-top: 1rem;
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--popover); box-shadow: var(--shadow-lg);
}
.save-bar-count { flex: 1; font-size: var(--text-sm); font-weight: 500; }

/* --- content editor ----------------------------------------------------- */

.editor-grid {
  display: grid; grid-template-columns: 17rem 1fr;
  gap: 1rem; align-items: start;
}
.file-list { max-height: 60vh; overflow-y: auto; padding: 0.375rem; }
.file-item {
  display: block; width: 100%; padding: 0.4rem 0.625rem;
  border: 0; border-radius: var(--radius-sm); background: transparent;
  font-family: var(--font-mono); font-size: var(--text-xs);
  color: var(--muted-foreground); text-align: left; cursor: pointer;
  word-break: break-all;
  transition: background-color var(--duration) var(--ease), color var(--duration) var(--ease);
}
.file-item:hover { background: var(--accent); color: var(--accent-foreground); }
.file-item[aria-current="true"] {
  background: color-mix(in oklch, var(--primary) 14%, transparent);
  color: var(--foreground); font-weight: 500;
}

/* --- gate (unauthenticated) --------------------------------------------- */

.gate { display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
.gate-card {
  width: 100%; max-width: 30rem; padding: 2rem;
  border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: var(--card); box-shadow: var(--shadow-md);
}
.gate-title {
  font-size: var(--text-lg); font-weight: 600; letter-spacing: -0.01em;
  display: flex; align-items: center; gap: 0.125rem;
}
.gate-text {
  margin-top: 0.75rem; font-size: var(--text-sm);
  color: var(--muted-foreground); line-height: 1.6;
}
.gate-code {
  display: block; margin-top: 0.75rem; padding: 0.625rem 0.75rem;
  font-family: var(--font-mono); font-size: var(--text-xs);
  background: var(--muted); border-radius: var(--radius-md);
  word-break: break-all;
}

/* --- responsive --------------------------------------------------------- */

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar {
    position: static; height: auto;
    border-right: 0; border-bottom: 1px solid var(--border);
  }
  .nav { flex-direction: row; flex-wrap: wrap; }
  .nav-group { width: 100%; }
  .nav-item { width: auto; }
  .field { grid-template-columns: 1fr; gap: 0.625rem; }
  .editor-grid { grid-template-columns: 1fr; }
  .header { gap: 1rem; overflow-x: auto; }
  .view { padding: 1.25rem 1rem 3rem; }
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; gap: 0.5rem; }
  .stat-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* --- spacing helpers ---------------------------------------------------- */

.mt { margin-top: 1rem; }
.mb { margin-bottom: 1rem; }
`;

export const STYLES = `${THEME}\n${COMPONENTS}\n${LAYOUT}\n${WIDTH_UTILITIES}\n`;
