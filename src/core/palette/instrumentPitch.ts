import { drumInstrument } from './instrumentMap';
import { INSTRUMENTS, type NoteBlockInstrument } from './instruments';
import type { OutOfRangePolicy, PitchRegion } from './pitchMap';

/**
 * Mapping a MIDI pitch onto one fixed note-block instrument.
 *
 * Unlike the five-slot palette, the instrument is chosen by the track, not by the
 * pitch. The only freedom left is which octave the whole track is played in: each
 * instrument covers two octaves, and a track written elsewhere has to be moved as a
 * unit or its melody would jump octaves note by note.
 */

export interface InstrumentPitch {
  dropped: boolean;
  midi: number;
  note: number;
  block: string;
  instrument: NoteBlockInstrument;
  /** Set only for the five-slot palette; a fixed instrument has no pitch region. */
  region?: PitchRegion;
  degraded: boolean;
  /** Semitones this note was moved by the out-of-range policy, after the track offset. */
  shiftSemitones: number;
}

export interface OctaveFit {
  /** Whole-track octave shift: -2, -1, 0, 1 or 2. */
  offset: number;
  /** Notes still outside the instrument's range after applying the shift. */
  outside: number;
}

/**
 * Pick one octave offset for a whole track.
 *
 * The offset that leaves the fewest notes outside the instrument's two octaves wins;
 * a tie goes to the smallest shift, so a track that already fits is never moved. The
 * residual notes are then handled by the out-of-range policy.
 */
export function chooseOctaveOffset(
  notes: ReadonlyArray<{ midi: number }>,
  instrument: NoteBlockInstrument,
  transpose = 0,
): OctaveFit {
  const range = INSTRUMENTS[instrument].range;
  if (range === null) return { offset: 0, outside: 0 };
  const [low, high] = range;

  let best: OctaveFit = { offset: 0, outside: Number.POSITIVE_INFINITY };
  for (let offset = -2; offset <= 2; offset++) {
    let outside = 0;
    for (const note of notes) {
      // `transpose` is the user's per-track octave override and is applied before the
      // automatic fit, exactly as `mapPitchToInstrument` will apply it later.
      const sounding = note.midi + 12 * (offset + transpose);
      if (sounding < low || sounding > high) outside += 1;
    }
    if (outside < best.outside || (outside === best.outside && Math.abs(offset) < Math.abs(best.offset))) {
      best = { offset, outside };
    }
  }
  return best;
}

/**
 * Map one pitch onto one instrument.
 *
 * `octaveOffset` is the whole-track shift from `chooseOctaveOffset`; `transpose` is the
 * per-track user override in octaves. A note still outside after both is moved by the
 * out-of-range policy, and `warn` is what makes that visible per note.
 */
export function mapPitchToInstrument(
  midi: number,
  instrument: NoteBlockInstrument,
  policy: OutOfRangePolicy = 'warn',
  transpose = 0,
  octaveOffset = 0,
): InstrumentPitch {
  const def = INSTRUMENTS[instrument];
  const base = {
    midi,
    instrument,
    block: def.baseBlock,
  };

  if (def.range === null || def.anchorMidi === null) {
    // Fixed-pitch percussion: the note value is ignored by the game.
    return { ...base, dropped: false, note: 0, degraded: false, shiftSemitones: 0 };
  }

  const sounding = midi + 12 * transpose + 12 * octaveOffset;
  const note = sounding - def.anchorMidi;
  if (note >= 0 && note <= 24) {
    return { ...base, dropped: false, note, degraded: false, shiftSemitones: 0 };
  }

  if (policy === 'drop') {
    return { ...base, dropped: true, note: 0, degraded: true, shiftSemitones: 0 };
  }

  const [low, high] = def.range;
  let shifted: number;
  if (policy === 'clamp') {
    shifted = sounding < low ? low : high;
  } else if (sounding < low) {
    shifted = sounding + 12 * Math.ceil((low - sounding) / 12);
  } else {
    shifted = sounding - 12 * Math.ceil((sounding - high) / 12);
  }

  return {
    ...base,
    dropped: false,
    note: shifted - def.anchorMidi,
    degraded: true,
    // The whole-track shift has its own warning; this figure is the residual move.
    shiftSemitones: shifted - sounding,
  };
}

/** A channel-9 note as a drum, or null when neither the note nor the title maps. */
export function mapDrumNote(note: number, trackName = ''): InstrumentPitch | null {
  const instrument = drumInstrument(note, trackName);
  if (instrument === null) return null;
  return {
    midi: note,
    instrument,
    note: 0,
    block: INSTRUMENTS[instrument].baseBlock,
    dropped: false,
    degraded: false,
    shiftSemitones: 0,
  };
}
