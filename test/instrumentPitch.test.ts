import { describe, expect, it } from 'vitest';
import { chooseOctaveOffset, mapDrumNote, mapPitchToInstrument } from '../src/core/palette/instrumentPitch';

/**
 * Fitting a track onto one instrument's two octaves.
 *
 * The whole-track offset is what keeps a melody's contour intact; the per-note policy
 * is only for the few notes that still do not fit afterwards.
 */

const notes = (...midis: number[]): Array<{ midi: number }> => midis.map((midi) => ({ midi }));

describe('whole-track octave fit', () => {
  it('leaves a track that already fits alone', () => {
    expect(chooseOctaveOffset(notes(60, 67, 74), 'harp')).toEqual({ offset: 0, outside: 0 });
  });

  it('lifts a flute part by one octave and a bell part by two', () => {
    expect(chooseOctaveOffset(notes(60, 67, 74), 'flute')).toEqual({ offset: 1, outside: 0 });
    expect(chooseOctaveOffset(notes(60, 67), 'bell')).toEqual({ offset: 2, outside: 0 });
  });

  it('drops a guitar, pling or bass part by one octave when that fits it', () => {
    expect(chooseOctaveOffset(notes(55, 60, 72), 'guitar')).toEqual({ offset: -1, outside: 0 });
    expect(chooseOctaveOffset(notes(72, 78, 84), 'pling')).toEqual({ offset: -1, outside: 0 });
    expect(chooseOctaveOffset(notes(48, 55, 62), 'bass')).toEqual({ offset: -1, outside: 0 });
  });

  it('keeps the shift and reports the single note that still does not fit', () => {
    expect(chooseOctaveOffset(notes(53, 54, 72), 'iron_xylophone')).toEqual({
      offset: 0,
      outside: 1,
    });
    expect(chooseOctaveOffset(notes(64, 79), 'banjo')).toEqual({ offset: 0, outside: 1 });
  });

  it('reports overflow for a track wider than two octaves', () => {
    const fit = chooseOctaveOffset(notes(30, 55, 80), 'harp');
    expect(fit.outside).toBeGreaterThan(0);
  });

  it('does not shift fixed-pitch drums', () => {
    expect(chooseOctaveOffset(notes(36, 38, 42), 'basedrum')).toEqual({ offset: 0, outside: 0 });
  });
});

describe('mapping one pitch onto one instrument', () => {
  it('anchors note 0 at the instrument F#', () => {
    expect(mapPitchToInstrument(54, 'harp').note).toBe(0);
    expect(mapPitchToInstrument(78, 'harp').note).toBe(24);
    expect(mapPitchToInstrument(60, 'harp').note).toBe(6);
    expect(mapPitchToInstrument(42, 'guitar').note).toBe(0);
    expect(mapPitchToInstrument(78, 'bell').note).toBe(0);
  });

  it('applies the whole-track offset before checking the range', () => {
    const mapped = mapPitchToInstrument(60, 'flute', 'warn', 0, 1);
    expect(mapped).toMatchObject({ note: 6, degraded: false, shiftSemitones: 0 });
  });

  it('moves a residual note by the nearest octave and reports it', () => {
    const mapped = mapPitchToInstrument(53, 'iron_xylophone', 'warn');
    expect(mapped).toMatchObject({ note: 11, degraded: true, shiftSemitones: 12 });
  });

  it('clamps or drops at the extremes when asked', () => {
    expect(mapPitchToInstrument(80, 'harp', 'clamp')).toMatchObject({
      note: 24,
      degraded: true,
      dropped: false,
    });
    expect(mapPitchToInstrument(80, 'harp', 'drop')).toMatchObject({ dropped: true });
  });

  it('applies the per-track transpose in octaves', () => {
    expect(mapPitchToInstrument(60, 'harp', 'warn', 1).note).toBe(18);
  });

  it('writes fixed-pitch drums at note 0 with their own base block', () => {
    const mapped = mapPitchToInstrument(36, 'basedrum');
    expect(mapped).toMatchObject({
      note: 0,
      block: 'minecraft:stone',
      degraded: false,
      dropped: false,
    });
  });
});

describe('drum note mapping', () => {
  it('maps a standard kick note to basedrum at note 0', () => {
    expect(mapDrumNote(36)).toMatchObject({ instrument: 'basedrum', note: 0 });
  });

  it('uses the track title for cow bell', () => {
    expect(mapDrumNote(56, 'Cow Bell - Soul Sand')).toMatchObject({ instrument: 'cow_bell' });
    expect(mapDrumNote(56, 'Drums')).toBeNull();
  });
});
