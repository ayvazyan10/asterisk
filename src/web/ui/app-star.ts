// The system figure: the asterisk drawn from live state. Styles live in
// ./star.ts; this is the markup and the readings behind it.
//
// Concatenated after APP_CORE and before APP_VIEWS, sharing their scope.
// viewOverview calls systemFigure() from APP_CORE — fine, because function
// declarations hoist across the concatenated script and nothing runs until
// the whole thing has been evaluated.
//
// Geometry is a table rather than trigonometry: six fixed spokes at 60°
// intervals on a 620×400 field centred at (310, 200), inner radius 52, outer
// 132. Written out because it never changes, and a table is easier to check
// against the picture than a loop of sin and cos.

export const APP_STAR = String.raw`
// hx/hy/hw/hh is the click target. A bare <g> of a hairline and two <text>
// nodes is almost impossible to hit — the gaps between them are not part of
// the element, so a pointer lands on the SVG behind it. Each spoke therefore
// carries an invisible rect over its label block and a fat invisible line over
// its stroke. Found by trying to click one.
const SPOKE_GEOMETRY = {
  90:  { x1: 310, y1: 148, x2: 310, y2: 68,  lx: 310, ly: 30,  vy: 48,  anchor: 'middle',
         hx: 230, hy: 12,  hw: 160, hh: 64 },
  30:  { x1: 355, y1: 174, x2: 424, y2: 134, lx: 438, ly: 128, vy: 146, anchor: 'start',
         hx: 392, hy: 110, hw: 194, hh: 54 },
  330: { x1: 355, y1: 226, x2: 424, y2: 266, lx: 438, ly: 260, vy: 278, anchor: 'start',
         hx: 392, hy: 242, hw: 194, hh: 54 },
  270: { x1: 310, y1: 252, x2: 310, y2: 332, lx: 310, ly: 360, vy: 378, anchor: 'middle',
         hx: 230, hy: 320, hw: 160, hh: 70 },
  210: { x1: 265, y1: 226, x2: 196, y2: 266, lx: 182, ly: 260, vy: 278, anchor: 'end',
         hx: 34,  hy: 242, hw: 194, hh: 54 },
  150: { x1: 265, y1: 174, x2: 196, y2: 134, lx: 182, ly: 128, vy: 146, anchor: 'end',
         hx: 34,  hy: 110, hw: 194, hh: 54 },
};

function clip(value, max) {
  const s = String(value == null ? '—' : value);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * The six readings, in spoke order. Tone follows the palette's rule:
 * 'live' is happening now, 'rest' is configured and sitting there, 'off' is
 * nothing at all.
 */
function systemSpokes() {
  const s = state.status;
  const running = s.daemon.running;
  const c = s.counts;

  const enabledTone = (on, all) => (on > 0 ? 'live' : all > 0 ? 'rest' : 'off');
  const files = (kind) => { const e = contentEntry(kind); return e ? e.files.length : null; };
  const fileTone = (n) => (n === null ? 'off' : n > 0 ? 'rest' : 'off');

  return [
    { angle: 90, label: 'provider', value: clip(s.provider, 16),
      tone: running ? 'live' : 'rest', tab: 'settings',
      title: 'Provider: ' + s.provider },
    { angle: 30, label: 'mcp', value: c.enabledMcpServers + '/' + c.mcpServers,
      tone: enabledTone(c.enabledMcpServers, c.mcpServers), tab: 'mcp',
      title: c.enabledMcpServers + ' of ' + c.mcpServers + ' MCP servers enabled' },
    { angle: 330, label: 'hooks', value: c.enabledHooks + '/' + c.hooks,
      tone: enabledTone(c.enabledHooks, c.hooks), tab: 'hooks',
      title: c.enabledHooks + ' of ' + c.hooks + ' hooks enabled' },
    { angle: 270, label: 'telegram', value: s.bots.telegram ? 'on' : 'off',
      tone: s.bots.telegram ? 'live' : 'off', tab: 'settings',
      title: 'Telegram bridge ' + (s.bots.telegram ? 'enabled' : 'disabled') },
    // Skills report what resolved, not what is on disk — most are bundled and
    // have no file, and an invalid file is not a skill.
    { angle: 210, label: 'skills', value: clip(kindCount('skills'), 6),
      tone: fileTone(kindCount('skills')), tab: 'skills',
      title: (kindCount('skills') === null ? 'no' : kindCount('skills')) + ' skills resolved' },
    { angle: 150, label: 'rules', value: clip(files('rules'), 6),
      tone: fileTone(files('rules')), tab: 'rules',
      title: (files('rules') === null ? 'no' : files('rules')) + ' rule files' },
  ];
}

function spokeSvg(spoke) {
  const g = SPOKE_GEOMETRY[spoke.angle];
  return '<g class="spoke is-' + spoke.tone + '" data-tab="' + esc(spoke.tab) +
    '" role="link" tabindex="0" aria-label="' + esc(spoke.title) + '">' +
    '<line class="spoke-line" x1="' + g.x1 + '" y1="' + g.y1 + '" x2="' + g.x2 + '" y2="' + g.y2 + '"/>' +
    '<circle class="spoke-node" cx="' + g.x2 + '" cy="' + g.y2 + '" r="4"/>' +
    '<line class="spoke-hit" x1="' + g.x1 + '" y1="' + g.y1 + '" x2="' + g.x2 + '" y2="' + g.y2 + '"/>' +
    '<rect class="spoke-hit" x="' + g.hx + '" y="' + g.hy + '" width="' + g.hw + '" height="' + g.hh + '"/>' +
    '<text class="spoke-label" x="' + g.lx + '" y="' + g.ly + '" text-anchor="' + g.anchor + '">' +
      esc(spoke.label) + '</text>' +
    '<text class="spoke-value" x="' + g.lx + '" y="' + g.vy + '" text-anchor="' + g.anchor + '">' +
      esc(spoke.value) + '</text>' +
  '</g>';
}

function systemFigure() {
  const s = state.status;
  const spokes = systemSpokes();
  const running = s.daemon.running;

  const svg = '<svg class="system-figure ' + (running ? 'hub-live' : '') +
    '" viewBox="0 0 620 400" role="group" aria-label="System overview">' +
    spokes.map(spokeSvg).join('') +
    '<circle class="hub-pulse" cx="310" cy="200" r="46"/>' +
    '<circle class="hub-face" cx="310" cy="200" r="46"/>' +
    '<circle class="hub-ring" cx="310" cy="200" r="46"/>' +
    '<text class="hub-label" x="310" y="192">agent</text>' +
    '<text class="hub-state" x="310" y="214">' + (running ? 'live' : 'idle') + '</text>' +
  '</svg>';

  // Same six readings for narrow screens, where the figure's labels would
  // shrink past legibility. Only one of the two is ever displayed.
  const tiles = '<div class="system-tiles">' + spokes.map((sp) =>
    '<button class="system-tile is-' + sp.tone + '" data-tab="' + esc(sp.tab) +
      '" aria-label="' + esc(sp.title) + '">' +
      '<span class="silk">' + esc(sp.label) + '</span>' +
      '<span class="tile-value">' + esc(sp.value) + '</span>' +
    '</button>').join('') + '</div>';

  return '<section class="system">' +
    '<div class="system-caption">' +
      '<span class="silk">system</span>' +
      ui.stateBadge(running, 'daemon live', 'daemon idle') +
    '</div>' + svg + tiles +
  '</section>';
}
`;
