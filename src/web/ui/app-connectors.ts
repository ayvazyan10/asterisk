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

function connectorActions(c) {
  const id = esc(c.id);
  // A token connector cannot open a browser flow — its server does not hand
  // out client registrations — so the button asks for the token instead.
  const attr = c.auth === 'token' ? ' data-connector-token="' : ' data-connector-connect="';
  const label = c.auth === 'token' ? (c.connected ? 'Replace token' : 'Add token')
                                   : (c.connected ? 'Reconnect' : 'Connect');
  const connect = ui.btn(label,
    { size: 'sm', variant: c.connected ? 'outline' : 'default', attrs: attr + id + '"' });
  if (!c.installed) return connect;
  return connect +
    (c.connected
      ? ui.btn('Disconnect', { size: 'sm', variant: 'ghost', attrs: ' data-mcp-disconnect="' + id + '"' })
      : '') +
    ui.btn('Remove', { size: 'sm', variant: 'destructive-ghost', attrs: ' data-connector-remove="' + id + '"' });
}

/** Cards for the popular-and-not-yet-added ones; once added they belong in the table. */
function connectorCards() {
  const popular = state.connectors.filter((c) => c.source === 'catalog' && !c.installed).slice(0, 3);
  if (popular.length === 0) return '';
  return '<div class="connector-cards">' + popular.map((c) =>
    '<div class="connector-card">' +
      '<div class="connector-mark">' + esc(c.name.slice(0, 1)) + '</div>' +
      '<div class="connector-card-body">' +
        '<div class="connector-card-name">' + esc(c.name) + '</div>' +
        '<div class="connector-card-detail">' + esc(c.description) + '</div>' +
      '</div>' +
      ui.btn(c.auth === 'token' ? 'Add token' : 'Connect', { size: 'sm',
        attrs: (c.auth === 'token' ? ' data-connector-token="' : ' data-connector-connect="') + esc(c.id) + '"' }) +
    '</div>'
  ).join('') + '</div>';
}

/** Rows only — replaced in place by the search box, which must not lose focus. */
function connectorRows() {
  const shown = state.connectors.filter(connectorMatches);
  if (shown.length === 0) return ui.empty('Nothing matches that filter.');
  return shown.map((c) => ui.listRow(
    esc(c.name) +
      (c.source === 'custom' ? ' ' + ui.badge('custom', 'outline') : '') +
      ' ' + connectorStatus(c),
    c.url,
    connectorActions(c),
    '<div class="connector-mark">' + esc(c.name.slice(0, 1)) + '</div>'
  )).join('');
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

  const custom = '<div class="form-grid">' +
    '<label class="label" for="connector-name">Name</label>' +
    '<input class="input" type="text" id="connector-name" placeholder="my-service">' +
    '<label class="label" for="connector-url">MCP endpoint URL</label>' +
    '<input class="input" type="text" id="connector-url" placeholder="https://mcp.example.com/mcp">' +
    '<div class="form-span section-actions">' +
      ui.btn('Add and connect', { variant: 'default', attrs: ' data-action="connector-add"' }) +
      '<span class="form-hint">Streamable HTTP endpoints that authenticate with OAuth.</span>' +
    '</div></div>';

  return ui.pageHeader('Connectors',
      'Services the agent can use through their own hosted MCP endpoints. Connecting one opens ' +
      'that service’s consent screen; the token is stored locally and refreshes itself. ' +
      'Google and Slack are absent because they publish no endpoint a third-party client may use.') +
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

/**
 * Asks for a token and stores it.
 *
 * prompt() rather than a designed field because this is the one place the
 * panel takes a secret from the user, and a real form would have to solve
 * masking, paste handling and accidental persistence in the DOM to be an
 * improvement. The value goes straight to the API and is never rendered.
 */
async function addConnectorToken(id) {
  const c = state.connectors.find((x) => x.id === id);
  const help = c && c.tokenHelp ? c.tokenHelp : 'Paste the access token for this service.';
  const where = c && c.tokenUrl ? '\n\nCreate one at: ' + c.tokenUrl : '';
  const token = prompt(help + where);
  if (token === null) return;
  if (!token.trim()) { toast('No token entered', 'bad'); return; }

  const ok = await guard(() => api('/connectors/' + encodeURIComponent(id) + '/token', {
    method: 'PUT', body: JSON.stringify({ token: token.trim() }),
  }), 'Token saved');
  if (!ok) return;
  await loadConnectors();
  await loadMcp();
  render();
}

async function addCustomConnector() {
  const name = $('#connector-name').value.trim();
  const url = $('#connector-url').value.trim();
  if (!name || !url) { toast('Name and URL are required', 'bad'); return; }
  if (!/^https?:\/\//i.test(url)) { toast('URL must start with http:// or https://', 'bad'); return; }

  const server = { name, transport: 'http', url, headers: {}, auth: 'oauth', scopes: [], enabled: true };
  const ok = await guard(() => api('/mcp', { method: 'PUT', body: JSON.stringify({ server }) }), 'Connector added');
  if (!ok) return;
  await connectConnector(name);
}
`;
