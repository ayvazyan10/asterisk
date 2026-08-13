// The signature element: the asterisk, drawn from live state.
//
// Asterisk's mark is a six-pointed radial, and its architecture happens to be
// the same shape — one agent loop at the centre with six things wired to it:
// the provider, the tool set, the chat transports, the MCP servers, the hooks,
// and the store on disk. So the logogram is not decoration here, it is the
// system diagram, and a local-first agent is the rare case where the whole
// machine genuinely fits in one figure. A hosted dashboard could not draw this
// honestly; that is exactly why it belongs to this product.
//
// Each spoke carries real state and is a link to the section that owns it, so
// the figure is a control surface rather than an illustration — which is what
// earns it the space it takes. Colour follows the palette's rule: amber for
// live right now, teal for a quantity at rest, faint for absent.
//
// Below 820px the figure would shrink its labels past legibility, so it is
// swapped for a tile grid carrying the same six readings and the same links.
// Only one of the two is ever displayed, so only one is ever in the
// accessibility tree.

export const STAR = String.raw`
.system {
  position: relative;
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface);
  /* Top padding clears the caption band so the figure's uppermost label never
     collides with it, however narrow the column gets. */
  padding: 2.5rem 1rem 0.75rem;
  overflow: hidden;
}

/* An instrument label in the corner of the faceplate, not a card header. */
.system-caption {
  position: absolute; top: 0.9rem; left: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}

.system-figure { display: block; width: 100%; max-width: 41rem; margin: 0 auto; }

/* --- the spokes --------------------------------------------------------- */

.spoke { cursor: pointer; }

/* The click target. Transparent rather than unpainted, because an SVG shape
   with no paint is not hit-tested — which is what made the spokes look
   clickable and refuse to be clicked. */
.spoke-hit { fill: transparent; stroke: transparent; stroke-width: 18; }

.spoke-line { stroke-width: 1.5; fill: none; transition: stroke var(--dur) var(--ease); }
.spoke-node { transition: fill var(--dur) var(--ease), r var(--dur) var(--ease); }

.spoke-label {
  font-family: var(--font-machine); font-size: 10px;
  letter-spacing: var(--track-silk); text-transform: uppercase;
  fill: var(--ink-faint);
}
.spoke-value {
  font-family: var(--font-machine); font-size: 13px;
  fill: var(--ink); transition: fill var(--dur) var(--ease);
}

/* live right now */
.is-live .spoke-line { stroke: var(--signal); }
.is-live .spoke-node { fill: var(--signal); }
.is-live .spoke-value { fill: var(--signal); }

/* configured, at rest */
.is-rest .spoke-line { stroke: var(--tide); }
.is-rest .spoke-node { fill: var(--tide); }

/* nothing there */
.is-off .spoke-line { stroke: var(--border-strong); }
.is-off .spoke-node { fill: var(--border-strong); }
.is-off .spoke-value { fill: var(--ink-faint); }

.spoke:hover .spoke-line { stroke: var(--ink); }
.spoke:hover .spoke-value { fill: var(--ink); }
.spoke:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }

/* --- the hub ------------------------------------------------------------- */

.hub-ring { fill: none; stroke: var(--border-strong); stroke-width: 1; }
.hub-face { fill: var(--bg); }
.hub-label {
  font-family: var(--font-machine); font-size: 9px;
  letter-spacing: var(--track-silk); text-transform: uppercase;
  fill: var(--ink-faint); text-anchor: middle;
}
.hub-state {
  font-family: var(--font-machine); font-size: 15px;
  fill: var(--ink-faint); text-anchor: middle;
}

.hub-live .hub-ring { stroke: var(--signal); }
.hub-live .hub-state { fill: var(--signal); }

/* A slow breath while the daemon is up — the one moving thing on the page,
   and it says the reading is live rather than a snapshot. */
.hub-pulse { fill: none; stroke: var(--signal); stroke-width: 1; opacity: 0; }
.hub-live .hub-pulse { animation: breathe 3.2s var(--ease) infinite; }

@keyframes breathe {
  0%   { opacity: 0.5; transform: scale(1); }
  70%  { opacity: 0; transform: scale(1.28); }
  100% { opacity: 0; transform: scale(1.28); }
}

/* --- narrow fallback ------------------------------------------------------ */

.system-tiles { display: none; grid-template-columns: repeat(2, 1fr); gap: 1px; }

.system-tile {
  display: flex; flex-direction: column; gap: 0.15rem;
  padding: 0.7rem 0.25rem; border: 0; background: transparent;
  text-align: left; cursor: pointer; color: inherit;
  font-family: var(--font-human);
}
.system-tile:hover { background: var(--surface-high); }
.system-tile .tile-value {
  font-family: var(--font-machine); font-size: var(--t-sm); color: var(--ink);
}
.system-tile.is-live .tile-value { color: var(--signal); }
.system-tile.is-off .tile-value { color: var(--ink-faint); }

@media (max-width: 820px) {
  .system-figure { display: none; }
  .system-tiles { display: grid; }
  .system { padding-top: 2.5rem; }
}

@media (prefers-reduced-motion: reduce) {
  .hub-live .hub-pulse { animation: none; opacity: 0.35; }
}
`;
