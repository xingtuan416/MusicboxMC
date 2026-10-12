import { describe, expect, it } from 'vitest';
import {
  BASE_CELL,
  BADGE_MIN_CELL,
  DETAIL_MIN_CELL,
  dustSizes,
  noteBlockSizes,
  previewGeometry,
  repeaterSizes,
} from '../src/renderer/previewGeometry.js';

/**
 * The preview draws each cell as a small piece of art whose parts used to be sized
 * with `Math.max(minimum, CELL * fraction)` alone. The minimums suit the default
 * 38 px cell, so on a long song - where the canvas budget caps the cell at 10-20 px -
 * the delay badge, the terminals and the note stem were drawn larger than the cell
 * and spilled into their neighbours.
 *
 * These tests pin the two properties that keep that from coming back: nothing a cell
 * draws may exceed the cell, and the default size must be pixel-for-pixel unchanged.
 */
const CELLS = Array.from({ length: 96 }, (_, index) => index + 1);

describe('preview geometry', () => {
  it('keeps a short song at full detail', () => {
    const geometry = previewGeometry({ x: 47, z: 10, dpr: 1, previewScale: 1 });
    expect(geometry.cell).toBe(BASE_CELL);
    expect(geometry.detail).toBe(true);
    expect(geometry.renderScale).toBe(1);
  });

  it('drops to flat fills once a long song forces the cell down', () => {
    const geometry = previewGeometry({ x: 1893, z: 1034, dpr: 1, previewScale: 1 });
    expect(geometry.cell).toBeLessThan(DETAIL_MIN_CELL);
    expect(geometry.detail).toBe(false);
  });

  it('never lets the canvas exceed the budget it is solving for', () => {
    for (const [x, z] of [
      [47, 10],
      [500, 40],
      [1893, 1034],
      [20000, 16],
    ] as const) {
      const geometry = previewGeometry({ x, z, dpr: 1, previewScale: 1 });
      const area = geometry.width * geometry.height;
      // The solve includes the fixed headers, so allow a hair over the rectangle.
      expect(area, `${x}x${z}`).toBeLessThan(16_000_000 * 1.02);
      expect(geometry.width).toBeLessThanOrEqual(30000);
      expect(geometry.height).toBeLessThanOrEqual(30000);
    }
  });

  it('keeps the level of detail tied to the cell size', () => {
    expect(previewGeometry({ x: 10, z: 10, dpr: 1, previewScale: 1 }).detail).toBe(true);
    const tiny = previewGeometry({ x: 4000, z: 4000, dpr: 1, previewScale: 1 });
    expect(tiny.detail).toBe(tiny.cell >= DETAIL_MIN_CELL);
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
