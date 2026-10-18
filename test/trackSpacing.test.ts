import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout/index';
import { songOfSpecs } from './helpers/song';

/**
 * Vertical spacing between tracks.
 *
 * The old layout reserved the widest chord in the whole song for every gap, so two
 * one-row tracks could sit six cells apart. Tracks only need their own chord rows plus
 * one empty row; more than that pushes neighbours outside the 48-block hearing radius.
 */

function ranges(result: ReturnType<typeof layout>) {
  return result.tracks.map((track) => {
    const zs = track.placements.map((p) => p.pos.z);
    return { min: Math.min(...zs), max: Math.max(...zs), zBase: track.zBase };
  });
}

describe('track Z spacing', () => {
  it('puts two one-row tracks two cells apart, with one empty row between them', () => {
    const result = layout(
      songOfSpecs([{ notes: [{ tick: 0, midi: 60 }] }, { notes: [{ tick: 0, midi: 64 }] }]),
    );
    expect(result.tracks).toHaveLength(2);
    const [first, second] = ranges(result);
    expect(second!.zBase - first!.zBase).toBe(2);
    // One empty row: the difference between the two occupied edges is 2.
    expect(second!.min - first!.max - 1).toBe(1);
  });

  it('reserves only the chord sides that are actually used', () => {
    // Four notes use one row above and two below, not two on each side.
    const result = layout(
      songOfSpecs([
        { notes: [60, 64, 67, 69].map((midi) => ({ tick: 0, midi })) },
        { notes: [{ tick: 10, midi: 60 }] },
      ]),
    );
    const [first, second] = ranges(result);
    expect(first!.zBase).toBe(1);
    expect(first!.min).toBe(0);
    expect(first!.max).toBe(3);
    expect(second!.min - first!.max - 1).toBe(1);
  });

  it('keeps one empty row between tracks whose chords lean to different sides', () => {
    // The first test covers the simple case; this catches asymmetry across many chords.
    const gaps: number[] = [];
    const result = layout(
      songOfSpecs([
        { notes: [{ tick: 0, midi: 60 }] },
        { notes: [60, 64, 67, 69].map((midi) => ({ tick: 4, midi })) },
        { notes: [60, 62, 64, 65, 67, 69].map((midi) => ({ tick: 8, midi })) },
        { notes: [{ tick: 12, midi: 72 }] },
      ]),
    );
    const sorted = ranges(result).sort((a, b) => a.min - b.min);
    for (let i = 1; i < sorted.length; i += 1) {
      gaps.push(sorted[i]!.min - sorted[i - 1]!.max - 1);
    }
    expect(gaps).toEqual([1, 1, 1]);
  });

  it('treats an explicit trackPitch as a minimum centre distance, never a collision', () => {
    const result = layout(
      songOfSpecs([{ notes: [{ tick: 0, midi: 60 }] }, { notes: [{ tick: 0, midi: 64 }] }]),
      { config: { trackPitch: 10 } },
    );
    const [first, second] = ranges(result);
    expect(second!.zBase - first!.zBase).toBe(10);
    expect(second!.min - first!.max).toBeGreaterThan(0);
  });
});
