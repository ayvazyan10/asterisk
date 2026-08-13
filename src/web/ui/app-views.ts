// Control-panel client, second half: the remaining views, data loading and
// the delegated event wiring. Shares scope with APP_CORE, including its `ui.*`
// component builders.

export const APP_VIEWS = String.raw`
/**
 * An add-form kept behind a button. These pages are read far more often than
 * they are written to, and a permanently open five-field form pushed the list
 * it belongs to off the first screen.
 */
function addPanel(id, label, form) {
  const open = state.expanded === id;
  return '<div class="section-actions mb">' +
    ui.btn(open ? 'Cancel' : label,
      { variant: open ? 'ghost' : 'default', attrs: ' data-expand="' + id + '"' }) +
  '</div>' + (open ? ui.card(label, '<div class="card-content">' + form + '</div>') : '');
}

// --- mcp servers ---------------------------------------------------------

function viewMcp() {
  const rows = state.mcp.length === 0
    ? ui.empty('No MCP servers configured.')
    : state.mcp.map((s) => ui.listRow(
        esc(s.name),
        s.transport === 'stdio' ? s.command + ' ' + (s.args || []).join(' ') : s.url,
        ui.btn(s.enabled ? 'Disable' : 'Enable', { size: 'sm', attrs: ' data-mcp-toggle="' + esc(s.name) + '"' }) +
        ui.btn('Delete', { size: 'sm', variant: 'destructive-ghost', attrs: ' data-mcp-delete="' + esc(s.name) + '"' }),
        ui.stateBadge(s.enabled)
      )).join('');

  const form = '<div class="form-grid">' +
    '<label class="label" for="mcp-name">Name</label>' +
    '<input class="input" type="text" id="mcp-name" placeholder="filesystem">' +
    '<label class="label" for="mcp-transport">Transport</label>' +
    '<select class="select" id="mcp-transport"><option value="stdio">stdio</option>' +
      '<option value="http">http</option></select>' +
    '<label class="label" for="mcp-command">Command / URL</label>' +
    '<input class="input" type="text" id="mcp-command" ' +
      'placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp">' +
    '<label class="label" for="mcp-env">Env / headers</label>' +
    '<input class="input" type="text" id="mcp-env" placeholder="KEY=value, OTHER=value">' +
    '<div class="form-span section-actions">' +
      ui.btn('Save server', { variant: 'default', attrs: ' data-action="mcp-save"' }) +
      '<span class="form-hint">A matching name replaces the existing entry.</span>' +
    '</div></div>';

  return ui.pageHeader('MCP servers',
      'Model Context Protocol servers loaded at startup. stdio servers run as subprocesses; ' +
      'http servers are reached over Streamable HTTP.') +
    addPanel('mcp-add', 'Add a server', form) +
    ui.card('Configured', rows, { aside: ui.badge(state.mcp.length, 'secondary') });
}

function parsePairs(raw) {
  const out = {};
  for (const pair of String(raw || '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

async function saveMcp() {
  const name = $('#mcp-name').value.trim();
  const transport = $('#mcp-transport').value;
  const target = $('#mcp-command').value.trim();
  const pairs = parsePairs($('#mcp-env').value);

  if (!name || !target) { toast('Name and command/URL are required', 'bad'); return; }

  const server = transport === 'stdio'
    ? (() => {
        const parts = target.split(/\s+/);
        return { name, transport, command: parts[0], args: parts.slice(1), env: pairs, enabled: true };
      })()
    : { name, transport, url: target, headers: pairs, enabled: true };

  const ok = await guard(() => api('/mcp', { method: 'PUT', body: JSON.stringify({ server }) }), 'Server saved');
  if (ok) { await loadMcp(); await loadStatus(); render(); }
}

// --- hooks ---------------------------------------------------------------

const HOOK_EVENTS = ['before_turn', 'after_turn', 'before_tool', 'after_tool', 'on_error'];

function viewHooks() {
  const rows = state.hooks.length === 0
    ? ui.empty('No hooks configured.')
    : state.hooks.map((h) => ui.listRow(
        esc(h.name) + ' ' + ui.badge(h.event + (h.matcher ? ' · ' + h.matcher : ''), 'outline'),
        h.command,
        ui.btn(h.enabled ? 'Disable' : 'Enable', { size: 'sm', attrs: ' data-hook-toggle="' + esc(h.name) + '"' }) +
        ui.btn('Delete', { size: 'sm', variant: 'destructive-ghost', attrs: ' data-hook-delete="' + esc(h.name) + '"' }),
        ui.stateBadge(h.enabled)
      )).join('');

  const form = '<div class="form-grid">' +
    '<label class="label" for="hook-name">Name</label>' +
    '<input class="input" type="text" id="hook-name" placeholder="format-on-edit">' +
    '<label class="label" for="hook-event">Event</label>' +
    '<select class="select" id="hook-event">' +
      HOOK_EVENTS.map((e) => '<option value="' + e + '">' + e + '</option>').join('') + '</select>' +
    '<label class="label" for="hook-matcher">Matcher</label>' +
    '<input class="input" type="text" id="hook-matcher" placeholder="Edit (optional)">' +
    '<label class="label" for="hook-command">Command</label>' +
    '<input class="input" type="text" id="hook-command" placeholder="biome check --write">' +
    '<label class="label" for="hook-timeout">Timeout (s)</label>' +
    '<input class="input" type="number" id="hook-timeout" value="30" min="1" max="300">' +
    '<div class="form-span section-actions">' +
      ui.btn('Save hook', { variant: 'default', attrs: ' data-action="hook-save"' }) +
    '</div></div>';

  return ui.pageHeader('Hooks',
      'Shell commands fired at agent-loop lifecycle events, with the event payload on stdin as JSON. ' +
      'They run with your full user privileges — treat them like any other shell script.') +
    addPanel('hook-add', 'Add a hook', form) +
    ui.card('Configured', rows, { aside: ui.badge(state.hooks.length, 'secondary') });
}

async function saveHook() {
  const hook = {
    name: $('#hook-name').value.trim(),
    event: $('#hook-event').value,
    command: $('#hook-command').value.trim(),
    timeoutSeconds: Number($('#hook-timeout').value) || 30,
    enabled: true,
  };
  const matcher = $('#hook-matcher').value.trim();
  if (matcher) hook.matcher = matcher;
  if (!hook.name || !hook.command) { toast('Name and command are required', 'bad'); return; }

  const ok = await guard(() => api('/hooks', { method: 'PUT', body: JSON.stringify({ hook }) }), 'Hook saved');
  if (ok) { await loadHooks(); await loadStatus(); render(); }
}

// --- secrets -------------------------------------------------------------

function viewSecrets() {
  // An env var of the same name wins over anything stored here, so a key that
  // is overridden needs to say so where you would otherwise edit it and
  // wonder why nothing changed — not in small print underneath.
  const rows = state.secrets.map((s) =>
    '<div class="field' + (s.overriddenByEnv ? ' field-shadowed' : '') + '">' +
      '<div><span class="label">' + esc(s.key) + '</span> ' +
        (s.overriddenByEnv
          ? ui.badge('overridden by env', 'destructive', true)
          : ui.stateBadge(s.set, 'set', 'not set')) +
        '<code class="field-path">' + (s.set ? esc(s.masked) : 'nothing stored') + '</code>' +
        (s.overriddenByEnv
          ? '<div class="field-help">The environment variable of the same name is what Asterisk ' +
            'actually uses. Editing this will not take effect until it is unset.</div>'
          : '') +
      '</div>' +
      '<div class="field-control">' +
        '<input class="input" type="password" data-secret="' + esc(s.key) +
          '" placeholder="paste to replace" autocomplete="off">' +
        ui.btn('Save', { size: 'sm', attrs: ' data-secret-save="' + esc(s.key) + '"' }) +
        (s.set ? ui.btn('Clear', { size: 'sm', variant: 'destructive-ghost',
          attrs: ' data-secret-clear="' + esc(s.key) + '"' }) : '') +
      '</div>' +
    '</div>'
  ).join('');

  const shadowed = state.secrets.filter((s) => s.overriddenByEnv).length;

  return ui.pageHeader('Secrets',
      'Kept in the database, which is <code class="code-inline">chmod 600</code>. Values never come ' +
      'back to the browser — only a masked fingerprint.') +
    ui.card('API keys and tokens', rows || ui.empty('No secrets defined.'), {
      aside: shadowed > 0
        ? ui.badge(shadowed + ' overridden by env', 'destructive', true)
        : ui.badge(state.secrets.filter((s) => s.set).length + ' set', 'secondary'),
    });
}

// --- content editor ------------------------------------------------------

// One kind per call — the sidebar now has a destination for each, so this
// renders exactly the files belonging to the kind it is given and nothing else.
function viewContent(kind) {
  const label = (CONTENT_KINDS.find((k) => k.id === kind) || {}).label || kind;
  const entry = contentEntry(kind);

  if (!entry) {
    return ui.pageHeader(label, 'Loading…') + ui.card('Files', ui.skeletonRows(3));
  }

  // The description is the API's own words for the kind; the root is where
  // the files live, which is the machine's half of the title.
  return ui.pageHeader(label, esc(entry.description), entry.root) + viewContentBody(kind);
}

/**
 * The file list and editor, without a page header. Rules and Souls put their
 * resolution report above this rather than replacing it — knowing what is in
 * effect and being able to edit it are both wanted, in that order.
 */
function viewContentBody(kind) {
  const entry = contentEntry(kind);
  if (!entry) return '<section class="card">' + ui.skeletonRows(3) + '</section>';

  const list = ui.card('Files',
    '<div class="file-list">' +
      (entry.files.length === 0
        ? ui.empty('No files yet.')
        : entry.files.map((f) =>
            '<button class="file-item" data-open="' + esc(kind) + '|' + esc(f.path) + '" aria-current="' +
            (state.editor.kind === kind && state.editor.path === f.path) + '">' +
            esc(f.path) + '</button>').join('')) +
    '</div>',
    { aside: ui.badge(entry.files.length, 'secondary') });

  // No kind picker any more: the tab you are on is the kind.
  const newFile = ui.card('New file',
    '<div class="card-content"><div class="form-grid">' +
      '<label class="label" for="new-path">Path</label>' +
      '<input class="input input-mono" type="text" id="new-path" placeholder="common/style.md">' +
      '<div class="form-span section-actions">' +
        ui.btn('Create', { variant: 'default', attrs: ' data-action="content-create"' }) +
      '</div>' +
    '</div></div>');

  const e = state.editor;
  const changed = e.content !== e.original;
  // An open file from another kind belongs to that kind's tab, not this one.
  const pane = e.path && e.kind === kind
    ? ui.card(e.path,
        '<div class="card-content mt"><textarea class="textarea" id="editor-body" spellcheck="false">' +
        esc(e.content) + '</textarea>' +
        '<div class="section-actions mt">' +
          ui.btn('Save', { variant: 'default', attrs: ' data-action="content-save"', disabled: !changed }) +
          ui.btn('Revert', { attrs: ' data-action="content-revert"', disabled: !changed }) +
          ui.btn('Delete file', { variant: 'destructive-ghost', attrs: ' data-action="content-delete"' }) +
        '</div></div>',
        { aside: ui.badge(changed ? 'unsaved' : 'saved', changed ? 'destructive' : 'muted', true) })
    : ui.card('Editor', ui.empty('Select a file, or create a new one below.'));

  return '<div class="editor-grid mt"><div>' + list + newFile + '</div><div>' + pane + '</div></div>';
}

async function openFile(kind, path) {
  const body = await guard(() => api('/content/' + encodeURIComponent(kind) + '/' +
    path.split('/').map(encodeURIComponent).join('/')));
  if (!body) return;
  state.editor = { kind, path, content: body.content, original: body.content };
  render();
}

async function saveFile() {
  const e = state.editor;
  if (!e.path) return;
  const ok = await guard(() => api('/content/' + encodeURIComponent(e.kind) + '/' +
    e.path.split('/').map(encodeURIComponent).join('/'), {
      method: 'PUT', body: JSON.stringify({ content: e.content }),
    }), 'Saved ' + e.path);
  if (!ok) return;
  state.editor.original = e.content;
  await loadContent();
  render();
}

// --- tokens --------------------------------------------------------------

function viewTokens() {
  const rows = state.tokens.length === 0
    ? ui.empty('No tokens issued.')
    : state.tokens.map((t) => ui.listRow(
        esc(t.label),
        'created ' + when(t.created_at) + ' · last used ' + when(t.last_used_at),
        ui.btn('Revoke', { size: 'sm', variant: 'destructive-ghost',
          attrs: ' data-token-revoke="' + t.id + '"' })
      )).join('');

  const form = '<div class="form-grid">' +
    '<label class="label" for="token-label">Label</label>' +
    '<input class="input" type="text" id="token-label" placeholder="laptop">' +
    '<div class="form-span section-actions">' +
      ui.btn('Issue token', { variant: 'default', attrs: ' data-action="token-new"' }) +
      '<span class="form-hint">Shown once, at creation — copy it then.</span>' +
    '</div></div>';

  return ui.pageHeader('Access tokens',
      'Tokens authenticate browser sessions for this panel. Only hashes are stored, so a token is ' +
      'shown exactly once — at creation. Revoking one ends its sessions.') +
    addPanel('token-add', 'Issue a token', form) +
    ui.card('Issued', rows, { aside: ui.badge(state.tokens.length, 'secondary') });
}

// --- diagnostics, logs, audit --------------------------------------------

function viewDoctor() {
  const d = state.doctor;
  const header = ui.pageHeader('Diagnostics',
    'Connectivity and environment checks — the same ground <code class="code-inline">/doctor</code> ' +
    'covers in the REPL.');

  if (!d) return header + '<section class="card">' + ui.skeletonRows(4) + '</section>';

  const failing = d.checks.filter((c) => !c.ok);
  const passing = d.checks.filter((c) => c.ok);

  const row = (c) => '<div class="check' + (c.ok ? '' : ' check-bad') + '">' +
    '<span class="check-mark">' + (c.ok ? '✓' : '✗') + '</span>' +
    '<div class="list-row-grow"><div class="check-name">' + esc(c.name) + '</div>' +
    '<div class="check-detail">' + esc(c.detail) + '</div></div></div>';

  // What is broken comes first and takes the whole width; what works is a
  // quiet confirmation underneath. A flat list gave both the same weight,
  // which is the wrong shape for a page you only open when something is off.
  const problems = failing.length > 0
    ? ui.card('Needs attention', failing.map(row).join(''),
        { aside: ui.badge(failing.length, 'destructive', true) })
    : ui.card('All clear', ui.empty('Every check passed.'),
        { aside: ui.badge('healthy', 'success', true) });

  const fine = passing.length > 0
    ? ui.card('Passing', passing.map(row).join(''), { aside: ui.badge(passing.length, 'secondary') })
    : '';

  return header +
    '<div class="section-actions mb">' +
      ui.btn('Run again', { attrs: ' data-action="doctor-rerun"' }) +
      '<span class="form-hint">' + passing.length + ' of ' + d.checks.length + ' passing</span>' +
    '</div>' +
    problems + fine;
}

// Everything append-only lives here, behind one segmented control: the daemon's
// own output, and the panel's record of what was changed through it.
const LOG_TABS = [
  { id: 'daemon', label: 'Daemon log' },
  { id: 'audit', label: 'Audit trail' },
];

const LOG_DESCRIPTIONS = {
  daemon: 'What the background process has been doing.',
  audit: 'Every change made through this panel.',
};

const LOG_SUBJECTS = {
  daemon: '~/.asterisk/logs/daemon.log',
  audit: '',
};

function viewLogs() {
  const active = state.logsTab;
  return ui.pageHeader('Logs', LOG_DESCRIPTIONS[active] || '', LOG_SUBJECTS[active]) +
    '<div class="section-actions mb">' +
      ui.tabs(LOG_TABS, active, 'logs-tab') +
      ui.btn('Reload', { attrs: ' data-action="logs-refresh"' }) +
    '</div>' +
    (active === 'audit' ? auditPanel() : daemonLogPanel());
}

function auditPanel() {
  const rows = state.audit.length === 0
    ? ui.empty('Nothing recorded yet. Changes you make here will show up.')
    : state.audit.map((a) => ui.listRow(
        esc(a.action) + ' ' + ui.badge(a.target, 'outline'),
        when(a.at) + ' · ' + a.actor
      )).join('');

  return ui.card('Recent', rows, { aside: ui.badge(state.audit.length, 'secondary') });
}

// --- data loading --------------------------------------------------------

async function loadStatus()   { state.status   = await guard(() => api('/status')); }
async function loadSettings() { state.settings = await guard(() => api('/settings')); }
async function loadMcp()      { const r = await guard(() => api('/mcp'));      state.mcp = r ? r.servers : []; }
async function loadHooks()    { const r = await guard(() => api('/hooks'));    state.hooks = r ? r.hooks : []; }
async function loadSecrets()  { const r = await guard(() => api('/secrets'));  state.secrets = r ? r.secrets : []; }
async function loadContent()  { const r = await guard(() => api('/content'));  state.content = r ? r.kinds : []; }
async function loadTokens()   { const r = await guard(() => api('/tokens'));   state.tokens = r ? r.tokens : []; }
async function loadAudit()    { const r = await guard(() => api('/audit'));    state.audit = r ? r.entries : []; }
async function loadLogs()     { const r = await guard(() => api('/logs'));     state.logText = r ? r.text : ''; }
async function loadDoctor()   { state.doctor = await guard(() => api('/doctor')); }

// The Logs tab shows one record at a time but fetches both, so switching the
// segmented control is instant. Two small requests on a monitoring page is the
// right trade against a spinner every time you toggle.
async function loadLogRecords() { await Promise.all([loadLogs(), loadAudit()]); }

// The system figure reads rule and skill counts alongside everything /status
// returns, so the landing page fetches both and the figure is complete on
// first paint rather than filling in a beat later.
// The rail's counts and the system figure both read resolved sets, so the
// landing page fetches them alongside /status rather than leaving the numbers
// blank until you happen to open the section they came from.
async function loadOverview() {
  await Promise.all([loadStatus(), loadContent(), loadSkills(), loadRulesReport(), loadAgentsReport()]);
}

const LOADERS = {
  overview: loadOverview, settings: loadSettings, mcp: loadMcp, hooks: loadHooks,
  secrets: loadSecrets, tokens: loadTokens,
  logs: loadLogRecords, doctor: loadDoctor,
};

const VIEWS = {
  overview: viewOverview, settings: viewSettings, mcp: viewMcp, hooks: viewHooks,
  secrets: viewSecrets, tokens: viewTokens,
  logs: viewLogs, doctor: viewDoctor,
};

// Every content kind routes to the same pair, parameterised by kind. Derived
// from CONTENT_KINDS rather than written out four times, so adding a kind to
// the API means adding one entry there and nothing here.
for (const k of CONTENT_KINDS) {
  LOADERS[k.id] = loadContent;
  VIEWS[k.id] = () => viewContent(k.id);
}

// Every Author kind keeps the sidebar entry the loop gave it and replaces the
// view. What the loader resolved and what is in the directory are different
// sets for all four, and the page's job is to say so — see ./app-skills.ts
// and ./app-authored.ts.
LOADERS.skills = loadSkills;
VIEWS.skills = viewSkills;

LOADERS.rules = async () => { await Promise.all([loadContent(), loadRulesReport()]); };
VIEWS.rules = viewRules;

LOADERS.agents = loadAgentsReport;
VIEWS.agents = viewAgents;

LOADERS.souls = async () => { await Promise.all([loadContent(), loadSoulsReport()]); };
VIEWS.souls = viewSouls;

function render() {
  renderSidebar();
  renderHeader();
  const view = VIEWS[state.tab] || viewOverview;
  $('.view').innerHTML = view();
  renderSaveBar();
}

async function goto(tab) {
  state.tab = tab;
  location.hash = tab;
  const load = LOADERS[tab];
  render();
  if (load) { await load(); state.loaded.add(tab); render(); }
}

// --- events --------------------------------------------------------------

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-tab],[data-action],[data-daemon],[data-toggle],[data-reset],' +
    '[data-revert],[data-mcp-toggle],[data-mcp-delete],[data-hook-toggle],[data-hook-delete],' +
    '[data-secret-save],[data-secret-clear],[data-token-revoke],[data-open],[data-logs-tab],' +
    '[data-skill-open],[data-agent-open],[data-group],[data-settings-filter],[data-log-level],' +
    '[data-expand]');
  if (!t) return;
  const d = t.dataset;

  if (d.tab) return goto(d.tab);
  if (d.skillOpen) return openSkill(d.skillOpen);
  if (d.agentOpen) return openAgent(d.agentOpen);
  if (d.expand) {
    state.expanded = state.expanded === d.expand ? '' : d.expand;
    return render();
  }
  if (d.group) {
    if (state.openGroups.has(d.group)) state.openGroups.delete(d.group);
    else state.openGroups.add(d.group);
    return refreshSettingsGroups();
  }
  if (d.settingsFilter) {
    state.settingsFilter = d.settingsFilter;
    return render();
  }
  if (d.logLevel) {
    state.logLevel = d.logLevel;
    return render();
  }
  // Both records are already loaded; switching is a re-render, not a fetch.
  if (d.logsTab) { state.logsTab = d.logsTab; return render(); }
  if (d.open) { const [kind, ...rest] = d.open.split('|'); return openFile(kind, rest.join('|')); }

  if (d.toggle) {
    const field = findField(d.toggle);
    const current = state.dirty.has(d.toggle) ? state.dirty.get(d.toggle) : field.value;
    stageEdit(d.toggle, !current);
    return render();
  }
  if (d.revert) { state.dirty.delete(d.revert); return render(); }
  if (d.reset) {
    const ok = await guard(() => api('/settings/reset', {
      method: 'POST', body: JSON.stringify({ path: d.reset }),
    }), 'Reset to default');
    if (ok) { state.dirty.delete(d.reset); await loadSettings(); render(); }
    return;
  }

  if (d.daemon) {
    const ok = await guard(() => api('/daemon/' + d.daemon, { method: 'POST' }));
    if (ok) toast(ok.message, ok.ok ? 'good' : 'bad');
    await loadStatus(); return render();
  }

  if (d.mcpToggle) {
    const server = state.mcp.find((s) => s.name === d.mcpToggle);
    const { id, ...rest } = server;
    const ok = await guard(() => api('/mcp', {
      method: 'PUT', body: JSON.stringify({ server: { ...rest, enabled: !server.enabled } }),
    }), 'Updated ' + server.name);
    if (ok) { await loadMcp(); await loadStatus(); render(); }
    return;
  }
  if (d.mcpDelete) {
    if (!confirm('Delete MCP server "' + d.mcpDelete + '"?')) return;
    const ok = await guard(() => api('/mcp/' + encodeURIComponent(d.mcpDelete), { method: 'DELETE' }), 'Deleted');
    if (ok) { await loadMcp(); await loadStatus(); render(); }
    return;
  }
  if (d.hookToggle) {
    const hook = state.hooks.find((h) => h.name === d.hookToggle);
    const { id, ...rest } = hook;
    const ok = await guard(() => api('/hooks', {
      method: 'PUT', body: JSON.stringify({ hook: { ...rest, enabled: !hook.enabled } }),
    }), 'Updated ' + hook.name);
    if (ok) { await loadHooks(); await loadStatus(); render(); }
    return;
  }
  if (d.hookDelete) {
    if (!confirm('Delete hook "' + d.hookDelete + '"?')) return;
    const ok = await guard(() => api('/hooks/' + encodeURIComponent(d.hookDelete), { method: 'DELETE' }), 'Deleted');
    if (ok) { await loadHooks(); await loadStatus(); render(); }
    return;
  }

  if (d.secretSave || d.secretClear) {
    const key = d.secretSave || d.secretClear;
    const input = document.querySelector('[data-secret="' + CSS.escape(key) + '"]');
    const value = d.secretClear ? '' : (input ? input.value : '');
    if (d.secretSave && !value) { toast('Nothing to save', 'bad'); return; }
    if (d.secretClear && !confirm('Clear ' + key + '?')) return;
    const ok = await guard(() => api('/secrets', {
      method: 'PUT', body: JSON.stringify({ key, value }),
    }), d.secretClear ? 'Cleared' : 'Saved');
    if (ok) { await loadSecrets(); render(); }
    return;
  }

  if (d.tokenRevoke) {
    if (!confirm('Revoke this token? Sessions using it will be signed out.')) return;
    const ok = await guard(() => api('/tokens/' + d.tokenRevoke, { method: 'DELETE' }), 'Revoked');
    if (ok) { await loadTokens(); render(); }
    return;
  }

  switch (d.action) {
    case 'refresh': return goto(state.tab);
    case 'theme': {
      const root = document.documentElement;
      const now = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = now;
      try { localStorage.setItem('asterisk-theme', now); } catch {}
      return;
    }
    case 'apply': return applySettings();
    case 'discard': state.dirty.clear(); return render();
    case 'mcp-save': return saveMcp();
    case 'hook-save': return saveHook();
    case 'token-new': {
      const label = $('#token-label').value.trim() || 'panel';
      const out = await guard(() => api('/tokens', { method: 'POST', body: JSON.stringify({ label }) }));
      if (out) {
        toast('Token issued — copy it now, it will not be shown again', 'good', out.token);
        await loadTokens(); render();
      }
      return;
    }
    case 'content-save': return saveFile();
    case 'content-revert': state.editor.content = state.editor.original; return render();
    case 'content-delete': {
      const e = state.editor;
      if (!e.path || !confirm('Delete ' + e.path + '?')) return;
      const ok = await guard(() => api('/content/' + encodeURIComponent(e.kind) + '/' +
        e.path.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' }), 'Deleted');
      if (ok) { state.editor = { kind: null, path: null, content: '', original: '' }; await loadContent(); render(); }
      return;
    }
    case 'content-create': {
      // The tab you are on is the kind — there is no picker to read any more.
      const kind = state.tab;
      const path = $('#new-path').value.trim();
      if (!path) { toast('Path is required', 'bad'); return; }
      const ok = await guard(() => api('/content/' + encodeURIComponent(kind) + '/' +
        path.split('/').map(encodeURIComponent).join('/'), {
          method: 'PUT', body: JSON.stringify({ content: '# ' + path + '\n\n' }),
        }), 'Created ' + path);
      if (ok) { await loadContent(); await openFile(kind, path); }
      return;
    }
    case 'export': {
      const config = await guard(() => api('/config/export'));
      if (!config) return;
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'asterisk-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    case 'import': {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'application/json';
      picker.addEventListener('change', async () => {
        const file = picker.files && picker.files[0];
        if (!file) return;
        let parsed;
        try { parsed = JSON.parse(await file.text()); }
        catch { return toast('That file is not valid JSON', 'bad'); }
        const ok = await guard(() => api('/config/import', {
          method: 'POST', body: JSON.stringify({ config: parsed }),
        }), 'Configuration imported');
        if (ok) { await loadSettings(); await loadStatus(); render(); }
      });
      picker.click();
      return;
    }
    case 'skill-save': return saveSkill();
    case 'skill-delete': return deleteSkillEntry();
    case 'skill-create': return createSkill();
    case 'skill-revert':
      state.skillDraft = { description: state.skill.description, prompt: state.skill.prompt };
      return render();
    case 'settings-toggle-all': {
      if (state.openGroups.size > 0) state.openGroups.clear();
      else for (const g of state.settings.groups) state.openGroups.add(g.group);
      return render();
    }
    case 'log-follow': setLogFollow(!state.logFollow); return render();
    case 'doctor-rerun': state.doctor = null; render(); await loadDoctor(); return render();
    case 'logs-refresh': await loadLogRecords(); return render();
  }
});

document.addEventListener('change', (ev) => {
  const input = ev.target.closest('[data-input]');
  if (input) {
    const field = findField(input.dataset.input);
    if (!field) return;
    try {
      stageEdit(field.path, parseFieldValue(field, input.value));
      input.setAttribute('aria-invalid', 'false');
    } catch (e) {
      input.setAttribute('aria-invalid', 'true');
      toast(e.message, 'bad');
    }
  }
});

document.addEventListener('input', (ev) => {
  const id = ev.target.id;

  if (id === 'editor-body') {
    state.editor.content = ev.target.value;
    const save = document.querySelector('[data-action="content-save"]');
    const revert = document.querySelector('[data-action="content-revert"]');
    const changed = state.editor.content !== state.editor.original;
    if (save) save.disabled = !changed;
    if (revert) revert.disabled = !changed;
    return;
  }

  // The skill editor toggles its own buttons rather than re-rendering, or the
  // textarea would lose the caret on every keystroke.
  if (id === 'skill-desc' || id === 'skill-body') {
    state.skillDraft[id === 'skill-desc' ? 'description' : 'prompt'] = ev.target.value;
    const dirty = skillDirty();
    for (const action of ['skill-save', 'skill-revert']) {
      const btn = document.querySelector('[data-action="' + action + '"]');
      if (btn) btn.disabled = !dirty;
    }
    return;
  }

  // Every search box below redraws only what it narrows. Re-rendering the
  // view would take focus out of the box on the first keystroke.
  if (id === 'skill-filter') {
    state.skillFilter = ev.target.value;
    const card = document.querySelector('.skill-list-body');
    if (card) card.innerHTML = skillGroups(state.skills);
    return;
  }

  if (id === 'agent-filter') {
    state.agentFilter = ev.target.value;
    const host = document.querySelector('.agent-list-body');
    if (host) host.innerHTML = agentGroups(state.agents);
    return;
  }

  if (id === 'settings-search') {
    state.settingsQuery = ev.target.value;
    return refreshSettingsGroups();
  }

  if (id === 'log-search') {
    state.logQuery = ev.target.value;
    const body = document.querySelector('.log-body');
    if (body) body.innerHTML = renderLogBody();
  }
});

window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1) || 'overview';
  if (tab !== state.tab) goto(tab);
});

window.addEventListener('beforeunload', (ev) => {
  if (state.dirty.size > 0 || state.editor.content !== state.editor.original) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

// --- boot ----------------------------------------------------------------

(async () => {
  try {
    const saved = localStorage.getItem('asterisk-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {}

  await loadStatus();
  render();
  await goto(state.tab);
})();
`;
