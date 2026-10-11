import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { songOfSpecs } from './helpers/song';

/**
 * Merging tracks that share an instrument (opt-in, off by default).
 *
 * MIDI tracks with the same instrument merge onto one main line: those notes now sit
 * on the same line, so cross-track X drift cannot happen. Percussion is its own class.
 */

const cfg = { ...DEFAULT_LAYOUT_CONFIG };

function noteBlocks(res: ReturnType<typeof layout>): number {
  return res.tracks.reduce(
    (s, t) => s + t.placements.filter((p) => p.block === 'minecraft:note_block').length,
    0,
  );
}

describe('merging tracks that share an instrument', () => {
  it('is off by default: one line per track', () => {
    const res = layout(
      songOfSpecs([
        { instrument: 'Acoustic Grand Piano', notes: [{ tick: 0, midi: 60 }] },
        { instrument: 'Acoustic Grand Piano', notes: [{ tick: 20, midi: 64 }] },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(res.tracks).toHaveLength(2);
    expect(noteBlocks(res)).toBe(2);
  });

  it('merges two tracks with the same instrument onto one line, conserving notes', () => {
    const res = layout(
      songOfSpecs([
        { instrument: 'Acoustic Grand Piano', notes: [{ tick: 0, midi: 60 }] },
        { instrument: 'Acoustic Grand Piano', notes: [{ tick: 20, midi: 64 }] },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS, mergeSameInstrument: true },
    );
    expect(res.tracks).toHaveLength(1);
    expect(noteBlocks(res)).toBe(2);
  });

  it('does not merge different instruments', () => {
    const res = layout(
      songOfSpecs([
        { instrument: 'Acoustic Grand Piano', notes: [{ tick: 0, midi: 60 }] },
        { instrument: 'Violin', notes: [{ tick: 0, midi: 64 }] },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS, mergeSameInstrument: true },
    );
    expect(res.tracks).toHaveLength(2);
  });

  it('keeps percussion in its own class, apart from melodic instruments', () => {
    const res = layout(
      songOfSpecs([
        { instrument: 'Acoustic Grand Piano', notes: [{ tick: 0, midi: 60 }] },
        { instrument: 'Steel Drums', percussion: true, notes: [{ tick: 0, midi: 40 }] },
        { instrument: 'Woodblock', percussion: true, notes: [{ tick: 20, midi: 42 }] },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS, mergeSameInstrument: true },
    );
    // One line for the melody plus one for percussion
    expect(res.tracks).toHaveLength(2);
    expect(noteBlocks(res)).toBe(3);
  });

  it('turns simultaneous notes into a chord on one branch column, splitting past capacity without losing notes', () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({ tick: 0, midi: 48 + (i % 12) }));
    const res = layout(
      songOfSpecs([
        { instrument: 'Piano', notes },
        { instrument: 'Piano', notes },
      ]),
      {
        config: cfg,
        regions: DEFAULT_REGIONS,
        mergeSameInstrument: true,
      },
    );
    // 80 notes on one tick against a column capacity of 29: split across several lines,
    // with no note lost
    expect(res.tracks.length).toBeGreaterThanOrEqual(3);
    expect(noteBlocks(res)).toBe(80);
  });

  it('keeps the index of the first original track in the merged group', () => {
    const res = layout(
      songOfSpecs([
        { instrument: 'Piano', notes: [{ tick: 0, midi: 60 }] },
        { instrument: 'Piano', notes: [{ tick: 20, midi: 64 }] },
        { instrument: 'Violin', notes: [{ tick: 40, midi: 67 }] },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS, mergeSameInstrument: true },
    );
    expect(res.tracks.map((t) => t.trackIndex)).toEqual([0, 2]);
  });
});
