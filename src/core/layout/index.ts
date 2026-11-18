import {
  buildTrack,
  chordCapacity,
  GAME_TICKS_PER_REDSTONE_TICK,
  gameTickToRedstone,
  chordSideRows,
  groupByTick,
  naturalSamples,
  ALIGN_TOLERANCE_CELLS,
  MAX_REPEATER_DELAY,
  type TrackNote,
  type XPlan,
} from './track';
import type {
  LayoutConfig,
  LayoutResult,
  LayoutWarning,
  TrackInstrumentInfo,
  TrackSkeleton,
  Vec3,
} from './types';
import { boundsOf, sizeOf } from './placement';
import type { SongModel } from '../midi/types';
import { coreError } from '../errors';
import { DEFAULT_REGIONS, type PitchRegion, type RegionTable } from '../palette/pitchMap';
import {
  createBlockResolver,
  DEFAULT_BLOCK_TABLE,
  type BlockDefaults,
  type BlockOverrides,
  type BlockResolver,
  type BlockTable,
} from '../palette/blockTable';
import { secondsToTick } from '../tempo/tick';
import { numericRange } from '../numericRange';
import { chooseOctaveOffset } from '../palette/instrumentPitch';
import { INSTRUMENTS, type NoteBlockInstrument } from '../palette/instruments';
import type { TrackAssignment, TrackVoicing } from '../palette/assignment';
import { buildForcedLayout } from './forced';
import { hearingSpot } from './hearing';
import { applyWireConnections } from './wiring';
import { mapTrackNotes, type NoteToPlace } from './groups';

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  baseTps: 20,
  circuitY: 1,
  floorY: 0,
  dMax: 14,
  trackPitch: 'auto',
};

export interface LayoutOptions {
  config?: Partial<LayoutConfig>;
  regions?: RegionTable;
  /** What to do with notes outside the covered pitch range. */
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
  /** Tracks to leave out, such as a percussion track. */
  excludeTracks?: number[];
  /** Per-track transpose override, in octaves. */
  transpose?: Record<number, number>;
  /** Block material overrides, by track or by pitch region; see palette/blockTable. */
  blocks?: BlockOverrides;
  /**
   * Source track indices in priority order, lead track first.
   *
   * When present, the first track is placed at the Z centre and the rest alternate around
   * it by priority. Omitting it preserves the historical input order and Z origin.
   */
  laneOrder?: readonly number[];
  /**
   * Source track whose lane row the player stands on, when `laneOrder` is absent.
   *
   * The standing row is what the 48-block hearing radius is measured from, so it has to be
   * known even when the layout keeps its historical order (centring switched off).
   * Ignored when `laneOrder` names a lead.
   */
  standTrackIndex?: number;
  /**
   * Merge tracks that share an instrument onto **one main line**, with percussion
   * treated as its own class.
   *
   * The merged notes now sit on the same line, so cross-track X drift cannot happen
   * and no padding is needed to approximate alignment. The cost is that notes landing
   * together become a chord, which is split into extra tracks by the usual rules when
   * it exceeds the column capacity. Default false: one line per track. Transpose and
   * block overrides for a merged group come from its first original track.
   */
  mergeSameInstrument?: boolean;
  /** Opt-in: one connected time spine for the whole song; takes precedence over legacy merging. */
  forceMergeSameInstrument?: boolean;
  /**
   * Source track indices to fold onto one lane, one array per lane.
   *
   * A track with only a handful of notes does not need a main line of its own: its
   * notes can share the line of a track that is already there. Groups must be disjoint
   * and may only name tracks that are actually laid out; anything else throws instead
   * of silently producing the wider layout the caller was trying to avoid.
   */
  laneGroups?: readonly (readonly number[])[];
  /**
   * Opt-in: let a lane that starts late tap the lane below instead of building a head.
   *
   * A lane whose first note is at X=3000 normally carries song time from X=0 with a
   * delay chain: thousands of dust cells and hundreds of repeaters, all of which have
   * to stay in loaded chunks in the right order. If the lane one gap row below already
   * carries that time at some cell, one repeater is enough to inherit it. Default
   * false: omitting the option keeps the previous layout.
   */
  laneRide?: boolean;
  /**
   * Per-track voicing, from `assignTracks`. When omitted every track uses the
   * five-slot piano palette, which keeps existing callers and tests unchanged.
   */
  assignments?: Record<number, TrackAssignment>;
}

