// Renders the control-panel page.
//
// The whole app ships as one HTML document with the stylesheet and script
// inlined under a per-request CSP nonce — no second request, no bundler step,
// nothing loaded from a third-party origin.

import { APP_CORE } from './app-core.ts';
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
    '<rect width="32" height="32" rx="6" fill="#111418"/>' +
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

function gate(nonce: string): string {
  return `<!doctype html>
<html lang="en" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${FAVICON}">
<title>Asterisk — locked</title>
<style nonce="${attr(nonce)}">${STYLES}</style>
</head>
<body>
<main class="gate">
  <div class="card">
    <h1>Asterisk<span style="color:var(--signal)">*</span> control</h1>
    <p>This panel needs an access token. Start it from a terminal and follow the printed link, which
       carries the token as a query parameter and exchanges it for a session cookie.</p>
    <code>asterisk web</code>
    <p style="margin-top:1.25rem">Already have a token? Append it to the URL:</p>
    <code>http://127.0.0.1:4321/?token=YOUR_TOKEN</code>
  </div>
</main>
</body>
</html>`;
}

export function renderIndexHtml(opts: RenderOptions): string {
  if (!opts.authenticated) return gate(opts.nonce);
  const nonce = attr(opts.nonce);

  return `<!doctype html>
<html lang="en" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${FAVICON}">
<title>Asterisk control panel</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<div class="shell">
  <aside class="rail">
    <div class="brand">
      <h1>Asterisk<span>*</span></h1>
      <div class="meta">connecting…</div>
    </div>
    <nav class="nav" aria-label="Sections"></nav>
    <div class="rail-foot">
      <button class="btn sm" data-action="refresh">Reload data</button>
    </div>
  </aside>
  <div class="main">
    <header class="topbar"></header>
    <main class="view"></main>
  </div>
</div>
<div class="toasts" role="status" aria-live="polite"></div>
<script nonce="${nonce}">${APP_CORE}\n${APP_VIEWS}</script>
</body>
</html>`;
}
