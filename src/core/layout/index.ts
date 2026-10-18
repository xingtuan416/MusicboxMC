import {
  buildTrack,
  chordCapacity,
  GAME_TICKS_PER_REDSTONE_TICK,
  gameTickToRedstone,
  chordSideRows,
  groupByTick,
  naturalSamples,
  type TrackNote,
  type XPlan,
} from './track';
import type { LayoutConfig, LayoutResult, LayoutWarning, TrackInstrumentInfo, Vec3 } from './types';
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
import { chooseOctaveOffset } from '../palette/instrumentPitch';
import { INSTRUMENTS, type NoteBlockInstrument } from '../palette/instruments';
import type { TrackAssignment, TrackVoicing } from '../palette/assignment';
import { buildForcedLayout } from './forced';

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
      hit.notes.push(...input.notes);
      hit.sourceIndices.push(...input.sourceIndices);
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
 * Build the shared "song time -> X" reference line: the **upper envelope** of every
 * track's natural X.
 *
 * An upper envelope is never behind any track, so each track only has to pad forward
 * with dust (zero delay) to keep up. Nothing ever has to move backwards or be
 * compressed, and no delay is altered and no cross-track wiring is needed. The X
 * difference between tracks at any quantised time is therefore bounded, instead of
 * accumulating over the length of the song.
 */
function buildXPlan(samples: Array<{ atRt: number; x: number; trackId: number }>): XPlan {
  const sorted = [...samples].sort((a, b) => a.atRt - b.atRt);
  const envelope: Array<{ atRt: number; x: number }> = [];
  const synchronizedAtRts = new Set<number>();
  let max = 0;
  for (const s of sorted) {
    max = Math.max(max, s.x);
    const last = envelope[envelope.length - 1];
    if (last && last.atRt === s.atRt) last.x = max;
    else envelope.push({ atRt: s.atRt, x: max });
  }

  // Mark a time as synchronised whenever two or more independent tracks land a note
  // there. Simultaneous notes should share an X wherever possible; the natural
  // distance only decides whether padding can close the gap, and must not be used as
  // a threshold for giving up. Otherwise a dense and a sparse track would settle onto
  // permanently different axes late in a long song, as soon as their natural distance
  // exceeded the check window.
  for (let i = 0; i < sorted.length;) {
    const atRt = sorted[i]!.atRt;
    const sameTime = [];
    while (i < sorted.length && sorted[i]!.atRt === atRt) {
      sameTime.push(sorted[i]!);
      i += 1;
    }
    // `NaN === NaN` is false, so a non-finite time would consume nothing and spin here
    // forever. The tick is validated before the plan is built; this makes the loop
    // provably terminating anyway, so a future path cannot hang the process.
    if (sameTime.length === 0) break;
    const trackIds = new Set(sameTime.map((s) => s.trackId));
    if (trackIds.size >= 2) synchronizedAtRts.add(atRt);
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

/** One entry per source track, including the source tracks of a merged group. */
function trackInstrumentsFor(
  inputs: LayoutInput[],
  assignments: Record<number, TrackAssignment>,
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
        octaveOffset: input.octaveOffset,
        outsideNotes: input.outside,
      });
    }
  }
  return result.sort((a, b) => a.trackIndex - b.trackIndex);
}

/** Top-level entry point: SongModel -> redstone layout. */
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

  // Warnings that describe the assignment itself are reported once per source track;
  // the octave shift is a property of the merged group, so it is computed after merging.
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
  const merged =
    opts.mergeSameInstrument && !opts.forceMergeSameInstrument ? mergeByInstrument(inputs) : inputs;

  const fitWarnings: LayoutWarning[] = [];
  for (const input of merged) {
    if (input.voicing.kind !== 'instrument') continue;
    const fit = chooseOctaveOffset(input.notes, input.voicing.instrument);
    input.octaveOffset = fit.offset;
    input.outside = fit.outside;
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
      const midis = input.notes.map((note) => note.midi);
      const span = Math.max(...midis) - Math.min(...midis);
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
  const instrumentWarnings = [...assignmentWarnings, ...fitWarnings];

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
      trackInstruments: trackInstrumentsFor(inputs, assignments),
    };
  }
  const trackInputs = merged;
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

  // Multi-track spatial alignment: X follows song time, using the upper envelope of
  // every track's natural X as the shared reference line.
  const samples: Array<{ atRt: number; x: number; trackId: number }> = [];
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
  // First free cell before the first track. A lane's upper band starts at `zCursor + 1`,
  // so one empty row always remains between two neighbours.
  let zCursor = -1;
  let previousBase: number | null = null;

  const warnings: LayoutWarning[] = [...instrumentWarnings];
  // One notice for the whole song. Every track is shifted by the same lead-in, so this
  // is not a per-note problem and must not be reported as one.
  if (base === 1) warnings.push({ code: 'STARTUP_LEAD_IN', ticks: GAME_TICKS_PER_REDSTONE_TICK });
  const tracks = [];
  const placed: LayoutResult['placed'] = [];
  const rangeShiftTotal = { notes: 0, maxSemitones: 0 };
  let maxTick = 0;

  for (const input of trackInputs) {
    const { index, notes } = input;
    // Groups past the column's chord capacity move to a new track (TRACK_SPLIT). Each
    // track has its own main line and column capacity, and they all start at the same
    // instant: the remaining notes are laid out again on the new track while their
    // trigger times stay unchanged.
    let pending = notes;
    for (let lane = 0; pending.length > 0; lane++) {
      const sides = chordSideRows(pending, maxSideRows);
      // Reserve this lane's own branch rows plus exactly one empty row before the next
      // lane. An explicit trackPitch is a minimum centre distance, never a collision.
      let zBase = zCursor + 1 + sides.up;
      if (previousBase !== null) zBase = Math.max(zBase, previousBase + minCenterGap);
      zCursor = zBase + sides.down + 1;
      previousBase = zBase;
      const {
        track,
        warnings: w,
        overflow,
        placed: pl,
        rangeShift: laneShift,
      } = buildTrack({
        trackIndex: index,
        zBase,
        notes: pending,
        config,
        regions,
        resolve,
        transpose: opts.transpose?.[index] ?? 0,
        outOfRange: opts.outOfRange,
        voicing: input.voicing,
        octaveOffset: input.octaveOffset,
        trackName: input.trackName,
        collectOverflow: true,
        // Only the first lane reports: the rest carry notes that were mapped and
        // reported already, and re-reporting them counted one source note several times.
        reportRangeWarnings: lane === 0,
        base,
        plan,
      });

      warnings.push(...w);
      rangeShiftTotal.notes += laneShift.notes;
      rangeShiftTotal.maxSemitones = Math.max(rangeShiftTotal.maxSemitones, laneShift.maxSemitones);
      tracks.push(track);
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

  return {
    tracks,
    size,
    min,
    totalTicks: maxTick,
    warnings,
    placed,
    rangeShift: rangeShiftTotal,
    trackInstruments: trackInstrumentsFor(trackInputs, assignments),
  };
}
