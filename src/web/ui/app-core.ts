// Control-panel client: shared helpers, shell chrome, overview and settings.
//
// Vanilla DOM on purpose — no build step, no framework, and the whole page
// stays inlineable under a CSP nonce. Concatenated with APP_VIEWS at render
// time, so both halves share one scope.
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
  hooks: [],
  secrets: [],
  content: [],
  tokens: [],
  audit: [],
  logText: '',
  doctor: null,
  editor: { kind: null, path: null, content: '', original: '' },
  loaded: new Set(),
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

function toast(message, kind, detail) {
  const host = $('.toasts');
  const node = document.createElement('div');
  node.className = 'toast ' + (kind || '');
  node.innerHTML = '<div>' + esc(message) + '</div>' +
    (detail ? '<div class="detail">' + esc(detail) + '</div>' : '');
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

// --- shell --------------------------------------------------------------

// Counts come from /status where possible so the rail is accurate on first
// paint, before the corresponding tab has ever been opened. A count of null
// renders nothing, which is honest about "not loaded yet".
const TABS = [
  { group: 'Monitor', items: [
    { id: 'overview', label: 'Overview' },
    { id: 'doctor', label: 'Diagnostics' },
    { id: 'logs', label: 'Daemon log' },
    { id: 'audit', label: 'Audit trail' },
  ]},
  { group: 'Configure', items: [
    { id: 'settings', label: 'Settings' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'mcp', label: 'MCP servers', count: () => state.status && state.status.counts.mcpServers },
    { id: 'hooks', label: 'Hooks', count: () => state.status && state.status.counts.hooks },
  ]},
  { group: 'Author', items: [
    { id: 'content', label: 'Rules & skills' },
  ]},
  { group: 'Access', items: [
    { id: 'tokens', label: 'Tokens', count: () => state.loaded.has('tokens') ? state.tokens.length : null },
  ]},
];

function renderRail() {
  const nav = TABS.map((section) => (
    '<div class="nav-group">' + esc(section.group) + '</div>' +
    section.items.map((tab) => {
      const count = tab.count ? tab.count() : null;
      return '<button data-tab="' + esc(tab.id) + '" aria-current="' +
        (state.tab === tab.id) + '">' + esc(tab.label) +
        (count === null || count === undefined ? '' : '<span class="count">' + count + '</span>') +
        '</button>';
    }).join('')
  )).join('');

  $('.nav').innerHTML = nav;
  const s = state.status;
  $('.brand .meta').textContent = s ? 'v' + s.version + ' · ' + s.runtime : 'connecting…';
}

function renderTopbar() {
  const s = state.status;
  if (!s) return;
  $('.topbar').innerHTML =
    '<div class="stat"><b>Provider</b><code>' + esc(s.provider) + '</code></div>' +
    '<div class="stat"><b>Model</b><code>' + esc(s.model) + '</code></div>' +
    '<div class="stat"><b>Daemon</b><span class="chip ' + (s.daemon.running ? 'on' : 'off') + '">' +
      (s.daemon.running ? 'running' : 'stopped') + '</span></div>' +
    '<div class="spacer"></div>' +
    '<button class="btn sm" data-action="theme">Theme</button>' +
    '<button class="btn sm" data-action="refresh">Refresh</button>';
}

// --- overview -----------------------------------------------------------

function viewOverview() {
  const s = state.status;
  if (!s) return '<div class="empty">Loading…</div>';

  return '' +
    '<header><h2>Overview</h2><p>Live state of this Asterisk install. Everything below is stored in ' +
      '<code>' + esc(s.database.path) + '</code>.</p></header>' +
    '<div class="readouts">' +
      readout('Provider', s.provider, 'sm') +
      readout('MCP servers', s.counts.enabledMcpServers + '/' + s.counts.mcpServers) +
      readout('Hooks', s.counts.enabledHooks + '/' + s.counts.hooks) +
      readout('Database', bytes(s.database.bytes), 'sm') +
      readout('Daemon', s.daemon.running ? 'up' : 'down', 'sm ' + (s.daemon.running ? 'on' : 'off')) +
    '</div>' +
    '<div class="panel"><h3>Daemon</h3>' +
      '<div class="item"><div class="grow"><div class="name">Process</div>' +
        '<div class="detail">' + esc(s.daemon.message) + '</div></div>' +
        '<div class="actions">' +
          '<button class="btn" data-daemon="start"' + (s.daemon.running ? ' disabled' : '') + '>Start</button>' +
          '<button class="btn" data-daemon="restart"' + (s.daemon.running ? '' : ' disabled') + '>Restart</button>' +
          '<button class="btn danger" data-daemon="stop"' + (s.daemon.running ? '' : ' disabled') + '>Stop</button>' +
        '</div></div>' +
      '<div class="item"><div class="grow"><div class="name">Bot bridges</div>' +
        '<div class="detail">telegram ' + (s.bots.telegram ? 'enabled' : 'disabled') + '</div></div></div>' +
    '</div>' +
    '<div class="panel"><h3>Configuration file</h3>' +
      '<div class="item"><div class="grow"><div class="name">Export / import</div>' +
        '<div class="detail">JSON snapshot of every setting. Secrets are never included.</div></div>' +
        '<div class="actions">' +
          '<button class="btn" data-action="export">Download JSON</button>' +
          '<button class="btn" data-action="import">Upload JSON</button>' +
        '</div></div>' +
    '</div>';
}

function readout(label, value, cls) {
  return '<div class="readout"><b>' + esc(label) + '</b>' +
    '<div class="value ' + (cls || '') + '">' + esc(value) + '</div></div>';
}

// --- settings -----------------------------------------------------------

function viewSettings() {
  if (!state.settings) return '<div class="empty">Loading…</div>';

  const groups = state.settings.groups.map((group) =>
    '<div class="panel"><h3>' + esc(group.group) + '</h3>' +
      group.fields.map(fieldRow).join('') +
    '</div>'
  ).join('');

  return '' +
    '<header><h2>Settings</h2><p>Generated from the configuration schema — every field Asterisk ' +
      'understands appears here, with its own validation bounds. Edits are staged until you apply them.</p></header>' +
    groups + '<div id="save-bar"></div>';
}

function fieldRow(field) {
  const staged = state.dirty.has(field.path);
  const value = staged ? state.dirty.get(field.path) : field.value;
  const id = 'f_' + field.path.replace(/\./g, '_');

  return '<div class="row' + (staged ? ' dirty' : '') + '" data-field="' + esc(field.path) + '">' +
    '<div><label class="label" for="' + esc(id) + '">' + esc(field.label) + '</label>' +
      '<code class="path">' + esc(field.path) + '</code>' +
      (field.description ? '<div class="help">' + esc(field.description) + '</div>' : '') +
    '</div>' +
    '<div class="control">' + control(field, value, id) +
      (staged ? '<button class="btn sm" data-revert="' + esc(field.path) + '">Revert</button>' : '') +
      '<button class="btn sm" data-reset="' + esc(field.path) + '">Default</button>' +
    '</div></div>';
}

function control(field, value, id) {
  if (field.kind === 'boolean') {
    return '<button class="toggle" id="' + esc(id) + '" role="switch" data-toggle="' +
      esc(field.path) + '" aria-pressed="' + (value === true) + '" aria-label="' +
      esc(field.label) + '"></button>' +
      '<span class="chip ' + (value ? 'on' : 'off') + '">' + (value ? 'on' : 'off') + '</span>';
  }
  if (field.kind === 'enum') {
    return '<select id="' + esc(id) + '" data-input="' + esc(field.path) + '">' +
      field.options.map((opt) =>
        '<option value="' + esc(opt) + '"' + (opt === value ? ' selected' : '') + '>' + esc(opt) + '</option>'
      ).join('') + '</select>';
  }
  if (field.kind === 'number') {
    return '<input type="number" id="' + esc(id) + '" data-input="' + esc(field.path) + '"' +
      (field.min !== undefined ? ' min="' + field.min + '"' : '') +
      (field.max !== undefined ? ' max="' + field.max + '"' : '') +
      (field.integer ? ' step="1"' : '') +
      ' value="' + esc(value) + '">';
  }
  if (field.kind === 'number-array' || field.kind === 'string-array') {
    return '<input type="text" id="' + esc(id) + '" data-input="' + esc(field.path) + '"' +
      ' placeholder="comma separated" value="' + esc((value || []).join(', ')) + '">';
  }
  return '<input type="text" id="' + esc(id) + '" data-input="' + esc(field.path) + '" value="' + esc(value) + '">';
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
  if (row) row.classList.toggle('dirty', state.dirty.has(path));
}

function renderSaveBar() {
  const bar = $('#save-bar');
  if (!bar) return;
  if (state.dirty.size === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = '<div class="sticky-save">' +
    '<span class="count">' + state.dirty.size + ' pending change' + (state.dirty.size === 1 ? '' : 's') + '</span>' +
    '<button class="btn" data-action="discard">Discard</button>' +
    '<button class="btn primary" data-action="apply">Apply</button></div>';
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
