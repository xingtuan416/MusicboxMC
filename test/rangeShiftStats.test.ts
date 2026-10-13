import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout';
import { songOfTracks } from './helpers/song';

/**
 * `outOfRangeNotes` is derived from the warning list, and the `octave` policy is
 * deliberately silent per note - so a song whose notes had all been shifted reported
 * zero, while the overview claimed that silent degradation was not an option.
 *
 * The statistic now comes from the mapping itself, which is the only place that knows how
 * far a note was actually moved.
 */
describe('range shift statistics', () => {
  it('counts shifted notes even when the policy reports nothing per note', () => {
    const notes = Array.from({ length: 100 }, () => ({ tick: 0, midi: 103 }));
    const result = layout(songOfTracks([notes]), { outOfRange: 'octave' });

    expect(result.warnings.filter((w) => w.code === 'OUT_OF_RANGE')).toHaveLength(0);
    expect(result.rangeShift.notes).toBe(100);
    // 103 is one semitone above the range, so one octave down is enough.
    expect(result.rangeShift.maxSemitones).toBe(12);
  });

  it('reports nothing when no note was moved', () => {
    const result = layout(songOfTracks([[{ tick: 0, midi: 60 }]]));
    expect(result.rangeShift).toEqual({ notes: 0, maxSemitones: 0 });
  });

  it('reports the largest move rather than the last one', () => {
    const result = layout(
      songOfTracks([
        [
          { tick: 0, midi: 103 },
          { tick: 10, midi: 115 },
        ],
      ]),
      { outOfRange: 'octave' },
    );
    expect(result.rangeShift.notes).toBe(2);
    // 103 needs one octave; 115 needs two.
    expect(result.rangeShift.maxSemitones).toBe(24);
  });

  it('counts each source note once when a chord is split across lanes', () => {
    // The same rule as the warnings: the later lanes re-map the notes they carry.
    const notes = Array.from({ length: 60 }, () => ({ tick: 0, midi: 10 }));
    const result = layout(songOfTracks([notes]), { outOfRange: 'octave' });
    expect(result.tracks.length).toBeGreaterThan(1);
    expect(result.rangeShift.notes).toBe(60);
  });
});
