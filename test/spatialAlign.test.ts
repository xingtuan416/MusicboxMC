import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { ALIGN_TOLERANCE_CELLS, gameTickToRedstone } from '../src/core/layout/track';
import { songOfTracks } from './helpers/song';

/**
 * Multi-track spatial alignment.
 *
 * The goal: a track's X is decided by **song time**, so the active regions of all
 * tracks stay near each other during the same passage instead of diverging as the
 * song goes on. The only tool is padding with dust, which adds no delay: no
 * cross-track wiring, no altered repeater delays, no padding past the end.
 */

const cfg = { ...DEFAULT_LAYOUT_CONFIG };

/** (Song redstone tick, note-column X) for each of a track's groups. taps[].x is the branch column; the note column sits 2 cells further along. */
function noteXs(res: ReturnType<typeof layout>, trackIdx: number): Array<{ rt: number; x: number }> {
  const tr = res.tracks[trackIdx]!;
  return tr.taps.map((t) => ({ rt: t.t, x: t.x + 2 }));
}

/** The track's X at rt, taken from the last group no later than rt. */
function xAt(samples: Array<{ rt: number; x: number }>, rt: number): number | undefined {
  let hit: number | undefined;
  for (const s of samples) {
    if (s.rt <= rt) hit = s.x;
    else break;
  }
  return hit;
}

