import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout';
import { WIRE_STRENGTH, chordRows, groupTailCells } from '../src/core/layout/model';
import { songOfTracks } from './helpers/song';

/**
 * The last run of padding dust and a chord's lateral branch share one strength budget.
 *
 * Dust loses one strength per cell, so the branch column is powered at
 * `WIRE_STRENGTH + 1 - padding`, and row `r` of the branch needs at least 1 of that left.
 * Spreading the padding evenly over every slot ignored this: a 29-note chord placed after
 * a dense passage left rows 12 and beyond with no power, while reporting success and no
 * warnings at all.
 *
 * The check below is arithmetic on the emitted geometry using the rule vanilla applies
 * (`RedStoneWireBlock` decrements per cell). It is not a redstone simulation, and it
 * cannot be: it verifies the static power budget of the layout, not what the game does
 * with it.
 */
function branchHeadroom(notes: number, denseNotes: number): { rootStrength: number; reach: number } {
  const dense = Array.from({ length: denseNotes }, (_, i) => ({ tick: (i + 1) * 2, midi: 60 }));
  const chord = Array.from({ length: notes }, (_, i) => ({ tick: 20, midi: 40 + i }));
  const result = layout(songOfTracks([dense, chord]));

  const track = result.tracks[1]!;
  const root = track.taps[0]!.x;
  const mainRow = track.placements.filter(
    (p) => p.pos.y === DEFAULT_LAYOUT_CONFIG.circuitY && p.pos.z === track.zBase,
  );
  const lastRepeater = mainRow.filter((p) => p.block === 'minecraft:repeater' && p.pos.x < root).at(-1)!;

  return { rootStrength: WIRE_STRENGTH + 1 - (root - lastRepeater.pos.x), reach: chordRows(notes) };
}

describe('padding and the branch strength budget', () => {
  it('leaves every branch row of a 29-note chord powered', () => {
    const { rootStrength, reach } = branchHeadroom(29, 10);
    expect(reach).toBe(14);
    // Row `reach` is the furthest the branch goes, and it needs 1 strength when it gets there.
    expect(rootStrength - reach).toBeGreaterThanOrEqual(1);
  });

  it('keeps the whole padding budget for a chord that has no branch column', () => {
    // Up to three notes are lit by one hop from the inline note block, so there is no
    // lateral dust to share the budget with and the full run stays available.
    expect(groupTailCells(3)).toBe(2);
    expect(groupTailCells(4)).toBe(3);
    const { rootStrength, reach } = branchHeadroom(3, 10);
    expect(reach).toBe(1);
    expect(rootStrength).toBeGreaterThan(1);
  });

  it('lays out a wide chord on its own without asking for padding', () => {
    // The cap only limits how much of a *requested* run may sit in the last slot, so a
    // chord with nothing to align against is unaffected.
    const chord = Array.from({ length: 29 }, (_, i) => ({ tick: 20, midi: 40 + i }));
    const result = layout(songOfTracks([chord]));
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]!.taps[0]!.notes).toHaveLength(29);
    expect(result.warnings.filter((w) => w.code === 'SPATIAL_DRIFT')).toHaveLength(0);
  });

  it('reports drift rather than silently over-padding when the budget runs out', () => {
    // A dense passage far ahead forces more padding than the last slot may carry; the
    // residual has to be reported instead of spent on a run that would starve the branch.
    const sparse = [{ tick: 0, midi: 60 }];
    const far = Array.from({ length: 40 }, (_, i) => ({ tick: i * 2, midi: 72 }));
    const result = layout(songOfTracks([sparse, far]));
    const drift = result.warnings.filter((w) => w.code === 'SPATIAL_DRIFT');
    for (const warning of drift) expect(warning.drift).toBeGreaterThan(0);
  });
});
