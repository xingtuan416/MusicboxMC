import { describe, expect, it } from 'vitest';
import {
  coveredRange,
  DEFAULT_REGIONS,
  mapPitch,
  PIANO_REGIONS,
  regionsFor,
  type NoteBlockInstrument,
  type RegionTable,
} from '../src/core/palette/pitchMap';

/**
 * Two palettes, and the difference between them is the whole point of the setting
 * they back: the full one reaches F#1-F#7 by using five vanilla instruments, which
 * is what makes the companion resource pack worth having; the piano one uses the
 * harp slot alone so that no resource pack is needed at all.
 */
function instrumentsUsed(regions: RegionTable): NoteBlockInstrument[] {
  const used = new Set<NoteBlockInstrument>();
  for (let midi = 0; midi <= 127; midi++) {
    const mapped = mapPitch(midi, regions, 'clamp');
    if (!mapped.dropped) used.add(mapped.instrument);
  }
  return [...used].sort();
}

describe('pitch palette', () => {
  it('reaches F#1-F#7 with the full palette', () => {
    expect(coveredRange(DEFAULT_REGIONS)).toEqual([30, 102]);
  });

  it('reaches exactly two octaves with the piano palette', () => {
    expect(coveredRange(PIANO_REGIONS)).toEqual([54, 78]);
  });

  it('uses all five vanilla instruments for the full range, and one for the piano range', () => {
    expect(instrumentsUsed(DEFAULT_REGIONS)).toEqual(['bass', 'bell', 'flute', 'guitar', 'harp']);
    expect(instrumentsUsed(PIANO_REGIONS)).toEqual(['harp']);
  });

  it('resolves each palette by name', () => {
    expect(regionsFor('full')).toBe(DEFAULT_REGIONS);
    expect(regionsFor('piano')).toBe(PIANO_REGIONS);
  });

  it('agrees in the middle, where both palettes use the harp slot', () => {
    const full = mapPitch(60, DEFAULT_REGIONS, 'warn');
    const piano = mapPitch(60, PIANO_REGIONS, 'warn');
    expect(piano).toEqual(full);
    expect(piano.instrument).toBe('harp');
    expect(piano.degraded).toBe(false);
  });

  it('hands notes below F#3 to the out-of-range policy in the piano palette', () => {
    // F#1 is ordinary for the full palette and out of reach for the piano one.
    expect(mapPitch(30, DEFAULT_REGIONS, 'warn').degraded).toBe(false);

    const shifted = mapPitch(30, PIANO_REGIONS, 'octave');
    expect(shifted.degraded).toBe(true);
    expect(shifted.dropped).toBe(false);
    expect(shifted.note).toBeGreaterThanOrEqual(0);
    expect(shifted.note).toBeLessThanOrEqual(24);
    expect(shifted.instrument).toBe('harp');

    expect(mapPitch(30, PIANO_REGIONS, 'drop').dropped).toBe(true);
  });

  it('never places a note outside the palette it was given', () => {
    for (const palette of [DEFAULT_REGIONS, PIANO_REGIONS]) {
      const [low, high] = coveredRange(palette);
      for (let midi = 0; midi <= 127; midi++) {
        for (const policy of ['warn', 'clamp', 'octave'] as const) {
          const mapped = mapPitch(midi, palette, policy);
          if (mapped.dropped) continue;
          const sounded = (palette[mapped.region]?.baseMidi ?? 0) + mapped.note;
          expect(sounded, `midi ${midi} under ${policy}`).toBeGreaterThanOrEqual(low);
          expect(sounded, `midi ${midi} under ${policy}`).toBeLessThanOrEqual(high);
        }
      }
    }
  });
});
