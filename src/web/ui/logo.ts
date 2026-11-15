// The Asterisk emblem.
//
// Six teardrop arms around an open centre, alternating long and short. The
// teardrop is the old typographic asterisk — a footnote mark cut in metal — and
// the alternating lengths are what make it a star rather than a flower:
// asteriskos is Greek for "little star", and a star twinkles unevenly. The
// arms stop short of the centre so a small hexagon of nothing sits in the
// middle; at 16px that closes up and the mark simply reads as `*`.
//
// Geometry, on a 64-unit square, optically centred at (32, 35) because the
// long arms point up:
//   long  arms at  90° / 330° / 210° — head radius 6.6 at distance 23
//   short arms at  30° / 270° / 150° — head radius 5.4 at distance 18
//   every tip stops 3 units from the centre
// Each arm is a circle with two tangents to its tip, so the path is exact
// rather than eyeballed. assets/logo.svg carries the same path; the test in
// tests/web-ui.test.ts keeps the two in step.

export const MARK_PATH =
  'M32 32L38.23 14.18A6.6 6.6 0 1 0 25.77 14.18Z' +
  'M34.6 36.5L46.92 50.81A6.6 6.6 0 1 0 53.15 40.02Z' +
  'M29.4 36.5L10.85 40.02A6.6 6.6 0 1 0 17.08 50.81Z' +
  'M34.6 33.5L48.42 31.33A5.4 5.4 0 1 0 43.39 22.61Z' +
  'M32 38L26.96 51.06A5.4 5.4 0 1 0 37.04 51.06Z' +
  'M29.4 33.5L20.61 22.61A5.4 5.4 0 1 0 15.58 31.33Z';

/**
 * The mark as inline SVG for the page itself. It fills with currentColor, so
 * the rail and the gate decide its colour through CSS rather than an
 * attribute — the CSP forbids style="…" and a hard-coded fill would ignore
 * the theme.
 */
export function markSvg(className: string): string {
  return (
    `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">` +
    `<path fill="currentColor" d="${MARK_PATH}"/></svg>`
  );
}

/**
 * The favicon: the mark in starlight on a night tile. A data URI rather than a
 * served file, so the page stays a single request — `img-src 'self' data:`
 * already allows it.
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#1b2150"/>' +
  '<path fill="#f2c45a" transform="translate(5 5) scale(0.84375)" d="MARK"/></svg>';

export const FAVICON = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG.replace('MARK', MARK_PATH))}`;
