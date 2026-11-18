import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout/index';
import type { LayoutResult } from '../src/core/layout/types';
import { parseMidi } from '../src/core/midi/parse';
import { assignTracks } from '../src/core/palette/assignment';
import { RedstoneSim, toSimBlock, type SimBlock } from '../src/core/sim/redstone';
import { generate, measureLayout } from '../src/main/generate';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');
const song = parseMidi(readFileSync(FIXTURE));
const assignments = assignTracks(song, 'native');
const base = { assignments, config: { dMax: 8 } };

function plain(): LayoutResult {
  return layout(song, base);
}

function ridden(): LayoutResult {
  return layout(song, { ...base, laneRide: true });
}

function off(): LayoutResult {
  return layout(song, { ...base, laneRide: false });
}

/** Fill a simulator with the circuit, then power only the lanes that do not borrow. */
function drive(result: LayoutResult): RedstoneSim {
  const sim = new RedstoneSim();
  for (const track of result.tracks) {
    for (const placement of track.placements) {
      const block: SimBlock | null = toSimBlock(placement);
      if (block) sim.set(placement.pos, block);
    }
  }
  for (const track of result.tracks) {
    // A borrowing lane has no head: it is powered through the crossing repeater.
    if (track.ride) continue;
    const powered = track.placements.filter(
      (placement) =>
        placement.block === 'minecraft:redstone_wire' || placement.block === 'minecraft:repeater',
    );
    if (powered.length === 0) continue;
    const minX = Math.min(...powered.map((placement) => placement.pos.x));
    for (const placement of powered) {
      if (placement.pos.x !== minX) continue;
      sim.set({ x: minX - 1, y: placement.pos.y, z: placement.pos.z }, { kind: 'source', power: 15 });
    }
  }
  sim.settle();
  return sim;
}

function noteCount(result: LayoutResult): number {
  return result.tracks.reduce(
    (sum, track) => sum + track.placements.filter((p) => p.block === 'minecraft:note_block').length,
    0,
  );
}

function blockCount(result: LayoutResult): number {
  return result.tracks.reduce((sum, track) => sum + track.placements.length, 0);
}

function plannedTicks(result: LayoutResult): Map<string, number> {
  return new Map(
    result.placed.map((entry) => [entry.trackIndex + ':' + entry.tick + ':' + entry.actual, entry.actual]),
  );
}

describe('borrowing power from the neighbouring lane', () => {
  it('leaves the layout alone unless the option is on', () => {
    const legacy = plain();
    const withoutRide = off();
    // Opt-in: an option nobody set must not move a single block of the old layout.
    expect(legacy.tracks.some((track) => track.ride !== undefined)).toBe(false);
    expect(withoutRide.tracks.some((track) => track.ride !== undefined)).toBe(false);
    expect(blockCount(withoutRide)).toBe(blockCount(legacy));
    expect(withoutRide.tracks.map((track) => track.zBase)).toEqual(legacy.tracks.map((track) => track.zBase));
    expect(withoutRide.placed).toEqual(legacy.placed);
  });

  it('crosses every row between itself and the lane it borrows from', () => {
    const result = ridden();
    const rides = result.tracks.filter((track) => track.ride !== undefined);
    expect(rides.length).toBeGreaterThan(0);
    let multiRow = 0;
    for (const track of rides) {
      const ride = track.ride!;
      const host = result.tracks.find((candidate) => candidate.zBase === ride.hostZ);
      expect(host).toBeDefined();
      expect(host!.placements.length).toBeGreaterThan(0);
      // Chord branches put a row on each side of a lane, so the host is usually further
      // away than two rows; the tap walks up one repeater per row in between.
      expect(Math.abs(track.zBase - ride.hostZ)).toBeGreaterThanOrEqual(2);
      const up = track.zBase > ride.hostZ;
      const step = up ? 1 : -1;
      const corridor: number[] = [];
      for (let z = ride.hostZ + step; z !== track.zBase; z += step) corridor.push(z);
      if (corridor.length > 1) multiRow++;
      for (const z of corridor) {
        const crossing = track.placements.filter(
          (placement) =>
            placement.block === 'minecraft:repeater' && placement.pos.x === ride.x && placement.pos.z === z,
        );
        expect(crossing).toHaveLength(1);
        const block = toSimBlock(crossing[0]!);
        // A repeater reads only its own input side, so the corridor must all face one way.
        expect(block?.kind).toBe('repeater');
        expect(block?.kind === 'repeater' ? block.facing : null).toBe(up ? 'north' : 'south');
      }
      // The lane picks up its own row at the crossing and keeps going east from there.
      const pickup = track.placements.filter(
        (placement) =>
          placement.block === 'minecraft:redstone_wire' &&
          placement.pos.x === ride.x &&
          placement.pos.z === track.zBase,
      );
      expect(pickup).toHaveLength(1);
    }
    // One tap has to cross more than one row, or the corridor itself is untested.
    expect(multiRow).toBeGreaterThan(0);
  });

  it('still borrows once the same instruments are merged into fewer lanes', () => {
    // Merging adds chord rows around a lane, which is exactly what used to hide the
    // neighbouring lane from the tap search: every tap disappeared.
    const merged = layout(song, { ...base, mergeSameInstrument: true });
    const mergedRidden = layout(song, { ...base, mergeSameInstrument: true, laneRide: true });
    const rides = mergedRidden.tracks.filter((track) => track.ride !== undefined);
    expect(rides.length).toBeGreaterThan(0);
    expect(blockCount(mergedRidden)).toBeLessThan(blockCount(merged));
    expect(noteCount(mergedRidden)).toBe(noteCount(merged));
    expect(mergedRidden.size.z).toBe(merged.size.z);
    expect(plannedTicks(mergedRidden)).toEqual(plannedTicks(merged));
  });

  it('spends fewer blocks for the same notes and the same ticks', () => {
    const legacy = plain();
    const result = ridden();
    expect(blockCount(result)).toBeLessThan(blockCount(legacy));
    expect(noteCount(result)).toBe(noteCount(legacy));
    expect(result.size.z).toBe(legacy.size.z);
    // Timing is what the ride must not touch: every group fires where it did before.
    const before = plannedTicks(legacy);
    const after = plannedTicks(result);
    expect(after.size).toBe(before.size);
    for (const [key, actual] of before) expect(after.get(key)).toBe(actual);
  });

  it('fires every note at its planned tick when the borrowed lanes are unpowered', () => {
    for (const mergeSameInstrument of [false, true]) expectOnSchedule(mergeSameInstrument);
  });

  // Folding a lane onto its neighbour deepens the host's chord rows, which is exactly the
  // kind of change that can shift a column by a redstone tick without failing a shape test.
  it('fires every note after a merge folds sparse lanes into their neighbours', () => {
    const folded = generate(FIXTURE, { dMax: 8, mergeSameInstrument: true, laneSharing: true });
    const groups = folded.result.laneSharing?.groups;
    expect(groups).toBeDefined();
    checkOnSchedule(
      layout(song, { ...base, laneRide: true, mergeSameInstrument: true, laneGroups: groups! }),
    );
  });
});