describe('multi-track spatial alignment: X follows song time', () => {
  it('keeps two tracks of very different density within a local X range that does not grow with song length', () => {
    // A is dense, one note every 2 redstone ticks; B is sparse, one every 40.
    const aNotes = [];
    const bNotes = [];
    for (let rt = 1; rt <= 120; rt++) {
      if (rt % 2 === 0) aNotes.push({ tick: rt * 2, midi: 60 });
      if (rt % 40 === 0) bNotes.push({ tick: rt * 2, midi: 67 });
    }
    const res = layout(songOfTracks([aNotes, bNotes]), { config: cfg, regions: DEFAULT_REGIONS });

    const a = noteXs(res, 0);
    const b = noteXs(res, 1);
    expect(b.length).toBeGreaterThan(2);

    const deltas: Array<{ rt: number; d: number }> = [];
    for (const s of b) {
      const xa = xAt(a, s.rt);
      if (xa === undefined) continue;
      deltas.push({ rt: s.rt, d: Math.abs(xa - s.x) });
    }
    expect(deltas.length).toBe(b.length);

    // Bounded throughout, with 6 cells of slack for offsets within the dense track's
    // own groups.
    for (const d of deltas) expect(d.d).toBeLessThanOrEqual(ALIGN_TOLERANCE_CELLS + 6);

    // Must not keep growing: the worst deviation in the last third is no more than 4
    // cells above the first third.
    const third = Math.floor(deltas.length / 3);
    const maxOf = (arr: Array<{ d: number }>) => Math.max(...arr.map((v) => v.d));
    const early = maxOf(deltas.slice(0, third));
    const late = maxOf(deltas.slice(-third));
    expect(late).toBeLessThanOrEqual(early + 4);
  });

  it('returns to the same local region after a long rest without changing the rest length', () => {
    // A is dense throughout; B plays rt 1..20, rests for 200 redstone ticks, then
    // resumes at rt 220.
    const aNotes = [];
    for (let rt = 1; rt <= 240; rt++) aNotes.push({ tick: rt * 2, midi: 60 });
    const bNotes = [];
    for (let rt = 1; rt <= 20; rt += 2) bNotes.push({ tick: rt * 2, midi: 67 });
    for (let rt = 220; rt <= 240; rt += 2) bNotes.push({ tick: rt * 2, midi: 67 });

    const res = layout(songOfTracks([aNotes, bNotes]), { config: cfg, regions: DEFAULT_REGIONS });
    const a = noteXs(res, 0);
    const b = noteXs(res, 1);

    // On re-entry in the second half it is still in the same local region.
    const rejoined = b.filter((s) => s.rt >= 220);
    expect(rejoined.length).toBeGreaterThan(0);
    for (const s of rejoined) {
      const xa = xAt(a, s.rt);
      expect(Math.abs(xa! - s.x)).toBeLessThanOrEqual(ALIGN_TOLERANCE_CELLS + 6);
    }

    // The rest length is unchanged: across the rest, the actual trigger difference
    // equals 2 * the redstone-tick difference.
    const placedB = res.placed.filter((p) => p.trackIndex === 1).sort((x, y) => x.tick - y.tick);
    const firstSection = placedB.filter((p) => p.tick < 100);
    const beforeRest = firstSection[firstSection.length - 1]!; // rt 19（tick 38）
    const afterRest = placedB.find((p) => p.tick === 440)!; // rt 220
    expect(afterRest.actual - beforeRest.actual).toBe(2 * (220 - 19));
  });

  it('does not pad an early-ending track out to the end of another, while still aligning while active', () => {
    const aNotes = [];
    for (let rt = 1; rt <= 100; rt += 2) aNotes.push({ tick: rt * 2, midi: 60 });
    const bNotes = [];
    for (let rt = 1; rt <= 20; rt += 4) bNotes.push({ tick: rt * 2, midi: 67 });

    const res = layout(songOfTracks([aNotes, bNotes]), { config: cfg, regions: DEFAULT_REGIONS });
    const a = noteXs(res, 0);
    const b = noteXs(res, 1);

    // Aligned while both are active
    for (const s of b) {
      expect(Math.abs(xAt(a, s.rt)! - s.x)).toBeLessThanOrEqual(ALIGN_TOLERANCE_CELLS + 6);
    }
    // The ends are not required to line up: B ends well short of A.
    const aEnd = a[a.length - 1]!.x;
    const bEnd = b[b.length - 1]!.x;
    expect(bEnd).toBeLessThan(aEnd);
  });

  it('pads with dust only, leaving timing and repeater delays completely unchanged', () => {
    const aNotes = [];
    for (let rt = 1; rt <= 60; rt += 2) aNotes.push({ tick: rt * 2, midi: 60 });
    const bNotes = [];
    for (let rt = 4; rt <= 60; rt += 20) bNotes.push({ tick: rt * 2, midi: 67 });

    const res = layout(songOfTracks([aNotes, bNotes]), { config: cfg, regions: DEFAULT_REGIONS });

    // For each track, adjacent groups differ by 2 * the redstone-tick difference:
    // padding changed no timing at all.
    for (const trackIdx of [0, 1]) {
      const placed = res.placed.filter((p) => p.trackIndex === trackIdx).sort((x, y) => x.tick - y.tick);
      for (let i = 1; i < placed.length; i++) {
        const dExp = (gameTickToRedstone(placed[i]!.tick) - gameTickToRedstone(placed[i - 1]!.tick)) * 2;
        expect(placed[i]!.actual - placed[i - 1]!.actual).toBe(dExp);
      }
    }

    // No timing warnings beyond the song-wide lead-in, and no spatial drift reported.
    expect(res.warnings.filter((w) => w.code === 'TIMING_ADJUSTED').length).toBeLessThanOrEqual(1);
    expect(res.warnings.some((w) => w.code === 'SPATIAL_DRIFT')).toBe(false);
  });

  it('forces simultaneous notes onto a shared X when the two tracks are within 10 cells naturally', () => {
    const res = layout(
      songOfTracks([
        [5, 10, 15, 20].map((rt) => ({ tick: rt * 2, midi: 60 })),
        [10, 20].map((rt) => ({ tick: rt * 2, midi: 67 })),
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    const a = noteXs(res, 0);
    const b = noteXs(res, 1);
    for (const rt of [10, 20]) {
      expect(a.find((sample) => sample.rt === rt)?.x).toBe(b.find((sample) => sample.rt === rt)?.x);
    }
  });

  it('still pads to share an X when the natural distance exceeds 10 cells', () => {
    // By rt 20 the dense track is already further along, so the natural distance exceeds
    // the old window. As long as the current group's dust slots can absorb it, the
    // simultaneous note columns should still be padded onto the same X.
    const res = layout(
      songOfTracks([
        [2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((rt) => ({
          tick: rt * 2,
          midi: 60,
        })),
        [10, 20].map((rt) => ({ tick: rt * 2, midi: 67 })),
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    const a = noteXs(res, 0);
    const b = noteXs(res, 1);

    expect(Math.abs(a.find((sample) => sample.rt === 20)!.x - 20)).toBe(0);
    expect(b.find((sample) => sample.rt === 20)?.x).toBe(a.find((sample) => sample.rt === 20)?.x);
    expect(res.warnings.some((w) => w.code === 'SPATIAL_DRIFT')).toBe(false);
  });

  it('adds no padding for a single-track song, where the reference line is the track itself', () => {
    const notes = [];
    for (let rt = 1; rt <= 50; rt += 5) notes.push({ tick: rt * 2, midi: 60 });
    const res = layout(songOfTracks([notes]), { config: cfg, regions: DEFAULT_REGIONS });
    const tr = res.tracks[0]!;
    const maxX = Math.max(...tr.placements.map((p) => p.pos.x));
    // The first group has gap 1 (first note at rt 1), so repeater + note block = 2 cells;
    // later groups have gap 5, so 1 rest repeater + final repeater + note block = 3 cells
    // per group, with no branch column.
    const expected = 2 + (notes.length - 1) * 3 - 1;
    expect(maxX).toBe(expected);
  });
});
