import { describe, expect, it } from 'vitest';
import { sliceRegions } from '../src/core/layout/regions';
import type { BlockPlacement, LayoutResult, TrackSkeleton } from '../src/core/layout/types';

function block(x: number, y: number, z: number, name: string): BlockPlacement {
  return { pos: { x, y, z }, block: name, props: {} };
}

/** A tall chord lane plus a lane that borrows power through its chord rows. */
function borrowThroughChords(): LayoutResult {
  const host: BlockPlacement[] = [];
  for (let x = 0; x <= 20; x += 1) host.push(block(x, 1, 0, 'minecraft:redstone_wire'));
  for (const z of [1, 2, 3]) host.push(block(10, 1, z, 'minecraft:repeater'));
  host.push(block(10, 1, -1, 'minecraft:repeater'));

  const guest: BlockPlacement[] = [];
  for (const z of [1, 2, 3]) guest.push(block(15, 1, z, 'minecraft:repeater'));
  for (let x = 15; x <= 25; x += 1) guest.push(block(x, 1, 4, 'minecraft:redstone_wire'));

  const tracks: TrackSkeleton[] = [
    { trackIndex: 0, sourceIndices: [0], zBase: 0, placements: host, taps: [] },
    { trackIndex: 1, sourceIndices: [1], zBase: 4, placements: guest, taps: [] },
  ];
  return { tracks } as unknown as LayoutResult;
}

function inside(
  slice: { position: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } },
  pos: { x: number; y: number; z: number },
): boolean {
  return (
    pos.x >= slice.position.x &&
    pos.x < slice.position.x + slice.size.x &&
    pos.y >= slice.position.y &&
    pos.y < slice.position.y + slice.size.y &&
    pos.z >= slice.position.z &&
    pos.z < slice.position.z + slice.size.z
  );
}

describe('slicing a layout into litematic regions', () => {
  it('never puts another track block inside a region box', () => {
    const result = borrowThroughChords();
    const slices = sliceRegions(result);
    const owner = new Map<string, number>();
    for (const track of result.tracks) {
      for (const placement of track.placements) {
        owner.set(`${placement.pos.x},${placement.pos.y},${placement.pos.z}`, track.trackIndex);
      }
    }
    const offenders: string[] = [];
    for (const track of result.tracks) {
      for (const placement of track.placements) {
        for (const slice of slices) {
          if (slice.trackIndex === track.trackIndex) continue;
          if (!inside(slice, placement.pos)) continue;
          // A box may include an empty cell, but never a cell that belongs to another track.
          offenders.push(
            `${placement.block}@${placement.pos.x},${placement.pos.z} inside track ${slice.trackIndex}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(owner.size).toBe(result.tracks[0]!.placements.length + result.tracks[1]!.placements.length);
  });

  it('keeps every block, exactly once, and inside its own box', () => {
    const result = borrowThroughChords();
    const slices = sliceRegions(result);
    const seen = new Map<string, number>();
    for (const [index, slice] of slices.entries()) {
      for (const placement of slice.blocks) {
        expect(placement.pos.x).toBeGreaterThanOrEqual(0);
        expect(placement.pos.y).toBeGreaterThanOrEqual(0);
        expect(placement.pos.z).toBeGreaterThanOrEqual(0);
        expect(placement.pos.x).toBeLessThan(slice.size.x);
        expect(placement.pos.y).toBeLessThan(slice.size.y);
        expect(placement.pos.z).toBeLessThan(slice.size.z);
        const key = `${index}:${placement.pos.x},${placement.pos.y},${placement.pos.z}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const total = result.tracks.reduce((sum, track) => sum + track.placements.length, 0);
    expect(seen.size).toBe(total);
    for (const count of seen.values()) expect(count).toBe(1);
  });

  it('splits the tall lane instead of swallowing the corridor', () => {
    const result = borrowThroughChords();
    const slices = sliceRegions(result);
    const hostSlices = slices.filter((slice) => slice.trackIndex === 0);
    expect(hostSlices.length).toBeGreaterThan(1);
    const corridorSlice = slices.find((slice) => slice.trackIndex === 1)!;
    expect(corridorSlice.position.z).toBe(1);
    // The corridor's own cells must be reachable: nothing taller claims them as air.
    for (const z of [1, 2, 3]) {
      const claiming = slices.filter((slice) => inside(slice, { x: 15, y: 1, z }));
      expect(claiming).toHaveLength(1);
      expect(claiming[0]!.trackIndex).toBe(1);
    }
  });
});
