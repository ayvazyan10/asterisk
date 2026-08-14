// The Settings page.
//
// Two rewrites now, and the second one is a correction of the first.
//
// It began as one flat list of all 40 fields — 5092px, five screens, no way to
// reach a setting except by passing every other one. The fix was an accordion:
// twelve groups, all shut. That traded a wall of settings for a page that shows
// no settings at all, where every answer costs a click and the reader cannot
// tell from the landing state whether they are in the right place.
//
// Neither problem was the list. It was the row: label, dotted path and
// description stacked into 92px, with the control stranded across a 580px gap,
// so six fields filled a screen and forty needed five. A row half that tall,
// with the control in a real column, puts the whole schema in about 1600px —
// which is a page you scroll, not a page you excavate.
//
// So: nothing is hidden. Every field is on the page under a sticky section
// heading, with an index down the left that says where you are and jumps you
// where you want. Search and the two filters narrow the same list rather than
// opening things.
//
// One rule that removed a lot of noise: a control shows Reset only when it is
// off its default. That was 40 identical "Default" buttons, most of them
// no-ops, and it also collapses three vocabularies for one fact — a badge
// reading "1 set", a 5px dot, and the word "default" — into a single visible
// signal. A field with a Reset is a field you changed.
//
// Split out of app-core.ts because it outgrew it; concatenated into the same
// scope, so the event wiring in APP_VIEWS still reaches stageEdit and friends.

