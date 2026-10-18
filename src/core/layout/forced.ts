import type { TrackVoicing } from '../palette/assignment';
import { mapDrumNote, mapPitchToInstrument, type InstrumentPitch } from '../palette/instrumentPitch';
import { INSTRUMENTS, type NoteBlockInstrument } from '../palette/instruments';
import { mapPitch, type MappedPitch, type RegionTable } from '../palette/pitchMap';
import type { BlockResolver } from '../palette/blockTable';
import {
  noteBlock,
  plainBlock,
  redstoneWire,
  repeater,
  type BlockState,
  type RepeaterFacing,
} from '../palette/noteBlock';
import { place } from './placement';
import { applyWireConnections } from './wiring';
import {
  chordCapacity,
  chordRowLayout,
  gameTickToRedstone,
  GAME_TICKS_PER_REDSTONE_TICK,
  MAX_PAD_RUN,
  MAX_REPEATER_DELAY,
  MAX_SIDE_ROWS,
  type TrackNote,
} from './track';
import type {
  BlockPlacement,
  LayoutConfig,
  LayoutResult,
  LayoutWarning,
  PlacedNote,
  Tap,
  TrackSkeleton,
  Vec3,
} from './types';
import { validateForcedTrack } from './forcedValidation';
import { coreError } from '../errors';

/** One source track's notes and voicing, before the forced layout combines them. */
export interface ForcedInput {
  index: number;
  notes: TrackNote[];
  /** Omitted means the five-slot piano palette, for backward compatibility. */
  voicing?: TrackVoicing;
  octaveOffset?: number;
  trackName?: string;
}

/** Dependencies and source-track overrides for the opt-in single-spine layout. */
export interface ForcedOptions {
  config: LayoutConfig;
  regions: RegionTable;
  resolve: BlockResolver;
  transpose?: Record<number, number>;
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
}

type MappedNote = (MappedPitch | InstrumentPitch) & { sourceIndex: number };

interface Group {
  rt: number;
  tick: number;
  notes: MappedNote[];
}

/** Exact per-section budget: notes are two rows apart to prevent neighbor activation. */
export function forcedNotesPerSide(dMax: number): number {
  return Math.min(MAX_SIDE_ROWS >> 1, (chordCapacity(dMax) - 1) / 2);
}

/**
 * Build one connected time spine for the whole song, never an overflow playback lane.
 *
 * Every source track keeps its own voicing and octave offset, so a bass note can sit
 * inline next to a drum note on the same spine. Side buses renew power before
 * exhaustion; individual repeater chains compensate their bus stages to one song-wide
 * latency. Throws before export if the produced block graph is unsafe.
 */
