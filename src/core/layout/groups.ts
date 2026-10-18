import type { TrackVoicing } from '../palette/assignment';
import { mapDrumNote, mapPitchToInstrument, type InstrumentPitch } from '../palette/instrumentPitch';
import { INSTRUMENTS, type NoteBlockInstrument } from '../palette/instruments';
import { mapPitch, type MappedPitch, type PitchRegion, type RegionTable } from '../palette/pitchMap';
import type { LayoutWarning } from './types';
import { gameTickToRedstone, type OverflowGroup, type TrackNote } from './model';

/**
 * Turning a track's notes into the groups that will be placed.
 *
 * A group is everything that fires on one redstone tick. Two things happen here
 * that the caller cannot see afterwards:
 *
 *   - a note outside the covered pitch range is reported and then either shifted,
 *     clamped or dropped, according to the caller's policy;
 *   - a group wider than one chord column can hold keeps only the highest notes
 *     and hands the rest back as overflow, so the caller can re-emit them on
 *     another track instead of losing them.
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

export interface PrepareGroupsOptions {
  notes: TrackNote[];
  regions: RegionTable;
  outOfRange: 'warn' | 'clamp' | 'octave' | 'drop';
  transpose: number;
  /** Source MIDI track, carried into warnings so they can name the notes they mean. */
  trackIndex: number;
  /** Capacity of one chord column, from `chordCapacity`. */
  maxChordNotes: number;
  /** When false, the surplus is dropped rather than reported for re-emission. */
  collectOverflow: boolean;
  /** How this track sounds; defaults to the five-slot piano palette. */
  voicing?: TrackVoicing;
  /** Whole-track octave shift for a fixed instrument. */
  octaveOffset?: number;
  /** Track title, used only as the channel-9 name fallback. */
  trackName?: string;
  /**
   * Whether to report notes outside the pitch range.
   *
   * False for the lanes a chord overflow is re-emitted onto: those notes were already
   * mapped and reported on the first pass, so reporting again counted one source note
   * several times - a 60-note chord produced 93 `OUT_OF_RANGE` notices, more than the
   * song had notes.
   */
  reportRangeWarnings?: boolean;
}

export function prepareGroups(options: PrepareGroupsOptions): {
  groups: PreparedGroup[];
  overflow: OverflowGroup[];
  warnings: LayoutWarning[];
  /** How many notes the range policy moved, and by how much at most. */
  rangeShift: { notes: number; maxSemitones: number };
} {
  const {
    notes,
    regions,
    outOfRange,
    transpose,
    maxChordNotes,
    collectOverflow,
    trackIndex,
    voicing = { kind: 'pitch' },
    octaveOffset = 0,
    trackName = '',
    reportRangeWarnings = true,
  } = options;
  const warnings: LayoutWarning[] = [];
  const overflow: OverflowGroup[] = [];
  // Counted from the mapping itself rather than inferred from the warnings: the `octave`
  // policy deliberately stays silent per note, so a song where every note was shifted
  // used to report zero shifted notes.
  let shiftedNotes = 0;
  let maxShiftSemitones = 0;
  let droppedDrums = 0;

  // 1) Map pitches, then group by redstone tick
  const groupMap = new Map<number, PreparedGroup>();
  for (const note of notes) {
    let mapped: MappedPitch | InstrumentPitch;

    if (voicing.kind === 'pitch') {
      mapped = mapPitch(note.midi, regions, outOfRange, transpose);
    } else if (voicing.kind === 'instrument') {
      mapped = mapPitchToInstrument(note.midi, voicing.instrument, outOfRange, transpose, octaveOffset);
    } else {
      const drum = mapDrumNote(note.midi, trackName);
      if (drum === null) {
        droppedDrums += 1;
        continue;
      }
      mapped = drum;
    }

    let rangeFields: { instrument?: NoteBlockInstrument; low?: number; high?: number } = {};
    if (voicing.kind === 'instrument') {
      const range = INSTRUMENTS[voicing.instrument].range;
      if (range !== null) {
        rangeFields = { instrument: voicing.instrument, low: range[0], high: range[1] };
      }
    }

    if (mapped.dropped) {
      if (reportRangeWarnings) {
        warnings.push({
          code: 'OUT_OF_RANGE',
          midi: note.midi,
          action: 'drop',
          trackIndex,
          tick: note.tick,
          ...rangeFields,
        });
      }
      continue;
    }
    // The statistic covers every degraded note, including the silent `octave` policy,
    // but is counted once per source note: the later lanes re-map the same notes.
    if (reportRangeWarnings && mapped.degraded) {
      shiftedNotes += 1;
      maxShiftSemitones = Math.max(maxShiftSemitones, Math.abs(mapped.shiftSemitones));
    }
    // Automatic octave shifting is an explicit user choice and stays silent; every
    // other degraded outcome is reported.
    if (reportRangeWarnings && mapped.degraded && outOfRange !== 'octave') {
      warnings.push({
        code: 'OUT_OF_RANGE',
        midi: note.midi,
        action: outOfRange,
        trackIndex,
        tick: note.tick,
        ...rangeFields,
      });
    }

    const rt = gameTickToRedstone(note.tick);
    let group = groupMap.get(rt);
    if (!group) {
      group = { rt, tick: note.tick, notes: [] };
      groupMap.set(rt, group);
    }
    group.tick = Math.min(group.tick, note.tick);
    group.notes.push({
      source: note,
      midi: note.midi,
      note: mapped.note,
      region: mapped.region,
      block: mapped.block,
      instrument: mapped.instrument,
      degraded: mapped.degraded,
    });
  }
  const groups = [...groupMap.values()].sort((a, b) => a.rt - b.rt);

  if (reportRangeWarnings && droppedDrums > 0) {
    warnings.push({ code: 'DRUM_NOTES_DROPPED', trackIndex, count: droppedDrums });
  }

  // 2) Chord capacity: anything past the column's physical limit goes to overflow
  const prepared: PreparedGroup[] = [];
  for (const group of groups) {
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
    const sorted = [...group.notes].sort((a, b) => b.midi - a.midi);
    prepared.push({ rt: group.rt, tick: group.tick, notes: sorted.slice(0, maxChordNotes) });
    const rest = sorted.slice(maxChordNotes);
    if (collectOverflow && rest.length > 0) {
      overflow.push({ tick: group.tick, notes: rest.map((n) => n.source) });
    }
  }

  return {
    groups: prepared,
    overflow,
    warnings,
    rangeShift: { notes: shiftedNotes, maxSemitones: maxShiftSemitones },
  };
}
