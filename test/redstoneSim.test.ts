import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMidi } from '../src/core/midi/parse';
import { layout } from '../src/core/layout/index';
import { assignTracks } from '../src/core/palette/assignment';
import { RedstoneSim, toSimBlock, type SimBlock } from '../src/core/sim/redstone';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');
const Y = 1;

function wire(sim: RedstoneSim, x: number, z = 0): void {
  sim.set({ x, y: Y, z }, { kind: 'wire', power: 0 });
}

function repeater(sim: RedstoneSim, x: number, delay = 1, z = 0): void {
  sim.set({ x, y: Y, z }, { kind: 'repeater', facing: 'west', delay, powered: false });
}

function note(sim: RedstoneSim, x: number, z = 0): void {
  sim.set({ x, y: Y, z }, { kind: 'note', instrument: 'harp', note: 0, powered: false });
}

function source(sim: RedstoneSim, x: number, z = 0): void {
  sim.set({ x: x - 1, y: Y, z }, { kind: 'source', power: 15 });
}

describe('redstone simulator primitives', () => {
  it('decays dust by one per cell and renews it at a repeater', () => {
    const sim = new RedstoneSim();
    for (let x = 0; x <= 3; x++) wire(sim, x);
    repeater(sim, 4);
    wire(sim, 5);
    source(sim, 0);
    sim.settle();
    expect([0, 1, 2, 3].map((x) => sim.powerAt({ x, y: Y, z: 0 }))).toEqual([15, 14, 13, 12]);
    expect(sim.powerAt({ x: 5, y: Y, z: 0 })).toBe(0);
    sim.run(2);
    expect(sim.get({ x: 4, y: Y, z: 0 })).toMatchObject({ kind: 'repeater', powered: true });
    expect(sim.powerAt({ x: 5, y: Y, z: 0 })).toBe(15);
  });

  it('switches a repeater after delay * 2 game ticks', () => {
    for (const [delay, expected] of [
      [1, 2],
      [4, 8],
    ] as const) {
      const sim = new RedstoneSim();
      wire(sim, 0);
      repeater(sim, 1, delay);
      source(sim, 0);
      sim.settle();
      sim.run(expected - 1);
      expect(sim.get({ x: 1, y: Y, z: 0 })).toMatchObject({ powered: false });
      sim.step();
      expect(sim.get({ x: 1, y: Y, z: 0 })).toMatchObject({ powered: true });
    }
  });

  it('fires a note block once per rising edge', () => {
    const sim = new RedstoneSim();
    wire(sim, 0);
    repeater(sim, 1);
    note(sim, 2);
    source(sim, 0);
    sim.settle();
    sim.run(200);
    expect(sim.noteTriggers).toHaveLength(1);
    expect(sim.noteTriggers[0]?.tick).toBe(2);
  });

  it('lets a powered conductor feed the dust behind it', () => {
    const sim = new RedstoneSim();
    wire(sim, 0);
    repeater(sim, 1);
    note(sim, 2);
    wire(sim, 3);
    repeater(sim, 4);
    note(sim, 5);
    source(sim, 0);
    sim.settle();
    sim.run(20);
    expect(sim.noteTriggers.map((trigger) => trigger.tick)).toEqual([2, 4]);
    expect(sim.powerAt({ x: 3, y: Y, z: 0 })).toBe(15);
  });

  it('does not let a conductor chain strong power through several blocks', () => {
    const sim = new RedstoneSim();
    wire(sim, 0);
    repeater(sim, 1);
    note(sim, 2);
    note(sim, 3);
    wire(sim, 4);
    source(sim, 0);
    sim.settle();
    sim.run(20);
    expect(sim.powerAt({ x: 4, y: Y, z: 0 })).toBe(0);
  });

  it('feeds dust only along the repeater axis', () => {
    const sim = new RedstoneSim();
    wire(sim, 0);
    repeater(sim, 1);
    wire(sim, 1, 1);
    source(sim, 0);
    sim.settle();
    sim.run(10);
    expect(sim.get({ x: 1, y: Y, z: 0 })).toMatchObject({ powered: true });
    expect(sim.powerAt({ x: 1, y: Y, z: 1 })).toBe(0);
  });

  it('turns a note off again when the input drops', () => {
    const sim = new RedstoneSim();
    wire(sim, 0);
    repeater(sim, 1);
    note(sim, 2);
    source(sim, 0);
    sim.settle();
    sim.run(10);
    sim.set({ x: -1, y: Y, z: 0 }, { kind: 'air' });
    sim.settle();
    sim.run(20);
    expect(sim.get({ x: 2, y: Y, z: 0 })).toMatchObject({ powered: false });
    expect(sim.noteTriggers).toHaveLength(1);
  });
});

describe('redstone simulator on a real layout', () => {
  const song = parseMidi(readFileSync(FIXTURE));
  const result = layout(song, { assignments: assignTracks(song, 'native'), config: { dMax: 8 } });

  function drive(policy: ((chunkX: number, chunkZ: number) => boolean) | null): RedstoneSim {
    const sim = new RedstoneSim({ isChunkLoaded: policy });
    for (const track of result.tracks) {
      for (const placement of track.placements) {
        const block: SimBlock | null = toSimBlock(placement);
        if (block) sim.set(placement.pos, block);
      }
    }
    for (const track of result.tracks) {
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

  it('fires every note block at the tick the layout planned', () => {
    const sim = drive(null);
    sim.run(result.totalTicks * 2 + 200);
    const triggers = sim.noteTriggers;
    const noteBlocks = result.tracks.flatMap((track) =>
      track.placements.filter((placement) => placement.block === 'minecraft:note_block'),
    );
    expect(triggers).toHaveLength(noteBlocks.length);
    const byPos = new Map(triggers.map((trigger) => [trigger.pos.x + ':' + trigger.pos.z, trigger.tick]));
    let checked = 0;
    for (const track of result.tracks) {
      const groups = result.placed
        .filter((entry) => entry.trackIndex === track.trackIndex)
        .sort((a, b) => a.x - b.x);
      const notes = track.placements
        .filter((placement) => placement.block === 'minecraft:note_block')
        .sort((a, b) => a.pos.x - b.pos.x);
      if (groups.length === 0) continue;
      let index = 0;
      for (const placement of notes) {
        while (index + 1 < groups.length && groups[index + 1]!.x <= placement.pos.x) index++;
        const group = groups[index]!;
        expect(byPos.get(placement.pos.x + ':' + placement.pos.z)).toBe(group.actual);
        checked++;
      }
    }
    expect(checked).toBe(noteBlocks.length);
  });

  it('keeps chord notes of one row on the same tick', () => {
    const sim = drive(null);
    sim.run(result.totalTicks * 2 + 200);
    const byTick = new Map<number, number>();
    for (const trigger of sim.noteTriggers) byTick.set(trigger.tick, (byTick.get(trigger.tick) ?? 0) + 1);
    const chords = [...byTick.values()].filter((count) => count > 1);
    expect(chords.length).toBeGreaterThan(0);
  });

  it('stops at the chunk loading frontier instead of firing late', () => {
    const loaded = drive(null);
    loaded.run(result.totalTicks * 2 + 200);
    const limited = drive((chunkX) => chunkX <= 0);
    limited.run(result.totalTicks * 2 + 200);
    expect(limited.noteTriggers.length).toBeLessThan(loaded.noteTriggers.length);
    expect(limited.noteTriggers.length).toBeGreaterThan(0);
    for (const trigger of limited.noteTriggers) expect(trigger.pos.x).toBeLessThan(16);
  });
});
