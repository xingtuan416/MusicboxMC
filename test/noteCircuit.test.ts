import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { song } from './helpers/song';

const cfg = { ...DEFAULT_LAYOUT_CONFIG };

/** Single notes, 3-note and 5-note chords and mixed spacing, covering both inline and branch-row geometry. */
const CASES: Array<Array<{ tick: number; midi: number }>> = [
  [{ tick: 0, midi: 60 }],
  [
    { tick: 0, midi: 60 },
    { tick: 0, midi: 64 },
    { tick: 0, midi: 67 },
  ],
  [60, 62, 64, 65, 67].map((midi) => ({ tick: 6, midi })),
  [
    { tick: 0, midi: 60 },
    { tick: 6, midi: 62 },
    { tick: 6, midi: 64 },
    { tick: 30, midi: 65 },
  ],
];

/** The block on a track's circuit layer (y = circuitY) at (x, z relative to zBase). */
function at(
  res: ReturnType<typeof layout>,
  trackIdx: number,
  x: number,
  zRel: number,
): { block: string; props?: Record<string, string> } | undefined {
  const tr = res.tracks[trackIdx]!;
  return tr.placements.find((p) => p.pos.x === x && p.pos.y === cfg.circuitY && p.pos.z === tr.zBase + zRel);
}