export const APP_SETTINGS = String.raw`
const SETTING_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changed', label: 'Staged' },
  { id: 'modified', label: 'Changed from default' },
];

/** A field the user has moved off the schema default. */
function isModified(field) {
  if (field.default === undefined) return false;
  return JSON.stringify(field.value) !== JSON.stringify(field.default);
}

function fieldMatches(field) {
  if (state.settingsFilter === 'changed' && !state.dirty.has(field.path)) return false;
  if (state.settingsFilter === 'modified' && !isModified(field)) return false;

  const q = (state.settingsQuery || '').trim().toLowerCase();
  if (!q) return true;
  return field.label.toLowerCase().includes(q) ||
    field.path.toLowerCase().includes(q) ||
    (field.description || '').toLowerCase().includes(q);
}

function narrowing() {
  return Boolean((state.settingsQuery || '').trim()) || state.settingsFilter !== 'all';
}

/** Groups paired with the fields currently passing the filter. */
function visibleGroups() {
  if (!state.settings) return [];
  return state.settings.groups
    .map((group) => ({ group, fields: group.fields.filter(fieldMatches) }))
    .filter((g) => g.fields.length > 0);
}

/**
 * The index — where you are and where you can go.
 *
 * It replaces the accordion's only real job. The accordion answered "jump to a
 * section" by hiding the other eleven; this answers it without hiding anything,
 * and it doubles as a table of contents, which a shut accordion is not.
 */
function settingsIndex(groups) {
  const rows = groups.map((g) => {
    const staged = g.group.fields.filter((f) => state.dirty.has(f.path)).length;
    return '<button class="toc-item" data-jump="' + esc(g.group.group) + '" ' +
      'aria-current="' + (state.settingsSection === g.group.group) + '">' +
      '<span class="toc-label">' + esc(g.group.label || g.group.group) + '</span>' +
      (staged > 0
        ? '<span class="toc-staged" title="' + staged + ' staged">' + staged + '</span>'
        : '<span class="toc-count">' + g.fields.length + '</span>') +
      '</button>';
  }).join('');
  return '<nav class="toc" aria-label="Settings sections">' + rows + '</nav>';
}

function settingsSections(groups) {
  if (groups.length === 0) return ui.empty('Nothing matches that.');
  return groups.map((g) =>
    '<section class="settings-section" id="set_' + esc(g.group.group) + '">' +
      '<header class="settings-section-head">' +
        '<h2 class="settings-section-name">' + esc(g.group.label || g.group.group) + '</h2>' +
        '<span class="settings-section-count">' +
          (narrowing() ? g.fields.length + ' of ' + g.group.fields.length : g.fields.length) +
        '</span>' +
      '</header>' +
      g.fields.map(fieldRow).join('') +
    '</section>'
  ).join('');
}

function viewSettings() {
  const header = ui.pageHeader('Settings',
    'Every field Asterisk understands, generated from its schema with its own bounds. ' +
    'Edits are staged until you apply them.');

  if (!state.settings) return header + '<section class="card">' + ui.skeletonRows(4) + '</section>';

  const total = state.settings.groups.reduce((n, g) => n + g.fields.length, 0);
  const staged = state.dirty.size;
  const changed = state.settings.groups
    .reduce((n, g) => n + g.fields.filter(isModified).length, 0);

  const toolbar = '<div class="toolbar">' +
    '<input class="input" type="search" id="settings-search" ' +
      'placeholder="Search ' + total + ' settings by name, key or description" ' +
      'value="' + esc(state.settingsQuery || '') + '" aria-label="Search settings">' +
    ui.tabs(SETTING_FILTERS, state.settingsFilter, 'settings-filter') +
    '<span class="toolbar-spacer"></span>' +
    '<span class="form-hint">' + changed + ' of ' + total + ' changed from default' +
      (staged > 0 ? ' · ' + staged + ' staged' : '') + '</span>' +
  '</div>';

  const groups = visibleGroups();
  return header + toolbar +
    '<div class="settings-layout">' +
      settingsIndex(groups) +
      '<div class="settings-body">' + settingsSections(groups) + '</div>' +
    '</div>' +
    '<div id="save-bar"></div>';
}

/**
 * One field: name and key on the left, control in a column on the right.
 *
 * The dotted path stays — it is the key you would use from the CLI or the API,
 * and this page is where you look it up — but it sits beside the label rather
 * than on a line of its own.
 */
function fieldRow(field) {
  const staged = state.dirty.has(field.path);
  const value = staged ? state.dirty.get(field.path) : field.value;
  const id = 'f_' + field.path.replace(/\./g, '_');
  const modified = isModified(field);

  return '<div class="field' + (staged ? ' field-dirty' : '') + '" data-field="' + esc(field.path) + '">' +
    '<div class="field-text">' +
      '<label class="field-name" for="' + esc(id) + '">' + esc(field.label) + '</label>' +
      '<code class="field-path">' + esc(field.path) + '</code>' +
      (field.description ? '<div class="field-help">' + esc(field.description) + '</div>' : '') +
    '</div>' +
    '<div class="field-control">' + control(field, value, id) +
      // Only where there is something to undo. Forty always-on Default buttons
      // were the loudest thing on the page and usually did nothing.
      (staged
        ? ui.btn('Revert', { size: 'sm', variant: 'ghost', attrs: ' data-revert="' + esc(field.path) + '"' })
        : modified
          ? ui.btn('Reset', { size: 'sm', variant: 'ghost', attrs: ' data-reset="' + esc(field.path) + '"' })
          : '') +
    '</div></div>';
}

function control(field, value, id) {
  if (field.kind === 'boolean') {
    // role="switch" pairs with aria-checked, not aria-pressed — the latter
    // belongs to toggle buttons and reads wrong to a screen reader here.
    // Wrapped: the control column is a two-cell grid, and an unwrapped label
    // landed in the reset button's cell at the far right of the row.
    return '<span class="switch-cell">' +
      '<button class="switch" id="' + esc(id) + '" role="switch" data-toggle="' +
      esc(field.path) + '" aria-checked="' + (value === true) + '" aria-label="' +
      esc(field.label) + '"></button>' +
      '<span class="switch-state">' + (value === true ? 'on' : 'off') + '</span>' +
      '</span>';
  }
  if (field.kind === 'enum') {
    return '<select class="select" id="' + esc(id) + '" data-input="' + esc(field.path) + '">' +
      field.options.map((opt) =>
        '<option value="' + esc(opt) + '"' + (opt === value ? ' selected' : '') + '>' + esc(opt) + '</option>'
      ).join('') + '</select>';
  }
  if (field.kind === 'number') {
    return '<input class="input" type="number" id="' + esc(id) + '" data-input="' + esc(field.path) + '"' +
      (field.min !== undefined ? ' min="' + field.min + '"' : '') +
      (field.max !== undefined ? ' max="' + field.max + '"' : '') +
      (field.integer ? ' step="1"' : '') +
      ' value="' + esc(value) + '">';
  }
  if (field.kind === 'number-array' || field.kind === 'string-array') {
    return '<input class="input" type="text" id="' + esc(id) + '" data-input="' + esc(field.path) + '"' +
      ' placeholder="comma separated" value="' + esc((value || []).join(', ')) + '">';
  }
  return '<input class="input" type="text" id="' + esc(id) + '" data-input="' +
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
    '<span class="save-bar-count">' + state.dirty.size + ' change' +
      (state.dirty.size === 1 ? '' : 's') + ' staged</span>' +
    ui.btn('Discard', { variant: 'ghost', attrs: ' data-action="discard"' }) +
    ui.btn('Apply', { variant: 'default', attrs: ' data-action="apply"' }) +
  '</div>';
}

/** Redraws only the list, so the search box keeps focus and caret. */
function refreshSettingsGroups() {
  const groups = visibleGroups();
  const body = $('.settings-body');
  const toc = $('.toc');
  if (body) body.innerHTML = settingsSections(groups);
  if (toc) toc.outerHTML = settingsIndex(groups);
  watchSettingsSections();
}

function jumpToSection(group) {
  const target = $('#set_' + CSS.escape(group));
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Keeps the index in step with the scroll position.
 *
 * Without it the index answers "where can I go" but not "where am I", which on
 * a page this long is the half people actually use. The observer is rebuilt on
 * every redraw and the old one disconnected — a stale observer holding removed
 * nodes would keep firing and fight the new one for the current section.
 */
let settingsObserver = null;

function watchSettingsSections() {
  if (settingsObserver) settingsObserver.disconnect();
  const sections = document.querySelectorAll('.settings-section');
  if (sections.length === 0) return;

  settingsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.id.replace(/^set_/, '');
      if (id === state.settingsSection) continue;
      state.settingsSection = id;
      for (const item of document.querySelectorAll('.toc-item')) {
        item.setAttribute('aria-current', String(item.dataset.jump === id));
      }
    }
    // rootMargin pulls the trigger line just under the sticky bar, so the
    // section marked current is the one whose heading is at the top of the
    // reading area rather than one that is technically still on screen.
  }, { rootMargin: '-60px 0px -75% 0px', threshold: 0 });

  for (const section of sections) settingsObserver.observe(section);
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
