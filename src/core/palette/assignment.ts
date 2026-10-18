import type { SongModel, TrackModel } from '../midi/types';
import { detectTrack, type DetectionSource } from './instrumentMap';
import type { NoteBlockInstrument } from './instruments';

/**
 * Turning a MIDI track into a note-block voicing.
 *
 * `native` mode plays every track with the instrument it was written for. `extended`
 * keeps the five-slot piano range: piano and unidentified tracks use the five slots,
 * the other eleven instruments stay native, and the five instruments the piano range
 * occupies are replaced by the closest free timbre.
 */

export type InstrumentMode = 'native' | 'extended';

export type TrackVoicing =
  { kind: 'pitch' } | { kind: 'instrument'; instrument: NoteBlockInstrument } | { kind: 'drums' };

export interface TrackAssignment {
  trackIndex: number;
  /** What the track would play in native mode; `drums` for mixed channel-9 tracks. */
  native: NoteBlockInstrument | 'drums';
  source: DetectionSource;
  voicing: TrackVoicing;
  /** True when extended mode replaced a piano-slot instrument. */
  substituted: boolean;
}

/**
 * Extended-mode replacements for the five instruments the piano range occupies.
 *
 * The point is to keep a similar timbre and register instead of folding the track into
 * the piano, which is what the old full-range mode did.
 */
export const SUBSTITUTIONS: Readonly<Partial<Record<NoteBlockInstrument, NoteBlockInstrument>>> = {
  bass: 'didgeridoo',
  guitar: 'banjo',
  flute: 'bit',
  bell: 'chime',
};

/** The voicing one track gets in a mode. */
export function assignTrack(track: TrackModel, mode: InstrumentMode): TrackAssignment {
  const detection = detectTrack(track);

  if (detection.native === 'drums') {
    return {
      trackIndex: track.index,
      native: 'drums',
      source: 'drum',
      voicing: { kind: 'drums' },
      substituted: false,
    };
  }

  const native = detection.native;

  if (mode === 'native') {
    return {
      trackIndex: track.index,
      native,
      source: detection.source,
      voicing: { kind: 'instrument', instrument: native },
      substituted: false,
    };
  }

  // Extended mode: harp (and anything unrecognised) is the piano range itself.
  if (native === 'harp' || detection.source === 'fallback') {
    return {
      trackIndex: track.index,
      native,
      source: detection.source,
      voicing: { kind: 'pitch' },
      substituted: false,
    };
  }

  const replacement = SUBSTITUTIONS[native];
  return {
    trackIndex: track.index,
    native,
    source: detection.source,
    voicing: { kind: 'instrument', instrument: replacement ?? native },
    substituted: replacement !== undefined,
  };
}

/** One assignment per source track, in track order. */
export function assignTracks(song: SongModel, mode: InstrumentMode): TrackAssignment[] {
  return song.tracks.map((track) => assignTrack(track, mode));
}

/** A plain lookup for the layout and command backends. */
export function voicingMap(assignments: readonly TrackAssignment[]): Record<number, TrackVoicing> {
  const map: Record<number, TrackVoicing> = {};
  for (const assignment of assignments) map[assignment.trackIndex] = assignment.voicing;
  return map;
}