describe('note circuit geometry (note blocks inline on the main line, branch repeaters powered directly)', () => {
  it('leaves air directly above every note block, or it cannot sound', () => {
    for (const notes of CASES) {
      const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
      for (const tr of res.tracks) {
        const occupied = new Set(tr.placements.map((p) => `${p.pos.x},${p.pos.y},${p.pos.z}`));
        for (const p of tr.placements) {
          if (p.block !== 'minecraft:note_block') continue;
          expect(occupied.has(`${p.pos.x},${p.pos.y + 1},${p.pos.z}`)).toBe(false);
        }
      }
    }
  });

  it('supports every circuit-layer block, so no dust, repeater or note block floats', () => {
    for (const notes of CASES) {
      const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
      for (const tr of res.tracks) {
        const occupied = new Set(tr.placements.map((p) => `${p.pos.x},${p.pos.y},${p.pos.z}`));
        for (const p of tr.placements) {
          if (p.pos.y !== cfg.circuitY) continue;
          expect(occupied.has(`${p.pos.x},${p.pos.y - 1},${p.pos.z}`)).toBe(true);
        }
      }
    }
  });

  it('faces every repeater west (input from the -X line, output to the +X note block) with delay 1-4', () => {
    for (const notes of CASES) {
      const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
      for (const tr of res.tracks) {
        for (const p of tr.placements) {
          if (p.block !== 'minecraft:repeater') continue;
          expect(p.props?.facing).toBe('west');
          const delay = Number(p.props?.delay);
          expect(delay).toBeGreaterThanOrEqual(1);
          expect(delay).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it('lays a single note as [repeater][note block] along +X, with no branch column and input from the block behind', () => {
    // First group at rt 0, so the whole track gets the +1 redstone tick lead-in; group 1
    // occupies x=0..1 and there is no dust anywhere.
    const res = layout(song([{ tick: 0, midi: 60 }]), { config: cfg, regions: DEFAULT_REGIONS });
    expect(at(res, 0, 0, 0)?.block).toBe('minecraft:repeater');
    expect(at(res, 0, 1, 0)?.block).toBe('minecraft:note_block');
    expect(res.tracks[0]!.placements.some((p) => p.block === 'minecraft:redstone_wire')).toBe(false);
  });

  it('keeps the starting dust cell as the power connection point when the first group has repeaters ahead of it', () => {
    // First note at rt 5 (tick 10), so there are repeaters ahead of the group and a
    // starting dust cell is laid for the player to apply power to.
    const res = layout(song([{ tick: 10, midi: 60 }]), { config: cfg, regions: DEFAULT_REGIONS });
    expect(at(res, 0, 0, 0)?.block).toBe('minecraft:redstone_wire');
    expect(res.tracks[0]!.placements.filter((p) => p.block === 'minecraft:redstone_wire')).toHaveLength(1);
  });

  it('for up to 3 notes powers only the inline one and lights the neighbours by a single hop', () => {
    // 3-note chord: the inline row plus the rows above and below it, with a single
    // repeater and a single dust cell.
    const res = layout(
      song([
        { tick: 0, midi: 60 },
        { tick: 0, midi: 64 },
        { tick: 0, midi: 67 },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    // Main row: repeater -> note block, with no branch column.
    expect(at(res, 0, 0, 0)?.block).toBe('minecraft:repeater');
    // All three rows hold note blocks: the inline one plus the two conducted rows.
    for (const zRel of [-1, 0, 1]) {
      expect(at(res, 0, 1, zRel)?.block).toBe('minecraft:note_block');
    }
    // Conducted rows carry neither dust nor repeaters.
    for (const zRel of [-1, 1]) {
      expect(at(res, 0, 0, zRel)).toBeUndefined();
    }
    // The whole track has exactly one repeater and zero dust cells.
    const tr = res.tracks[0]!;
    expect(tr.placements.filter((p) => p.block === 'minecraft:repeater')).toHaveLength(1);
    expect(tr.placements.filter((p) => p.block === 'minecraft:redstone_wire')).toHaveLength(0);
  });

  it('treats 2 notes the same way: one repeater and two adjacent note blocks', () => {
    const res = layout(
      song([
        { tick: 0, midi: 60 },
        { tick: 0, midi: 64 },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(at(res, 0, 1, 0)?.block).toBe('minecraft:note_block');
    expect(at(res, 0, 1, 1)?.block).toBe('minecraft:note_block');
    expect(at(res, 0, 0, 1)).toBeUndefined();
    const repeaters = res.tracks[0]!.placements.filter((p) => p.block === 'minecraft:repeater').length;
    expect(repeaters).toBe(1);
  });

  it('switches to branch mode from 4 notes up, giving each extra note its own row and repeater', () => {
    const res4 = layout(song([60, 64, 67, 69].map((midi) => ({ tick: 0, midi }))), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    // Branch rows -1, +1 and +2 each carry dust and a repeater.
    for (const zRel of [-1, 0, 1, 2]) {
      expect(at(res4, 0, 2, zRel)?.block).toBe('minecraft:note_block');
      expect(at(res4, 0, 0, zRel)?.block).toBe('minecraft:redstone_wire');
      expect(at(res4, 0, 1, zRel)?.block).toBe('minecraft:repeater');
    }
    expect(at(res4, 0, 2, -2)?.block).toBeUndefined();
    const repeaters = res4.tracks[0]!.placements.filter((p) => p.block === 'minecraft:repeater').length;
    expect(repeaters).toBe(4);
  });

  it('writes dust connections explicitly so the schematic does not load as unconnected dots', () => {
    const res = layout(song([60, 64, 67, 69].map((midi) => ({ tick: 0, midi }))), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    const wire = res.tracks[0]!.placements.find(
      (p) => p.block === 'minecraft:redstone_wire' && p.pos.z === 1,
    );
    expect(wire?.props).toMatchObject({
      north: 'none',
      east: 'side',
      south: 'side',
      west: 'none',
      power: '0',
    });
  });

  it('writes an unpowered schematic: dust at power=0, repeaters and note blocks powered=false', () => {
    for (const notes of CASES) {
      const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
      for (const tr of res.tracks) {
        for (const p of tr.placements) {
          if (p.block === 'minecraft:redstone_wire') expect(p.props?.power).toBe('0');
          if (p.block === 'minecraft:repeater') expect(p.props?.powered).toBe('false');
          if (p.block === 'minecraft:note_block') expect(p.props?.powered).toBe('false');
        }
      }
    }
  });

  it('conserves the note count, inventing none and losing none within the truncation limit', () => {
    for (const notes of CASES) {
      const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
      const nb = res.tracks.reduce(
        (s, t) => s + t.placements.filter((p) => p.block === 'minecraft:note_block').length,
        0,
      );
      expect(nb).toBe(notes.length);
    }
  });

  it('writes the instrument blockstate the resource pack needs', () => {
    const res = layout(
      song([
        { tick: 0, midi: 30 },
        { tick: 2, midi: 54 },
        { tick: 4, midi: 78 },
      ]),
      {
        config: cfg,
        regions: DEFAULT_REGIONS,
      },
    );
    const instruments = res.tracks[0]!.placements.filter((p) => p.block === 'minecraft:note_block').map(
      (p) => p.props?.instrument,
    );
    expect(instruments).toEqual(['bass', 'guitar', 'flute']);
  });
});
