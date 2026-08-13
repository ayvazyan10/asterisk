// Renders the control-panel page.
//
// The whole app ships as one HTML document with the stylesheet and script
// inlined under a per-request CSP nonce — no second request, no bundler step,
// nothing loaded from a third-party origin. That constraint is what keeps the
// UI vanilla: see ./theme.ts for how the shadcn design system is ported rather
// than installed.

import { APP_CORE } from './app-core.ts';
import { APP_LOGS } from './app-logs.ts';
import { APP_SETTINGS } from './app-settings.ts';
import { APP_SKILLS } from './app-skills.ts';
import { APP_STAR } from './app-star.ts';
import { APP_VIEWS } from './app-views.ts';
import { STYLES } from './styles.ts';

export interface RenderOptions {
  nonce: string;
  authenticated: boolean;
}

/**
 * Inline SVG favicon. Data URI rather than a served file so the page stays a
 * single request and the browser stops asking for /favicon.ico.
 */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="8" fill="#0a0a0a"/>' +
    '<text x="16" y="23" font-family="monospace" font-size="24" font-weight="700" ' +
    'text-anchor="middle" fill="#e8a33d">*</text>' +
    '</svg>',
)}`;

/** Escapes a value for interpolation into an HTML attribute. */
function attr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Shared <head>. `data-theme` is empty so the OS preference wins until the
 *  client script restores an explicit choice from localStorage. */
function head(nonce: string, title: string): string {
  return `<!doctype html>
<html lang="en" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${FAVICON}">
<title>${attr(title)}</title>
<style nonce="${attr(nonce)}">${STYLES}</style>
</head>`;
}

function gate(nonce: string): string {
  return `${head(nonce, 'Asterisk — locked')}
<body>
<main class="gate">
  <div class="gate-card">
    <h1 class="gate-title">Asterisk<span class="brand-mark">*</span></h1>
    <p class="gate-text">This panel needs an access token. Start it from a terminal and follow the
       printed link, which carries the token as a query parameter and exchanges it for a session
       cookie.</p>
    <code class="gate-code">asterisk web</code>
    <p class="gate-text">Already have a token? Append it to the URL:</p>
    <code class="gate-code">http://127.0.0.1:4321/?token=YOUR_TOKEN</code>
  </div>
</main>
</body>
</html>`;
}

export function renderIndexHtml(opts: RenderOptions): string {
  if (!opts.authenticated) return gate(opts.nonce);
  const nonce = attr(opts.nonce);

  return `${head(opts.nonce, 'Asterisk control panel')}
<body>
<div class="shell">
  <aside class="rail">
    <div class="brand">
      <div class="brand-name">Asterisk<span class="brand-mark">*</span></div>
      <div class="brand-meta"></div>
    </div>
    <nav class="nav" aria-label="Sections"></nav>
    <div class="rail-foot">
      <button class="btn btn-outline btn-sm" data-action="refresh">Reload data</button>
    </div>
  </aside>
  <div class="main">
    <header class="header"></header>
    <main class="view"></main>
  </div>
</div>
<div class="toasts" role="status" aria-live="polite"></div>
<script nonce="${nonce}">${APP_CORE}\n${APP_STAR}\n${APP_SETTINGS}\n${APP_LOGS}\n${APP_SKILLS}\n${APP_VIEWS}</script>
</body>
</html>`;
}
