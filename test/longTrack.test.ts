import { describe, expect, it } from 'vitest';
import { analyze } from '../src/main/analyze';
import { layout } from '../src/core/layout';
import { assignTracks } from '../src/core/palette/assignment';
import { numericRange } from '../src/core/numericRange';
import { songOfSpecs } from './helpers/song';

/**
 * A track can hold more notes than a function call can carry arguments.
 * `Math.min(...notes)` used to fail while merely importing the file.
 */
const LONG_TRACK_NOTES = 200_000;

const longTrack = songOfSpecs([
  {
    program: 73, // GM flute, so native mode exercises the fixed-instrument span check.
    notes: Array.from({ length: LONG_TRACK_NOTES }, (_, index) => ({ tick: index, midi: 0 })),
  },
]);

describe('very long tracks do not overflow the call stack', () => {
  it('summarises a track with 200,000 notes', () => {
    const result = analyze(longTrack, 'long.mid');
    expect(result.tracks[0]!.noteCount).toBe(LONG_TRACK_NOTES);
    expect(result.tracks[0]!.minTick).toBe(0);
    expect(result.tracks[0]!.maxTick).toBe(LONG_TRACK_NOTES - 1);
  });

  it('checks a fixed-instrument pitch span with 200,000 notes', () => {
    const assignments = Object.fromEntries(
      assignTracks(longTrack, 'native').map((item) => [item.trackIndex, item]),
    );
    const result = layout(longTrack, { assignments, outOfRange: 'drop' });
    expect(result.tracks.every((track) => track.placements.length === 0)).toBe(true);
    expect(result.placed).toHaveLength(0);
  });

  it('scans bounds without a variadic call', () => {
    expect(numericRange([])).toBeNull();
    expect(numericRange(Array.from({ length: LONG_TRACK_NOTES }, (_, index) => index))).toEqual({
      min: 0,
      max: LONG_TRACK_NOTES - 1,
    });
  });
});
