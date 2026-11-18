import type { TrackVoicing } from '../palette/assignment';
import { mapDrumNote, mapPitchToInstrument, type InstrumentPitch } from '../palette/instrumentPitch';
import { INSTRUMENTS, type NoteBlockInstrument } from '../palette/instruments';
import { mapPitch, type MappedPitch, type PitchRegion, type RegionTable } from '../palette/pitchMap';
import type { LayoutWarning } from './types';
import { gameTickToRedstone, type TrackNote } from './model';

/**
 * Turning a track's notes into the notes to place, and those into groups.
 *
 * The two steps are separate on purpose. Mapping happens **once per source track**,
 * before any merging, so a track keeps the octave that suits its own range even when
 * it ends up sharing a lane with a track that fits elsewhere; a merged lane is then
 * just the union of already-mapped notes. Grouping happens per lane, because chord
 * capacity is a property of the column that lane is built on.
 *
 * A track is voiced in one of three ways: the five-slot piano palette (`pitch`),
 * one fixed instrument, or mixed channel-9 percussion. The mapping differs, but the
 * grouping and overflow rules are the same for all three.
 */

/** A note ready to be placed: already mapped to a note value, region and base block. */
export interface NoteToPlace {
  /** Original note, kept so overflow can be re-emitted elsewhere. */
  source: TrackNote;
  midi: number;
  note: number;
  /** Set for the five-slot palette only; a fixed instrument has no pitch region. */
  region?: PitchRegion;
  block: string;
  instrument: NoteBlockInstrument;
  degraded: boolean;
}

/** Notes that fire on the same redstone tick. */
export interface PreparedGroup {
  rt: number;
  /** Earliest original game tick in the group, used for warnings and placed reporting. */
  tick: number;
  notes: NoteToPlace[];
}

/**
 * One group that exceeded the column's capacity, for the caller to re-emit elsewhere.
 *
 * The notes are kept **mapped**: the range policy already ran on them, so re-emitting
 * must not run it again. Mapping twice used to report one source note several times -
 * a 60-note chord produced 93 `OUT_OF_RANGE` notices, more than the song had notes.
 */
export interface OverflowGroup {
  tick: number;
  notes: NoteToPlace[];
}

export interface MapTrackNotesOptions {
  notes: readonly TrackNote[];
  regions: RegionTable;
  outOfRange: 'warn' | 'clamp' | 'octave' | 'drop';
  transpose: number;
  /** Source MIDI track, carried into warnings so they can name the notes they mean. */
  trackIndex: number;
  /** How this track sounds; defaults to the five-slot piano palette. */
  voicing?: TrackVoicing;
  /** Whole-track octave shift for a fixed instrument. */
  octaveOffset?: number;
  /** Track title, used only as the channel-9 name fallback. */
  trackName?: string;
}

/**
 * Map every note of one source track onto what the circuit will actually play.
 *
 * The returned statistics are counted from the mapping itself rather than inferred
 * from the warnings: the `octave` policy deliberately stays silent per note, so a
 * song where every note was shifted used to report zero shifted notes.
 */
