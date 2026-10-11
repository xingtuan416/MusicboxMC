import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { gameTickToRedstone } from '../src/core/layout/track';
import { buildLitematic } from '../src/core/litematic/build';
import { sliceRegions } from '../src/core/layout/regions';
import { songOfTracks } from './helpers/song';

/**
 * Layout acceptance: structure and note conservation.
 *
 * This suite deliberately does **not** simulate redstone timing. Dust propagation, a
 * powered note block feeding the dust next to it, and the network isolation between
 * adjacent groups all need in-game verification; asserting timing against a
 * simplified model would only give false confidence. So the automated acceptance
 * checks two invariants that hold regardless of those unknowns:
 *   1. structure: note count is conserved, tracks do not overlap, a valid .litematic
 *      can be exported;
 *   2. timing: the relative order in `placed` matches MIDI redstone-tick quantisation
 *      exactly, across tracks as well.
 */

const cfg = { ...DEFAULT_LAYOUT_CONFIG };

function noteBlockCount(res: ReturnType<typeof layout>): number {
  return res.tracks.reduce(
    (s, t) => s + t.placements.filter((p) => p.block === 'minecraft:note_block').length,
    0,
  );
}

describe('layout acceptance: structure and note conservation', () => {
  it('conserves the note count for single notes, chords and dense scores', () => {
    const cases = [
      [{ tick: 0, midi: 60 }],
      [60, 64, 67].map((midi) => ({ tick: 0, midi })),
      Array.from({ length: 40 }, (_, i) => ({ tick: i * 2, midi: 54 + (i % 9) })),
      Array.from({ length: 35 }, (_, i) => ({ tick: 0, midi: 48 + (i % 12) })),
    ];
    for (const notes of cases) {
      const res = layout(songOfTracks([notes]), { config: cfg, regions: DEFAULT_REGIONS });
      expect(noteBlockCount(res)).toBe(notes.length);
    }
  });

  it('gives every track a non-overlapping Z range, including tracks split off by overflow', () => {
    const res = layout(
      songOfTracks([
        Array.from({ length: 35 }, (_, i) => ({ tick: 0, midi: 48 + (i % 12) })),
        [{ tick: 4, midi: 60 }],
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(res.tracks.length).toBeGreaterThanOrEqual(2);
    const ranges = res.tracks.map((t) => {
      const zs = t.placements.map((p) => p.pos.z);
      return [Math.min(...zs), Math.max(...zs)] as const;
    });
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const overlap = Math.min(ranges[i]![1], ranges[j]![1]) - Math.max(ranges[i]![0], ranges[j]![0]);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it('exports a valid .litematic with non-negative region coordinates and no lost note blocks', () => {
    const res = layout(
      songOfTracks([
        [{ tick: 0, midi: 60 }],
        [
          { tick: 0, midi: 64 },
          { tick: 0, midi: 67 },
        ],
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    const slices = sliceRegions(res);
    const buf = buildLitematic(
      slices.map((s) => ({
        position: s.position,
        size: s.size,
        blocks: s.blocks.map((b) => ({
          x: b.pos.x,
          y: b.pos.y,
          z: b.pos.z,
          state: { name: b.block, properties: b.props ?? {} },
        })),
      })),
      { name: 'acc', author: 't', description: '', dataVersion: 3700, version: 6 },
    );
    expect(buf.length).toBeGreaterThan(0);
    for (const s of slices) {
      for (const b of s.blocks) {
        expect(b.pos.x).toBeGreaterThanOrEqual(0);
        expect(b.pos.y).toBeGreaterThanOrEqual(0);
        expect(b.pos.z).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('layout acceptance: timing invariants', () => {
  it('preserves cross-track relative timing: track A starts at rt 0 and B at rt 10, so the difference must be 20 game ticks', () => {
    // Lock down the song-wide lead-in: a repeater's minimum delay means a note at rt 0
    // cannot sound before one redstone tick in, and that offset has to be identical on
    // every track or their first notes end up misaligned.
    const res = layout(songOfTracks([[{ tick: 0, midi: 60 }], [{ tick: 20, midi: 62 }]]), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    const a = res.placed.find((p) => p.trackIndex === 0)!;
    const b = res.placed.find((p) => p.trackIndex === 1)!;
    expect(a.actual).toBe(2); // rt 0 plus the song-wide lead-in of 1 redstone tick
    expect(b.actual).toBe(22); // rt 10 plus the same lead-in
    expect(b.actual - a.actual).toBe(20);
  });

  it('keeps adjacent groups 2*(redstone tick difference) apart on random scores', () => {
    for (let seed = 0; seed < 100; seed++) {
      const notes = [];
      let t = seed % 4;
      for (let i = 0; i < 15; i++) {
        notes.push({ tick: t, midi: 54 + ((seed + i) % 9) });
        t += 1 + ((seed * 11 + i * 7) % 23);
      }
      const res = layout(songOfTracks([notes]), { config: cfg, regions: DEFAULT_REGIONS });
      const placed = [...res.placed].sort((a, b) => a.tick - b.tick);
      expect(placed.length).toBeGreaterThan(0);
      for (let i = 1; i < placed.length; i++) {
        const dExp = (gameTickToRedstone(placed[i]!.tick) - gameTickToRedstone(placed[i - 1]!.tick)) * 2;
        expect(placed[i]!.actual - placed[i - 1]!.actual).toBe(dExp);
      }
    }
  });

  it('reports one placed entry per chord group, firing on its quantised redstone tick', () => {
    const notes = [60, 64, 67, 70].map((midi) => ({ tick: 12, midi }));
    const res = layout(songOfTracks([notes]), { config: cfg, regions: DEFAULT_REGIONS });
    expect(res.placed).toHaveLength(1);
    expect(res.placed[0]!.actual).toBe(12); // rt 6 (tick 12); first group at rt >= 1, so no lead-in
  });
});
