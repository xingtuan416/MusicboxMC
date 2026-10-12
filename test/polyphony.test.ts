import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import {
  branchRow,
  buildTrack,
  chordRowLayout,
  chordRows,
  MAX_CHORD_NOTES,
  MAX_SIDE_ROWS,
} from '../src/core/layout/track';
import { song } from './helpers/song';

const cfg = { ...DEFAULT_LAYOUT_CONFIG };

describe('branchRow / chordRows (branch row assignment)', () => {
  it('alternates sides as +1, -1, +2, -2, ...', () => {
    expect([0, 1, 2, 3, 4, 5].map(branchRow)).toEqual([
      { side: 1, row: 1 },
      { side: -1, row: 1 },
      { side: 1, row: 2 },
      { side: -1, row: 2 },
      { side: 1, row: 3 },
      { side: -1, row: 3 },
    ]);
  });

  it('computes chordRows as the rows reached to one side, ceil((n-1)/2)', () => {
    expect(chordRows(0)).toBe(0);
    expect(chordRows(1)).toBe(0);
    expect(chordRows(2)).toBe(1);
    expect(chordRows(3)).toBe(1);
    expect(chordRows(4)).toBe(2);
    expect(chordRows(29)).toBe(14);
  });

  it('derives column capacity from signal strength: 1 inline plus MAX_SIDE_ROWS rows on each side', () => {
    expect(MAX_SIDE_ROWS).toBe(14);
    expect(MAX_CHORD_NOTES).toBe(2 * MAX_SIDE_ROWS + 1);
  });
});

describe('chordRowLayout (single hop up to 3 notes, branch rows from 4)', () => {
  it('n=1: only the inline note', () => {
    expect(chordRowLayout(1)).toEqual([]);
  });

  it('n=2 and n=3: all rows are conducted, with no dust and no repeaters', () => {
    expect(chordRowLayout(2)).toEqual([{ side: 1, row: 1, conducted: true }]);
    expect(chordRowLayout(3)).toEqual([
      { side: -1, row: 1, conducted: true },
      { side: 1, row: 1, conducted: true },
    ]);
    for (const n of [2, 3]) {
      for (const r of chordRowLayout(n)) expect(r.conducted).toBe(true);
    }
  });

  it('n>=4: all rows are branch rows with their own repeater, ordered +1,-1,+2,-2, ...', () => {
    const rows = chordRowLayout(4);
    expect(rows.every((r) => !r.conducted)).toBe(true);
    expect(rows.map((r) => r.side * r.row)).toEqual([1, -1, 2]);
  });

  it('never exceeds chordRows on one side, keeping the Z span unchanged', () => {
    for (let n = 2; n <= 29; n++) {
      const rows = chordRowLayout(n);
      expect(Math.max(...rows.map((r) => r.row))).toBe(chordRows(n));
      expect(rows.length).toBe(n - 1);
    }
  });
});

describe('chord capacity and overflow splitting', () => {
  it('fits a chord of MAX_CHORD_NOTES on one track without a capacity warning', () => {
    const notes = Array.from({ length: MAX_CHORD_NOTES }, (_, i) => ({
      tick: 0,
      midi: 48 + (i % 12),
    }));
    const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
    expect(res.tracks).toHaveLength(1);
    expect(res.warnings.some((w) => w.code === 'POLYPHONY_EXCEEDED')).toBe(false);
    const nb = res.tracks[0]!.placements.filter((p) => p.block === 'minecraft:note_block').length;
    expect(nb).toBe(MAX_CHORD_NOTES);
  });

  it('moves the surplus to a new track (TRACK_SPLIT) without losing notes', () => {
    const notes = Array.from({ length: MAX_CHORD_NOTES + 5 }, (_, i) => ({
      tick: 0,
      midi: 48 + (i % 12),
    }));
    const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
    expect(res.tracks).toHaveLength(2);
    expect(res.warnings.some((w) => w.code === 'POLYPHONY_EXCEEDED')).toBe(true);
    const nb = res.tracks.reduce(
      (s, t) => s + t.placements.filter((p) => p.block === 'minecraft:note_block').length,
      0,
    );
    expect(nb).toBe(notes.length);
  });

  it('truncates and warns instead of throwing when collectOverflow is false', () => {
    const notes = Array.from({ length: MAX_CHORD_NOTES + 3 }, (_, i) => ({
      tick: 0,
      midi: 48 + (i % 12),
    }));
    const res = buildTrack({
      trackIndex: 0,
      zBase: 0,
      notes: notes.map((n) => ({ tick: n.tick, midi: n.midi })),
      config: cfg,
      regions: DEFAULT_REGIONS,
      resolve: () => 'minecraft:dirt',
    });
    expect(res.warnings.some((w) => w.code === 'POLYPHONY_EXCEEDED')).toBe(true);
    expect(res.overflow).toHaveLength(0);
    const nb = res.track.placements.filter((p) => p.block === 'minecraft:note_block').length;
    expect(nb).toBe(MAX_CHORD_NOTES);
  });
});

