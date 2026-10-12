import { mapPitch, type NoteBlockInstrument, type PitchRegion, type RegionTable } from '../palette/pitchMap';
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
 */

/** A note ready to be placed: already mapped to a note value, region and base block. */
export interface NoteToPlace {
  /** Original note, kept so overflow can be re-emitted elsewhere. */
  source: TrackNote;
  midi: number;
  note: number;
  region: PitchRegion;
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
  /** Capacity of one chord column, from `chordCapacity`. */
  maxChordNotes: number;
  /** When false, the surplus is dropped rather than reported for re-emission. */
  collectOverflow: boolean;
}

export function prepareGroups(options: PrepareGroupsOptions): {
  groups: PreparedGroup[];
  overflow: OverflowGroup[];
  warnings: LayoutWarning[];
} {
  const { notes, regions, outOfRange, transpose, maxChordNotes, collectOverflow } = options;
  const warnings: LayoutWarning[] = [];
  const overflow: OverflowGroup[] = [];

  // 1) Map pitches, then group by redstone tick
  const groupMap = new Map<number, PreparedGroup>();
  for (const note of notes) {
    const mapped = mapPitch(note.midi, regions, outOfRange, transpose);
    if (mapped.dropped) {
      warnings.push({ code: 'OUT_OF_RANGE', midi: note.midi, action: 'drop' });
      continue;
    }
    // Automatic octave shifting is an explicit user choice and stays silent; every
    // other degraded outcome is reported.
    if (mapped.degraded && outOfRange !== 'octave') {
      warnings.push({ code: 'OUT_OF_RANGE', midi: note.midi, action: outOfRange });
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

  return { groups: prepared, overflow, warnings };
}
