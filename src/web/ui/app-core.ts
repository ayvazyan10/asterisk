// Control-panel client: shared helpers, component builders, shell chrome and
// the overview. Settings, the system figure, skills and the log reader each
// have their own module beside this one.
//
// Vanilla DOM on purpose — no build step, no framework, and the whole page
// stays inlineable under a CSP nonce. All the modules are concatenated at
// render time, so they share one scope.
//
// Every value that reaches innerHTML goes through esc(); listeners are
// attached via delegation because the CSP forbids inline handlers.

export const APP_CORE = String.raw`
const state = {
  tab: location.hash.slice(1) || 'overview',
  status: null,
  settings: null,
  dirty: new Map(),
  mcp: [],
  connectors: [],
  connectorFilter: 'all',
  connectorQuery: '',
  hooks: [],
  secrets: [],
  content: [],
  tokens: [],
  audit: [],
  logText: '',
  doctor: null,
  editor: { kind: null, path: null, content: '', original: '' },
  loaded: new Set(),

  // Settings is an index before it is a form — see ./app-settings.ts. Groups
  // start shut; searching opens whatever it matches.
  settingsQuery: '',
  settingsFilter: 'all',
  openGroups: new Set(),

  // The log reader parses pino's JSON lines rather than printing them.
  logsTab: 'daemon',
  logLevel: 'all',
  logQuery: '',
  logFollow: false,
  logLines: 200,
  // Handle of the polling interval while Follow is on, so a second Follow
  // cannot leave the first one running.
  logTimer: null,

  // The Author pages read what the loaders resolved, not the file tree —
  // see ./app-skills.ts and ./app-authored.ts.
  skills: null,
  skill: null,
  skillDraft: null,
  skillFilter: '',
  rules: null,
  agents: null,
  agent: null,
  agentFilter: '',
  souls: null,

  // Which list row is expanded, keyed by section.
  expanded: '',
};

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return (n / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function when(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ms).toLocaleDateString();
}

// --- component builders --------------------------------------------------

const ui = {
  badge(label, variant, dot) {
    return '<span class="badge badge-' + (variant || 'secondary') + (dot ? ' badge-dot' : '') + '">' +
      esc(label) + '</span>';
  },

  // on/off is the panel's most repeated state. Live things take the warm
  // accent, absent things go quiet — see the colour rule in ./components.ts.
  stateBadge(on, onLabel, offLabel) {
    return ui.badge(on ? (onLabel || 'on') : (offLabel || 'off'), on ? 'success' : 'muted', true);
  },

  btn(label, opts) {
    const o = opts || {};
    return '<button class="btn btn-' + (o.variant || 'outline') + (o.size ? ' btn-' + o.size : '') + '"' +
      (o.attrs || '') + (o.disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  },

  card(title, body, opts) {
    const o = opts || {};
    const aside = o.aside === undefined || o.aside === null ? '' : o.aside;
    return '<section class="card' + (o.divided === false ? '' : ' card-divided') + '">' +
      '<header class="card-header"><h3 class="card-title">' + esc(title) + '</h3>' + aside + '</header>' +
      body + '</section>';
  },

  // The title is markup — callers compose it from esc() and badges — while
  // the detail is text and is escaped here. The asymmetry is deliberate but
  // easy to get wrong: anything user-supplied in the title must be escaped by
  // the caller, and the detail must not be, or it double-escapes.
  listRow(title, detail, actions, leading) {
    return '<div class="list-row">' + (leading || '') +
      '<div class="list-row-grow"><div class="list-row-title">' + title + '</div>' +
      (detail ? '<div class="list-row-detail">' + esc(detail) + '</div>' : '') + '</div>' +
      (actions ? '<div class="section-actions">' + actions + '</div>' : '') +
    '</div>';
  },

  empty(message) {
    return '<div class="empty">' + esc(message) + '</div>';
  },

  // Segmented control for switching between sibling views inside one tab.
  // The attr argument is the dataset key the delegation reads: 'logs-tab'.
  tabs(items, active, attr) {
    return '<div class="tabs-list" role="tablist">' + items.map((i) =>
      '<button class="tabs-trigger" role="tab" aria-selected="' + (i.id === active) +
      '" data-' + attr + '="' + esc(i.id) + '">' + esc(i.label) + '</button>'
    ).join('') + '</div>';
  },

  // Skeletons rather than the word "Loading": the shape of what is coming is
  // already known, and showing it stops the page reflowing when data lands.
  skeletonRows(count) {
    let out = '';
    for (let i = 0; i < (count || 3); i++) {
      out += '<div class="skeleton-row"><div class="skeleton skeleton-line w40"></div>' +
        '<div class="skeleton skeleton-line w70"></div></div>';
    }
    return out;
  },

  // The human names the thing, the machine names where it lives. The title is
  // escaped; the description is not, because callers pass markup through it.
  pageHeader(title, description, subject) {
    return '<header class="page-header"><h2 class="page-title">' + esc(title) +
      (subject ? '<span class="page-subject">' + esc(subject) + '</span>' : '') + '</h2>' +
      '<p class="page-description">' + description + '</p></header>';
  },
};

function toast(message, kind, detail) {
  const host = $('.toasts');
  const node = document.createElement('div');
  node.className = 'toast ' + (kind === 'bad' ? 'toast-error' : kind === 'good' ? 'toast-success' : '');
  node.innerHTML = '<div class="toast-title">' + esc(message) + '</div>' +
    (detail ? '<div class="toast-detail">' + esc(detail) + '</div>' : '');
  host.appendChild(node);
  setTimeout(() => node.remove(), kind === 'bad' ? 8000 : 3500);
}

async function api(path, options) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options && options.headers) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) {
    const detail = body && body.detail
      ? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail))
      : '';
    const err = new Error((body && body.error) || ('HTTP ' + res.status));
    err.detail = detail;
    throw err;
  }
  return body;
}

async function guard(fn, successMessage) {
  try {
    const out = await fn();
    if (successMessage) toast(successMessage, 'good');
    return out;
  } catch (e) {
    toast(e.message, 'bad', e.detail);
    return null;
  }
}

// --- shell ---------------------------------------------------------------

// The four editable content kinds, each its own destination. One /content
// call backs all four, so opening any one fills in the others' counts.
const CONTENT_KINDS = [
  { id: 'rules', label: 'Rules' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'souls', label: 'Souls' },
];

function contentEntry(kind) {
  return state.content.find((k) => k.kind === kind) || null;
}

// Kinds with a resolution step count what the loader resolved, not what is on
// disk — a rule in the wrong language folder and a skill that fails to
// validate are both files that do nothing, and counting them here would repeat
// on the rail the same lie the pages were built to stop telling.
//
// Souls are the exception and count files: every soul file is usable by some
// session, so there is no inert set to exclude.
function kindCount(id) {
  if (id === 'skills') return state.skills ? state.skills.counts.loaded : null;
  if (id === 'agents') return state.agents ? state.agents.counts.loaded : null;
  if (id === 'rules') return state.rules ? state.rules.rules.length : null;
  const entry = contentEntry(id);
  return entry ? entry.files.length : null;
}

// Counts come from /status where possible so the rail is accurate on first
// paint. A count of null renders nothing, which is honest about "not loaded".
const TABS = [
  { group: 'Monitor', items: [
    { id: 'overview', label: 'Overview' },
    { id: 'doctor', label: 'Diagnostics' },
    { id: 'logs', label: 'Logs' },
  ]},
  { group: 'Configure', items: [
    { id: 'settings', label: 'Settings' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'connectors', label: 'Connectors',
      count: () => state.loaded.has('connectors') ? state.connectors.filter((c) => c.connected).length : null },
    { id: 'mcp', label: 'MCP servers', count: () => state.status && state.status.counts.mcpServers },
    { id: 'hooks', label: 'Hooks', count: () => state.status && state.status.counts.hooks },
  ]},
  { group: 'Author', items: CONTENT_KINDS.map((k) => ({
    id: k.id,
    label: k.label,
    count: () => kindCount(k.id),
  })) },
  { group: 'Access', items: [
    { id: 'tokens', label: 'Tokens', count: () => state.loaded.has('tokens') ? state.tokens.length : null },
  ]},
];

function renderSidebar() {
  $('.nav').innerHTML = TABS.map((section) => (
    '<div class="nav-group">' + esc(section.group) + '</div>' +
    section.items.map((tab) => {
      const count = tab.count ? tab.count() : null;
      return '<button class="nav-item" data-tab="' + esc(tab.id) + '" aria-current="' +
        (state.tab === tab.id) + '"><span class="nav-label">' + esc(tab.label) + '</span>' +
        (count === null || count === undefined ? '' : '<span class="nav-count">' + count + '</span>') +
        '</button>';
    }).join('')
  )).join('');

  const s = state.status;
  $('.brand-meta').textContent = s ? 'v' + s.version : '';
}

function renderHeader() {
  const s = state.status;
  if (!s) return;
  $('.header').innerHTML =
    '<div class="header-stat"><span class="header-stat-label">model</span>' +
      '<span class="header-stat-value">' + esc(s.model) + '</span></div>' +
    '<div class="header-stat"><span class="header-stat-label">via</span>' +
      '<span class="header-stat-value">' + esc(s.provider) + '</span></div>' +
    '<div class="header-spacer"></div>' +
    '<div class="header-actions">' +
      ui.btn('Theme', { variant: 'ghost', size: 'sm', attrs: ' data-action="theme"' }) +
      ui.btn('Refresh', { variant: 'outline', size: 'sm', attrs: ' data-action="refresh"' }) +
    '</div>';
}

// --- overview ------------------------------------------------------------

function viewOverview() {
  const s = state.status;
  if (!s) {
    return ui.pageHeader('Overview', 'Reading the state of this install.') +
      '<section class="card">' + ui.skeletonRows(3) + '</section>';
  }

  const daemon = ui.card('Daemon',
    ui.listRow('Background process', s.daemon.message,
      ui.btn('Start', { attrs: ' data-daemon="start"', disabled: s.daemon.running }) +
      ui.btn('Restart', { attrs: ' data-daemon="restart"', disabled: !s.daemon.running }) +
      ui.btn('Stop', { variant: 'outline-destructive', attrs: ' data-daemon="stop"', disabled: !s.daemon.running })
    ) +
    ui.listRow('Telegram bridge',
      s.bots.telegram ? 'Answers messages while the daemon runs.' : 'Turn it on in Settings.',
      ui.stateBadge(s.bots.telegram)),
    { aside: ui.stateBadge(s.daemon.running, 'running', 'stopped') });

  const store = ui.card('On disk',
    ui.listRow('Database', s.database.path, ui.badge(bytes(s.database.bytes), 'secondary')) +
    ui.listRow('Settings backup', 'A JSON copy of every setting. Secrets are never included.',
      ui.btn('Download', { attrs: ' data-action="export"' }) +
      ui.btn('Restore', { attrs: ' data-action="import"' })));

  return ui.pageHeader('Overview',
      'Everything Asterisk is wired to, running on this machine. Pick a spoke to go to it.') +
    '<div class="overview-grid">' + systemFigure() +
      '<div>' + daemon + store + '</div>' +
    '</div>';
}

`;
