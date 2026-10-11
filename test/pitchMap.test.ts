import { describe, expect, it } from 'vitest';
import { DEFAULT_REGIONS, mapPitch } from '../src/core/palette/pitchMap';

describe('pitch mapping for the full-range piano resource pack', () => {
  it('covers F#1 to F#7 (MIDI 30 to 102) and uses note=12 at the sample centre', () => {
    const expected = [
      [30, 'A', 'bass', 0],
      [42, 'A', 'bass', 12],
      [54, 'B', 'guitar', 12],
      [66, 'C', 'harp', 12],
      [78, 'D', 'flute', 12],
      [102, 'E', 'bell', 24],
    ] as const;

    for (const [midi, region, instrument, note] of expected) {
      const mapped = mapPitch(midi, DEFAULT_REGIONS, 'drop');
      expect(mapped.dropped).toBe(false);
      expect(mapped.region).toBe(region);
      expect(mapped.instrument).toBe(instrument);
      expect(mapped.note).toBe(note);
    }
  });

  it('picks the region closest to the sample centre where regions overlap', () => {
    expect(mapPitch(47).region).toBe('A');
    expect(mapPitch(48).region).toBe('B');
    expect(mapPitch(59).region).toBe('B');
    expect(mapPitch(60).region).toBe('C');
    expect(mapPitch(71).region).toBe('C');
    expect(mapPitch(72).region).toBe('D');
    expect(mapPitch(83).region).toBe('D');
    expect(mapPitch(84).region).toBe('E');
  });

  it('applies the chosen policy below F#1 and above F#7', () => {
    expect(mapPitch(29, DEFAULT_REGIONS, 'drop').dropped).toBe(true);
    expect(mapPitch(103, DEFAULT_REGIONS, 'drop').dropped).toBe(true);

    const low = mapPitch(29, DEFAULT_REGIONS, 'clamp');
    expect(low.dropped).toBe(false);
    expect(low.region).toBe('A');
    expect(low.note).toBe(0);

    const high = mapPitch(103, DEFAULT_REGIONS, 'clamp');
    expect(high.dropped).toBe(false);
    expect(high.region).toBe('E');
    expect(high.note).toBe(24);
  });
});