/** Run the real simulator over one layout and assert every note lands on its planned tick. */
function expectOnSchedule(mergeSameInstrument: boolean): void {
  checkOnSchedule(layout(song, { ...base, laneRide: true, mergeSameInstrument }));
}

/** Assert every note of one layout lands on the tick its group planned. */
function checkOnSchedule(result: LayoutResult): void {
  const sim = drive(result);
  sim.run(result.totalTicks * 2 + 200);
  const noteBlocks = result.tracks.flatMap((track) =>
    track.placements.filter((placement) => placement.block === 'minecraft:note_block'),
  );
  expect(sim.noteTriggers).toHaveLength(noteBlocks.length);
  const byPos = new Map(
    sim.noteTriggers.map((trigger) => [trigger.pos.x + ':' + trigger.pos.z, trigger.tick]),
  );
  let checked = 0;
  for (const track of result.tracks) {
    const groups = result.placed
      .filter((entry) => entry.trackIndex === track.trackIndex)
      .sort((a, b) => a.x - b.x);
    if (groups.length === 0) continue;
    const notes = track.placements
      .filter((placement) => placement.block === 'minecraft:note_block')
      .sort((a, b) => a.pos.x - b.pos.x);
    let index = 0;
    for (const placement of notes) {
      while (index + 1 < groups.length && groups[index + 1]!.x <= placement.pos.x) index++;
      expect(byPos.get(placement.pos.x + ':' + placement.pos.z)).toBe(groups[index]!.actual);
      checked++;
    }
  }
  expect(checked).toBe(noteBlocks.length);
}

describe('borrowed power through generation', () => {
  it('reports nothing when the switch is off', () => {
    const generated = generate(FIXTURE, { laneRide: false });
    expect(generated.result.laneRide).toBeUndefined();
    expect(measureLayout(FIXTURE, { laneRide: false }).riddenLanes).toBe(0);
  });

  it('measures the ride it actually builds', () => {
    const generated = generate(FIXTURE, { laneRide: true });
    const info = generated.result.laneRide;
    expect(info).toBeDefined();
    expect(info!.count).toBe(info!.lanes.length);
    expect(info!.count).toBeGreaterThan(0);
    const measure = measureLayout(FIXTURE, { laneRide: true });
    expect(measure.riddenLanes).toBe(info!.count);
    expect(measure.blockCount).toBe(generated.result.stats.circuitBlocks);
    expect(measure.noteBlockCount).toBe(generated.result.stats.noteBlockCount);
    // The reported row count is what the reader will ask about: one repeater per row.
    // Only the gap between the two lanes is crossed - the host's own chord rows can make
    // the distance between the two centre lines longer than the corridor.
    for (const lane of info!.lanes) {
      expect(lane.rows).toBeGreaterThanOrEqual(1);
      expect(lane.rows).toBeLessThan(Math.abs(lane.z - lane.hostZ));
    }
  });
});
