// The Settings page.
//
// It renders every field the schema knows about — 40 of them across 12 groups
// — and as one flat list that came to 5092px: five screens of scrolling with
// no way to reach a setting except by passing every other one. The schema is
// the right source; presenting all of it at once was the mistake.
//
// So the page is an index first and a form second. Groups are shut until
// asked for, which turns the wall into twelve rows you can read at a glance.
// Searching matches the label, the dotted path and the description, and opens
// whatever it hits. Two filters answer the questions people actually arrive
// with: what have I staged, and what is no longer at its default.
//
// Split out of app-core.ts because it outgrew it; concatenated into the same
// scope, so the event wiring in APP_VIEWS still reaches stageEdit and friends.

export const APP_SETTINGS = String.raw`
const SETTING_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changed', label: 'Staged' },
  { id: 'modified', label: 'Not default' },
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

/** Narrowing the set is itself an answer — an open group would hide it. */
function narrowing() {
  return Boolean((state.settingsQuery || '').trim()) || state.settingsFilter !== 'all';
}

function groupOpen(group, visibleCount) {
  if (narrowing()) return visibleCount > 0;
  return state.openGroups.has(group.group);
}

function settingsGroups() {
  if (!state.settings) return '';

  const rendered = state.settings.groups.map((group) => {
    const visible = group.fields.filter(fieldMatches);
    if (narrowing() && visible.length === 0) return '';

    const open = groupOpen(group, visible.length);
    const staged = group.fields.filter((f) => state.dirty.has(f.path)).length;
    const modified = group.fields.filter(isModified).length;

    return '<section class="group" data-open="' + open + '">' +
      '<button class="group-head" data-group="' + esc(group.group) + '" aria-expanded="' + open + '">' +
        '<span class="group-caret" aria-hidden="true">▸</span>' +
        '<span class="group-name">' + esc(group.group) + '</span>' +
        (staged > 0 ? ui.badge(staged + ' staged', 'destructive', true) : '') +
        (modified > 0 ? ui.badge(modified + ' set', 'secondary') : '') +
        '<span class="group-count">' +
          (narrowing() ? visible.length + ' of ' + group.fields.length : group.fields.length) +
        '</span>' +
      '</button>' +
      (open ? '<div class="group-body">' + visible.map(fieldRow).join('') + '</div>' : '') +
    '</section>';
  }).join('');

  return rendered || ui.empty('Nothing matches that.');
}

function viewSettings() {
  const header = ui.pageHeader('Settings',
    'Every field Asterisk understands, generated from its schema with its own bounds. ' +
    'Edits are staged until you apply them.');

  if (!state.settings) return header + '<section class="card">' + ui.skeletonRows(4) + '</section>';

  const total = state.settings.groups.reduce((n, g) => n + g.fields.length, 0);
  const toolbar = '<div class="toolbar">' +
    '<input class="input" type="search" id="settings-search" ' +
      'placeholder="Search ' + total + ' settings by name, key or description" ' +
      'value="' + esc(state.settingsQuery || '') + '" aria-label="Search settings">' +
    ui.tabs(SETTING_FILTERS, state.settingsFilter, 'settings-filter') +
    '<span class="toolbar-spacer"></span>' +
    ui.btn(state.openGroups.size > 0 ? 'Collapse all' : 'Expand all',
      { size: 'sm', variant: 'ghost', attrs: ' data-action="settings-toggle-all"' }) +
  '</div>';

  return header + toolbar +
    '<div class="settings-groups">' + settingsGroups() + '</div>' +
    '<div id="save-bar"></div>';
}

function fieldRow(field) {
  const staged = state.dirty.has(field.path);
  const value = staged ? state.dirty.get(field.path) : field.value;
  const id = 'f_' + field.path.replace(/\./g, '_');

  return '<div class="field' + (staged ? ' field-dirty' : '') + '" data-field="' + esc(field.path) + '">' +
    '<div><label class="label" for="' + esc(id) + '">' + esc(field.label) + '</label>' +
      (isModified(field) && !staged ? '<span class="field-mark" title="not the default"></span>' : '') +
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

/** Redraws only the group list, so the search box keeps focus and caret. */
function refreshSettingsGroups() {
  const host = $('.settings-groups');
  if (host) host.innerHTML = settingsGroups();
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
