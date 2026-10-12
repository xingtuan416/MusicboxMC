/**
 * Preview geometry, kept free of the DOM so it can be tested directly.
 *
 * The preview has two levels of detail. The detailed one draws each cell as a small
 * piece of art: a tile with a border, a shadow, terminals, a delay badge and, for
 * note blocks, a stem, a note head and a timbre stripe. Every one of those parts used
 * to be sized with `Math.max(minimum, CELL * fraction)`, and the minimums were picked
 * for the default cell of 38 px.
 *
 * That is fine at full size and fine at 1-2 px, where the renderer falls back to flat
 * fills. In between it is not: a 22 px wide delay badge on a 14 px cell, or two
 * terminal dots 8 px in from either edge of a 14 px cell, are drawn on top of their
 * neighbours. Long songs land in exactly that band, because the canvas budget caps
 * the cell size - a 2000 x 16 circuit gets a 15 px cell and turns into a smear of
 * overlapping badges.
 *
 * So the sizes below are the same formulas, clamped so that no part can ever exceed
 * the cell it belongs to, and the detailed level is only used once the cell is big
 * enough for it to be legible.
 */

export const BASE_CELL = 38;
/** Width of the left gutter, which shows the Z row and its track. */
export const GUTTER = 150;
/** Height of the top ruler (X is the time axis). */
export const RULER = 28;
/** Chromium caps canvas dimensions, so leave headroom for long songs. */
export const MAX_CANVAS_PIXELS = 30000;
export const MAX_CANVAS_AREA = 16000000;
/** Narrowest CSS width the preview canvas may be compressed to. */
export const MIN_CANVAS_CSS_WIDTH = 640;

/**
 * Below this cell size the tile art cannot be drawn without its parts overrunning the
 * cell, so the preview switches to flat fills.
 *
 * The binding constraint is the repeater's delay badge, which is 22 px wide by
 * default: 24 leaves it a little room inside its own cell.
 */
export const DETAIL_MIN_CELL = 24;

/** Below this the delay badge's label is too small to read, so only the badge is drawn. */
export const BADGE_MIN_CELL = 26;

/** Keep a value inside the cell it is drawn in. */
function fit(value, cell, maxFraction) {
  return Math.min(value, cell * maxFraction);
}

/**
 * Canvas size and level of detail for one preview.
 *
 * `cell` is in CSS pixels; the caller multiplies by the device pixel ratio.
 */
export function previewGeometry({ x, z, dpr, previewScale }) {
  const cols = Math.max(1, x);
  const rows = Math.max(1, z);
  const maxCssWidth = Math.max(MIN_CANVAS_CSS_WIDTH, MAX_CANVAS_PIXELS / Math.max(1, dpr));
  const dimensionCell = Math.min((maxCssWidth - GUTTER) / cols, (maxCssWidth - RULER) / rows);

  // Include the fixed headers in the area budget, not just the circuit rectangle.
  const cssArea = MAX_CANVAS_AREA / (dpr * dpr);
  const budget = Math.max(1, cssArea - GUTTER * RULER);
  const areaB = GUTTER * rows + RULER * cols;
  const areaCell = (2 * budget) / (areaB + Math.sqrt(areaB * areaB + 4 * cols * rows * budget));

  const cell = Math.min(BASE_CELL * previewScale, dimensionCell, areaCell);
  return {
    cell,
    renderScale: cell / BASE_CELL,
    width: GUTTER + x * cell,
    height: RULER + z * cell,
    /** Detailed tile art, or flat fills. */
    detail: cell >= DETAIL_MIN_CELL,
    /** Cells need a hairline between them to stay countable, but not when tiny. */
    gap: cell >= 4 ? 1 : 0,
  };
}

/** Sizes for redstone dust: a connector line with a node at each cell. */
export function dustSizes(cell, branches) {
  const nodeRadius = fit(Math.max(3.5, cell * (branches ? 0.11 : 0.09)), cell, 0.35);
  return {
    stroke: fit(Math.max(3, cell * 0.12), cell, 0.5),
    nodeRadius,
    haloRadius: fit(nodeRadius + 2, cell, 0.5),
  };
}

/** Sizes for one repeater: a tile with two terminals, an arrow and a delay badge. */
export function repeaterSizes(cell) {
  const inset = fit(Math.max(3, cell * 0.09), cell, 0.25);
  const badgeHeight = fit(Math.max(14, cell * 0.34), cell, 0.45);
  return {
    inset,
    radius: fit(Math.max(4, cell * 0.12), (cell - inset * 2) / 2, 1),
    terminalOffset: fit(Math.max(8, cell * 0.19), cell, 0.4),
    terminalRadius: fit(Math.max(3, cell * 0.08), cell, 0.12),
    centerStroke: fit(Math.max(2, cell * 0.055), cell, 0.2),
    badgeWidth: fit(Math.max(22, cell * 0.62), cell, 0.9),
    badgeHeight,
    badgeRadius: badgeHeight / 2,
    badgeFont: fit(Math.max(9, cell * 0.22), cell, 0.3),
    /** Only worth drawing once the label can be read. */
    showBadge: cell >= BADGE_MIN_CELL,
  };
}

/** Sizes for one note block: tile, grain, note glyph and timbre stripe. */
export function noteBlockSizes(cell) {
  const inset = fit(Math.max(3, cell * 0.08), cell, 0.25);
  const stripeHeight = fit(Math.max(7, cell * 0.18), cell, 0.35);
  return {
    inset,
    radius: fit(Math.max(4, cell * 0.12), (cell - inset * 2) / 2, 1),
    stem: fit(Math.max(9, cell * 0.3), cell, 0.6),
    stemWidth: fit(Math.max(2, cell * 0.07), cell, 0.15),
    head: fit(Math.max(4, cell * 0.13), cell, 0.2),
    headOffset: fit(Math.max(7, cell * 0.22), cell, 0.3),
    grain: fit(Math.max(2, cell * 0.07), cell, 0.1),
    grainInset: fit(Math.max(4, cell * 0.13), cell, 0.3),
    stripeHeight,
    stripeRadius: fit(Math.max(2, cell * 0.06), stripeHeight / 2, 1),
    stripeInset: fit(3, cell, 0.08),
  };
}
