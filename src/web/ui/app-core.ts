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
  // { id, kind: 'client' | 'token' } while a connector is being set up by hand.
  connectorSetup: null,
  hooks: [],
  secrets: [],
  content: [],
  tokens: [],
  audit: [],
  logText: '',
  doctor: null,
  editor: { kind: null, path: null, content: '', original: '' },
  loaded: new Set(),

  // Settings shows everything and hides nothing — see ./app-settings.ts.
  // settingsSection is the group the index marks as current, kept in step with
  // the scroll position rather than set by clicking.
  settingsQuery: '',
  settingsFilter: 'all',
  settingsSection: '',

  // The log reader parses pino's JSON lines rather than printing them.
  // logOrder applies to both records: the file arrives oldest-first and the
  // audit query newest-first, and disagreeing with each other was the bug.
  logsTab: 'daemon',
  credentialsTab: 'secrets',
  logOrder: localStorage.getItem('asterisk-log-order') === 'oldest' ? 'oldest' : 'newest',
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

  // The rail collapses to icons. A preference, so it is restored from
  // localStorage before the first render rather than reset on every reload.
  railTight: localStorage.getItem('asterisk-rail') === 'tight',
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
  return stamp(ms).slice(0, 10);
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A wall-clock timestamp split into its parts, in local time.
 *
 * ISO order for the date rather than toLocaleDateString: a log is read for
 * ordering, and 08/09 means two different days depending on where the reader
 * is. The time is local because that is the clock the reader was watching when
 * the thing happened — the daemon writes UTC, and converting is the point.
 *
 * Takes epoch milliseconds or an ISO string; returns null for anything that is
 * neither, so callers can fall back rather than print "Invalid Date".
 */
function stampParts(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
    time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()),
    millis: String(d.getMilliseconds()).padStart(3, '0'),
  };
}

/** 2026-08-14 12:34:56, or an empty string when the value is not a time. */
function stamp(value) {
  const p = stampParts(value);
  return p ? p.date + ' ' + p.time : '';
}

/**
 * One icon from ./icons.ts, as the <svg> Lucide's own components emit.
 *
 * aria-hidden because every icon here sits beside a label that already says
 * the thing; a screen reader announcing "plug, Connectors" is worse than
 * "Connectors". The stroke width is the one lever — 1.5 resting, 2 for the
 * current page — which is how the reference marks the active row.
 */
