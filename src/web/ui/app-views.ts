// Control-panel client, second half: the remaining views, data loading and
// the delegated event wiring. Shares scope with APP_CORE.

export const APP_VIEWS = String.raw`
// --- mcp servers --------------------------------------------------------

function viewMcp() {
  const rows = state.mcp.length === 0
    ? '<div class="empty">No MCP servers configured.</div>'
    : state.mcp.map((s) =>
        '<div class="item">' +
          '<span class="chip ' + (s.enabled ? 'on' : 'off') + '">' + (s.enabled ? 'on' : 'off') + '</span>' +
          '<div class="grow"><div class="name">' + esc(s.name) + '</div>' +
            '<div class="detail">' + esc(s.transport === 'stdio'
              ? s.command + ' ' + (s.args || []).join(' ')
              : s.url) + '</div></div>' +
          '<div class="actions">' +
            '<button class="btn sm" data-mcp-toggle="' + esc(s.name) + '">' + (s.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="btn sm danger" data-mcp-delete="' + esc(s.name) + '">Delete</button>' +
          '</div></div>'
      ).join('');

  return '' +
    '<header><h2>MCP servers</h2><p>Model Context Protocol servers loaded at startup. ' +
      'stdio servers are spawned as subprocesses; http servers are reached over Streamable HTTP.</p></header>' +
    '<div class="panel"><h3>Configured<span>' + state.mcp.length + '</span></h3>' + rows + '</div>' +
    '<div class="panel"><h3>Add or replace</h3><div class="form-grid">' +
      '<label for="mcp-name">Name</label><input type="text" id="mcp-name" placeholder="filesystem">' +
      '<label for="mcp-transport">Transport</label>' +
      '<select id="mcp-transport"><option value="stdio">stdio</option><option value="http">http</option></select>' +
      '<label for="mcp-command">Command / URL</label>' +
      '<input type="text" id="mcp-command" placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp">' +
      '<label for="mcp-env">Env / headers</label>' +
      '<input type="text" id="mcp-env" placeholder="KEY=value, OTHER=value">' +
      '<div class="span actions"><button class="btn primary" data-action="mcp-save">Save server</button>' +
      '<span class="detail">A matching name replaces the existing entry.</span></div>' +
    '</div></div>';
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

// --- hooks --------------------------------------------------------------

const HOOK_EVENTS = ['before_turn', 'after_turn', 'before_tool', 'after_tool', 'on_error'];

function viewHooks() {
  const rows = state.hooks.length === 0
    ? '<div class="empty">No hooks configured.</div>'
    : state.hooks.map((h) =>
        '<div class="item">' +
          '<span class="chip ' + (h.enabled ? 'on' : 'off') + '">' + (h.enabled ? 'on' : 'off') + '</span>' +
          '<div class="grow"><div class="name">' + esc(h.name) +
            ' <span class="detail">' + esc(h.event) + (h.matcher ? ' · ' + esc(h.matcher) : '') + '</span></div>' +
            '<div class="detail">' + esc(h.command) + '</div></div>' +
          '<div class="actions">' +
            '<button class="btn sm" data-hook-toggle="' + esc(h.name) + '">' + (h.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="btn sm danger" data-hook-delete="' + esc(h.name) + '">Delete</button>' +
          '</div></div>'
      ).join('');

  return '' +
    '<header><h2>Hooks</h2><p>Shell commands fired at agent-loop lifecycle events. The event payload ' +
      'arrives on stdin as JSON. These run with your full user privileges — treat them like any other shell script.</p></header>' +
    '<div class="panel"><h3>Configured<span>' + state.hooks.length + '</span></h3>' + rows + '</div>' +
    '<div class="panel"><h3>Add or replace</h3><div class="form-grid">' +
      '<label for="hook-name">Name</label><input type="text" id="hook-name" placeholder="format-on-edit">' +
      '<label for="hook-event">Event</label><select id="hook-event">' +
        HOOK_EVENTS.map((e) => '<option value="' + e + '">' + e + '</option>').join('') + '</select>' +
      '<label for="hook-matcher">Matcher</label><input type="text" id="hook-matcher" placeholder="Edit (optional)">' +
      '<label for="hook-command">Command</label><input type="text" id="hook-command" placeholder="biome check --write">' +
      '<label for="hook-timeout">Timeout (s)</label><input type="number" id="hook-timeout" value="30" min="1" max="300">' +
      '<div class="span actions"><button class="btn primary" data-action="hook-save">Save hook</button></div>' +
    '</div></div>';
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

// --- secrets ------------------------------------------------------------

function viewSecrets() {
  const rows = state.secrets.map((s) =>
    '<div class="row"><div><span class="label">' + esc(s.key) + '</span>' +
      '<code class="path">' + (s.set ? esc(s.masked) : 'not set') + '</code>' +
      (s.overriddenByEnv
        ? '<div class="help">An environment variable of the same name is set and takes precedence over this value.</div>'
        : '') +
    '</div><div class="control">' +
      '<input type="password" data-secret="' + esc(s.key) + '" placeholder="paste to replace" autocomplete="off">' +
      '<button class="btn sm" data-secret-save="' + esc(s.key) + '">Save</button>' +
      (s.set ? '<button class="btn sm danger" data-secret-clear="' + esc(s.key) + '">Clear</button>' : '') +
    '</div></div>'
  ).join('');

  return '' +
    '<header><h2>Secrets</h2><p>Stored in the database, which is <code>chmod 600</code>. Values are never ' +
      'sent back to the browser — only a masked fingerprint. Environment variables override anything set here.</p></header>' +
    '<div class="panel"><h3>API keys and tokens</h3>' + rows + '</div>';
}

// --- content editor -----------------------------------------------------

function viewContent() {
  const kinds = state.content;
  if (kinds.length === 0) return '<div class="empty">Loading…</div>';

  const list = kinds.map((k) =>
    '<div class="panel"><h3>' + esc(k.kind) + '<span>' + k.files.length + '</span></h3>' +
      '<div class="file-list">' +
        (k.files.length === 0
          ? '<div class="empty">No files.</div>'
          : k.files.map((f) =>
              '<button data-open="' + esc(k.kind) + '|' + esc(f.path) + '" aria-current="' +
              (state.editor.kind === k.kind && state.editor.path === f.path) + '">' +
              esc(f.path) + '</button>').join('')) +
      '</div></div>'
  ).join('');

  const e = state.editor;
  const changed = e.content !== e.original;
  const pane = e.path
    ? '<div class="panel"><h3>' + esc(e.kind + ' / ' + e.path) +
        '<span>' + (changed ? 'unsaved' : 'saved') + '</span></h3>' +
        '<div class="pad"><textarea id="editor-body" spellcheck="false">' + esc(e.content) + '</textarea>' +
        '<div class="actions mt">' +
          '<button class="btn primary" data-action="content-save"' + (changed ? '' : ' disabled') + '>Save</button>' +
          '<button class="btn" data-action="content-revert"' + (changed ? '' : ' disabled') + '>Revert</button>' +
          '<button class="btn danger" data-action="content-delete">Delete file</button>' +
        '</div></div></div>'
    : '<div class="panel"><h3>Editor</h3><div class="empty">Select a file, or create a new one below.</div></div>';

  return '' +
    '<header><h2>Rules &amp; skills</h2><p>Markdown that shapes the agent: layered rules, on-demand skills, ' +
      'sub-agent definitions and persona files. Saved straight to disk under your Asterisk home.</p></header>' +
    '<div class="editor-grid"><div>' + list +
      '<div class="panel"><h3>New file</h3><div class="form-grid">' +
        '<label for="new-kind">Kind</label><select id="new-kind">' +
          kinds.map((k) => '<option value="' + esc(k.kind) + '">' + esc(k.kind) + '</option>').join('') +
        '</select>' +
        '<label for="new-path">Path</label><input type="text" id="new-path" placeholder="common/style.md">' +
        '<div class="span actions"><button class="btn primary" data-action="content-create">Create</button></div>' +
      '</div></div>' +
    '</div><div>' + pane + '</div></div>';
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

// --- tokens -------------------------------------------------------------

function viewTokens() {
  const rows = state.tokens.length === 0
    ? '<div class="empty">No tokens issued.</div>'
    : state.tokens.map((t) =>
        '<div class="item"><div class="grow"><div class="name">' + esc(t.label) + '</div>' +
          '<div class="detail">created ' + esc(when(t.created_at)) +
          ' · last used ' + esc(when(t.last_used_at)) + '</div></div>' +
          '<button class="btn sm danger" data-token-revoke="' + t.id + '">Revoke</button></div>'
      ).join('');

  return '' +
    '<header><h2>Access tokens</h2><p>Tokens authenticate browser sessions for this panel. Only hashes are ' +
      'stored, so a token is shown exactly once — at creation. Revoking one ends its sessions.</p></header>' +
    '<div class="panel"><h3>Issued<span>' + state.tokens.length + '</span></h3>' + rows + '</div>' +
    '<div class="panel"><h3>Issue new</h3><div class="form-grid">' +
      '<label for="token-label">Label</label><input type="text" id="token-label" placeholder="laptop">' +
      '<div class="span actions"><button class="btn primary" data-action="token-new">Issue token</button></div>' +
    '</div></div>';
}

// --- usage & cost -------------------------------------------------------

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

function money(usd, unpriced) {
  const base = usd === 0 ? '$0.00'
    : usd < 0.01 ? '$' + usd.toFixed(5)
    : usd < 1 ? '$' + usd.toFixed(4)
    : '$' + usd.toFixed(2);
  // A "+" marks a floor: some turns ran on models with no configured rate.
  return unpriced > 0 ? base + '+' : base;
}

function viewUsage() {
  const u = state.usage;
  if (!u) return '<div class="empty">Loading…</div>';

  const t = u.totals;
  const peak = Math.max(1, ...u.byDay.map((d) => d.inputTokens + d.outputTokens));

  const chart = u.byDay.map((d) => {
    const total = d.inputTokens + d.outputTokens;
    // Quantised to the 2% steps the stylesheet defines — the CSP forbids
    // style attributes, so the width has to be a class.
    const pct = total === 0 ? 0 : Math.max(2, Math.round((total / peak) * 50) * 2);
    // Local MM-DD. toISOString() would render in UTC and label today's
    // bucket with yesterday's date east of Greenwich.
    const dt = new Date(d.day);
    const label = String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    return '<div class="item bar-row">' +
      '<code class="detail bar-label">' + esc(label) + '</code>' +
      '<div class="bar-track"><div class="bar-fill w' + pct + '"></div></div>' +
      '<code class="detail bar-tokens">' + esc(tokens(total)) + '</code>' +
      '<code class="detail bar-cost">' +
        (d.turns ? esc(money(d.costUsd, d.unpricedTurns)) : '—') + '</code>' +
    '</div>';
  }).join('');

  const models = u.byModel.length === 0
    ? '<div class="empty">Nothing recorded yet.</div>'
    : u.byModel.map((m) =>
        '<div class="item"><div class="grow"><div class="name">' + esc(m.provider + ':' + m.model) + '</div>' +
        '<div class="detail">' + esc(tokens(m.inputTokens)) + ' in · ' + esc(tokens(m.outputTokens)) + ' out · ' +
        m.turns + ' turns' + (m.unpricedTurns > 0 ? ' · ' + m.unpricedTurns + ' unpriced' : '') + '</div></div>' +
        '<code class="detail">' + esc(money(m.costUsd, m.unpricedTurns)) + '</code></div>'
      ).join('');

  const pricing = (state.pricing || []).map((p) =>
    '<div class="item"><div class="grow"><div class="name">' + esc(p.model) +
      ' <span class="detail">' + esc(p.source) + '</span></div>' +
      '<div class="detail">$' + p.inputPerMTok + ' in · $' + p.outputPerMTok + ' out · $' +
      p.cacheWritePerMTok.toFixed(3) + ' cache write · $' + p.cacheReadPerMTok.toFixed(3) +
      ' cache read (per Mtok)</div></div>' +
      '<button class="btn sm danger" data-price-delete="' + esc(p.model) + '">Delete</button></div>'
  ).join('');

  return '' +
    '<header><h2>Usage &amp; cost</h2><p>One row is recorded per agent turn. Local models are counted at ' +
      'zero cost; models with no configured rate are counted in tokens but excluded from the money total, ' +
      'which is why some figures carry a “+”.</p></header>' +
    '<div class="readouts">' +
      readout('Today', money(t.today.costUsd, t.today.unpricedTurns), 'sm') +
      readout('Last 7d', money(t.week.costUsd, t.week.unpricedTurns), 'sm') +
      readout('Last 30d', money(t.month.costUsd, t.month.unpricedTurns), 'sm') +
      readout('Lifetime', money(t.lifetime.costUsd, t.lifetime.unpricedTurns), 'sm') +
      readout('Turns', String(t.lifetime.turns)) +
    '</div>' +
    '<div class="panel"><h3>Last ' + u.days + ' days</h3>' + chart + '</div>' +
    '<div class="panel"><h3>By model</h3>' + models + '</div>' +
    '<div class="panel"><h3>Pricing<span>USD per million tokens</span></h3>' + pricing +
      '<div class="form-grid">' +
        '<label for="price-model">Model</label><input type="text" id="price-model" placeholder="claude-opus-5">' +
        '<label for="price-in">Input</label><input type="number" id="price-in" step="0.01" placeholder="5">' +
        '<label for="price-out">Output</label><input type="number" id="price-out" step="0.01" placeholder="25">' +
        '<div class="span actions"><button class="btn primary" data-action="price-save">Save rate</button>' +
        '<span class="detail">Cache rates default to 1.25× input (write) and 0.1× input (read).</span></div>' +
      '</div>' +
    '</div>' +
    '<div class="actions"><button class="btn danger" data-action="usage-clear">Clear usage history</button></div>';
}

async function savePricing() {
  const model = $('#price-model').value.trim();
  const inputPerMTok = $('#price-in').value;
  const outputPerMTok = $('#price-out').value;
  if (!model || inputPerMTok === '' || outputPerMTok === '') {
    toast('Model, input and output rates are required', 'bad');
    return;
  }
  const ok = await guard(() => api('/pricing', {
    method: 'PUT',
    body: JSON.stringify({ model, inputPerMTok, outputPerMTok }),
  }), 'Rate saved');
  if (ok) { await loadUsage(); render(); }
}

// --- diagnostics, logs, audit -------------------------------------------

function viewDoctor() {
  const d = state.doctor;
  if (!d) return '<div class="empty">Running checks…</div>';
  return '' +
    '<header><h2>Diagnostics</h2><p>Connectivity and environment checks, same ground as <code>/doctor</code> ' +
      'in the REPL.</p></header>' +
    '<div class="panel"><h3>Checks<span>' + d.checks.filter((c) => c.ok).length + '/' + d.checks.length + '</span></h3>' +
      d.checks.map((c) =>
        '<div class="item"><span class="chip ' + (c.ok ? 'on' : 'bad') + '">' + (c.ok ? 'ok' : 'fail') + '</span>' +
        '<div class="grow"><div class="name">' + esc(c.name) + '</div>' +
        '<div class="detail">' + esc(c.detail) + '</div></div></div>').join('') +
    '</div>' +
    '<div class="actions"><button class="btn" data-action="doctor-rerun">Run again</button></div>';
}

function viewLogs() {
  return '' +
    '<header><h2>Daemon log</h2><p>Tail of <code>~/.asterisk/logs/daemon.log</code>.</p></header>' +
    '<div class="actions mb">' +
      '<button class="btn" data-action="logs-refresh">Refresh</button></div>' +
    '<div class="panel"><pre class="log">' + esc(state.logText || '(empty)') + '</pre></div>';
}

function viewAudit() {
  const rows = state.audit.length === 0
    ? '<div class="empty">Nothing recorded yet.</div>'
    : state.audit.map((a) =>
        '<div class="item"><div class="grow">' +
          '<div class="name">' + esc(a.action) + ' <span class="detail">' + esc(a.target) + '</span></div>' +
          '<div class="detail">' + esc(when(a.at)) + ' · ' + esc(a.actor) + '</div></div></div>'
      ).join('');
  return '' +
    '<header><h2>Audit trail</h2><p>Every change made through this panel.</p></header>' +
    '<div class="panel"><h3>Recent</h3>' + rows + '</div>';
}

// --- data loading -------------------------------------------------------

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
async function loadUsage() {
  state.usage = await guard(() => api('/usage'));
  const r = await guard(() => api('/pricing'));
  state.pricing = r ? r.pricing : [];
}

const LOADERS = {
  overview: loadStatus, settings: loadSettings, mcp: loadMcp, hooks: loadHooks,
  secrets: loadSecrets, content: loadContent, tokens: loadTokens,
  audit: loadAudit, logs: loadLogs, doctor: loadDoctor, usage: loadUsage,
};

const VIEWS = {
  overview: viewOverview, settings: viewSettings, mcp: viewMcp, hooks: viewHooks,
  secrets: viewSecrets, content: viewContent, tokens: viewTokens,
  audit: viewAudit, logs: viewLogs, doctor: viewDoctor, usage: viewUsage,
};

function render() {
  renderRail();
  renderTopbar();
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

// --- events -------------------------------------------------------------

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-tab],[data-action],[data-daemon],[data-toggle],[data-reset],' +
    '[data-revert],[data-mcp-toggle],[data-mcp-delete],[data-hook-toggle],[data-hook-delete],' +
    '[data-secret-save],[data-secret-clear],[data-token-revoke],[data-open],[data-price-delete]');
  if (!t) return;
  const d = t.dataset;

  if (d.tab) return goto(d.tab);
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

  if (d.priceDelete) {
    if (!confirm('Delete the rate for "' + d.priceDelete + '"?')) return;
    const ok = await guard(() => api('/pricing/' + encodeURIComponent(d.priceDelete), { method: 'DELETE' }), 'Deleted');
    if (ok) { await loadUsage(); render(); }
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
    case 'price-save': return savePricing();
    case 'usage-clear': {
      if (!confirm('Delete all recorded usage history? Totals reset to zero.')) return;
      const ok = await guard(() => api('/usage', { method: 'DELETE' }), 'Usage history cleared');
      if (ok) { await loadUsage(); render(); }
      return;
    }
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
      const kind = $('#new-kind').value;
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
    case 'doctor-rerun': state.doctor = null; render(); await loadDoctor(); return render();
    case 'logs-refresh': await loadLogs(); return render();
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
  if (ev.target.id === 'editor-body') {
    state.editor.content = ev.target.value;
    const save = document.querySelector('[data-action="content-save"]');
    const revert = document.querySelector('[data-action="content-revert"]');
    const changed = state.editor.content !== state.editor.original;
    if (save) save.disabled = !changed;
    if (revert) revert.disabled = !changed;
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

// --- boot ---------------------------------------------------------------

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
