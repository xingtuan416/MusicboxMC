import { describe, expect, it } from 'vitest';
import { sliceRegions } from '../src/core/layout/regions';
import { buildLitematic, parseLitematic, blockIndex } from '../src/core/litematic/build';
import { layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { song } from './helpers/song';

/** Build a SongModel from explicit (tick, midi) pairs, bypassing MIDI parsing. */

describe('sliceRegions', () => {
  it('keeps every block coordinate non-negative and inside the region size', () => {
    // A 3-note chord fans out along +/-Z, which is where negative Z used to leak out.
    const res = layout(
      song([
        { tick: 0, midi: 60 },
        { tick: 0, midi: 64 },
        { tick: 0, midi: 67 },
      ]),
      {
        regions: DEFAULT_REGIONS,
      },
    );

    const slices = sliceRegions(res);
    expect(slices.length).toBeGreaterThan(0);

    for (const s of slices) {
      for (const b of s.blocks) {
        expect(b.pos.x).toBeGreaterThanOrEqual(0);
        expect(b.pos.y).toBeGreaterThanOrEqual(0);
        expect(b.pos.z).toBeGreaterThanOrEqual(0);
        expect(b.pos.x).toBeLessThan(s.size.x);
        expect(b.pos.y).toBeLessThan(s.size.y);
        expect(b.pos.z).toBeLessThan(s.size.z);
      }
    }
  });

  it('feeds slices straight into buildLitematic without an out-of-bounds error', () => {
    const res = layout(
      song([
        { tick: 0, midi: 60 },
        { tick: 0, midi: 64 },
        { tick: 0, midi: 67 },
      ]),
      {
        regions: DEFAULT_REGIONS,
      },
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
      { name: 'chord', author: 't', description: '', dataVersion: 3700, version: 6 },
    );

    const parsed = parseLitematic(buf);
    expect(parsed.regions).toHaveLength(slices.length);

    // Reading the file back must yield the same note block count as the slice: no note
    // may be lost.
    const expected = slices.reduce(
      (s, sl) => s + sl.blocks.filter((b) => b.block === 'minecraft:note_block').length,
      0,
    );
    let actual = 0;
    for (const r of parsed.regions) {
      for (let i = 0; i < r.indices.length; i++) {
        if (r.palette[r.indices[i]!]?.name === 'minecraft:note_block') actual++;
      }
    }
    expect(actual).toBe(expected);
    expect(actual).toBe(3);
  });

  it('gives split tracks non-overlapping slices and conserves the total note count', () => {
    // Create a dense passage to trigger layout()'s automatic track splitting.
    const notes: Array<{ tick: number; midi: number }> = [];
    for (let i = 0; i < 14; i++) {
      for (const m of [60, 64, 67]) notes.push({ tick: i, midi: m });
    }
    const res = layout(song(notes), { regions: DEFAULT_REGIONS });
    const slices = sliceRegions(res);

    const noteCount = slices.reduce(
      (s, sl) => s + sl.blocks.filter((b) => b.block === 'minecraft:note_block').length,
      0,
    );
    // layout() may truncate a group past the limit, but must never invent notes.
    expect(noteCount).toBeGreaterThan(0);
    expect(noteCount).toBeLessThanOrEqual(notes.length);

    // No region's Z range may coincide exactly with another's, which would mean the
    // translation to region-local coordinates went wrong.
    const zRanges = slices.map((s) => [s.position.z, s.position.z + s.size.z] as const);
    for (let i = 0; i < zRanges.length; i++) {
      for (let j = i + 1; j < zRanges.length; j++) {
        const [a0, a1] = zRanges[i]!;
        const [b0, b1] = zRanges[j]!;
        const overlap = Math.min(a1, b1) - Math.max(a0, b0);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it('reads blocks back at the same relative positions as the original layout', () => {
    const res = layout(
      song([
        { tick: 0, midi: 60 },
        { tick: 0, midi: 64 },
        { tick: 0, midi: 67 },
      ]),
      {
        regions: DEFAULT_REGIONS,
      },
    );
    const slices = sliceRegions(res);
    const src = slices[0]!;

    const buf = buildLitematic(
      [
        {
          position: src.position,
          size: src.size,
          blocks: src.blocks.map((b) => ({
            x: b.pos.x,
            y: b.pos.y,
            z: b.pos.z,
            state: { name: b.block, properties: b.props ?? {} },
          })),
        },
      ],
      { name: 'x', author: 'x', description: '', dataVersion: 3700, version: 6 },
    );

    const r = parseLitematic(buf).regions[0]!;
    for (const b of src.blocks) {
      const got = r.palette[r.indices[blockIndex(b.pos.x, b.pos.y, b.pos.z, r.size.x, r.size.z)]!]!;
      expect(got.name).toBe(b.block);
    }
  });
});
