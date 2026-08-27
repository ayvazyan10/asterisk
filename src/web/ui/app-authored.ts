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

// Only one inert category means "this is not a mistake" — see
// ruleSkipReason() in src/web/api/authored.ts, which returns a structured
// 'category' alongside the human-readable 'reason' from the one place that
// knows which case it is. A rule under rules/python/ in a TypeScript project
// reports category: 'other-language' (reason "written for python, and this
// project reads as typescript") — the one case the layered-rules feature
// produces *on purpose*. Nested too deep, an unrecognised folder, an empty
// file, and an agent's one inert reason — no prompt body — all report
// category: 'misconfigured'. Branching on that field, rather than the prose,
// means rewording a reason can never silently change which bucket it lands
// in.
function splitInert(items) {
  const list = items || [];
  return {
    design: list.filter((i) => i.category === 'other-language'),
    broken: list.filter((i) => i.category !== 'other-language'),
  };
}

/** One row of something that sat on disk and never loaded. */
function inertRow(i, bad) {
  return '<div class="check' + (bad ? ' check-bad' : ' check-dim') + '">' +
    '<span class="check-mark">' + (bad ? '✗' : '–') + '</span>' +
    '<div class="list-row-grow">' +
      '<div class="check-name">' + esc(i.rel) +
        ' <span class="issue-path">' + esc(i.scope || '') + '</span></div>' +
      '<div class="check-detail">' + esc(i.reason) + '</div>' +
    '</div></div>';
}

/**
 * What is sitting on disk doing nothing, told apart by why. A genuine
 * misconfiguration — nested too deep, an unrecognised folder, an empty file,
 * an agent file with no prompt body — gets the doctor panel's and Skills'
 * own red: visible, un-collapsed, first, because it is worth acting on. A
 * rule written for a language this project is not is inert *by design* —
 * the whole point of layering rules by language, not a failure — so it does
 * not wear that red. It is named, counted, and collapsed behind a summary
 * instead: 55 of these should not out-shout the 22 rules actually in effect.
 */
function inertCard(items) {
  if (!items || items.length === 0) return '';
  const { design, broken } = splitInert(items);

  const problems = broken.length === 0 ? '' : ui.card('Not loaded',
    broken.map((i) => inertRow(i, true)).join(''),
    { aside: ui.badge(broken.length + ' not loaded', 'destructive', true) });

  if (design.length === 0) return problems;

  // Every design-bucket reason ends "…and this project reads as X" — the
  // same X for all of them — so it is worth saying once, not once per file.
  const reads = /reads as (.+)$/.exec(design[0].reason);
  const suffix = reads ? ' — this project reads as ' + reads[1] : '';

  const dormant = '<details class="dormant">' +
    '<summary class="dormant-summary">' +
      '<span>' + design.length + (design.length === 1 ? ' file' : ' files') +
        ' for another language' + suffix + '</span>' +
      icon('chevronRight', 14) +
    '</summary>' +
    '<div class="dormant-body">' + design.map((i) => inertRow(i, false)).join('') + '</div>' +
  '</details>';

  return problems + dormant;
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

  const { design, broken } = splitInert(d.inert);

  const summary = '<div class="section-actions mb">' +
    ui.badge(d.rules.length + ' in effect', 'secondary') +
    ui.badge('reads as ' + d.lang + (d.langPinned ? ' (pinned)' : ''), 'success', true) +
    (broken.length > 0 ? ui.badge(broken.length + ' not loaded', 'destructive', true) : '') +
    (design.length > 0 ? ui.badge(design.length + ' for another language', 'muted') : '') +
  '</div>';

  // Load order is override order, so it is the order shown. Sorting these
  // alphabetically would hide the one thing the list is for.
  const rows = d.rules.length === 0
    ? ui.empty('No rules load yet. Add one under common/ to shape every prompt.')
    : ui.list(d.rules.map((r, i) =>
        '<div class="list-row" role="listitem"><span class="order-mark">' + (i + 1) + '</span>' +
          '<div class="list-row-grow">' +
            '<div class="list-row-title">' + esc(r.name) + '</div>' +
            '<div class="list-row-detail">' + esc(r.path) + '</div>' +
          '</div>' +
          '<div class="section-actions">' +
            ui.badge(r.scope, r.scope === 'user' ? 'secondary' : 'outline') +
            ui.badge(r.layer, 'muted') +
          '</div></div>').join(''), 'Rules in load order');

  // In effect first — that is what the reader came for. What is inert
  // (broken, or just for a different language) follows, not the reverse.
  return header + summary +
    ui.card('In effect, in load order', rows,
      { aside: ui.badge(d.rules.length + ' loaded', 'secondary') }) +
    inertCard(d.inert) +
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
      // Wrapped the way app-skills.ts wraps its own scope lists: the button
      // keeps role="button" inside a role="listitem" element rather than
      // losing it, and the group gets announced as the list of N that it is.
      ui.list(inScope.map((a) => {
        // "page" is the ARIA token for the current item in a nav-like list;
        // an explicit "false" on every other row is noise a screen reader
        // has to sit through ten times to find the one that matters.
        const current = Boolean(state.agent && state.agent.name === a.name);
        return '<div role="listitem"><button class="skill-item" data-agent-open="' + esc(a.name) + '"' +
          (current ? ' aria-current="page"' : '') + '>' +
          '<span class="skill-item-name">' + esc(a.name) +
            (d.shadowed.includes(a.name) ? ' <span class="issue-path">replaces bundled</span>' : '') +
          '</span>' +
          '<span class="skill-item-desc">' + esc(a.description) + '</span>' +
        '</button></div>';
      }).join(''), scope + ' agents');
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

  // Available agents first — that is what the reader came for. Agents have
  // no "different language" bucket (a missing prompt body is always worth
  // fixing), so inertCard renders the same red "Not loaded" card as before,
  // just no longer ahead of the thing the page is actually for.
  return header + summary +
    '<div class="editor-grid"><div>' + list + '</div><div>' + agentDetailCard() + '</div></div>' +
    inertCard(d.inert);
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