/**
 * Merge key: the piano extension is one class, a fixed instrument is another, and
 * channel-9 percussion never merges because its notes can carry different drums.
 */
function voicingKey(voicing: TrackVoicing, index: number): string {
  if (voicing.kind === 'pitch') return 'piano';
  if (voicing.kind === 'drums') return `drums:${index}`;
  return `instrument:${voicing.instrument}`;
}

interface LayoutInput {
  index: number;
  notes: TrackNote[];
  key: string;
  trackName: string;
  voicing: TrackVoicing;
  sourceIndices: number[];
  native: NoteBlockInstrument | 'drums';
  source: TrackAssignment['source'];
  substituted: boolean;
  /** False for callers that did not opt into the assignment table. */
  assigned: boolean;
  /** Whole-track octave shift, filled in after merging. */
  octaveOffset: number;
  outside: number;
}

function mergeByInstrument<T extends { notes: TrackNote[]; key: string; sourceIndices: number[] }>(
  inputs: T[],
): T[] {
  const groups = new Map<string, T>();
  for (const input of inputs) {
    const hit = groups.get(input.key);
    if (hit) {
      for (const note of input.notes) hit.notes.push(note);
      for (const index of input.sourceIndices) hit.sourceIndices.push(index);
    } else {
      groups.set(input.key, {
        ...input,
        notes: [...input.notes],
        sourceIndices: [...input.sourceIndices],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Fold the source tracks named by `laneGroups` onto one lane each.
 *
 * A group becomes one layout input whose `sourceIndices` are its tracks in the order
 * given, so the lane carries their already-mapped notes on a single main line. Every
 * group that cannot be honoured throws: silently ignoring it would report success while
 * the layout stayed exactly as wide as the caller was trying to avoid.
 */
function applyLaneGroups(
  inputs: LayoutInput[],
  groups: readonly (readonly number[])[] | undefined,
): LayoutInput[] {
  if (!groups || groups.length === 0) return inputs;
  const owner = new Map<number, LayoutInput>();
  for (const input of inputs) {
    for (const source of input.sourceIndices) owner.set(source, input);
  }

  const folded = new Map<number, LayoutInput>();
  const consumed = new Set<number>();
  for (const group of groups) {
    if (group.length === 0) throw coreError('LAYOUT_INVALID_CONFIG', { field: 'laneGroups' });
    const members: LayoutInput[] = [];
    for (const trackIndex of group) {
      const input = owner.get(trackIndex);
      if (!input) throw coreError('LAYOUT_INVALID_CONFIG', { field: 'laneGroups' });
      if (!members.includes(input)) members.push(input);
    }
    const first = members[0];
    if (!first) throw coreError('LAYOUT_INVALID_CONFIG', { field: 'laneGroups' });
    const sourceIndices = members.flatMap((member) => member.sourceIndices);
    for (const source of sourceIndices) {
      // A track may sit on exactly one lane; naming it twice would place it twice.
      if (consumed.has(source)) throw coreError('LAYOUT_INVALID_CONFIG', { field: 'laneGroups' });
      consumed.add(source);
    }
    const lane: LayoutInput = {
      ...first,
      key: `lane:${sourceIndices.join(',')}`,
      notes: members.flatMap((member) => member.notes).sort((a, b) => a.tick - b.tick),
      sourceIndices,
      octaveOffset: 0,
      outside: 0,
    };
    for (const member of members) folded.set(member.index, lane);
  }

  const result: LayoutInput[] = [];
  const emitted = new Set<LayoutInput>();
  for (const input of inputs) {
    const lane = folded.get(input.index);
    if (!lane) {
      result.push(input);
      continue;
    }
    if (emitted.has(lane)) continue;
    emitted.add(lane);
    result.push(lane);
  }
  return result;
}

/** Base blocks differ per pitch region and per fixed instrument. */
function blockDefaults(regions: RegionTable): BlockDefaults {
  // Only the slots this palette defines: the single-instrument palette has just one.
  const byRegion: Partial<Record<PitchRegion, Partial<BlockTable>>> = {};
  for (const [region, def] of Object.entries(regions)) {
    if (def) byRegion[region as PitchRegion] = { noteBase: def.baseBlock };
  }

  const byInstrument: Partial<Record<NoteBlockInstrument, Partial<BlockTable>>> = {};
  for (const [id, def] of Object.entries(INSTRUMENTS)) {
    byInstrument[id as NoteBlockInstrument] = { noteBase: def.baseBlock };
  }

  return { global: DEFAULT_BLOCK_TABLE, regions: byRegion, instruments: byInstrument };
}

/**
 * Build the shared "song time -> X" reference line from positions reachable after
 * earlier padding. A natural-X-only envelope loses that history: once a padded track
 * becomes the naturally leading track, its actual line is already ahead of the plan
 * and later simultaneous groups cannot converge.
 *
 * Advance every track at each event time, choose the upper envelope of the candidate
 * positions, then apply the same tolerance and dust budget used by buildTrack. The
 * resulting actual position becomes the starting point for that track's next group.
 */
function buildXPlan(
  samples: Array<{ atRt: number; x: number; trackId: number; padCapacity: number }>,
): XPlan {
  const sorted = [...samples].sort((a, b) => a.atRt - b.atRt);
  const envelope: Array<{ atRt: number; x: number }> = [];
  const synchronizedAtRts = new Set<number>();
  const states = new Map<number, { naturalX: number; actualX: number }>();
  let max = 0;
  for (let i = 0; i < sorted.length;) {
    const atRt = sorted[i]!.atRt;
    const sameTime = [];
    while (i < sorted.length && sorted[i]!.atRt === atRt) {
      sameTime.push(sorted[i]!);
      i += 1;
    }
    // Ticks are validated before planning; keep the empty guard so a future non-finite
    // input cannot make the grouping loop spin forever.
    if (sameTime.length === 0) break;
    const trackIds = new Set(sameTime.map((s) => s.trackId));
    const synchronized = trackIds.size >= 2;
    if (synchronized) synchronizedAtRts.add(atRt);
    const tolerance = synchronized ? 0 : ALIGN_TOLERANCE_CELLS;
    const candidates = sameTime.map((sample) => {
      const state = states.get(sample.trackId) ?? { naturalX: 0, actualX: 0 };
      return { sample, state, naturalX: state.actualX + sample.x - state.naturalX };
    });
    for (const candidate of candidates) max = Math.max(max, candidate.naturalX);
    for (const candidate of candidates) {
      const deficit = Math.max(0, max - candidate.naturalX);
      const pad = Math.min(Math.max(0, deficit - tolerance), candidate.sample.padCapacity);
      candidate.state.naturalX = candidate.sample.x;
      candidate.state.actualX = candidate.naturalX + pad;
      states.set(candidate.sample.trackId, candidate.state);
    }
    envelope.push({ atRt, x: max });
  }

  return {
    targetX(atRt: number): number {
      let lo = 0;
      let hi = envelope.length - 1;
      let hit = 0;
      // Last sample whose atRt is <= the query time
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (envelope[mid]!.atRt <= atRt) {
          hit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return envelope.length === 0 ? 0 : envelope[hit]!.x;
    },
    isSynchronized(atRt: number): boolean {
      return synchronizedAtRts.has(atRt);
    },
  };
}

/** Build the block resolver used by the layout (tests and service share these defaults). */
export function layoutResolver(
  regions: RegionTable = DEFAULT_REGIONS,
  overrides: BlockOverrides = {},
): BlockResolver {
  return createBlockResolver(blockDefaults(regions), overrides);
}

/** Order inputs by source-track priority, highest first. */
function orderTrackInputs<T extends { index: number; sourceIndices: number[] }>(
  inputs: T[],
  laneOrder: readonly number[] | undefined,
): { ordered: T[]; leadTrackIndex: number | null } {
  if (!laneOrder || laneOrder.length === 0) return { ordered: inputs, leadTrackIndex: null };
  const rank = new Map<number, number>();
  laneOrder.forEach((trackIndex, index) => rank.set(trackIndex, index));
  const ranked = [...inputs].sort((a, b) => {
    const rankOf = (input: T): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const source of input.sourceIndices) best = Math.min(best, rank.get(source) ?? best);
      return best;
    };
    const delta = rankOf(a) - rankOf(b);
    return delta === 0 ? a.index - b.index : delta;
  });
  const lead = ranked[0];
  if (!lead) return { ordered: [], leadTrackIndex: null };
  // Priority order is distance order: the layout walks this list and always takes the
  // nearer side of the player's row, so the first entry ends up closest.
  return { ordered: ranked, leadTrackIndex: lead.index };
}

/** One entry per source track, including the source tracks of a merged group. */
function trackInstrumentsFor(
  inputs: LayoutInput[],
  assignments: Record<number, TrackAssignment>,
  transpose?: Record<number, number>,
): TrackInstrumentInfo[] {
  const result: TrackInstrumentInfo[] = [];
  for (const input of inputs) {
    for (const trackIndex of input.sourceIndices) {
      const assignment = assignments[trackIndex];
      result.push({
        trackIndex,
        native: assignment?.native ?? input.native,
        effective:
          input.voicing.kind === 'pitch'
            ? 'piano'
            : input.voicing.kind === 'drums'
              ? 'drums'
              : input.voicing.instrument,
        source: assignment?.source ?? input.source,
        substituted: assignment?.substituted ?? input.substituted,
        octaveOffset: input.octaveOffset + (transpose?.[trackIndex] ?? 0),
        outsideNotes: input.outside,
      });
    }
  }
  return result.sort((a, b) => a.trackIndex - b.trackIndex);
}

/** Top-level entry point: SongModel -> redstone layout. */
/** Shortest head worth trading for a tap; below this the tap costs as much as it saves. */
const MIN_RIDE_HEAD = 24;

/** Cells the lanes above already occupy, seen by the tap search. */
interface LaneCells {
  /** Every occupied X/Z column, at any Y: a corridor may only use a column that is free. */
  used: Set<string>;
  /** Repeater columns: a repeater beside a corridor repeater would lock it. */
  diodes: Set<string>;
}

function laneCellKey(x: number, z: number): string {
  return `${x},${z}`;
}

/** Record a finished lane so later lanes can tap it without crossing its blocks. */
function rememberLane(track: TrackSkeleton, cells: LaneCells): void {
  for (const entry of track.placements) {
    cells.used.add(laneCellKey(entry.pos.x, entry.pos.z));
    if (entry.block === 'minecraft:repeater') cells.diodes.add(laneCellKey(entry.pos.x, entry.pos.z));
  }
}

/** True when the same cell is written twice, which means two parts of a lane collide. */
function hasRepeatedCell(track: TrackSkeleton): boolean {
  const seen = new Set<string>();
  for (const entry of track.placements) {
    const key = `${entry.pos.x},${entry.pos.y},${entry.pos.z}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

interface RidePlan {
  x: number;
  hostZ: number;
  prevRt: number;
  hostTrackIndex: number;
  corridor: number[];
  facing: 'north' | 'south';
}

/**
 * Find a cell on a neighbouring lane where this lane can start without a head of its own.
 *
 * The tap has to land on a **dust** cell: a repeater cannot be read from its side. The
 * crossed rows and this lane's own row must be free there, and the guest must still have
 * room to lay the delay chain for the rest of its first gap before the reference line,
 * otherwise the notes would land east of where their tick puts them. The latest usable
 * cell wins - it leaves the least padding to lay.
 *
 * Neighbouring lanes are not always two rows apart: a lane with chord branches adds a row
 * on each side, and a merged lane has more of them, so insisting on a single empty row is
 * what made taps disappear as soon as merging was on. Instead the tap walks up one
 * repeater per crossed row. A repeater reads only its own input side and repeats the
 * signal at full strength, so such a column carries the tap across the rows in between
 * without touching the branches that share them; each repeater costs one redstone tick,
 * which is why a shorter corridor is preferred at equal reach.
 */
function chooseRide(
  tracks: readonly TrackSkeleton[],
  zBase: number,
  notes: readonly NoteToPlace[],
  plan: XPlan,
  base: number,
  cells: LaneCells,
): RidePlan | null {
  let firstRt = Number.POSITIVE_INFINITY;
  for (const note of notes) firstRt = Math.min(firstRt, gameTickToRedstone(note.source.tick));
  if (!Number.isFinite(firstRt)) return null;
  const atRt = firstRt + base;
  const target = plan.targetX(atRt);
  if (target < MIN_RIDE_HEAD) return null;
  let best: RidePlan | null = null;
  for (const host of tracks) {
    if (!host.line || host.line.length === 0) continue;
    const delta = zBase - host.zBase;
    if (delta === 0) continue;
    // `facing` names the input side, so a host below means every repeater in the corridor
    // faces north (reads the row below it) and drives the row above it.
    const facing: 'north' | 'south' = delta > 0 ? 'north' : 'south';
    const step = delta > 0 ? 1 : -1;
    const corridor: number[] = [];
    for (let z = host.zBase + step; z !== zBase; z += step) corridor.push(z);
    for (const cell of host.line) {
      if (cell.kind !== 'dust') continue;
      // One repeater per crossed row: each adds its own delay before the guest sees it.
      const prevRt = cell.rt + corridor.length;
      if (prevRt >= atRt) continue;
      if (cells.used.has(laneCellKey(cell.x, zBase))) continue;
      let clear = true;
      for (const z of corridor) {
        if (
          cells.used.has(laneCellKey(cell.x, z)) ||
          cells.diodes.has(laneCellKey(cell.x - 1, z)) ||
          cells.diodes.has(laneCellKey(cell.x + 1, z))
        ) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const chain = Math.ceil((atRt - prevRt) / MAX_REPEATER_DELAY);
      if (cell.x + chain + 2 > target) continue;
      // Latest cell wins; at equal x the shorter corridor wins because it is fewer blocks.
      if (!best || cell.x > best.x || (cell.x === best.x && corridor.length < best.corridor.length)) {
        best = { x: cell.x, hostZ: host.zBase, prevRt, hostTrackIndex: host.trackIndex, corridor, facing };
      }
    }
  }
  return best;
}

export function layout(song: SongModel, opts: LayoutOptions = {}): LayoutResult {
  const config: LayoutConfig = { ...DEFAULT_LAYOUT_CONFIG, ...opts.config };
  // A non-positive or non-finite TPS makes every derived tick NaN. Report it as the
  // configuration problem it is, rather than as an invalid tick further downstream.
  if (!Number.isFinite(config.baseTps) || config.baseTps <= 0) {
    throw coreError('LAYOUT_INVALID_CONFIG', { field: 'baseTps' });
  }
  const regions = opts.regions ?? DEFAULT_REGIONS;
  const exclude = new Set(opts.excludeTracks ?? []);
  const resolve = layoutResolver(regions, opts.blocks ?? {});

  // Compute each track's note array once: the row pre-scan, the song-wide lead-in and
  // the main loop all reuse it.
  const assignments = opts.assignments ?? {};
  const inputs: LayoutInput[] = [];
  for (const t of song.tracks) {
    if (exclude.has(t.index) || t.notes.length === 0) continue;
    const notes: TrackNote[] = t.notes.map((n) => {
      const tick = secondsToTick(n.timeSec, config.baseTps);
      // The plan's grouping loop advances by comparing `atRt`, and `NaN === NaN` is
      // false, so a non-finite tick would spin forever instead of failing. Refuse it.
      if (!Number.isSafeInteger(tick) || tick < 0) {
        throw coreError('LAYOUT_INVALID_TICK', { track: t.index, tick: n.timeSec });
      }
      return { tick, midi: n.midi };
    });
    const assignment = assignments[t.index];
    const voicing: TrackVoicing = assignment?.voicing ?? { kind: 'pitch' };
    inputs.push({
      index: t.index,
      notes,
      // Without an assignment table, keep the historical merge key so existing
      // callers still merge by MIDI instrument rather than folding everything
      // into the piano class.
      key: assignment ? voicingKey(voicing, t.index) : t.percussion ? 'percussion' : t.instrument,
      trackName: t.name,
      voicing,
      sourceIndices: [t.index],
      native: assignment?.native ?? 'harp',
      source: assignment?.source ?? 'fallback',
      substituted: assignment?.substituted ?? false,
      assigned: assignment !== undefined,
      octaveOffset: 0,
      outside: 0,
    });
  }

  // Warnings that describe the assignment itself are reported once per source track.
  const assignmentWarnings: LayoutWarning[] = [];
  for (const input of inputs) {
    if (!input.assigned || input.voicing.kind === 'drums') continue;
    if (input.source === 'fallback') {
      assignmentWarnings.push({ code: 'INSTRUMENT_UNKNOWN', trackIndex: input.index });
    }
    if (input.substituted && input.native !== 'drums' && input.voicing.kind === 'instrument') {
      assignmentWarnings.push({
        code: 'INSTRUMENT_SUBSTITUTED',
        trackIndex: input.index,
        native: input.native,
        effective: input.voicing.instrument,
      });
    }
  }

  // Legacy merging adds simultaneous notes, so merge first and only then work out the
  // spacing and the whole-track octave shift. Forced merging is different: it builds one
  // spine for the whole song, so it must keep every source track's own voicing separate.
  // Map every source track once, before merging. The octave fit belongs to the track,
  // not to the lane: two tracks that share an instrument keep the octave that suits
  // each of them, and the shared lane is simply the union of the mapped notes. Fitting
  // the union instead moved notes that had been placed correctly on their own.
  const mappedNotes = new Map<number, NoteToPlace[]>();
  const fitWarnings: LayoutWarning[] = [];
  const mapWarnings: LayoutWarning[] = [];
  const rangeShiftTotal = { notes: 0, maxSemitones: 0 };
  for (const input of inputs) {
    if (input.voicing.kind === 'instrument') {
      const fit = chooseOctaveOffset(
        input.notes,
        input.voicing.instrument,
        opts.transpose?.[input.index] ?? 0,
      );
      input.octaveOffset = fit.offset;
      input.outside = fit.outside;
      // The warning is about the automatic fit; the user's transpose is separate and
      // already visible in the table.
      if (fit.offset !== 0) {
        fitWarnings.push({
          code: 'INSTRUMENT_OCTAVE_SHIFT',
          trackIndex: input.index,
          instrument: input.voicing.instrument,
          octaves: fit.offset,
          notes: input.notes.length,
        });
      }
      if (input.notes.length > 0) {
        // Span is the written range before the whole-track octave fit; transpose and
        // octave offset move every note together and cannot change it. `outside` is
        // counted after that fit, which is what the warning needs to say.
        const pitchRange = numericRange(input.notes.map((note) => note.midi));
        const span = pitchRange ? pitchRange.max - pitchRange.min : 0;
        if (span > 24) {
          fitWarnings.push({
            code: 'INSTRUMENT_RANGE_OVERFLOW',
            trackIndex: input.index,
            instrument: input.voicing.instrument,
            span,
            outside: fit.outside,
          });
        }
      }
    }

    const mapping = mapTrackNotes({
      notes: input.notes,
      regions,
      outOfRange: opts.outOfRange ?? 'warn',
      transpose: opts.transpose?.[input.index] ?? 0,
      trackIndex: input.index,
      voicing: input.voicing,
      octaveOffset: input.octaveOffset,
      trackName: input.trackName,
    });
    mappedNotes.set(input.index, mapping.notes);
    // Pushed one by one: a 200k-note track produces 200k warnings, and spreading them
    // into push() exceeds the argument limit and throws RangeError.
    for (const warning of mapping.warnings) mapWarnings.push(warning);
    rangeShiftTotal.notes += mapping.rangeShift.notes;
    rangeShiftTotal.maxSemitones = Math.max(rangeShiftTotal.maxSemitones, mapping.rangeShift.maxSemitones);
  }
  const instrumentWarnings = [...assignmentWarnings, ...fitWarnings, ...mapWarnings];

  const merged =
    opts.mergeSameInstrument && !opts.forceMergeSameInstrument ? mergeByInstrument(inputs) : inputs;
  const trackInputs = applyLaneGroups(merged, opts.laneGroups);

  if (opts.forceMergeSameInstrument) {
    const forced = buildForcedLayout(inputs, {
      config,
      regions,
      resolve,
      transpose: opts.transpose,
      outOfRange: opts.outOfRange,
    });
    return {
      ...forced,
      warnings: [...instrumentWarnings, ...forced.warnings],
      trackInstruments: trackInstrumentsFor(inputs, assignments, opts.transpose),
    };
  }
  const { ordered: orderedInputs, leadTrackIndex } = orderTrackInputs(trackInputs, opts.laneOrder);
  const standTrackIndex = leadTrackIndex ?? opts.standTrackIndex ?? null;
  if (leadTrackIndex === null && standTrackIndex !== null) {
    // Historical order is kept, but the standing row still has to be the lead's, so that
    // lane is laid out first and anchored on z = 0.
    const at = orderedInputs.findIndex((input) => input.sourceIndices.includes(standTrackIndex));
    if (at > 0) orderedInputs.unshift(...orderedInputs.splice(at, 1));
  }
  const maxSideRows = Math.max(1, Math.min(14, Math.floor(config.dMax)));
  const maxChordNotes = chordCapacity(config.dMax);
  let minRt = Number.POSITIVE_INFINITY;
  for (const { notes } of trackInputs) {
    for (const n of notes) minRt = Math.min(minRt, gameTickToRedstone(n.tick));
  }

  // A repeater's minimum delay is 1, so a note at rt 0 cannot sound before one
  // redstone tick in. To preserve **relative timing across tracks** this lead-in has
  // to be identical song-wide: if any track has a group at rt 0, every track gets +1.
  // Inferring it per track would give the tracks inconsistent first-note offsets.
  const base = minRt === 0 ? 1 : 0;

  // Multi-track spatial alignment: X follows song time, advancing the shared reference
  // line from every track's reachable position after earlier padding.
  const samples: Array<{ atRt: number; x: number; trackId: number; padCapacity: number }> = [];
  for (const { index, notes } of trackInputs) {
    samples.push(
      ...naturalSamples(notes, base, maxChordNotes).map((sample) => ({
        ...sample,
        trackId: index,
      })),
    );
  }
  const plan = buildXPlan(samples);

  // Track Z spacing follows each track's own chord depth, not the song's widest chord.
  // The previous global value reserved room for the widest track everywhere: two tracks
  // that both used one row still sat `2 * maxRows + 2` apart, which put six or more empty
  // rows between neighbours, far beyond what the redstone needs to stay separate.
  const minCenterGap = config.trackPitch === 'auto' ? 0 : config.trackPitch;
  // Lanes are now laid out on **both** sides of the row the player stands on. The old code
  // walked Z in one direction, so the last lane was as far away as the song was deep, even
  // though the player stands in the middle of it: the 48-block rule is a radius around the
  // player, not the width of the arrangement. Emitting the lanes in priority order and
  // always taking the nearer side puts the loudest lane next to the player and grows the
  // arrangement outwards evenly.
  let aboveLimit = 0;
  let belowLimit = 0;
  let nearestAbove: number | null = null;
  let nearestBelow: number | null = null;
  let preferAbove = true;
  let standPlaced = false;
  /** Row of the lane the player stands on, once that lane has been placed. */
  let standLaneZ: number | null = null;

  const warnings: LayoutWarning[] = [...instrumentWarnings];
  // One notice for the whole song. Every track is shifted by the same lead-in, so this
  // is not a per-note problem and must not be reported as one.
  if (base === 1) warnings.push({ code: 'STARTUP_LEAD_IN', ticks: GAME_TICKS_PER_REDSTONE_TICK });
  const tracks = [];
  const placed: LayoutResult['placed'] = [];
  let maxTick = 0;
  // The tap search needs the columns the lanes above already occupy, heads included.
  const laneCells: LaneCells = { used: new Set(), diodes: new Set() };

  for (const input of orderedInputs) {
    const { index, notes } = input;
    // Groups past the column's chord capacity move to a new track (TRACK_SPLIT). Each
    // track has its own main line and column capacity, and they all start at the same
    // instant: the remaining notes are laid out again on the new track while their
    // trigger times stay unchanged.
    // Mapped once per source track above; a shared lane concatenates its members.
    let pending = input.sourceIndices.flatMap((source) => mappedNotes.get(source) ?? []);
    let laneSide: 'above' | 'below' | null = null;
    for (let lane = 0; pending.length > 0; lane++) {
      // The row count only depends on tick and pitch, which the source note still has.
      const sides = chordSideRows(
        pending.map((note) => note.source),
        maxSideRows,
      );
      // One empty row always remains between two neighbours; an explicit trackPitch is a
      // minimum centre distance, never a collision.
      const placeAbove = (): number => {
        let z = aboveLimit - 1 - sides.down;
        if (nearestAbove !== null) z = Math.min(z, nearestAbove - minCenterGap);
        aboveLimit = z - sides.up - 1;
        nearestAbove = z;
        return z;
      };
      const placeBelow = (): number => {
        let z = belowLimit + 1 + sides.up;
        if (nearestBelow !== null) z = Math.max(z, nearestBelow + minCenterGap);
        belowLimit = z + sides.down + 1;
        nearestBelow = z;
        return z;
      };
      let zBase: number;
      if (!standPlaced) {
        // The standing lane is the reference row: the player stands on it, so it sits on
        // z = 0 and every hearing decision is measured from there.
        zBase = 0;
        standPlaced = true;
        standLaneZ = zBase;
        aboveLimit = -sides.up - 1;
        belowLimit = sides.down + 1;
        nearestAbove = 0;
        nearestBelow = 0;
      } else if (laneSide !== null) {
        // A split stays beside the lane it was split from instead of jumping across.
        zBase = laneSide === 'above' ? placeAbove() : placeBelow();
      } else {
        // Nearer side first: priority order then equals distance order.
        const goAbove: boolean = -aboveLimit < belowLimit || (-aboveLimit === belowLimit && preferAbove);
        zBase = goAbove ? placeAbove() : placeBelow();
        laneSide = goAbove ? 'above' : 'below';
        preferAbove = !goAbove;
      }
      const buildOptions = {
        trackIndex: index,
        sourceIndices: input.sourceIndices,
        zBase,
        mapped: pending,
        config,
        regions,
        resolve,
        collectOverflow: true,
        base,
        plan,
      };
      const ride = opts.laneRide === true ? chooseRide(tracks, zBase, pending, plan, base, laneCells) : null;
      const hostTrack = ride ? tracks.find((candidate) => candidate.zBase === ride.hostZ) : undefined;
      let built = buildTrack(ride ? { ...buildOptions, ride } : buildOptions);
      // A tap that cannot be padded back onto the reference line would place notes east of
      // their tick; the head is the fallback that never drifts.
      if (ride && built.warnings.some((warning) => warning.code === 'SPATIAL_DRIFT')) {
        built = buildTrack(buildOptions);
      }
      // The corridor is chosen before this lane's own branches exist, so it can land on
      // one of them. Two blocks in one cell would paste as one, silently breaking the tap;
      // the head is the fallback that always fits.
      if (ride && built.track.ride && hasRepeatedCell(built.track)) {
        built = buildTrack(buildOptions);
      }
      const { track, warnings: w, overflow, placed: pl, rangeShift: laneShift } = built;
      if (hostTrack && track.ride) {
        // The tap changes how the host's dust connects towards the gap row.
        applyWireConnections([...hostTrack.placements, ...track.placements]);
      }

      for (const warning of w) warnings.push(warning);
      rangeShiftTotal.notes += laneShift.notes;
      rangeShiftTotal.maxSemitones = Math.max(rangeShiftTotal.maxSemitones, laneShift.maxSemitones);
      tracks.push(track);
      rememberLane(track, laneCells);
      for (const p of pl) placed.push({ trackIndex: index, zBase, ...p });

      if (overflow.length === 0) break;
      pending = overflow.flatMap((o) => o.notes);
      for (const o of overflow) {
        warnings.push({ code: 'TRACK_SPLIT', tick: o.tick, notes: o.notes.length });
      }
    }

    for (const g of groupByTick(notes)) maxTick = Math.max(maxTick, g.tick);
  }

  // Bounding box over everything. Region origins are derived from it, so getting this
  // wrong makes the exported coordinates fall outside the region.
  const bounds = boundsOf(tracks.flatMap((track) => track.placements));
  // An empty layout keeps the size it reported before: this is a de-duplication, not a
  // change of behaviour.
  const min: Vec3 = bounds ? bounds.min : { x: 0, y: 0, z: 0 };
  const size: Vec3 = bounds ? sizeOf(bounds.min, bounds.max) : { x: 1, y: config.circuitY + 1, z: 1 };

  // The standing lane sits on z = 0, and its row is the one the player can stand on while
  // the dust runs. Radius, not Z span, is what the 48-block rule measures.
  // Without an explicit lead the stand row is the lane the layout anchored at z = 0; the
  // midpoint is only a fallback for a song with no notes at all.
  const standLane =
    standTrackIndex === null
      ? null
      : (tracks.find((track) => track.sourceIndices.includes(standTrackIndex)) ?? null);
  const spot = hearingSpot(tracks, standLaneZ ?? standLane?.zBase ?? null);

  return {
    tracks,
    size,
    playerZ: spot.playerZ,
    hearingRadius: spot.hearingRadius,
    min,
    totalTicks: maxTick,
    warnings,
    placed,
    rangeShift: rangeShiftTotal,
    trackInstruments: trackInstrumentsFor(inputs, assignments, opts.transpose),
  };
}
