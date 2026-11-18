import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout/index';
import { measureLayout } from '../src/main/generate';
import { songOfSpecs } from './helpers/song';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');

/** Three one-row tracks: the lane order is the only thing that can move. */
function threeLanes() {
  return songOfSpecs([
    {
      notes: [
        { tick: 0, midi: 60 },
        { tick: 8, midi: 62 },
      ],
    },
    {
      notes: [
        { tick: 0, midi: 64 },
        { tick: 8, midi: 65 },
      ],
    },
    {
      notes: [
        { tick: 0, midi: 67 },
        { tick: 8, midi: 69 },
      ],
    },
  ]);
}

function laneOf(result: ReturnType<typeof layout>, source: number) {
  const lane = result.tracks.find((track) => track.sourceIndices.includes(source));
  if (!lane) throw new Error('lane for track ' + source + ' is missing');
  return lane;
}

describe('player row and lane order', () => {
  it('stands the player on the lead lane, on z = 0', () => {
    const result = layout(threeLanes(), { laneOrder: [2, 0, 1] });
    expect(result.playerZ).toBe(0);
    expect(laneOf(result, 2).zBase).toBe(0);
    // A dust row means the player can stand next to the wire that starts the lane.
    expect(laneOf(result, 2).placements.some((placement) => placement.pos.z === 0)).toBe(true);
  });

  it('places the remaining lanes by priority, nearest to the player first', () => {
    const result = layout(threeLanes(), { laneOrder: [2, 0, 1] });
    const distances = [2, 0, 1].map((source) => Math.abs(laneOf(result, source).zBase));
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeLessThanOrEqual(distances[2]!);
  });

  it('keeps the file order when the lane order is left alone, still on the lead row', () => {
    const result = layout(threeLanes(), { standTrackIndex: 2 });
    // The lead lane is anchored on z = 0 so the player can stand on it; the rest keep the
    // order they had in the file.
    expect(result.playerZ).toBe(0);
    expect(laneOf(result, 2).zBase).toBe(0);
    const others = result.tracks.filter((track) => !track.sourceIndices.includes(2));
    expect(others.map((track) => track.sourceIndices[0])).toEqual([0, 1]);
  });

  it('grows the arrangement on both sides of the player', () => {
    const result = layout(threeLanes(), { laneOrder: [2, 0, 1] });
    const zs = result.tracks.flatMap((track) => track.placements.map((placement) => placement.pos.z));
    expect(Math.min(...zs)).toBeLessThan(result.playerZ);
    expect(Math.max(...zs)).toBeGreaterThan(result.playerZ);
    // The radius is measured from the player, not from the edge of the box.
    expect(result.hearingRadius).toBe(Math.max(...zs.map((z) => Math.abs(z - result.playerZ))));
  });

  it('measures the generated file on the same row it stands on', () => {
    const measure = measureLayout(FIXTURE, { dMax: 8 });
    expect(measure.playerZ).toBe(0);
    expect(measure.hearingRadius).toBeGreaterThan(0);
    expect(measure.hearingRadius).toBeLessThanOrEqual(Math.max(measure.size.z, 1));
  });
});
