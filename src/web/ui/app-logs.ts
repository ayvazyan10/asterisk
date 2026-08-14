// The log reader.
//
// The daemon logs through pino, so daemon.log is a file of JSON lines:
//   {"level":30,"time":"…","name":"asterisk-daemon","msg":"adapters started"}
// The panel used to print that verbatim into a <pre>. Every line was 60%
// punctuation, the level was a number, and finding an error meant reading
// them all.
//
// So each line is parsed and laid out: time, level, message, then whatever
// extra fields the record carried. Lines that are not JSON — a subprocess
// writing to the same stream — pass through as raw text rather than being
// dropped, because that output is often exactly what you came to read.
//
// Levels are pino's: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.

export const APP_LOGS = String.raw`
const LOG_LEVELS = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info+', min: 30 },
  { id: 'warn', label: 'Warn+', min: 40 },
  { id: 'error', label: 'Errors', min: 50 },
];

const LEVEL_NAMES = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

/** One raw line → a record the renderer can lay out. */
function parseLogLine(raw) {
  const text = raw.trimEnd();
  if (!text) return null;
  if (text[0] !== '{') return { raw: text, level: 0 };

  let rec;
  try { rec = JSON.parse(text); } catch { return { raw: text, level: 0 }; }
  if (!rec || typeof rec !== 'object') return { raw: text, level: 0 };

  // Everything that is not part of the envelope is context worth showing.
  const extra = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'level' || k === 'time' || k === 'msg' || k === 'name' || k === 'pid' || k === 'hostname') continue;
    extra[k] = v;
  }
  return {
    level: typeof rec.level === 'number' ? rec.level : 0,
    time: rec.time || '',
    msg: rec.msg || '',
    name: rec.name || '',
    extra,
  };
}

function logRecords() {
  return String(state.logText || '').split('\n').map(parseLogLine).filter(Boolean);
}

function visibleLogRecords() {
  const chosen = LOG_LEVELS.find((l) => l.id === state.logLevel);
  const min = chosen && chosen.min ? chosen.min : 0;
  const q = (state.logQuery || '').trim().toLowerCase();

  const kept = logRecords().filter((r) => {
    // An unparsable line has no level; a level filter would silently hide the
    // subprocess output people most often come here for.
    if (min > 0 && r.level > 0 && r.level < min) return false;
    if (!q) return true;
    return JSON.stringify(r).toLowerCase().includes(q);
  });

  // Reversed rather than sorted by time: the file is already in the order the
  // daemon wrote it, and a line with no parsable timestamp — subprocess output
  // — has nothing to sort on and would be flung to one end.
  return state.logOrder === 'newest' ? kept.reverse() : kept;
}

/** The order button, shared by both records so they cannot disagree. */
function logOrderButton() {
  const newest = state.logOrder === 'newest';
  return ui.btn(newest ? 'Newest first' : 'Oldest first', {
    size: 'sm', variant: 'outline',
    icon: newest ? 'sortDesc' : 'sortAsc',
    attrs: ' data-action="log-order" title="Switch to ' +
      (newest ? 'oldest' : 'newest') + ' first"',
  });
}

/**
 * The stamp column: date then time, both local.
 *
 * The date is on every line rather than on a separator when the day changes.
 * A separator is only visible if you can see it, and this pane is a scrolling
 * tail — the reader is usually somewhere in the middle of it. It is dimmed
 * instead, so the eye can run down the times and still know the day without
 * scrolling anywhere.
 *
 * An unparsable time still shows whatever the record carried, sliced at the
 * ISO offsets, because a wrong-looking timestamp is more use than none.
 */
function logStampHtml(iso) {
  const p = stampParts(iso);
  if (!p) {
    const fallback = String(iso || '');
    return '<span class="log-time">' + esc(fallback.slice(11, 19)) + '</span>';
  }
  return '<span class="log-time" title="' + esc(p.date + ' ' + p.time + '.' + p.millis) + '">' +
    '<span class="log-date">' + esc(p.date) + '</span> ' + esc(p.time) + '</span>';
}

function logLineHtml(r) {
  if (r.raw !== undefined) {
    return '<div class="log-line is-raw"><span class="log-time"></span>' +
      '<span class="log-level">·</span>' +
      '<span class="log-msg">' + esc(r.raw) + '</span></div>';
  }

  const name = LEVEL_NAMES[r.level] || '·';
  const tone = r.level >= 50 ? ' is-error' : r.level >= 40 ? ' is-warn' : '';
  const extra = Object.entries(r.extra)
    .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
    .join('  ');

  return '<div class="log-line' + tone + '">' +
    logStampHtml(r.time) +
    '<span class="log-level log-' + esc(name) + '">' + esc(name) + '</span>' +
    '<span class="log-msg">' + esc(r.msg) +
      (extra ? ' <span class="log-extra">' + esc(extra) + '</span>' : '') +
    '</span></div>';
}

function renderLogBody() {
  const records = visibleLogRecords();
  if (records.length === 0) {
    return ui.empty(state.logQuery || state.logLevel !== 'all'
      ? 'No lines match that.'
      : 'The log is empty.');
  }
  return '<div class="log">' + records.map(logLineHtml).join('') + '</div>';
}

/** Follow polls, because the panel has no socket back to the daemon. */
function setLogFollow(on) {
  state.logFollow = on;
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  if (!on) return;
  state.logTimer = setInterval(async () => {
    // Leaving the tab must not leave a timer hitting the daemon forever.
    if (state.tab !== 'logs' || state.logsTab !== 'daemon') { setLogFollow(false); render(); return; }
    await loadLogs();
    const host = $('.log-body');
    if (host) {
      host.innerHTML = renderLogBody();
      // Follow means "keep the newest line in view", and which end that is
      // depends on the order.
      const scroller = $('.log-scroll');
      if (scroller) scroller.scrollTop = state.logOrder === 'newest' ? 0 : scroller.scrollHeight;
    }
  }, 3000);
}

function daemonLogPanel() {
  const total = logRecords().length;
  const shown = visibleLogRecords().length;

  const toolbar = '<div class="toolbar toolbar-inset">' +
    '<input class="input" type="search" id="log-search" placeholder="Search the log" ' +
      'value="' + esc(state.logQuery || '') + '" aria-label="Search the log">' +
    ui.tabs(LOG_LEVELS, state.logLevel, 'log-level') +
    '<span class="toolbar-spacer"></span>' +
    '<span class="form-hint">' + shown + ' of ' + total + '</span>' +
    logOrderButton() +
    ui.btn(state.logFollow ? 'Following' : 'Follow', {
      size: 'sm',
      variant: state.logFollow ? 'default' : 'outline',
      attrs: ' data-action="log-follow"',
    }) +
  '</div>';

  return '<section class="card">' + toolbar +
    '<div class="log-scroll log-body">' + renderLogBody() + '</div></section>';
}
`;
