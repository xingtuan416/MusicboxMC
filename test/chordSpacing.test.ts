import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout/index';
import { songOfSpecs } from './helpers/song';

/**
 * Chord rows must be adjacent.
 *
 * Minecraft does not retrigger a note block that is also lit by its neighbour, so
 * there is no reason to leave a blank row between simultaneous notes. Three notes
 * need only the inline note's repeater; the two neighbours are conducted. Four or
 * more get one repeater per row, all with the same delay.
 */

function forced(notes: number[]) {
  return layout(songOfSpecs([{ notes: notes.map((midi) => ({ tick: 0, midi })) }]), {
    forceMergeSameInstrument: true,
  });
}

function noteRows(result: ReturnType<typeof layout>): number[] {
  return result.tracks[0]!.placements.filter((p) => p.block === 'minecraft:note_block')
    .map((p) => p.pos.z)
    .sort((a, b) => a - b);
}

describe('chord rows in the forced single spine', () => {
  it('uses one repeater and three adjacent note blocks for a three-note chord', () => {
    const result = forced([60, 64, 67]);
    expect(result.tracks).toHaveLength(1);
    const rows = noteRows(result);
    expect(rows).toHaveLength(3);
    expect(rows[1]! - rows[0]!).toBe(1);
    expect(rows[2]! - rows[1]!).toBe(1);
    const repeaters = result.tracks[0]!.placements.filter((p) => p.block === 'minecraft:repeater').length;
    expect(repeaters).toBe(1);
  });

  it('gives every row of a four-note chord a repeater, with no blank row', () => {
    const result = forced([60, 64, 67, 69]);
    const rows = noteRows(result);
    expect(rows).toHaveLength(4);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]! - rows[i - 1]!).toBe(1);
    const repeaters = result.tracks[0]!.placements.filter((p) => p.block === 'minecraft:repeater').length;
    expect(repeaters).toBe(4);
  });

  it('keeps a twenty-note chord on twenty adjacent rows', () => {
    const notes = Array.from({ length: 20 }, (_, i) => 48 + i);
    const result = forced(notes);
    const rows = noteRows(result);
    expect(rows).toHaveLength(20);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]! - rows[i - 1]!).toBe(1);
  });
});
