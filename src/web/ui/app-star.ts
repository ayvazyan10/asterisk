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
    '<div class="sky-foot">' +
      '<span class="form-hint">Change the order or the models in Settings.</span>' +
      ui.btn('Backend settings', { size: 'sm', variant: 'ghost', attrs: ' data-tab="settings"' }) +
    '</div>' +
  '</section>';
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
