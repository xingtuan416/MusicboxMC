/**
 * Preview geometry, kept free of the DOM so it can be tested directly.
 *
 * The preview is a **viewport**: the canvas is only ever as large as the panel, and the
 * zoom factor alone decides how big a cell is. Nothing is solved against a canvas
 * budget any more, which is what used to cap long songs at two or three pixels per cell
 * and put everything past Chromium's dimension limit out of reach.
 *
 * The detailed cell art has two levels. Its parts used to be sized with
 * `Math.max(minimum, CELL * fraction)` alone, and the minimums were picked for the
 * default 38 px cell, so at 8-24 px a 22 px delay badge and two terminal dots 8 px in
 * from either edge were drawn on top of their neighbours. The sizes below are the same
 * formulas, clamped so no part can exceed the cell it belongs to.
 */

export const BASE_CELL = 38;
/** Width of the left gutter, which shows the Z row and its track. */
export const GUTTER = 150;
/** Height of the top ruler (X is the time axis). */
export const RULER = 28;

/**
 * Zoom bounds, in cell pixels.
 *
 * The low end stays countable rather than becoming a smear; the high end is where a
 * cell stops being worth looking at closely.
 */
export const MIN_CELL = 4;
export const MAX_CELL = 72;

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

/** The cell size a zoom factor actually renders at. */
export function cellForScale(previewScale) {
  return Math.min(MAX_CELL, Math.max(MIN_CELL, BASE_CELL * previewScale));
}

/** Cell size back to a zoom factor, for the label. */
export function scaleForCell(cell) {
  return cell / BASE_CELL;
}

/** Level of detail for one zoom factor. */
export function viewGeometry({ previewScale }) {
  const cell = cellForScale(previewScale);
  return {
    cell,
    renderScale: cell / BASE_CELL,
    detail: cell >= DETAIL_MIN_CELL,
    /** Cells need a hairline between them to stay countable, but not when tiny. */
    gap: cell >= 4 ? 1 : 0,
  };
}

/** How many whole cells fit beside the gutter and below the ruler. */
export function visibleCells({ viewportWidth, viewportHeight, cell }) {
  return {
    cols: Math.max(1, Math.floor((viewportWidth - GUTTER) / cell)),
    rows: Math.max(1, Math.floor((viewportHeight - RULER) / cell)),
  };
}

/**
 * Keep the view inside the grid.
 *
 * The limit leaves a whole viewport of cells on screen, so a grid shorter than the
 * viewport cannot be scrolled at all and stays showing its first row. Allowing the
 * offset up to the last cell instead let zooming a short song push the view to the
 * bottom, showing one row and a lot of empty space.
 */
export function clampView({ x, z }, view, { cols, rows }) {
  const limitX = Math.max(0, Math.ceil(x) - Math.max(1, cols));
  const limitZ = Math.max(0, Math.ceil(z) - Math.max(1, rows));
  return {
    x0: Math.min(Math.max(0, Math.round(view.x0)), limitX),
    z0: Math.min(Math.max(0, Math.round(view.z0)), limitZ),
  };
}

/**
 * Largest cell that still shows the whole grid in the given space.
 *
 * On a very long song even this lands on MIN_CELL, so "fit" shows as much as stays
 * legible and leaves the rest to panning - more honest than shrinking every cell past
 * the point of being countable.
 */
export function fitCell({ x, z, availableWidth, availableHeight }) {
  const width = Math.max(1, availableWidth - GUTTER);
  const height = Math.max(1, availableHeight - RULER);
  const raw = Math.min(width / Math.max(1, x), height / Math.max(1, z));
  return Math.min(MAX_CELL, Math.max(MIN_CELL, raw));
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