function icon(name, size, stroke) {
  const node = ICONS[name];
  if (!node) return '';
  const body = node.map(([tag, attrs]) => '<' + tag + ' ' +
    Object.entries(attrs).map(([k, v]) => k + '="' + esc(v) + '"').join(' ') + '/>').join('');
  return '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="' + (size || 15) +
    '" height="' + (size || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="' + (stroke || 1.5) + '" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' + body + '</svg>';
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

  // The label is wrapped even when there is no icon: the collapsed rail hides
  // labels by hiding that span, and a bare text node cannot be addressed.
  btn(label, opts) {
    const o = opts || {};
    return '<button class="btn btn-' + (o.variant || 'outline') +
      (o.size ? ' btn-' + o.size : '') + (o.square ? ' btn-icon' : '') + '"' +
      (o.attrs || '') + (o.disabled ? ' disabled' : '') + '>' +
      (o.icon ? icon(o.icon, o.size === 'sm' ? 13 : 14) : '') +
      (label ? '<span>' + esc(label) + '</span>' : '') +
      '</button>';
  },

  // h2: the page itself carries the h1 (see pageHeader below), so every card
  // heading nests one level under it. Kept in lock-step with pageHeader's
  // level — bump one and the other must follow, or the outline gets a gap.
  card(title, body, opts) {
    const o = opts || {};
    const aside = o.aside === undefined || o.aside === null ? '' : o.aside;
    return '<section class="card' + (o.divided === false ? '' : ' card-divided') + '">' +
      '<header class="card-header"><h2 class="card-title">' + esc(title) + '</h2>' + aside + '</header>' +
      body + '</section>';
  },

  // The title is markup — callers compose it from esc() and badges — while
  // the detail is text and is escaped here. The asymmetry is deliberate but
  // easy to get wrong: anything user-supplied in the title must be escaped by
  // the caller, and the detail must not be, or it double-escapes.
  //
  // Not itself list markup — most callers use this for a handful of unlike
  // facts about one thing (the Overview cards: "Background process",
  // "Telegram bridge"), which is not a collection, so the default omits
  // role="listitem". Pass listItem: true when the row is one member of a
  // genuine repeated collection — pair it with ui.list() around the
  // concatenated rows. Off by default rather than always-on: a listitem role
  // with no list ancestor is exactly the "wrap things that are not a list"
  // mistake the shared helper should not default into for every one of its
  // callers, several of which use it for unlike facts, not collections.
  listRow(title, detail, actions, leading, listItem) {
    return '<div class="list-row"' + (listItem ? ' role="listitem"' : '') + '>' + (leading || '') +
      '<div class="list-row-grow"><div class="list-row-title">' + title + '</div>' +
      (detail ? '<div class="list-row-detail">' + esc(detail) + '</div>' : '') + '</div>' +
      (actions ? '<div class="section-actions">' + actions + '</div>' : '') +
    '</div>';
  },

  // Wraps a genuine repeated collection (rows built by listRow, or any other
  // same-shaped items) so a screen reader announces it as a list with a
  // count, and offers list navigation, instead of an unannounced stack of
  // divs. Deliberately not a real <ul>/<li>: that would need a list-style/
  // margin reset this stylesheet does not carry, and adding one is out of
  // scope here (see CLAUDE.md on styles.ts ownership) — role="list" gets the
  // same announcement without touching layout. No wrapping class, so it has
  // no footprint of its own; the rows inside keep their existing classes and
  // spacing untouched.
  list(rowsHtml, label) {
    return '<div role="list"' + (label ? ' aria-label="' + esc(label) + '"' : '') + '>' + rowsHtml + '</div>';
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
  //
  // h1: this, not the "Asterisk" brand in the rail, is the page's top
  // heading. The brand is chrome that sits beside every view unchanged; the
  // page title is the one heading that actually describes what is on screen,
  // and every view calls pageHeader exactly once, at the top of what it
  // returns, so this is the only h1 the authenticated app ever renders. A
  // static "Asterisk" h1 would instead sit there for the life of the page
  // while the content underneath it changes on every tab switch — the thing
  // a screen-reader user jumps to first would never describe what they
  // landed on. The brand stays a plain <div> (index.ts) on purpose. Keep
  // ui.card's h2 one level under this — see the note there.
  pageHeader(title, description, subject) {
    return '<header class="page-header"><h1 class="page-title">' + esc(title) +
      (subject ? '<span class="page-subject">' + esc(subject) + '</span>' : '') + '</h1>' +
      '<p class="page-description">' + description + '</p></header>';
  },
};

// The .toasts host (index.ts) carries role="status"/aria-live="polite" as
// the container-level default. A failure is not routine status, though —
// it is the one thing a screen-reader user needs interrupted for, and the
// 8s the bad case stays on screen (versus 3.5s for good) does nothing for
// someone who was not already looking at the corner of the screen when it
// appeared. Marking the individual node role="alert" (implicitly assertive)
// makes an error interrupt and get announced on its own, nested inside the
// polite container; success/info nodes keep an explicit role="status" too,
// so the announcement priority travels with the node that actually knows
// its own kind rather than relying on the container alone.
function toast(message, kind, detail) {
  const host = $('.toasts');
  const node = document.createElement('div');
  const bad = kind === 'bad';
  node.className = 'toast ' + (bad ? 'toast-error' : kind === 'good' ? 'toast-success' : '');
  node.setAttribute('role', bad ? 'alert' : 'status');
  node.setAttribute('aria-live', bad ? 'assertive' : 'polite');
  node.innerHTML = '<div class="toast-title">' + esc(message) + '</div>' +
    (detail ? '<div class="toast-detail">' + esc(detail) + '</div>' : '');
  host.appendChild(node);
  setTimeout(() => node.remove(), bad ? 8000 : 3500);
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
  { id: 'rules', label: 'Rules', icon: 'rules' },
  { id: 'skills', label: 'Skills', icon: 'skills' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'souls', label: 'Souls', icon: 'souls' },
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
    { id: 'overview', label: 'Overview', icon: 'overview' },
    { id: 'logs', label: 'Logs', icon: 'logs' },
  ]},
  { group: 'Configure', items: [
    { id: 'settings', label: 'Settings', icon: 'settings' },
    // Same shape as its neighbours: read from the /status payload so the
    // badge exists on first paint, rather than only after the tab has been
    // opened once and populated state.connectors.
    { id: 'connectors', label: 'Connectors', icon: 'connectors',
      count: () => state.status && state.status.counts.connectedConnectors },
    { id: 'mcp', label: 'MCP servers', icon: 'mcp', count: () => state.status && state.status.counts.mcpServers },
    { id: 'hooks', label: 'Hooks', icon: 'hooks', count: () => state.status && state.status.counts.hooks },
  ]},
  { group: 'Author', items: CONTENT_KINDS.map((k) => ({
    id: k.id,
    label: k.label,
    icon: k.icon,
    count: () => kindCount(k.id),
  })) },
  { group: 'Access', items: [
    // No count: the page holds two unlike things, and a single number beside
    // it would be read as whichever one the reader had in mind.
    { id: 'credentials', label: 'Credentials', icon: 'secrets' },
  ]},
];

