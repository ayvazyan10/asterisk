// Rules, Agents and Souls — the three pages beside Skills.
//
// Each one used to be a file tree with a textarea, and each one was hiding the
// same thing skills was: the set on disk and the set the agent loads are not
// equal. So each leads with what is in effect, names what is inert and why,
// and only then offers the editor.
//
// The specifics differ because the loaders differ:
//   Rules   layer common → language → flat, and the language layer is gated on
//           what the project detects as. Load order is override order, so the
//           list is shown in it rather than alphabetically.
//   Agents  resolve 27 bundled definitions plus yours; your definition of a
//           bundled name replaces it outright.
//   Souls   layer user → session → project, last wins.
//
// Backed by ../api/authored.ts.

export const APP_AUTHORED = String.raw`
// --- shared ---------------------------------------------------------------

/** The card that names what is sitting there doing nothing, and why. */
function inertCard(items, noun) {
  if (!items || items.length === 0) return '';
  return ui.card('Not loaded', items.map((i) =>
    '<div class="check check-bad"><span class="check-mark">✗</span>' +
      '<div class="list-row-grow">' +
        '<div class="check-name">' + esc(i.rel) +
          ' <span class="issue-path">' + esc(i.scope || '') + '</span></div>' +
        '<div class="check-detail">' + esc(i.reason) + '</div>' +
      '</div></div>').join(''),
    { aside: ui.badge(items.length + ' ' + noun, 'destructive', true) });
}

// --- rules ----------------------------------------------------------------

async function loadRulesReport() { state.rules = await guard(() => api('/rules')); }

function viewRules() {
  const d = state.rules;
  const header = ui.pageHeader('Rules',
    'Markdown spliced into every system prompt. Layers load in order — common, then your ' +
    'language, then loose files — and later ones win.',
    d ? d.roots.user : '');

  if (!d) return header + '<section class="card">' + ui.skeletonRows(4) + '</section>';

  const summary = '<div class="section-actions mb">' +
    ui.badge(d.rules.length + ' in effect', 'secondary') +
    ui.badge('reads as ' + d.lang + (d.langPinned ? ' (pinned)' : ''), 'success', true) +
    (d.inert.length > 0 ? ui.badge(d.inert.length + ' not loaded', 'destructive', true) : '') +
  '</div>';

  // Load order is override order, so it is the order shown. Sorting these
  // alphabetically would hide the one thing the list is for.
  const rows = d.rules.length === 0
    ? ui.empty('No rules load yet. Add one under common/ to shape every prompt.')
    : d.rules.map((r, i) =>
        '<div class="list-row"><span class="order-mark">' + (i + 1) + '</span>' +
          '<div class="list-row-grow">' +
            '<div class="list-row-title">' + esc(r.name) + '</div>' +
            '<div class="list-row-detail">' + esc(r.path) + '</div>' +
          '</div>' +
          '<div class="section-actions">' +
            ui.badge(r.scope, r.scope === 'user' ? 'secondary' : 'outline') +
            ui.badge(r.layer, 'muted') +
          '</div></div>').join('');

  return header + summary +
    inertCard(d.inert, 'inert') +
    ui.card('In effect, in load order', rows,
      { aside: ui.badge(d.rules.length + ' loaded', 'secondary') }) +
    viewContentBody('rules');
}

// --- agents ---------------------------------------------------------------

async function loadAgentsReport() { state.agents = await guard(() => api('/agents')); }

async function openAgent(name) {
  const body = await guard(() => api('/agents/' + encodeURIComponent(name)));
  if (!body) return;
  state.agent = body;
  render();
}

function agentDetailCard() {
  const a = state.agent;
  if (!a) return ui.card('Agent', ui.empty('Pick one to read the prompt it runs under.'));

  const tools = a.allowedTools
    ? a.allowedTools.map((t) => ui.badge(t, 'outline')).join(' ')
    : '<span class="form-hint">Inherits every tool the parent has.</span>';

  return ui.card(a.name,
    '<div class="card-content">' +
      '<p class="skill-readonly-desc">' + esc(a.description) + '</p>' +
      '<div class="agent-meta">' +
        '<span class="silk">tools</span><div>' + tools + '</div>' +
        '<span class="silk">turns</span><div>' +
          (a.maxTurns === null ? '<span class="form-hint">default</span>' : esc(a.maxTurns)) +
        '</div>' +
      '</div>' +
      (a.editable
        ? '<p class="form-hint mt">Edit it as a file below.</p>'
        : '<p class="form-hint mt">Built into Asterisk. Add a file of the same name to replace it.</p>') +
      '<pre class="code-block skill-prompt mt">' + esc(a.prompt) + '</pre>' +
    '</div>',
    { aside: ui.badge(a.scope, a.scope === 'bundled' ? 'muted' : 'secondary') });
}

function matchingAgents(d) {
  const filter = (state.agentFilter || '').toLowerCase();
  if (!filter) return d.agents;
  return d.agents.filter((a) =>
    a.name.toLowerCase().includes(filter) || a.description.toLowerCase().includes(filter));
}

/** Just the grouped list, so filtering can redraw it without losing focus. */
function agentGroups(d) {
  const matches = matchingAgents(d);
  // Yours first: the 27 bundled are the ones you are least likely to want.
  const groups = ['project', 'user', 'bundled'].map((scope) => {
    const inScope = matches.filter((a) => a.scope === scope);
    if (inScope.length === 0) return '';
    return '<div class="skill-group"><span class="silk">' + scope + '</span>' +
      '<span class="nav-count">' + inScope.length + '</span></div>' +
      inScope.map((a) =>
        '<button class="skill-item" data-agent-open="' + esc(a.name) + '" aria-current="' +
          (state.agent && state.agent.name === a.name) + '">' +
          '<span class="skill-item-name">' + esc(a.name) +
            (d.shadowed.includes(a.name) ? ' <span class="issue-path">replaces bundled</span>' : '') +
          '</span>' +
          '<span class="skill-item-desc">' + esc(a.description) + '</span>' +
        '</button>').join('');
  }).join('');

  return groups || ui.empty('Nothing matches that.');
}

function viewAgents() {
  const d = state.agents;
  const header = ui.pageHeader('Agents',
    'Sub-agent types the Agent tool can dispatch to. Most ship with Asterisk; a file of the same ' +
    'name replaces one outright.',
    d ? d.roots.user : '');

  if (!d) return header + '<section class="card">' + ui.skeletonRows(4) + '</section>';

  const matches = matchingAgents(d);

  const summary = '<div class="section-actions mb">' +
    ui.badge(d.counts.loaded + ' available', 'secondary') +
    ui.badge(d.counts.bundled + ' bundled', 'muted') +
    (d.counts.user > 0 ? ui.badge(d.counts.user + ' yours', 'success', true) : '') +
    (d.shadowed.length > 0
      ? ui.badge(d.shadowed.length + ' replacing a bundled one', 'outline', true) : '') +
    (d.inert.length > 0 ? ui.badge(d.inert.length + ' not loaded', 'destructive', true) : '') +
  '</div>';

  const list = ui.card('Available',
    '<div class="skill-search"><input class="input" type="search" id="agent-filter" ' +
      'placeholder="Name or description" value="' + esc(state.agentFilter || '') +
      '" aria-label="Filter agents"></div>' +
    '<div class="agent-list-body">' + agentGroups(d) + '</div>',
    { aside: ui.badge(matches.length + ' of ' + d.agents.length, 'secondary') });

  return header + summary + inertCard(d.inert, 'inert') +
    '<div class="editor-grid"><div>' + list + '</div><div>' + agentDetailCard() + '</div></div>';
}

// --- souls ----------------------------------------------------------------

async function loadSoulsReport() { state.souls = await guard(() => api('/souls')); }

function viewSouls() {
  const d = state.souls;
  const header = ui.pageHeader('Souls',
    'Persona files. The operator soul applies everywhere, a chat can set its own, and a project ' +
    'can override both — later layers win.',
    d ? d.roots.sessions : '');

  if (!d) return header + '<section class="card">' + ui.skeletonRows(3) + '</section>';

  const active = d.active.length === 0
    ? ui.empty('No soul applies here yet. Write ~/.asterisk/SOUL.md to set one everywhere.')
    : d.active.map((s, i) =>
        ui.listRow('<span class="order-mark">' + (i + 1) + '</span> ' + esc(s.scope), s.path, '',
          ui.badge(bytes(s.bytes), 'muted'))).join('');

  // Per-chat souls never apply to the panel — it is not a chat — so they are
  // listed as what they are rather than mixed in with the layers in effect.
  const sessions = d.sessions.length === 0
    ? ui.empty('No chat has set its own persona.')
    : d.sessions.map((s) => ui.listRow(esc(s.rel), s.path, '', ui.badge(bytes(s.bytes), 'muted'))).join('');

  return header +
    ui.card('In effect here, in layer order', active,
      { aside: ui.badge(d.active.length + ' layer' + (d.active.length === 1 ? '' : 's'), 'secondary') }) +
    ui.card('Per-chat', sessions, { aside: ui.badge(d.sessions.length, 'muted') }) +
    viewContentBody('souls');
}
`;