export function mapTrackNotes(options: MapTrackNotesOptions): {
  notes: NoteToPlace[];
  warnings: LayoutWarning[];
  /** How many notes the range policy moved, and by how much at most. */
  rangeShift: { notes: number; maxSemitones: number };
} {
  const {
    notes,
    regions,
    outOfRange,
    transpose,
    trackIndex,
    voicing = { kind: 'pitch' },
    octaveOffset = 0,
    trackName = '',
  } = options;
  const warnings: LayoutWarning[] = [];
  const mapped: NoteToPlace[] = [];
  let shiftedNotes = 0;
  let maxShiftSemitones = 0;
  let droppedDrums = 0;

  for (const note of notes) {
    let result: MappedPitch | InstrumentPitch;

    if (voicing.kind === 'pitch') {
      result = mapPitch(note.midi, regions, outOfRange, transpose);
    } else if (voicing.kind === 'instrument') {
      result = mapPitchToInstrument(note.midi, voicing.instrument, outOfRange, transpose, octaveOffset);
    } else {
      const drum = mapDrumNote(note.midi, trackName);
      if (drum === null) {
        droppedDrums += 1;
        continue;
      }
      result = drum;
    }

    let rangeFields: { instrument?: NoteBlockInstrument; low?: number; high?: number } = {};
    if (voicing.kind === 'instrument') {
      const range = INSTRUMENTS[voicing.instrument].range;
      if (range !== null) {
        rangeFields = { instrument: voicing.instrument, low: range[0], high: range[1] };
      }
    }

    if (result.dropped) {
      warnings.push({
        code: 'OUT_OF_RANGE',
        midi: note.midi,
        action: 'drop',
        trackIndex,
        tick: note.tick,
        ...rangeFields,
      });
      continue;
    }
    if (result.degraded) {
      shiftedNotes += 1;
      maxShiftSemitones = Math.max(maxShiftSemitones, Math.abs(result.shiftSemitones));
    }
    // Automatic octave shifting is an explicit user choice and stays silent; every
    // other degraded outcome is reported.
    if (result.degraded && outOfRange !== 'octave') {
      warnings.push({
        code: 'OUT_OF_RANGE',
        midi: note.midi,
        action: outOfRange,
        trackIndex,
        tick: note.tick,
        ...rangeFields,
      });
    }

    mapped.push({
      source: note,
      midi: note.midi,
      note: result.note,
      region: result.region,
      block: result.block,
      instrument: result.instrument,
      degraded: result.degraded,
    });
  }

  if (droppedDrums > 0) {
    warnings.push({ code: 'DRUM_NOTES_DROPPED', trackIndex, count: droppedDrums });
  }

  return {
    notes: mapped,
    warnings,
    rangeShift: { notes: shiftedNotes, maxSemitones: maxShiftSemitones },
  };
}

export interface GroupNotesOptions {
  /** Already-mapped notes; a lane may carry the union of several source tracks. */
  notes: readonly NoteToPlace[];
  /** Capacity of one chord column, from `chordCapacity`. */
  maxChordNotes: number;
  /** When false, the surplus is dropped rather than reported for re-emission. */
  collectOverflow: boolean;
}

/** Group mapped notes by redstone tick and push any surplus past capacity into overflow. */
export function groupNotes(options: GroupNotesOptions): {
  groups: PreparedGroup[];
  overflow: OverflowGroup[];
  warnings: LayoutWarning[];
} {
  const { notes, maxChordNotes, collectOverflow } = options;
  const groupMap = new Map<number, PreparedGroup>();
  for (const note of notes) {
    const rt = gameTickToRedstone(note.source.tick);
    let group = groupMap.get(rt);
    if (!group) {
      group = { rt, tick: note.source.tick, notes: [] };
      groupMap.set(rt, group);
    }
    group.tick = Math.min(group.tick, note.source.tick);
    group.notes.push(note);
  }
  const sorted = [...groupMap.values()].sort((a, b) => a.rt - b.rt);

  const warnings: LayoutWarning[] = [];
  const prepared: PreparedGroup[] = [];
  const overflow: OverflowGroup[] = [];
  for (const group of sorted) {
    if (group.notes.length <= maxChordNotes) {
      prepared.push(group);
      continue;
    }
    warnings.push({
      code: 'POLYPHONY_EXCEEDED',
      tick: group.tick,
      n: group.notes.length,
      limit: maxChordNotes,
    });
    const byPitch = [...group.notes].sort((a, b) => b.midi - a.midi);
    prepared.push({ rt: group.rt, tick: group.tick, notes: byPitch.slice(0, maxChordNotes) });
    const rest = byPitch.slice(maxChordNotes);
    if (collectOverflow && rest.length > 0) {
      overflow.push({ tick: group.tick, notes: rest });
    }
  }

  return { groups: prepared, overflow, warnings };
}
