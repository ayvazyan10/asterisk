// The Connectors page.
//
// Its own module rather than another section of app-views.ts, which is already
// at the repo's file-size limit. Everything here is the client half of
// /api/connectors: the page asks one endpoint and renders what it gets.
//
// The shape is a catalog, not a config list. Popular services get cards at the
// top because the common case is "I want Linear" and not "I want to inspect
// server rows"; the table below is every service, filterable, with one action
// per row. The raw view — stdio servers, headers, auth mode — stays on the MCP
// servers page, which this page never duplicates.

export const APP_CONNECTORS = String.raw`
// --- connectors ----------------------------------------------------------

const CONNECTOR_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'available', label: 'Not connected' },
];

function connectorMatches(c) {
  if (state.connectorFilter === 'connected' && !c.connected) return false;
  if (state.connectorFilter === 'available' && c.connected) return false;
  const q = state.connectorQuery.trim().toLowerCase();
  if (!q) return true;
  return (c.name + ' ' + c.description + ' ' + c.url).toLowerCase().includes(q);
}

function connectorStatus(c) {
  if (!c.installed) return ui.badge('Not connected', 'outline');
  if (!c.connected) return ui.badge('Added, not authorized', 'muted', true);
  if (!c.enabled) return ui.badge('Connected, disabled', 'secondary', true);
  return ui.badge('Connected', 'success', true);
}

/**
 * The one thing the row's primary button is for.
 *
 * Three services, three different first steps, and the button says which:
 * a token connector cannot open a browser flow at all, and a manual-client one
 * cannot until the user has registered a client — pressing Connect there would
 * only ever return the same 409.
 */
function connectorEntry(c) {
  if (c.auth === 'token') {
    return { attr: ' data-connector-token="', label: c.connected ? 'Replace token' : 'Add token' };
  }
  if (c.clientRegistration === 'manual' && !c.hasClient) {
    return { attr: ' data-connector-client="', label: 'Add OAuth client' };
  }
  return { attr: ' data-connector-connect="', label: c.connected ? 'Reconnect' : 'Connect' };
}

function connectorActions(c) {
  const id = esc(c.id);
  const { attr, label } = connectorEntry(c);
  // Quiet in the table, loud on the cards. Six primary buttons stacked down
  // one edge is not six primary actions — it is a list, and the row's own
  // action is the one thing on it, not the thing on the page.
  const connect = ui.btn(label,
    { size: 'sm', variant: 'secondary', attrs: attr + id + '"' });
  if (!c.installed) return connect;
  return connect +
    (c.clientRegistration === 'manual' && c.hasClient
      ? ui.btn('Replace client', { size: 'sm', variant: 'ghost', attrs: ' data-connector-client="' + id + '"' })
      : '') +
    (c.connected
      ? ui.btn('Disconnect', { size: 'sm', variant: 'ghost', attrs: ' data-mcp-disconnect="' + id + '"' })
      : '') +
    ui.btn('Remove', { size: 'sm', variant: 'destructive-ghost', attrs: ' data-connector-remove="' + id + '"' });
}

/**
 * Cards for the popular-and-not-yet-added ones; once added they belong in the
 * table below (connectorRows(), which does carry role="list").
 *
 * Deliberately NOT wrapped in ui.list(): '.connector-cards' is a CSS grid
 * (repeat(auto-fit, minmax(...))) whose reflow depends on '.connector-card'
 * being its DIRECT children. ui.list() always inserts one more div around the
 * rows it is given, which here would leave '.connector-cards' with a single
 * child and collapse the responsive grid into one column — the "the rows
 * inside keep their existing classes and spacing untouched" promise on
 * ui.list() in app-core.ts holds for a flow of list-rows, not for a grid.
 * Every one of these connectors is also reachable, fully row-marked, in the
 * table underneath, so nothing here goes unannounced to a screen reader.
 */
function connectorCards() {
  const popular = state.connectors.filter((c) => c.popular && !c.installed);
  if (popular.length === 0) return '';
  return '<div class="connector-cards">' + popular.map((c) => {
    const entry = connectorEntry(c);
    return '<div class="connector-card">' +
      '<div class="connector-mark">' + esc(c.name.slice(0, 1)) + '</div>' +
      '<div class="connector-card-body">' +
        '<div class="connector-card-name">' + esc(c.name) + '</div>' +
        '<div class="connector-card-detail">' + esc(c.description) + '</div>' +
      '</div>' +
      ui.btn(entry.label, { size: 'sm', variant: 'default', attrs: entry.attr + esc(c.id) + '"' }) +
    '</div>';
  }).join('') + '</div>';
}

/**
 * Sets/clears one field's error message and aria-invalid, by the input's own
 * id — the same shape as Skills' setSkillFormError in app-skills.ts and MCP's
 * / Hooks' setAddFormError in app-views.ts, sized to a bare id because this
 * file's two forms (the custom-add form, the setup panel) do not share one
 * id prefix.
 */
function setConnectorFormError(id, message) {
  const input = $('#' + id);
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  const node = $('#' + id + '-error');
  if (node) node.textContent = message || '';
}

/** The redirect URI has to be registered by hand, so it is on the row to copy. */
function connectorDetail(c) {
  return c.auth === 'oauth' && c.clientRegistration === 'manual' && !c.hasClient
    ? c.url + '  ·  redirect URI to allow: ' + c.redirectUri
    : c.url;
}

/** Rows only — replaced in place by the search box, which must not lose focus. */
function connectorRows() {
  const shown = state.connectors.filter(connectorMatches);
  if (shown.length === 0) return ui.empty('Nothing matches that filter.');
  return ui.list(shown.map((c) => ui.listRow(
    esc(c.name) +
      (c.source === 'custom' ? ' ' + ui.badge('custom', 'outline') : '') +
      ' ' + connectorStatus(c),
    connectorDetail(c),
    connectorActions(c),
    '<div class="connector-mark">' + esc(c.name.slice(0, 1)) + '</div>',
    true
  )).join(''), 'Connectors');
}

/** A value the user has to carry to another site: selectable, whole, copyable. */
function copyField(id, label, value) {
  return '<label class="label" for="' + id + '">' + esc(label) + '</label>' +
    '<div class="copy-row">' +
      '<input class="input" id="' + id + '" readonly value="' + esc(value) + '">' +
      ui.btn('Copy', { size: 'sm', variant: 'outline', attrs: ' data-copy="' + id + '"' }) +
    '</div>';
}

/**
 * Setting a connector up by hand.
 *
 * This was two prompt() calls, on the reasoning that a secret deserved no
 * markup. That was wrong twice over: the panel already takes secrets in
 * password fields on the Secrets page, so nothing had to be solved — and a
 * prompt() cannot be copied out of, which is exactly what the user has to do
 * with the redirect URI and the scopes it was showing them.
 */
function connectorSetupPanel() {
  const setup = state.connectorSetup;
  if (!setup) return '';
  const c = state.connectors.find((x) => x.id === setup.id);
  if (!c) return '';

  const isToken = setup.kind === 'token';
  const help = isToken
    ? (c.tokenHelp || 'Paste an access token for this service.')
    : (c.clientHelp || 'Register an OAuth client with this service and paste its ID.');
  const where = isToken ? c.tokenUrl : c.clientUrl;

  // Both required fields are wrapped with their error node in a bare div, one
  // grid item per field, for the same reason as Skills' New skill form
  // (app-skills.ts): .form-grid alternates label/control per row, and a third
  // sibling per field would throw that off. The client secret stays
  // unwrapped and unmarked — it is genuinely optional, see the form hint
  // below and saveConnectorSetup()'s own comment.
  const fields = isToken
    ? '<label class="label" for="setup-token">Access token</label>' +
      '<div><input class="input" type="password" id="setup-token" autocomplete="off" spellcheck="false" ' +
        'required aria-required="true" aria-describedby="setup-token-error">' +
        '<div id="setup-token-error" role="alert"></div></div>'
    : copyField('setup-redirect', 'Redirect URI to allow', c.redirectUri) +
      (c.scopes && c.scopes.length
        ? copyField('setup-scopes', 'Scopes to grant', c.scopes.join(' '))
        : '') +
      '<label class="label" for="setup-client-id">Client ID</label>' +
      '<div><input class="input" type="text" id="setup-client-id" autocomplete="off" spellcheck="false" ' +
        'placeholder="000000-abc.apps.googleusercontent.com" ' +
        'required aria-required="true" aria-describedby="setup-client-id-error">' +
        '<div id="setup-client-id-error" role="alert"></div></div>' +
      '<label class="label" for="setup-client-secret">Client secret</label>' +
      '<input class="input" type="password" id="setup-client-secret" autocomplete="off" spellcheck="false">';

  const body = '<p class="form-hint mb">' + esc(help) + '</p>' +
    (where
      // A real link, so it opens. The same URL inside a prompt() was text the
      // user had to retype.
      ? '<p class="form-hint mb">Create one at ' +
        '<a class="link" href="' + esc(where) + '" target="_blank" rel="noopener noreferrer">' +
        esc(where) + '</a></p>'
      : '') +
    '<div class="form-grid">' + fields +
      '<div class="form-span section-actions">' +
        ui.btn(isToken ? 'Save token' : 'Save and connect',
          { variant: 'default', attrs: ' data-action="connector-setup-save"' }) +
        ui.btn('Cancel', { variant: 'ghost', attrs: ' data-action="connector-setup-cancel"' }) +
        (isToken ? '' : '<span class="form-hint">Leave the secret empty if your client has none.</span>') +
      '</div>' +
    '</div>';

  return ui.card((isToken ? 'Token for ' : 'OAuth client for ') + c.name,
    '<div class="card-content">' + body + '</div>');
}

function viewConnectors() {
  if (!state.loaded.has('connectors')) {
    return ui.pageHeader('Connectors', 'Loading…') + ui.card('Connectors', ui.skeletonRows(4));
  }

  const toolbar = '<div class="toolbar">' +
    ui.tabs(CONNECTOR_FILTERS, state.connectorFilter, 'connector-filter') +
    '<div class="toolbar-spacer"></div>' +
    '<input class="input toolbar-inset" type="search" id="connector-search" placeholder="Search connectors" ' +
      'value="' + esc(state.connectorQuery) + '">' +
    '</div>';

  // Both fields are genuinely required — McpHttpServerSchema (config/schema.ts)
  // takes name: z.string().min(1) and url: z.string().url() — so both carry
  // required/aria-required and an error node, each wrapped for the same
  // .form-grid alternation reason as the setup panel above.
  const custom = '<div class="form-grid">' +
    '<label class="label" for="connector-name">Name</label>' +
    '<div><input class="input" type="text" id="connector-name" placeholder="my-service" ' +
      'required aria-required="true" aria-describedby="connector-name-error">' +
      '<div id="connector-name-error" role="alert"></div></div>' +
    '<label class="label" for="connector-url">MCP endpoint URL</label>' +
    '<div><input class="input" type="text" id="connector-url" placeholder="https://mcp.example.com/mcp" ' +
      'required aria-required="true" aria-describedby="connector-url-error">' +
      '<div id="connector-url-error" role="alert"></div></div>' +
    '<div class="form-span section-actions">' +
      ui.btn('Add and connect', { variant: 'default', attrs: ' data-action="connector-add"' }) +
      '<span class="form-hint">Streamable HTTP endpoints that authenticate with OAuth.</span>' +
    '</div></div>';

  return ui.pageHeader('Connectors',
      'Services the agent can use through their own hosted MCP endpoints. Connecting one opens ' +
      'that service’s consent screen; the token is stored locally and refreshes itself. ' +
      'Google registers no clients on its own, so its entries ask for an OAuth client you create ' +
      'in the Google Cloud console first — one client covers all three.') +
    connectorSetupPanel() +
    connectorCards() +
    addPanel('connector-add-panel', 'Add a connector by URL', custom) +
    ui.card('Services',
      toolbar + '<div class="connector-list-body">' + connectorRows() + '</div>',
      { aside: ui.badge(state.connectors.length, 'secondary') });
}

async function loadConnectors() {
  const r = await guard(() => api('/connectors'));
  state.connectors = r ? r.connectors : [];
}

/** Shared by the cards, the rows and the add form — all three end in a consent URL. */
async function connectConnector(id) {
  const res = await guard(() => api('/connectors/' + encodeURIComponent(id) + '/connect', { method: 'POST' }));
  if (!res) return;
  await loadConnectors();
  if (res.status === 'refreshed') { toast('Already authorized', 'good'); return render(); }
  // A new tab rather than a navigation: the panel keeps its state, and the
  // consent screen is somebody else's page.
  window.open(res.authorizationUrl, '_blank', 'noopener');
  toast('Finish authorizing in the new tab, then reload the list', 'good');
  render();
}

/** Opens the setup panel. The work happens on save, not here. */
function openConnectorSetup(id, kind) {
  state.connectorSetup = { id, kind };
  render();
  const first = $(kind === 'token' ? '#setup-token' : '#setup-client-id');
  if (first) first.focus();
}

function closeConnectorSetup() {
  state.connectorSetup = null;
  render();
}

/** Copies a readonly field's value, so nothing here has to be retyped. */
async function copyFieldValue(id) {
  const el = $('#' + id);
  if (!el) return;
  el.select();
  try {
    await navigator.clipboard.writeText(el.value);
    toast('Copied', 'good');
  } catch {
    // Clipboard permission can be refused; the value is selected either way,
    // so Ctrl+C still works and saying so beats a silent no-op.
    toast('Could not copy — the value is selected, press Ctrl+C', 'bad');
  }
}

/**
 * Saves whichever credential the panel is open for.
 *
 * The client secret is optional on purpose: an authorization server that takes
 * a public client with PKCE issues none, and an empty string is not the same
 * as absent — the SDK picks the token endpoint's auth method from whether one
 * is there at all.
 */
async function saveConnectorSetup() {
  const setup = state.connectorSetup;
  if (!setup) return;
  const id = setup.id;

  if (setup.kind === 'token') {
    const token = $('#setup-token').value.trim();
    setConnectorFormError('setup-token', token ? '' : 'An access token is required.');
    if (!token) { toast('A token is required', 'bad'); $('#setup-token').focus(); return; }
    const ok = await guard(() => api('/connectors/' + encodeURIComponent(id) + '/token', {
      method: 'PUT', body: JSON.stringify({ token }),
    }), 'Token saved');
    if (!ok) return;
    state.connectorSetup = null;
    await loadConnectors();
    await loadMcp();
    render();
    return;
  }

  const clientId = $('#setup-client-id').value.trim();
  setConnectorFormError('setup-client-id', clientId ? '' : 'A client ID is required.');
  if (!clientId) { toast('A client ID is required', 'bad'); $('#setup-client-id').focus(); return; }
  const clientSecret = $('#setup-client-secret').value.trim();

  const ok = await guard(() => api('/connectors/' + encodeURIComponent(id) + '/client', {
    method: 'PUT', body: JSON.stringify({ clientId, clientSecret }),
  }), 'OAuth client saved');
  if (!ok) return;
  state.connectorSetup = null;
  await loadConnectors();
  await connectConnector(id);
}

async function addCustomConnector() {
  const name = $('#connector-name').value.trim();
  const url = $('#connector-url').value.trim();
  const badUrl = Boolean(url) && !/^https?:\/\//i.test(url);

  setConnectorFormError('connector-name', name ? '' : 'A name is required.');
  setConnectorFormError('connector-url',
    !url ? 'A URL is required.' : badUrl ? 'URL must start with http:// or https://.' : '');

  if (!name || !url || badUrl) {
    toast(badUrl ? 'URL must start with http:// or https://' : 'Name and URL are required', 'bad');
    $('#connector-' + (name ? 'url' : 'name')).focus();
    return;
  }

  const server = { name, transport: 'http', url, headers: {}, auth: 'oauth', scopes: [], enabled: true };
  const ok = await guard(() => api('/mcp', { method: 'PUT', body: JSON.stringify({ server }) }), 'Connector added');
  if (!ok) return;
  await connectConnector(name);
}
`;
