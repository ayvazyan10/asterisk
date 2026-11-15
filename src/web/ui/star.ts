// The signature: the backends that answer, drawn as a constellation on a
// chart. Markup and readings are in ./app-star.ts.
//
// One star per backend, joined by a dashed line in the order they are tried.
// The one answering right now is the only gold on the page apart from the
// emblem, and the only thing that moves: a slow halo that says the reading is
// live rather than a snapshot. Everything else on the chart is ink.
//
// Wide: stars in a row, the line running between them. Narrow: stars down
// the left edge, the line running down beneath each one, so the order still
// reads top to bottom without shrinking anything.

export const STAR = String.raw`
.sky {
  --star-size: 2.75rem;
  --chain-gap: 2.5rem;
  position: relative;
  border: 1px solid var(--border); border-radius: var(--r-xl);
  background-color: var(--surface);
  overflow: hidden;
  isolation: isolate;
}

/* The chart's graticule: a faint coordinate grid, fading out downwards so it
   sits behind the stars and never behind the controls. */
.sky::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  background-image:
    linear-gradient(color-mix(in oklch, var(--border) 70%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in oklch, var(--border) 70%, transparent) 1px, transparent 1px);
  background-size: 44px 44px;
  background-position: -1px -1px;
  mask-image: linear-gradient(to bottom, black, transparent 70%);
  -webkit-mask-image: linear-gradient(to bottom, black, transparent 70%);
}

.chain {
  list-style: none; margin: 0; padding: 1.75rem 1.75rem 1.5rem;
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: var(--chain-gap);
}
.chain:not(.chain-many) { grid-auto-columns: minmax(0, 34rem); }

.chain-node { position: relative; min-width: 0; }

/* The constellation line, from this star to the next one. */
.chain-node:not(:last-child)::after {
  content: ""; position: absolute;
  top: calc(var(--star-size) / 2);
  left: calc(var(--star-size) + 0.75rem);
  right: calc(-1 * var(--chain-gap) + 0.75rem);
  border-top: 1.5px dashed var(--border-strong);
}

.chain-star {
  position: relative;
  width: var(--star-size); height: var(--star-size);
  display: grid; place-items: center;
  color: var(--border-strong);
}
.chain-mark { width: 100%; height: 100%; display: block; }
.chain-mark path { transition: fill var(--dur) var(--ease); }

/* A star that is not answering is drawn in outline, as a chart marks a star
   below naked-eye brightness. */
.chain-node:not(.is-live) .chain-mark path {
  fill: none; stroke: currentColor; stroke-width: 2.25; stroke-linejoin: round;
}
.chain-node.is-ready .chain-star { color: var(--ink-dim); }

.chain-node.is-live .chain-star { color: var(--star); }
.chain-node.is-live .chain-star::before {
  content: ""; position: absolute; inset: -55%; z-index: -1; border-radius: 50%;
  background: radial-gradient(closest-side, var(--star-wash), transparent);
  animation: halo 4.8s var(--ease) infinite;
}

@keyframes halo {
  0%, 100% { opacity: 0.55; transform: scale(0.9); }
  50%      { opacity: 1;    transform: scale(1.05); }
}

.chain-body { margin-top: 1rem; min-width: 0; }

.chain-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
.chain-role { font-size: var(--t-xs); font-weight: 500; color: var(--ink-faint); }

.chain-name {
  margin-top: 0.4rem;
  font-family: var(--font-display); font-size: var(--t-xl); font-weight: 600;
  letter-spacing: -0.01em; line-height: 1.2; color: var(--ink);
}
.chain-node.is-off .chain-name { color: var(--ink-dim); }

.chain-model {
  display: block; margin-top: 0.2rem;
  font-family: var(--font-machine); font-size: var(--t-sm);
  color: var(--ink); overflow-wrap: anywhere;
}
.chain-model-none { font-family: var(--font-human); color: var(--ink-faint); }
.chain-detail { margin-top: 0.15rem; font-size: var(--t-xs); color: var(--ink-faint); }

.chain-reasoning {
  margin-top: 1.1rem;
  display: flex; flex-direction: column; align-items: flex-start; gap: 0.4rem;
}
.chain-note { margin-top: 1.1rem; font-size: var(--t-xs); color: var(--ink-faint); }

.sky-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.6rem 1rem 0.6rem 1.75rem;
  border-top: 1px solid var(--border);
  background: color-mix(in oklch, var(--surface-high) 60%, transparent);
}

/* --- narrow: the constellation turns on its side --------------------------- */

@media (max-width: 820px) {
  .sky { --star-size: 2.25rem; --chain-gap: 1.75rem; }
  .chain, .chain:not(.chain-many) {
    grid-auto-flow: row; grid-auto-columns: auto; padding: 1.25rem 1rem 1.25rem;
  }
  .chain-node {
    display: grid; grid-template-columns: var(--star-size) minmax(0, 1fr); column-gap: 0.9rem;
  }
  .chain-node:not(:last-child)::after {
    top: calc(var(--star-size) + 0.5rem);
    bottom: calc(-1 * var(--chain-gap) + 0.5rem);
    left: calc(var(--star-size) / 2); right: auto;
    border-top: 0; border-left: 1.5px dashed var(--border-strong);
  }
  .chain-body { margin-top: 0; }
  .sky-foot { padding-left: 1rem; }
  /* The levels share the column evenly instead of wrapping onto a second
     line, which read as two separate controls. */
  .chain-reasoning, .chain-reasoning .tabs-list { align-self: stretch; }
  .chain-reasoning .tabs-list {
    display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  }
  .chain-reasoning .tabs-trigger { min-width: 0; padding: 0 0.2rem; }
}

@media (prefers-reduced-motion: reduce) {
  .chain-node.is-live .chain-star::before { animation: none; opacity: 0.8; }
}
`;