/** Flat, for anything that needs a tab by id — the breadcrumb, mostly. */
function findTab(id) {
  for (const section of TABS) {
    const hit = section.items.find((t) => t.id === id);
    if (hit) return hit;
  }
  return null;
}

function renderSidebar() {
  $('.shell').dataset.rail = state.railTight ? 'tight' : 'wide';

  $('.nav').innerHTML = TABS.map((section) => (
    '<div class="nav-group">' + esc(section.group) + '</div>' +
    section.items.map((tab) => {
      const count = tab.count ? tab.count() : null;
      const current = state.tab === tab.id;
      // The label is the accessible name when it is hidden by the collapsed
      // rail, so title carries it and the icon stays aria-hidden.
      //
      // aria-current is only present on the current item, never written as
      // the string "false" on the other nine — an attribute a screen reader
      // has to explain the absence of is worse than no attribute at all.
      // The value is "page", WAI-ARIA's own token for the current page in a
      // navigation landmark. styles.ts keys every one of these highlights off
      // the attribute's PRESENCE ([aria-current]) rather than its value, so
      // the token can be the semantically right one without the active-row
      // styling depending on which word it is — the arrangement that made an
      // earlier attempt at this migration risk dropping the highlight.
      return '<button class="nav-item" data-tab="' + esc(tab.id) + '"' +
        (current ? ' aria-current="page"' : '') +
        ' title="' + esc(tab.label) + '">' +
        icon(tab.icon, 15, current ? 2 : 1.5) +
        '<span class="nav-label">' + esc(tab.label) + '</span>' +
        (count === null || count === undefined ? '' : '<span class="nav-count">' + count + '</span>') +
        '</button>';
    }).join('')
  )).join('');

  $('.rail-foot').innerHTML = ui.btn('Collapse', {
    size: 'sm', variant: 'ghost',
    attrs: ' data-action="rail" title="' + (state.railTight ? 'Expand' : 'Collapse') + '"',
    icon: state.railTight ? 'chevronRight' : 'chevronLeft',
  });

  const s = state.status;
  $('.brand-meta').textContent = s ? 'v' + s.version : '';
}

/** ok / warn / bad, from the one thing the header has room to report. */
function healthOf(s) {
  if (!s || !s.daemon) return { state: 'warn', label: 'Unknown' };
  if (s.daemon.running) return { state: 'ok', label: 'Daemon running' };
  return { state: 'bad', label: 'Daemon stopped' };
}

/**
 * The header chip's three honest states — see resolveStatusModel() in
 * src/web/api/system.ts. 'detected' is what the server just reported;
 * 'configured' is a pin the server has not confirmed (always true for
 * Anthropic, which has no detection endpoint); null is neither.
 */
function modelChip(model) {
  if (!model) {
    return { label: 'no model detected', title: 'No model detected — the server may be unreachable, and none is pinned in Settings.' };
  }
  if (model.source === 'detected') {
    return { label: model.id, title: 'Detected from the running server: ' + model.id };
  }
  return { label: model.id + ' (pinned)', title: 'Configured in Settings, not confirmed by a live server: ' + model.id };
}

function renderHeader() {
  const s = state.status;
  if (!s) return;
  const tab = findTab(state.tab);
  const health = healthOf(s);
  const chip = modelChip(s.model);
  $('.header').innerHTML =
    '<nav class="crumbs" aria-label="Breadcrumb">' +
      '<span class="crumb-root">Asterisk</span>' +
      '<span class="crumb-sep">' + icon('chevronRight', 12) + '</span>' +
      '<span class="crumb-leaf">' + esc(tab ? tab.label : state.tab) + '</span>' +
    '</nav>' +
    '<div class="header-spacer"></div>' +
    '<div class="status-pill" data-state="' + health.state + '" title="' + esc(health.label) + '">' +
      '<span class="status-dot"></span>' +
      '<span class="status-value" title="' + esc(chip.title) + '">' + esc(chip.label) + '</span>' +
    '</div>' +
    '<div class="header-actions">' +
      ui.btn('', { variant: 'outline', size: 'sm', square: true,
        attrs: ' data-action="theme" title="Switch theme" aria-label="Switch theme"',
        icon: 'sun' }) +
      ui.btn('', { variant: 'outline', size: 'sm', square: true,
        attrs: ' data-action="refresh" title="Reload data" aria-label="Reload data"',
        icon: 'refresh' }) +
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
