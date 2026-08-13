// Control-panel client: shared helpers, component builders, shell chrome,
// overview and settings.
//
// Vanilla DOM on purpose — no build step, no framework, and the whole page
// stays inlineable under a CSP nonce. Concatenated with APP_VIEWS at render
// time, so both halves share one scope.
//
// Every value that reaches innerHTML goes through esc(); listeners are
// attached via delegation because the CSP forbids inline handlers.
//
// The `ui.*` builders below are the markup counterpart to ./components.ts —
// one function per shadcn component, so a card or a badge is described in one
// place rather than re-spelled at each of its two dozen call sites.

export const APP_CORE = String.raw`
const state = {
  tab: location.hash.slice(1) || 'overview',
  status: null,
  settings: null,
  dirty: new Map(),
  mcp: [],
  hooks: [],
  secrets: [],
  content: [],
  tokens: [],
  audit: [],
  logText: '',
  doctor: null,
  editor: { kind: null, path: null, content: '', original: '' },
  loaded: new Set(),
  // Which record the Logs tab is showing: 'daemon' | 'audit'.
  logsTab: 'daemon',
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

  // on/off is the panel's most repeated state, and it always renders the same
  // way: a dotted badge, green when live and grey when not.
  stateBadge(on, onLabel, offLabel) {
    return ui.badge(on ? (onLabel || 'on') : (offLabel || 'off'), on ? 'success' : 'muted', true);
  },

  btn(label, opts) {
    const o = opts || {};
    return '<button class="btn btn-' + (o.variant || 'outline') + (o.size ? ' btn-' + o.size : '') + '"' +
      (o.attrs || '') + (o.disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  },

  // A card whose header carries a title and an optional right-aligned count or
  // status. \`divided\` draws the rule under the header that list cards want and
  // form cards do not.
  card(title, body, opts) {
    const o = opts || {};
    const aside = o.aside === undefined || o.aside === null ? '' : o.aside;
    return '<section class="card' + (o.divided === false ? '' : ' card-divided') + '">' +
      '<header class="card-header"><h3 class="card-title">' + esc(title) + '</h3>' + aside + '</header>' +
      body + '</section>';
  },

  statCard(label, value, opts) {
    const o = opts || {};
    return '<div class="stat-card">' +
      '<div class="stat-label">' + esc(label) + (o.badge || '') + '</div>' +
      '<div class="stat-value' + (o.small ? ' stat-value-sm' : '') +
        (o.tone ? ' stat-value-' + o.tone : '') + '">' + esc(value) + '</div>' +
      (o.hint ? '<div class="stat-hint">' + esc(o.hint) + '</div>' : '') +
    '</div>';
  },

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

  // Skeletons rather than the word "Loading…": the shape of what is coming is
  // already known, and showing it stops the page reflowing when data lands.
  skeletonRows(count) {
    let out = '';
    for (let i = 0; i < (count || 3); i++) {
      out += '<div class="skeleton-row"><div class="skeleton skeleton-line w40"></div>' +
        '<div class="skeleton skeleton-line w70"></div></div>';
    }
    return out;
  },

  // The title is escaped; the description is not, because every caller passes
  // markup through it (<code> spans naming a path or a command). Keep that
  // asymmetry in mind before routing anything user-supplied into either.
  pageHeader(title, description) {
    return '<header class="page-header"><h2 class="page-title">' + esc(title) + '</h2>' +
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

// The four editable content kinds, each its own destination. They used to
// share a single "Rules & skills" tab, which meant scrolling past three
// mostly-empty card stacks to reach the fourth. One /content call still backs
// all four, so opening any one fills in the others' counts.
const CONTENT_KINDS = [
  { id: 'rules', label: 'Rules' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'souls', label: 'Souls' },
];

function contentEntry(kind) {
  return state.content.find((k) => k.kind === kind) || null;
}

// Counts come from /status where possible so the sidebar is accurate on first
// paint, before the corresponding tab has ever been opened. A count of null
// renders nothing, which is honest about "not loaded yet".
const TABS = [
  { group: 'Monitor', items: [
    { id: 'overview', label: 'Overview' },
    { id: 'doctor', label: 'Diagnostics' },
    // One destination for everything that is a log. The daemon tail and the
    // audit trail are both append-only records of what happened; splitting
    // them across two sidebar entries made the section look twice as busy as
    // it is, and neither name told you the other existed.
    { id: 'logs', label: 'Logs' },
  ]},
  { group: 'Configure', items: [
    { id: 'settings', label: 'Settings' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'mcp', label: 'MCP servers', count: () => state.status && state.status.counts.mcpServers },
    { id: 'hooks', label: 'Hooks', count: () => state.status && state.status.counts.hooks },
  ]},
  { group: 'Author', items: CONTENT_KINDS.map((k) => ({
    id: k.id,
    label: k.label,
    count: () => { const e = contentEntry(k.id); return e ? e.files.length : null; },
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
        (state.tab === tab.id) + '"><span>' + esc(tab.label) + '</span>' +
        (count === null || count === undefined ? '' : '<span class="nav-count">' + count + '</span>') +
        '</button>';
    }).join('')
  )).join('');

  const s = state.status;
  $('.brand-meta').textContent = s ? 'v' + s.version + ' · ' + s.runtime : 'connecting…';
}

function renderHeader() {
  const s = state.status;
  if (!s) return;
  $('.header').innerHTML =
    '<div class="header-stat"><span class="header-stat-label">Provider</span>' +
      '<span class="header-stat-value">' + esc(s.provider) + '</span></div>' +
    '<div class="header-stat"><span class="header-stat-label">Model</span>' +
      '<span class="header-stat-value">' + esc(s.model) + '</span></div>' +
    '<div class="header-stat">' + ui.stateBadge(s.daemon.running, 'daemon up', 'daemon down') + '</div>' +
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
    return ui.pageHeader('Overview', 'Live state of this Asterisk install.') +
      '<div class="stat-grid">' +
        '<div class="stat-card"><div class="skeleton skeleton-line w60"></div>' +
        '<div class="skeleton skeleton-line w40"></div></div>' +
        '<div class="stat-card"><div class="skeleton skeleton-line w60"></div>' +
        '<div class="skeleton skeleton-line w40"></div></div>' +
        '<div class="stat-card"><div class="skeleton skeleton-line w60"></div>' +
        '<div class="skeleton skeleton-line w40"></div></div>' +
      '</div>';
  }

  const stats =
    ui.statCard('Provider', s.provider, { small: true }) +
    ui.statCard('MCP servers', s.counts.enabledMcpServers + '/' + s.counts.mcpServers,
      { hint: 'enabled / configured' }) +
    ui.statCard('Hooks', s.counts.enabledHooks + '/' + s.counts.hooks,
      { hint: 'enabled / configured' }) +
    ui.statCard('Database', bytes(s.database.bytes), { small: true, hint: 'on disk' }) +
    ui.statCard('Daemon', s.daemon.running ? 'up' : 'down',
      { small: true, tone: s.daemon.running ? 'success' : 'muted' });

  const daemon = ui.card('Daemon', ui.listRow(
      'Process', s.daemon.message,
      ui.btn('Start', { attrs: ' data-daemon="start"', disabled: s.daemon.running }) +
      ui.btn('Restart', { attrs: ' data-daemon="restart"', disabled: !s.daemon.running }) +
      ui.btn('Stop', { variant: 'outline-destructive', attrs: ' data-daemon="stop"', disabled: !s.daemon.running })
    ) + ui.listRow('Bot bridges', null,
      ui.stateBadge(s.bots.telegram, 'telegram on', 'telegram off')
    ),
    { aside: ui.stateBadge(s.daemon.running, 'running', 'stopped') });

  const config = ui.card('Configuration file', ui.listRow(
    'Export / import',
    'JSON snapshot of every setting. Secrets are never included.',
    ui.btn('Download JSON', { attrs: ' data-action="export"' }) +
    ui.btn('Upload JSON', { attrs: ' data-action="import"' })
  ));

  return ui.pageHeader('Overview',
      'Live state of this Asterisk install. Everything below is stored in <code class="code-inline">' +
      esc(s.database.path) + '</code>.') +
    '<div class="stat-grid">' + stats + '</div>' + daemon + config;
}

// --- settings ------------------------------------------------------------

function viewSettings() {
  const header = ui.pageHeader('Settings',
    'Generated from the configuration schema — every field Asterisk understands appears here, with ' +
    'its own validation bounds. Edits are staged until you apply them.');

  if (!state.settings) return header + ui.card('Loading', ui.skeletonRows(4));

  const groups = state.settings.groups
    .map((group) => ui.card(group.group, group.fields.map(fieldRow).join('')))
    .join('');

  return header + groups + '<div id="save-bar"></div>';
}

function fieldRow(field) {
  const staged = state.dirty.has(field.path);
  const value = staged ? state.dirty.get(field.path) : field.value;
  const id = 'f_' + field.path.replace(/\./g, '_');

  return '<div class="field' + (staged ? ' field-dirty' : '') + '" data-field="' + esc(field.path) + '">' +
    '<div><label class="label" for="' + esc(id) + '">' + esc(field.label) + '</label>' +
      '<code class="field-path">' + esc(field.path) + '</code>' +
      (field.description ? '<div class="field-help">' + esc(field.description) + '</div>' : '') +
    '</div>' +
    '<div class="field-control">' + control(field, value, id) +
      (staged ? ui.btn('Revert', { size: 'sm', variant: 'ghost', attrs: ' data-revert="' + esc(field.path) + '"' }) : '') +
      ui.btn('Default', { size: 'sm', variant: 'ghost', attrs: ' data-reset="' + esc(field.path) + '"' }) +
    '</div></div>';
}

function control(field, value, id) {
  if (field.kind === 'boolean') {
    // role="switch" pairs with aria-checked, not aria-pressed — the latter
    // belongs to toggle buttons and reads wrong to a screen reader here.
    return '<button class="switch" id="' + esc(id) + '" role="switch" data-toggle="' +
      esc(field.path) + '" aria-checked="' + (value === true) + '" aria-label="' +
      esc(field.label) + '"></button>' +
      ui.stateBadge(value === true);
  }
  if (field.kind === 'enum') {
    return '<select class="select" id="' + esc(id) + '" data-input="' + esc(field.path) + '">' +
      field.options.map((opt) =>
        '<option value="' + esc(opt) + '"' + (opt === value ? ' selected' : '') + '>' + esc(opt) + '</option>'
      ).join('') + '</select>';
  }
  if (field.kind === 'number') {
    return '<input class="input input-mono" type="number" id="' + esc(id) + '" data-input="' + esc(field.path) + '"' +
      (field.min !== undefined ? ' min="' + field.min + '"' : '') +
      (field.max !== undefined ? ' max="' + field.max + '"' : '') +
      (field.integer ? ' step="1"' : '') +
      ' value="' + esc(value) + '">';
  }
  if (field.kind === 'number-array' || field.kind === 'string-array') {
    return '<input class="input input-mono" type="text" id="' + esc(id) + '" data-input="' + esc(field.path) + '"' +
      ' placeholder="comma separated" value="' + esc((value || []).join(', ')) + '">';
  }
  return '<input class="input input-mono" type="text" id="' + esc(id) + '" data-input="' +
    esc(field.path) + '" value="' + esc(value) + '">';
}

function parseFieldValue(field, raw) {
  if (field.kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error('"' + field.label + '" must be a number');
    return n;
  }
  if (field.kind === 'number-array') {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error('"' + field.label + '" takes numbers only');
      return n;
    });
  }
  if (field.kind === 'string-array') {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

function findField(path) {
  for (const group of state.settings.groups) {
    const found = group.fields.find((f) => f.path === path);
    if (found) return found;
  }
  return null;
}

function stageEdit(path, value) {
  const field = findField(path);
  if (!field) return;
  // Staging back to the stored value clears the edit rather than leaving a
  // no-op pending change.
  if (JSON.stringify(value) === JSON.stringify(field.value)) state.dirty.delete(path);
  else state.dirty.set(path, value);
  renderSaveBar();
  const row = document.querySelector('[data-field="' + CSS.escape(path) + '"]');
  if (row) row.classList.toggle('field-dirty', state.dirty.has(path));
}

function renderSaveBar() {
  const bar = $('#save-bar');
  if (!bar) return;
  if (state.dirty.size === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = '<div class="save-bar">' +
    '<span class="save-bar-count">' + state.dirty.size + ' pending change' +
      (state.dirty.size === 1 ? '' : 's') + '</span>' +
    ui.btn('Discard', { variant: 'ghost', attrs: ' data-action="discard"' }) +
    ui.btn('Apply', { variant: 'default', attrs: ' data-action="apply"' }) +
  '</div>';
}

async function applySettings() {
  const updates = Object.fromEntries(state.dirty);
  const ok = await guard(() => api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ updates }),
  }), 'Settings applied');
  if (!ok) return;
  state.dirty.clear();
  await loadSettings();
  await loadStatus();
  render();
}
`;
