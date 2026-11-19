import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout/index';
import { MAX_PAD_RUN } from '../src/core/layout/model';
import { distributePad } from '../src/core/layout/track';
import { parseMidi } from '../src/core/midi/parse';
import { assignTracks } from '../src/core/palette/assignment';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');

describe('padding distribution', () => {
  const caps = [...new Array<number>(9).fill(MAX_PAD_RUN), 4];

  it('spreads the cells evenly instead of loading the front', () => {
    const slots = distributePad(60, new Array<number>(caps.length).fill(MAX_PAD_RUN));
    expect(slots.reduce((sum, n) => sum + n, 0)).toBe(60);
    const used = slots.filter((n) => n > 0);
    expect(Math.max(...used) - Math.min(...used)).toBeLessThanOrEqual(1);
    // Front-loading put every cell in the first slots and left long bare repeater chains
    // behind it; that shape was reported as a broken wire in game.
    expect(slots[0]).toBeLessThanOrEqual(slots[slots.length - 2]! + 1);
  });

  it('keeps the last slot inside its own limit, because the branch column shares its budget', () => {
    const slots = distributePad(70, caps);
    expect(slots[slots.length - 1]).toBeLessThanOrEqual(4);
    expect(slots.reduce((sum, n) => sum + n, 0)).toBe(70);
  });

  it('never places more than the slots can hold', () => {
    const slots = distributePad(1000, [3, 3, 3]);
    expect(slots).toEqual([3, 3, 3]);
  });

  it('leaves every slot empty when no padding is needed', () => {
    expect(distributePad(0, caps)).toEqual(new Array<number>(caps.length).fill(0));
  });
});

describe('repeater spacing in a real layout', () => {
  const song = parseMidi(readFileSync(FIXTURE));
  const assignments = assignTracks(song, 'native');
  const result = layout(song, { assignments, config: { dMax: 8 } });

  it('never puts more than one slot worth of dust in a row', () => {
    // The previous front-loading loop could leave two slots adjacent with dust in both,
    // which measured 14 cells against a 13-cell cap. A long dust run also hides a missing
    // repeater: the wire still lights but the timing no longer adds up.
    for (const track of result.tracks) {
      const wireXs = new Set(
        track.placements
          .filter((placement) => placement.block === 'minecraft:redstone_wire')
          .map((placement) => placement.pos.x + ',' + placement.pos.z),
      );
      for (const placement of track.placements) {
        if (placement.block !== 'minecraft:redstone_wire') continue;
        // Longest dust run ending at this cell.
        let run = 0;
        for (let x = placement.pos.x; wireXs.has(x + ',' + placement.pos.z); x--) run += 1;
        expect(run).toBeLessThanOrEqual(MAX_PAD_RUN);
      }
      expect(wireXs.size).toBeGreaterThan(0);
    }
  });
});