describe('grouping notes and handling out-of-range pitches', () => {
  it('merges notes within one redstone tick (ticks 1 and 2 both quantise to rt 1)', () => {
    const res = layout(
      song([
        { tick: 1, midi: 60 },
        { tick: 2, midi: 64 },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(res.placed).toHaveLength(1);
    const nb = res.tracks[0]!.placements.filter((p) => p.block === 'minecraft:note_block').length;
    expect(nb).toBe(2);
  });

  it('outOfRange=drop: drops out-of-range notes with a warning and places the rest', () => {
    // The default range F#1..F#7 is MIDI 30..102, so MIDI 10 is outside every region.
    const res = buildTrack({
      trackIndex: 0,
      zBase: 0,
      notes: [
        { tick: 0, midi: 10 },
        { tick: 10, midi: 60 },
      ],
      config: cfg,
      regions: DEFAULT_REGIONS,
      resolve: () => 'minecraft:dirt',
      outOfRange: 'drop',
    });
    expect(res.warnings.some((w) => w.code === 'OUT_OF_RANGE' && w.midi === 10)).toBe(true);
    const nb = res.track.placements.filter((p) => p.block === 'minecraft:note_block').length;
    expect(nb).toBe(1);
  });

  it('outOfRange=warn: shifts by octaves and reports it', () => {
    const res = buildTrack({
      trackIndex: 0,
      zBase: 0,
      notes: [{ tick: 0, midi: 10 }],
      config: cfg,
      regions: DEFAULT_REGIONS,
      resolve: () => 'minecraft:dirt',
      outOfRange: 'warn',
    });

    expect(res.track.placements.some((p) => p.block === 'minecraft:note_block')).toBe(true);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'OUT_OF_RANGE', midi: 10, action: 'warn', trackIndex: 0 }),
    );
  });

  it('outOfRange=octave: shifts by octaves without an ordinary warning', () => {
    const res = buildTrack({
      trackIndex: 0,
      zBase: 0,
      notes: [{ tick: 0, midi: 10 }],
      config: cfg,
      regions: DEFAULT_REGIONS,
      resolve: () => 'minecraft:dirt',
      outOfRange: 'octave',
    });

    expect(res.track.placements.some((p) => p.block === 'minecraft:note_block')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'OUT_OF_RANGE')).toBe(false);
  });

  it('outOfRange=clamp: uses the nearest available pitch and reports it', () => {
    const res = buildTrack({
      trackIndex: 0,
      zBase: 0,
      notes: [{ tick: 0, midi: 10 }],
      config: cfg,
      regions: DEFAULT_REGIONS,
      resolve: () => 'minecraft:dirt',
      outOfRange: 'clamp',
    });

    expect(res.track.placements.some((p) => p.block === 'minecraft:note_block')).toBe(true);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'OUT_OF_RANGE', midi: 10, action: 'clamp', trackIndex: 0 }),
    );
  });
});
