import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGIONS,
  mapPitch,
  PIANO_REGIONS,
  type OutOfRangePolicy,
  type RegionTable,
} from '../src/core/palette/pitchMap';

/**
 * What a note actually sounds at, after region selection and any octave shift.
 *
 * The old formula anchored on the low end of the range, so anything above the top was
 * folded all the way to the bottom: MIDI 103, one semitone above F#7, came back as MIDI
 * 31 - 72 semitones lower and four instrument slots away - when a single octave down to
 * 91 was available. Low notes happened to land on the nearest octave, so the asymmetry
 * survived.
 */
function sounded(midi: number, policy: OutOfRangePolicy, regions: RegionTable = DEFAULT_REGIONS) {
  const mapped = mapPitch(midi, regions, policy);
  return (regions[mapped.region]?.baseMidi ?? 0) + mapped.note;
}

describe('octave shifting moves as little as it can', () => {
  it('drops a note just above the range by one octave, not to the bottom', () => {
    expect(sounded(103, 'octave')).toBe(91);
  });

  it('never drops further than the nearest octave', () => {
    // Asserted as a property rather than a table: for each note the result is in range,
    // and one octave less of a shift would still be above it.
    for (const midi of [103, 110, 115, 120, 127]) {
      const shifted = sounded(midi, 'octave');
      expect(shifted, `midi ${midi}`).toBeGreaterThanOrEqual(30);
      expect(shifted, `midi ${midi}`).toBeLessThanOrEqual(102);
      // The shift was downwards, so one octave less of it means adding 12 back.
      expect(shifted + 12, `midi ${midi}, one octave less`).toBeGreaterThan(102);
    }
  });

  it('raises a note just below the range by one octave', () => {
    expect(sounded(29, 'octave')).toBe(41);
  });

  it('never raises further than the nearest octave', () => {
    for (const midi of [29, 25, 20, 10, 0]) {
      const shifted = sounded(midi, 'octave');
      expect(shifted, `midi ${midi}`).toBeGreaterThanOrEqual(30);
      expect(shifted, `midi ${midi}`).toBeLessThanOrEqual(102);
      // The shift was upwards, so one octave less of it means taking 12 back off.
      expect(shifted - 12, `midi ${midi}, one octave less`).toBeLessThan(30);
    }
  });

  it('leaves an in-range note alone', () => {
    for (const midi of [30, 60, 91, 102]) {
      expect(sounded(midi, 'octave'), `midi ${midi}`).toBe(midi);
    }
  });

  it('applies the same rule to the narrow palette', () => {
    // F#3 to F#5. One octave either way is enough for anything nearby.
    expect(sounded(42, 'octave', PIANO_REGIONS)).toBe(54);
    expect(sounded(90, 'octave', PIANO_REGIONS)).toBe(78);
  });

  it('still respects the other out-of-range policies', () => {
    expect(sounded(103, 'clamp')).toBe(102);
    expect(mapPitch(103, DEFAULT_REGIONS, 'drop').dropped).toBe(true);
  });
});
