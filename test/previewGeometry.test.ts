import { describe, expect, it } from 'vitest';
import {
  BASE_CELL,
  BADGE_MIN_CELL,
  DETAIL_MIN_CELL,
  MAX_CELL,
  MIN_CELL,
  TILE_SIZE,
  cellForScale,
  cellRangeForView,
  clampView,
  dustSizes,
  fitCell,
  noteBlockSizes,
  repeaterSizes,
  scaleForCell,
  tileCells,
  tilesForView,
  viewGeometry,
  visibleCells,
} from '../src/renderer/previewGeometry.js';

/**
 * Two properties keep the wiring view honest, and both are pinned here.
 *
 * First, the preview is a viewport: the zoom factor alone decides how big a cell is, so
 * a long song can be inspected cell by cell like a short one. It used to be solved
 * against a canvas budget, which pinned long songs at two or three pixels per cell.
 *
 * Second, no part of the cell art may exceed the cell. The parts are sized with
 * `Math.max(minimum, CELL * fraction)` and the minimums suit the default 38 px cell, so
 * in the middle of the range a 22 px delay badge used to be painted across its
 * neighbours.
 */
const CELLS = Array.from({ length: 96 }, (_, index) => index + 1);

describe('preview viewport', () => {
  it('renders the default zoom at the base cell size', () => {
    const geometry = viewGeometry({ previewScale: 1 });
    expect(geometry.cell).toBe(BASE_CELL);
    expect(geometry.renderScale).toBe(1);
    expect(geometry.detail).toBe(true);
  });

  it('keeps the cell inside the zoom bounds for any factor', () => {
    for (const factor of [0.001, 0.05, 0.5, 1, 3, 40, 1000]) {
      const cell = cellForScale(factor);
      expect(cell, `factor ${factor}`).toBeGreaterThanOrEqual(MIN_CELL);
      expect(cell, `factor ${factor}`).toBeLessThanOrEqual(MAX_CELL);
    }
  });

  it('round-trips cell size and scale', () => {
    for (const cell of [MIN_CELL, 12, BASE_CELL, MAX_CELL]) {
      expect(cellForScale(scaleForCell(cell))).toBeCloseTo(cell, 9);
    }
  });

  it('ties the level of detail to the cell size', () => {
    expect(viewGeometry({ previewScale: 1 }).detail).toBe(true);
    expect(viewGeometry({ previewScale: DETAIL_MIN_CELL / BASE_CELL }).detail).toBe(true);
    expect(viewGeometry({ previewScale: (DETAIL_MIN_CELL - 0.5) / BASE_CELL }).detail).toBe(false);
  });

  it('never makes fit shrink a long song below a countable cell', () => {
    // A 20,000-column song in a 1200 x 700 panel: fitting it all would need 0.05 px.
    const cell = fitCell({ x: 20000, z: 16, availableWidth: 1200, availableHeight: 700 });
    expect(cell).toBe(MIN_CELL);
    // A short song still fits comfortably.
    expect(fitCell({ x: 40, z: 10, availableWidth: 1200, availableHeight: 700 })).toBeGreaterThan(20);
  });

  it('fits whole cells into the viewport', () => {
    const { cols, rows } = visibleCells({ viewportWidth: 1200, viewportHeight: 700, cell: 38 });
    expect(cols).toBe(Math.floor((1200 - 150) / 38));
    expect(rows).toBe(Math.floor((700 - 28) / 38));
    // Even a tiny viewport reports at least one cell rather than nothing.
    expect(visibleCells({ viewportWidth: 10, viewportHeight: 10, cell: 38 }).cols).toBe(1);
  });

  it('keeps the view inside the grid', () => {
    const grid = { x: 100, z: 20 };
    const visible = { cols: 10, rows: 5 };
    expect(clampView(grid, { x0: -5, z0: -5 }, visible)).toEqual({ x0: 0, z0: 0 });
    expect(clampView(grid, { x0: 500, z0: 500 }, visible)).toEqual({ x0: 90, z0: 15 });
    // A fractional offset is kept: rounding it here is what made a drag shorter than half
    // a cell move nothing and a longer one jump a whole cell, on each axis separately.
    expect(clampView(grid, { x0: 12.4, z0: 3.6 }, visible)).toEqual({ x0: 12.4, z0: 3.6 });
    // A grid smaller than the viewport cannot be scrolled away from its first cell.
    expect(clampView({ x: 4, z: 2 }, { x0: 9, z0: 9 }, visible)).toEqual({ x0: 0, z0: 0 });
  });

  it('never lets a drawn part exceed its cell', () => {
    for (const cell of CELLS) {
      const dust = dustSizes(cell, false);
      const branching = dustSizes(cell, true);
      const repeater = repeaterSizes(cell);
      const note = noteBlockSizes(cell);

      expect(dust.nodeRadius * 2, `dust node at ${cell}`).toBeLessThanOrEqual(cell);
      expect(dust.haloRadius * 2, `dust halo at ${cell}`).toBeLessThanOrEqual(cell);
      expect(dust.stroke, `dust stroke at ${cell}`).toBeLessThanOrEqual(cell);
      expect(branching.nodeRadius * 2, `branch node at ${cell}`).toBeLessThanOrEqual(cell);

      expect(repeater.inset * 2, `repeater inset at ${cell}`).toBeLessThan(cell);
      expect(repeater.radius, `repeater radius at ${cell}`).toBeLessThanOrEqual(
        (cell - repeater.inset * 2) / 2,
      );
      expect(repeater.terminalOffset * 2, `terminals at ${cell}`).toBeLessThanOrEqual(cell);
      expect(repeater.terminalRadius * 2, `terminal dot at ${cell}`).toBeLessThanOrEqual(cell);
      expect(repeater.badgeWidth, `badge width at ${cell}`).toBeLessThanOrEqual(cell);
      expect(repeater.badgeHeight, `badge height at ${cell}`).toBeLessThanOrEqual(cell);
      expect(repeater.centerStroke, `arrow at ${cell}`).toBeLessThanOrEqual(cell);

      expect(note.inset * 2, `note inset at ${cell}`).toBeLessThan(cell);
      expect(note.radius, `note radius at ${cell}`).toBeLessThanOrEqual((cell - note.inset * 2) / 2);
      expect(note.stem, `stem at ${cell}`).toBeLessThanOrEqual(cell);
      expect(note.head * 2, `head at ${cell}`).toBeLessThanOrEqual(cell);
      expect(note.stemWidth, `stem width at ${cell}`).toBeLessThanOrEqual(cell);
      expect(note.grain, `grain at ${cell}`).toBeLessThanOrEqual(cell);
      expect(note.stripeHeight + note.inset * 2, `timbre stripe at ${cell}`).toBeLessThanOrEqual(cell);
    }
  });

  it('draws the delay badge only once its label can be read', () => {
    expect(repeaterSizes(DETAIL_MIN_CELL).showBadge).toBe(DETAIL_MIN_CELL >= BADGE_MIN_CELL);
    expect(repeaterSizes(BADGE_MIN_CELL).showBadge).toBe(true);
    expect(repeaterSizes(BADGE_MIN_CELL - 1).showBadge).toBe(false);
    expect(repeaterSizes(BADGE_MIN_CELL).badgeFont).toBeGreaterThanOrEqual(7);
  });

  it('keeps a fractional offset so a short drag still moves the picture', () => {
    const grid = { x: 200, z: 40 };
    const visible = { cols: 20, rows: 10 };
    const before = clampView(grid, { x0: 10, z0: 5 }, visible);
    const after = clampView(grid, { x0: 10 + 0.25, z0: 5 + 0.25 }, visible);
    expect(after.x0 - before.x0).toBeCloseTo(0.25, 9);
    expect(after.z0 - before.z0).toBeCloseTo(0.25, 9);
  });

  it('reproduces the original full-size numbers exactly', () => {
    const cell = BASE_CELL;

    const dust = dustSizes(cell, true);
    expect(dust.stroke).toBeCloseTo(Math.max(3, cell * 0.12), 9);
    expect(dust.nodeRadius).toBeCloseTo(Math.max(3.5, cell * 0.11), 9);
    expect(dust.haloRadius).toBeCloseTo(Math.max(3.5, cell * 0.11) + 2, 9);
    expect(dustSizes(cell, false).nodeRadius).toBeCloseTo(Math.max(3.5, cell * 0.09), 9);

    const repeater = repeaterSizes(cell);
    expect(repeater.inset).toBeCloseTo(Math.max(3, cell * 0.09), 9);
    expect(repeater.radius).toBeCloseTo(Math.max(4, cell * 0.12), 9);
    expect(repeater.terminalOffset).toBeCloseTo(Math.max(8, cell * 0.19), 9);
    expect(repeater.terminalRadius).toBeCloseTo(Math.max(3, cell * 0.08), 9);
    expect(repeater.centerStroke).toBeCloseTo(Math.max(2, cell * 0.055), 9);
    expect(repeater.badgeWidth).toBeCloseTo(Math.max(22, cell * 0.62), 9);
    expect(repeater.badgeHeight).toBeCloseTo(Math.max(14, cell * 0.34), 9);
    expect(repeater.badgeFont).toBeCloseTo(Math.max(9, cell * 0.22), 9);

    const note = noteBlockSizes(cell);
    expect(note.inset).toBeCloseTo(Math.max(3, cell * 0.08), 9);
    expect(note.radius).toBeCloseTo(Math.max(4, cell * 0.12), 9);
    expect(note.stem).toBeCloseTo(Math.max(9, cell * 0.3), 9);
    expect(note.stemWidth).toBeCloseTo(Math.max(2, cell * 0.07), 9);
    expect(note.head).toBeCloseTo(Math.max(4, cell * 0.13), 9);
    expect(note.headOffset).toBeCloseTo(Math.max(7, cell * 0.22), 9);
    expect(note.grain).toBeCloseTo(Math.max(2, cell * 0.07), 9);
    expect(note.grainInset).toBeCloseTo(Math.max(4, cell * 0.13), 9);
    expect(note.stripeHeight).toBeCloseTo(Math.max(7, cell * 0.18), 9);
    expect(note.stripeRadius).toBeCloseTo(Math.max(2, cell * 0.06), 9);
    expect(note.stripeInset).toBeCloseTo(3, 9);
  });
});

