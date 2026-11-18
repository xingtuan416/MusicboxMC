import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout/index';
import type { BlockPlacement, LayoutResult, TrackSkeleton } from '../src/core/layout/types';
import { parseMidi } from '../src/core/midi/parse';
import { assignTracks } from '../src/core/palette/assignment';
import { RedstoneSim, toSimBlock, type SimBlock } from '../src/core/sim/redstone';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');
const song = parseMidi(readFileSync(FIXTURE));
const assignments = assignTracks(song, 'native');
const base = { assignments, config: { dMax: 8 } };
const everyTrack = song.tracks.map((track) => track.index);

function centred(extra: Record<string, unknown> = {}): LayoutResult {
  return layout(song, { ...base, laneOrder: everyTrack, ...extra });
}

function cellKey(pos: { x: number; y: number; z: number }): string {
  return pos.x + ',' + pos.y + ',' + pos.z;
}

function cellsOf(track: TrackSkeleton): Map<string, BlockPlacement> {
  const cells = new Map<string, BlockPlacement>();
  for (const placement of track.placements) cells.set(cellKey(placement.pos), placement);
  return cells;
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

/**
 * Re-ordering the lanes moves whole lanes through Z.
 *
 * Every note block has to travel with the wire that powers it, and the row it sits on is
 * recorded in two places: the block's own cell and the note's `notePos`. When those two
 * fell out of step the note blocks were translated twice and ended up rows away from
 * their dust - which is invisible to a snapshot test that only counts blocks.
 */
describe('a lane moved through Z', () => {
  it('keeps every note block on the row that powers it', () => {
    for (const result of [layout(song, base), centred(), centred({ laneRide: true })]) {
      for (const track of result.tracks) {
        const cells = cellsOf(track);
        for (const tap of track.taps) {
          for (const note of tap.notes) {
            const own = cells.get(cellKey(note.notePos));
            expect(own?.block).toBe('minecraft:note_block');
            // The base block is what selects the instrument: one cell straight down.
            const below = cells.get(cellKey({ ...note.notePos, y: note.blockPos.y }));
            expect(below?.block).toBe(note.block);
            expect(note.blockPos.z).toBe(note.notePos.z);
            expect(note.blockPos.y).toBe(note.notePos.y - 1);
            // A branch may be dMax rows to either side of the main row, never further.
            expect(Math.abs(note.notePos.z - track.zBase)).toBeLessThanOrEqual(8);
          }
        }
      }
    }
  });

  it('never puts two blocks in the same cell', () => {
    const seen = new Set<string>();
    for (const track of centred({ laneRide: true }).tracks) {
      for (const placement of track.placements) {
        const key = cellKey(placement.pos);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('keeps the width of the song whatever the lane order', () => {
    const natural = layout(song, base);
    const reordered = centred();
    // Moving lanes around in Z cannot make the song wider: the widest lane is the widest
    // lane. The old double translation reported 56 cells for this 40-cell song.
    expect(reordered.size.z).toBe(natural.size.z);
    expect(reordered.tracks.length).toBe(natural.tracks.length);
  });

  it('still fires every note on the tick it was planned for', () => {
    // The centred lane order is where the double translation lived: every note block was
    // rows away from the dust that should power it, so nothing sounded at all.
    const result = centred({ laneRide: true });
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
  });
});
