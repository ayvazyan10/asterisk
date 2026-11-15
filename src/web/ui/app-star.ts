// The signature element: who is answering, drawn as a constellation.
//
// Asterisk tries its backends in order — the primary, then each fallback — and
// uses the first one that answers. That chain is the most important fact on
// the panel, so the home page draws it the way a star chart draws a
// constellation: one star per backend, joined in the order they are tried. The
// star that is answering right now is lit in starlight; the others are
// outlines. Under each star sits the one control people change day to day —
// how hard that backend reasons.
//
// Styles live in ./star.ts. Concatenated after APP_CORE and before APP_VIEWS,
// sharing their scope; function declarations hoist, so viewOverview can call
// answeringChain() before this module appears in the source.
//
// The reasoning control is generated from the settings registry, not written
// out here: the levels are whatever `<backend>.reasoningEffort` allows in the
// schema, and a build without that setting simply shows no control.

import { MARK_PATH } from './logo.ts';

export const APP_STAR = String.raw`
const MARK_PATH = '${MARK_PATH}';

/** The emblem, inline, filled with currentColor so CSS decides the colour. */
function markSvg(className) {
  return '<svg class="' + className + '" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="' + MARK_PATH + '"/></svg>';
}

/** provider kind -> the settings group that configures it. */
const BACKEND_GROUP = {
  'openai-compatible': 'openaiCompatible',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
};

/** What a person calls each backend. A local server is "the local model". */
function backendName(entry) {
  if (entry.provider === 'deepseek') return 'DeepSeek';
  if (entry.provider === 'anthropic') return 'Anthropic';
  return /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(entry.endpoint || '')
    ? 'Local model'
    : 'OpenAI-compatible server';
}

/** The words for each reasoning level. Unknown values fall through as-is. */
const REASONING_WORDS = {
  default: 'Default', off: 'Off', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'Extra high', max: 'Max',
};

/** The /status chain, or a one-entry chain built from older payloads. */
function chainOf(s) {
  if (Array.isArray(s.chain) && s.chain.length > 0) return s.chain;
  return [{ provider: s.provider, model: s.model, ready: Boolean(s.model) }];
}

/** Index of the backend that will answer: the first one that is ready. */
function answeringIndex(chain) {
  return chain.findIndex((entry) => entry.ready);
}

/** The home page's h1: one sentence that says who answers. */
function answeringHeadline(chain) {
  const at = answeringIndex(chain);
  if (at === -1) return 'Nothing can answer right now';
  const name = backendName(chain[at]);
  const subject = name === 'Local model' ? 'The local model' : name;
  return subject + ' is answering';
}

function answeringSummary(chain) {
  const at = answeringIndex(chain);
  if (at === -1) {
    return 'None of the backends below is reachable. Start the local server or add an API key in Credentials.';
  }
  if (at > 0) {
    const first = backendName(chain[0]);
    return esc(first === 'Local model' ? 'The local model' : first) +
      ' is unreachable, so Asterisk has fallen back to the next one in line.';
  }
  return chain.length > 1
    ? 'Asterisk asks these in order and uses the first one that answers.'
    : 'Every chat, bot message and scheduled task goes to this backend.';
}

/** The reasoning control for one backend, or a quiet line when there is none. */
function reasoningControl(entry, name) {
  const group = BACKEND_GROUP[entry.provider];
  const path = group + '.reasoningEffort';
  if (!state.settings) {
    return '<div class="skeleton skeleton-line w60"></div>';
  }
  const field = findField(path);
  if (!field || field.kind !== 'enum') {
    return '<p class="chain-note">This build has no reasoning setting for ' + esc(name) + '.</p>';
  }
  const current = field.value === undefined ? field.default : field.value;
  const labelId = 'reason-' + esc(group);
  return '<div class="chain-reasoning">' +
    '<span class="silk" id="' + labelId + '">Reasoning</span>' +
    '<div class="tabs-list" role="radiogroup" aria-labelledby="' + labelId + '">' +
      field.options.map((opt) =>
        '<button class="tabs-trigger" role="radio" aria-checked="' + (opt === current) + '"' +
          ' data-reasoning="' + esc(path) + '|' + esc(opt) + '"' +
          (state.reasoningBusy === path ? ' disabled' : '') + '>' +
          esc(REASONING_WORDS[opt] || opt) + '</button>'
      ).join('') +
    '</div>' +
  '</div>';
}

/** The line under the model id: where it runs, or what is stopping it. */
function chainDetail(entry) {
  if (!entry.ready) return entry.reason || 'Not reachable';
  if (entry.endpoint) {
    return 'Served at ' + entry.endpoint +
      (entry.contextWindow ? ', ' + entry.contextWindow.toLocaleString('en-US') + '-token context' : '');
  }
  return 'API key set';
}

function chainNode(entry, i, answering) {
  const name = backendName(entry);
  const live = i === answering;
  const tone = live ? 'is-live' : entry.ready ? 'is-ready' : 'is-off';
  const role = i === 0 ? 'First choice' : 'Fallback ' + i;
  const status = live
    ? ui.badge('Answering now', 'live', true)
    : entry.ready
      ? ui.badge('Standing by', 'secondary', true)
      : ui.badge(entry.provider === 'openai-compatible' ? 'Unreachable' : 'No API key', 'muted', true);
  const model = entry.model
    ? '<code class="chain-model" title="' + esc(chip(entry.model)) + '">' + esc(entry.model.id) + '</code>'
    : '<span class="chain-model chain-model-none">No model detected</span>';

  return '<li class="chain-node ' + tone + '">' +
    '<div class="chain-star">' + markSvg('chain-mark') + '</div>' +
    '<div class="chain-body">' +
      '<div class="chain-meta"><span class="chain-role">' + role + '</span>' + status + '</div>' +
      '<h2 class="chain-name">' + esc(name) + '</h2>' +
      model +
      '<p class="chain-detail">' + esc(chainDetail(entry)) + '</p>' +
      reasoningControl(entry, name) +
    '</div>' +
  '</li>';
}

/** modelChip's title, reused so a model id says how it was learnt. */
function chip(model) {
  return modelChip(model).title;
}

/** The hero: every backend in the order it is tried. */
function answeringChain() {
  const chain = chainOf(state.status);
  const answering = answeringIndex(chain);
  return '<section class="sky" aria-label="Backends, in the order Asterisk tries them">' +
    '<ol class="chain' + (chain.length > 1 ? ' chain-many' : '') + '">' +
      chain.map((entry, i) => chainNode(entry, i, answering)).join('') +
    '</ol>' +
    (state.chainDraft ? chainEditor(state.chainDraft) : skyFoot()) +
  '</section>';
}

/** Under the chart: the way into the editor. The daemon re-reads the chain
 *  before each message, so a saved order needs no restart. */
function skyFoot() {
  return '<div class="sky-foot">' +
    '<span class="form-hint">Models and endpoints are in Settings.</span>' +
    '<div class="sky-foot-actions">' +
      ui.btn('Backend settings', { size: 'sm', variant: 'ghost', attrs: ' data-tab="settings"' }) +
      ui.btn('Edit order', { size: 'sm', attrs: ' data-chain="edit"' }) +
    '</div>' +
  '</div>';
}

// --- editing the chain ------------------------------------------------------
//
// A draft of provider kinds, first choice first, staged in state.chainDraft and
// written in one PATCH /settings as provider + providerFallback — the
// same path, and the same schema validation, as every other setting. Buttons,
// not dragging: each move is one keypress, and focus follows the backend that
// moved. The first choice has no Remove; it is replaced by moving another
// backend above it, so the chain can never be empty.

/** Every backend Asterisk can talk to, in the order Add offers them. */
const ALL_BACKENDS = Object.keys(BACKEND_GROUP);

/** One edit to a draft chain, returning a new array; the draft is never mutated. */
function editChain(chain, verb, kind) {
  const at = chain.indexOf(kind);
  if (verb === 'add') return at === -1 ? chain.concat(kind) : chain;
  if (verb === 'remove') return at > 0 ? chain.filter((k) => k !== kind) : chain;
  const to = verb === 'up' ? at - 1 : verb === 'down' ? at + 1 : -1;
  if (at === -1 || to < 0 || to >= chain.length) return chain;
  return chain.map((k, i) => (i === at ? chain[to] : i === to ? kind : k));
}

/** A backend's name from its kind, for one that may not be in the chain yet. */
function kindName(kind) {
  const known = chainOf(state.status).find((e) => e.provider === kind);
  if (known) return backendName(known);
  let endpoint = '';
  const base = kind === 'openai-compatible' && state.settings ? findField('openaiCompatible.baseUrl') : null;
  try { endpoint = base ? new URL(base.value ?? base.default).host : ''; } catch { endpoint = ''; }
  return backendName({ provider: kind, endpoint });
}

function chainEditRow(kind, i, draft) {
  const name = esc(kindName(kind));
  const last = i === draft.length - 1;
  const busy = state.chainBusy;
  const move = (dir, off) => ui.btn('', {
    size: 'sm', variant: 'ghost', square: true, icon: dir === 'up' ? 'chevronUp' : 'chevronDown',
    disabled: off || busy,
    attrs: ' data-chain="' + dir + ':' + esc(kind) + '" aria-label="Move ' + name + ' ' + dir + '"' +
      ' title="Move ' + dir + '"',
  });
  return '<li class="chain-edit-row' + (i === 0 ? ' is-first' : '') + '">' +
    markSvg('chain-edit-mark') +
    '<div class="chain-edit-text">' +
      '<span class="chain-role">' + (i === 0 ? 'First choice' : 'Fallback ' + i) + '</span>' +
      '<span class="chain-edit-name">' + name + '</span>' +
    '</div>' +
    '<div class="chain-edit-actions">' +
      move('up', i === 0) + move('down', last) +
      (i === 0
        ? '<span class="chain-edit-spacer" aria-hidden="true"></span>'
        : ui.btn('', {
            size: 'sm', variant: 'ghost', square: true, icon: 'x', disabled: busy,
            attrs: ' data-chain="remove:' + esc(kind) + '" aria-label="Remove ' + name + ' from the chain"' +
              ' title="Remove"',
          })) +
    '</div>' +
  '</li>';
}

function chainEditor(draft) {
  const missing = ALL_BACKENDS.filter((k) => !draft.includes(k));
  const saved = chainOf(state.status).map((e) => e.provider);
  const unchanged = saved.join() === draft.join();
  return '<div class="chain-editor" role="group" aria-labelledby="chain-edit-title">' +
    '<h2 class="chain-edit-title" id="chain-edit-title" tabindex="-1">Order of backends</h2>' +
    '<p class="form-hint">Asterisk asks the first choice, then each fallback in turn. ' +
      'To replace the first choice, move another backend above it.</p>' +
    '<ol class="chain-edit-list">' + draft.map(chainEditRow).join('') + '</ol>' +
    (missing.length > 0
      ? '<div class="chain-edit-add"><span class="chain-role">Not in the chain</span>' +
          missing.map((k) => ui.btn('Add ' + kindName(k), {
            size: 'sm', icon: 'plus', disabled: state.chainBusy, attrs: ' data-chain="add:' + esc(k) + '"',
          })).join('') +
        '</div>'
      : '') +
    '<div class="chain-edit-foot">' +
      '<span class="form-hint">The daemon uses the new order from its next message.</span>' +
      '<div class="sky-foot-actions">' +
        ui.btn('Cancel', { size: 'sm', variant: 'ghost', attrs: ' data-chain="cancel"' }) +
        ui.btn(state.chainBusy ? 'Saving…' : 'Save order', {
          size: 'sm', variant: 'default', disabled: unchanged || state.chainBusy, attrs: ' data-chain="save"',
        }) +
      '</div>' +
    '</div>' +
  '</div>';
}

/** Focuses the first selector that matches an enabled element. */
function focusFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && !el.disabled) { el.focus(); return; }
  }
}

/** data-chain="verb" or "verb:kind" from the hero's buttons. */
async function chainAction(action) {
  const [verb, kind] = action.split(':');
  if (verb === 'edit') {
    state.chainDraft = chainOf(state.status).map((e) => e.provider);
    render();
    return focusFirst(['#chain-edit-title']);
  }
  if (verb === 'cancel') {
    state.chainDraft = null;
    render();
    return focusFirst(['[data-chain="edit"]']);
  }
  if (verb === 'save') return saveChain();
  if (!state.chainDraft) return;
  state.chainDraft = editChain(state.chainDraft, verb, kind);
  render();
  const at = (v) => '[data-chain="' + v + ':' + kind + '"]';
  const next = {
    up: [at('up'), at('down')],
    down: [at('down'), at('up')],
    add: [at('remove'), at('up')],
    remove: ['[data-chain^="add:"]', '#chain-edit-title'],
  };
  focusFirst(next[verb] || ['#chain-edit-title']);
}

/**
 * Writes the draft: the first entry becomes provider, the rest
 * providerFallback. One request, so the server validates and applies both
 * or neither.
 */
async function saveChain() {
  const draft = state.chainDraft;
  if (!draft || draft.length === 0) return;
  state.chainBusy = true;
  render();
  const ok = await guard(() => api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ updates: { provider: draft[0], providerFallback: draft.slice(1) } }),
  }));
  state.chainBusy = false;
  if (ok) {
    state.chainDraft = null;
    state.dirty.delete('provider');
    toast('Backend order saved', 'good');
    await Promise.all([loadStatus(), loadSettings()]);
  }
  render();
  focusFirst(ok ? ['[data-chain="edit"]'] : ['[data-chain="save"]']);
}

/**
 * Writes one reasoning level straight away. It goes through the same
 * PATCH /settings the Settings page applies its staged edits with, so the
 * server validates it against the schema exactly as it would there.
 */
async function setReasoning(path, value) {
  const field = findField(path);
  if (!field) return;
  state.reasoningBusy = path;
  render();
  const ok = await guard(() => api('/settings', {
    method: 'PATCH', body: JSON.stringify({ updates: { [path]: value } }),
  }));
  state.reasoningBusy = '';
  if (ok) {
    state.dirty.delete(path);
    toast('Reasoning set to ' + (REASONING_WORDS[value] || value).toLowerCase(), 'good');
    await loadSettings();
  }
  render();
}
`;