/**
 * The viewport is drawn by compositing cached tiles, so three things have to hold: the
 * tiles cover everything on screen, they are anchored to the cell grid rather than to the
 * viewport (otherwise a drag rebuilds every tile), and they never run past the grid.
 */
describe('cached tiles', () => {
  const grid = { x: 640, z: 120 };
  const size = { width: 1200, height: 700 };

  it('spans a tile in whole cells at every zoom', () => {
    for (const cell of [MIN_CELL, 12, 28, 72]) {
      const span = tileCells(cell);
      expect(span, `span at ${cell}`).toBeGreaterThanOrEqual(1);
      expect(span * cell, `tile width at ${cell}`).toBeGreaterThanOrEqual(TILE_SIZE);
      expect((span - 1) * cell, `no oversized tile at ${cell}`).toBeLessThan(TILE_SIZE);
    }
  });

  it('covers every cell the viewport can show', () => {
    const cell = 28;
    const view = { x0: 10.3, z0: 4.7 };
    const range = cellRangeForView({ view, ...size, cell, grid });
    const { tiles } = tilesForView({ view, ...size, cell, grid });
    const covered = new Set();
    for (const tile of tiles) {
      for (let gx = tile.x0; gx < tile.x1; gx += 1) {
        for (let gz = tile.z0; gz < tile.z1; gz += 1) covered.add(gx + ',' + gz);
      }
    }
    for (let gx = range.gx0; gx < range.gx1; gx += 1) {
      for (let gz = range.gz0; gz < range.gz1; gz += 1) {
        expect(covered.has(gx + ',' + gz), `cell ${gx},${gz} covered`).toBe(true);
      }
    }
  });

  it('anchors tiles to the cell grid, not to the viewport', () => {
    const cell = 28;
    const span = tileCells(cell);
    const { tiles } = tilesForView({ view: { x0: 12.4, z0: 3.6 }, ...size, cell, grid });
    for (const tile of tiles) {
      expect(tile.x0 % span, `tile x ${tile.x0}`).toBe(0);
      expect(tile.z0 % span, `tile z ${tile.z0}`).toBe(0);
    }
  });

  it('reuses the same tiles when the view only shifts a fraction of a cell', () => {
    const cell = 28;
    const keys = (view: { x0: number; z0: number }) =>
      tilesForView({ view, ...size, cell, grid })
        .tiles.map((tile) => tile.x0 + ',' + tile.z0)
        .sort();
    const before = keys({ x0: 40, z0: 20 });
    const after = keys({ x0: 40.3, z0: 20.3 });
    expect(after).toEqual(before);
  });

  it('never builds a tile outside the grid', () => {
    const cell = 28;
    const { tiles } = tilesForView({ view: { x0: 630, z0: 116 }, ...size, cell, grid });
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.x1).toBeLessThanOrEqual(grid.x);
      expect(tile.z1).toBeLessThanOrEqual(grid.z);
      expect(tile.x1).toBeGreaterThan(tile.x0);
      expect(tile.z1).toBeGreaterThan(tile.z0);
    }
  });
});