export function buildForcedLayout(inputs: ForcedInput[], opts: ForcedOptions): LayoutResult {
  const { config, regions, resolve } = opts;
  if (
    !Number.isFinite(config.baseTps) ||
    config.baseTps <= 0 ||
    !Number.isInteger(config.circuitY) ||
    !Number.isInteger(config.floorY) ||
    (config.trackPitch !== 'auto' && (!Number.isFinite(config.trackPitch) || config.trackPitch <= 0))
  ) {
    throw coreError('FORCED_INVALID_CONFIG');
  }
  if (config.floorY !== config.circuitY - 1) {
    throw coreError('FORCED_SUPPORT_LAYER');
  }

  const warnings: LayoutWarning[] = [];
  const perSide = forcedNotesPerSide(config.dMax);
  let minRt = Infinity;
  let peakNotes = 0;
  const rangeShift = { notes: 0, maxSemitones: 0 };

  // Map every source track with its own voicing, then fold all groups into one timeline.
  const groupByRt = new Map<number, Group>();
  for (const input of inputs) {
    const voicing: TrackVoicing = input.voicing ?? { kind: 'pitch' };
    const transpose = opts.transpose?.[input.index] ?? 0;
    const outOfRange = opts.outOfRange ?? 'warn';
    let droppedDrums = 0;

    for (const note of input.notes) {
      if (!Number.isSafeInteger(note.tick) || note.tick < 0) throw coreError('FORCED_INVALID_NOTE_TIME');

      let mapped: MappedPitch | InstrumentPitch;
      if (voicing.kind === 'pitch') {
        mapped = mapPitch(note.midi, regions, outOfRange, transpose);
      } else if (voicing.kind === 'instrument') {
        mapped = mapPitchToInstrument(
          note.midi,
          voicing.instrument,
          outOfRange,
          transpose,
          input.octaveOffset ?? 0,
        );
      } else {
        const drum = mapDrumNote(note.midi, input.trackName ?? '');
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

      if (mapped.dropped || (mapped.degraded && outOfRange !== 'octave')) {
        warnings.push({
          code: 'OUT_OF_RANGE',
          midi: note.midi,
          action: mapped.dropped ? 'drop' : outOfRange,
          trackIndex: input.index,
          tick: note.tick,
          ...rangeFields,
        });
      }
      if (mapped.dropped) continue;
      if (mapped.degraded) {
        rangeShift.notes += 1;
        rangeShift.maxSemitones = Math.max(rangeShift.maxSemitones, Math.abs(mapped.shiftSemitones));
      }

      const rt = gameTickToRedstone(note.tick);
      let group = groupByRt.get(rt);
      if (!group) {
        group = { rt, tick: note.tick, notes: [] };
        groupByRt.set(rt, group);
      }
      group.tick = Math.min(group.tick, note.tick);
      group.notes.push({ ...mapped, sourceIndex: input.index });
      minRt = Math.min(minRt, rt);
    }

    if (droppedDrums > 0) {
      warnings.push({ code: 'DRUM_NOTES_DROPPED', trackIndex: input.index, count: droppedDrums });
    }
  }

  const groups = [...groupByRt.values()].sort((a, b) => a.rt - b.rt);
  for (const group of groups) {
    // Highest note first, then source order, so the fan-out is deterministic.
    group.notes.sort((a, b) => b.midi - a.midi || a.sourceIndex - b.sourceIndex);
    peakNotes = Math.max(peakNotes, group.notes.length);
  }

  // The first note of every group sits inline at zBase; the rest occupy adjacent
  // rows above and below it, exactly like the ordinary chord column. One row per
  // note is enough: Minecraft does not retrigger a note block that is also lit by
  // its neighbour, so the old two-row fan-out was wasting space.
  let maxUp = 0;
  let maxDown = 0;
  for (const group of groups) {
    for (const row of chordRowLayout(group.notes.length)) {
      if (row.side === 1) maxDown = Math.max(maxDown, row.row);
      else maxUp = Math.max(maxUp, row.row);
    }
  }
  // Chords that fit one normal branch column use the compact one-row topology. The
  // staged bus is only needed past that capacity, where its two-row spacing is the
  // price of renewing power along a much taller column.
  // The compact column is powered through one dust cell from the entry/previous
  // group, so its root arrives at strength 14 rather than 15. Keep one strength in
  // reserve: 2 * 13 + 1 notes. Wider chords use the staged fallback, whose stone feed
  // starts at full strength.
  const compactLimit = Math.min(chordCapacity(config.dMax), 2 * (MAX_SIDE_ROWS - 1) + 1);
  const compact = groups.every((group) => group.notes.length <= compactLimit);
  // Compact groups use one row per note and no power-renewal relays; the staged
  // fallback keeps the old two-row spacing and renews power every `perSide` notes.
  const runSpan = compact ? 0 : perSide * 2;
  const maxStage = compact ? 0 : Math.max(0, Math.floor((Math.ceil(peakNotes / 2) - 1) / perSide));
  const branchDelay = maxStage + 1;
  const branchCells = Math.ceil(branchDelay / MAX_REPEATER_DELAY);
  // Leave two isolation cells after the longest note chain. Main-line padding
  // cannot borrow extra repeaters: doing so would change dense consecutive beats.
  const mainRun = branchCells + 2;
  if (mainRun > MAX_PAD_RUN) {
    throw coreError('FORCED_BRANCH_TOO_DEEP', {
      peakNotes,
      branchDelay,
      mainRun,
      maxPadRun: MAX_PAD_RUN,
    });
  }
  const base = minRt === 0 ? 1 : 0;
  // Compact groups have no extra branch delay: their final repeater is part of the
  // inter-group gap, exactly as in the ordinary layout. Only the staged fallback
  // needs the song-wide branch-delay compensation.
  const startupDelayTicks = (base + (compact ? 0 : branchDelay)) * GAME_TICKS_PER_REDSTONE_TICK;
  if (peakNotes > 0 && startupDelayTicks > 0) {
    warnings.push({
      code: 'FORCE_MERGE_LEAD_IN',
      ticks: startupDelayTicks,
      peakNotes,
      sectionCapacity: perSide * 2,
    });
  }

  const tracks: TrackSkeleton[] = [];
  const placed: LayoutResult['placed'] = [];
  const zBase = compact ? maxUp : 2 * Math.ceil(peakNotes / 2);
  let totalTicks = 0;

  if (groups.length > 0) {
    const placements: BlockPlacement[] = [];
    const occupied = new Map<string, BlockPlacement>();
    const taps: Tap[] = [];
    // The single spine may combine tracks; support overrides come from the first
    // included track so a deliberate `air` refusal still works.
    const support = resolve({ slot: 'wireSupport', trackIndex: inputs[0]?.index });
    if (support === 'minecraft:air') throw coreError('FORCED_SUPPORT_IS_AIR');

    const key = (pos: Vec3): string => `${pos.x},${pos.y},${pos.z}`;
    const put = (x: number, y: number, z: number, state: BlockState): void => {
      const placement = place({ x, y, z }, state);
      if (occupied.has(key(placement.pos))) {
        throw coreError('FORCED_COORDINATE_CONFLICT', { position: key(placement.pos) });
      }
      occupied.set(key(placement.pos), placement);
      placements.push(placement);
    };
    const supported = (x: number, z: number, state: BlockState): void => {
      put(x, config.circuitY, z, state);
      put(x, config.floorY, z, plainBlock(support));
    };
    const wire = (x: number, z: number): void => {
      supported(x, z, redstoneWire(0));
    };
    const relay = (x: number, z: number, delay: number, facing: RepeaterFacing): void => {
      supported(x, z, repeater(facing, delay));
    };

    let x = 0;
    let prevRt = 0;
    wire(x++, zBase);

    for (const group of groups) {
      const notePlacements: PlacedNote[] = [];
      const branches = chordRowLayout(group.notes.length);
      let rootX: number;
      const gap = group.rt + base - prevRt;

      const putNoteAt = (
        note: (typeof group.notes)[number],
        z: number,
        noteX: number,
        path: Vec3[],
      ): void => {
        const block = note.region
          ? resolve({ slot: 'noteBase', trackIndex: note.sourceIndex, region: note.region })
          : resolve({ slot: 'noteBase', trackIndex: note.sourceIndex, instrument: note.instrument });
        put(noteX, config.circuitY, z, noteBlock(note.note, note.instrument));
        put(noteX, config.floorY, z, plainBlock(block));
        notePlacements.push({
          notePos: { x: noteX, y: config.circuitY, z },
          blockPos: { x: noteX, y: config.floorY, z },
          note: note.note,
          block,
          path,
        });
      };

      if (compact) {
        // Ordinary topology: the final repeater is the last part of the inter-group
        // gap, so it must not be added on top of the gap. Two and three notes are lit
        // by the inline note's single hop; four or more use one branch row each.
        const finalDelay = Math.min(MAX_REPEATER_DELAY, gap);
        let rest = gap - finalDelay;
        while (rest > 0) {
          const delay = Math.min(MAX_REPEATER_DELAY, rest);
          relay(x++, zBase, delay, 'west');
          rest -= delay;
        }
        rootX = x;
        const needColumn = group.notes.length > 3;
        if (needColumn) {
          wire(rootX, zBase);
          for (const row of branches) wire(rootX, zBase + row.side * row.row);
        }
        const relayX = needColumn ? rootX + 1 : rootX;
        const noteX = relayX + 1;
        relay(relayX, zBase, finalDelay, 'west');
        if (needColumn) {
          for (const row of branches) relay(relayX, zBase + row.side * row.row, finalDelay, 'west');
        }

        putNoteAt(
          group.notes[0]!,
          zBase,
          noteX,
          needColumn
            ? [
                { x: rootX, y: config.circuitY, z: zBase },
                { x: relayX, y: config.circuitY, z: zBase },
              ]
            : [{ x: relayX, y: config.circuitY, z: zBase }],
        );
        branches.forEach((row, index) => {
          const note = group.notes[index + 1]!;
          const z = zBase + row.side * row.row;
          putNoteAt(
            note,
            z,
            noteX,
            row.conducted
              ? []
              : [
                  { x: rootX, y: config.circuitY, z },
                  { x: relayX, y: config.circuitY, z },
                ],
          );
        });
        x = noteX + 1;
      } else {
        // Staged fallback for chords wider than one normal column: two rows per note
        // leave a power-renewal row between them, and each note's chain compensates
        // for the bus stage it sits behind.
        let remaining = gap;
        while (remaining > 0) {
          const delay = Math.min(MAX_REPEATER_DELAY, remaining);
          relay(x++, zBase, delay, 'west');
          remaining -= delay;
        }
        rootX = x;
        supported(rootX, zBase, plainBlock('minecraft:stone'));
        const rows = [Math.ceil(group.notes.length / 2), Math.floor(group.notes.length / 2)];
        for (let sideIndex = 0; sideIndex < rows.length; sideIndex++) {
          const sign = sideIndex === 0 ? 1 : -1;
          const reach = rows[sideIndex]! * 2;
          for (let row = 1; row <= reach; row++) {
            const z = zBase + sign * row;
            if (row > runSpan && (row - 1) % runSpan === 0) {
              relay(rootX, z, 1, sign === 1 ? 'north' : 'south');
            } else {
              wire(rootX, z);
            }
          }
        }
        group.notes.forEach((note, index) => {
          const sign = index % 2 === 0 ? 1 : -1;
          const row = Math.floor(index / 2) + 1;
          const stage = Math.floor((row - 1) / perSide);
          const z = zBase + sign * row * 2;
          let noteX = rootX + 1;
          const path: Vec3[] = [{ x: rootX, y: config.circuitY, z }];
          let delayLeft = branchDelay - stage;
          while (delayLeft > 0) {
            const delay = Math.min(MAX_REPEATER_DELAY, delayLeft);
            relay(noteX, z, delay, 'west');
            path.push({ x: noteX++, y: config.circuitY, z });
            delayLeft -= delay;
          }
          putNoteAt(note, z, noteX, path);
        });
        // Notes are all on branch rows; the main row at zBase stays free.
        x = rootX + 1;
      }

      taps.push({ x: rootX, t: group.rt, notes: notePlacements });
      // One group may hold notes from several source tracks; each needs a placement
      // entry so the interface can still locate that track's warnings.
      const sources = new Set(group.notes.map((note) => note.sourceIndex));
      for (const trackIndex of sources) {
        placed.push({
          trackIndex,
          zBase,
          tick: group.tick,
          actual: group.rt * 2 + startupDelayTicks,
          x: rootX,
        });
      }
      totalTicks = Math.max(totalTicks, group.tick);

      if (!compact && group.notes.length > perSide * 2) {
        warnings.push({
          code: 'FANOUT_EXPANDED',
          tick: group.tick,
          n: group.notes.length,
          limit: perSide * 2,
          stages: Math.floor((Math.ceil(group.notes.length / 2) - 1) / perSide) + 1,
        });
      }

      prevRt = group.rt + base;
      // The staged fallback needs isolation cells after its branch bus; the compact
      // column does not, and padding it with dust would weaken the next column's
      // root before its first branch repeater.
      if (!compact && group !== groups[groups.length - 1]) {
        for (let pad = 0; pad < mainRun; pad++) wire(x++, zBase);
      }
    }

    applyWireConnections(placements);
    const track: TrackSkeleton = {
      // A synthetic index: the spine is not one source track. Regions and the preview
      // treat a negative index as "merged spine".
      trackIndex: -1,
      zBase,
      placements,
      taps,
    };
    validateForcedTrack(
      track,
      config.circuitY,
      groups.map((group) => group.rt * 2 + startupDelayTicks),
    );
    tracks.push(track);
  }

  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const track of tracks)
    for (const p of track.placements) {
      for (const axis of ['x', 'y', 'z'] as const) {
        min[axis] = Math.min(min[axis], p.pos[axis]);
        max[axis] = Math.max(max[axis], p.pos[axis]);
      }
    }
  const size =
    tracks.length === 0
      ? { x: 1, y: 2, z: 1 }
      : { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  return {
    tracks,
    min: tracks.length === 0 ? { x: 0, y: 0, z: 0 } : min,
    size,
    totalTicks,
    warnings,
    placed,
    startupDelayTicks,
    rangeShift,
    // The caller (layout/index.ts) fills this in; the forced builder is not the place
    // that knows about the assignment table.
    trackInstruments: [],
  };
}
