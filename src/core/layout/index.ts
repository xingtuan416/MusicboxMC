import {
  buildTrack,
  chordCapacity,
  GAME_TICKS_PER_REDSTONE_TICK,
  gameTickToRedstone,
  groupByTick,
  maxChordRows,
  naturalSamples,
  type TrackNote,
  type XPlan,
} from './track';
import type { LayoutConfig, LayoutResult, LayoutWarning, Vec3 } from './types';
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
import type { TrackModel } from '../midi/types';
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
  /** Opt-in: one connected time spine per instrument; takes precedence over legacy merging. */
  forceMergeSameInstrument?: boolean;
}

/** Merge key: percussion is its own class, everything else groups by instrument name. */
function instrumentKey(t: TrackModel): string {
  return t.percussion ? 'percussion' : t.instrument;
}

function mergeByInstrument<T extends { index: number; notes: TrackNote[]; key: string }>(inputs: T[]): T[] {
  const groups = new Map<string, T>();
  for (const input of inputs) {
    const hit = groups.get(input.key);
    if (hit) hit.notes.push(...input.notes);
    else groups.set(input.key, { ...input, notes: [...input.notes] });
  }
  return [...groups.values()];
}

/** Base blocks already differ per pitch region, so feed them to the resolver as region-level defaults. */
function regionDefaults(regions: RegionTable): BlockDefaults {
  // Only the slots this palette defines: the single-instrument palette has just one.
  const byRegion: Partial<Record<PitchRegion, Partial<BlockTable>>> = {};
  for (const [region, def] of Object.entries(regions)) {
    if (def) byRegion[region as PitchRegion] = { noteBase: def.baseBlock };
  }
  return { global: DEFAULT_BLOCK_TABLE, regions: byRegion };
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
  return createBlockResolver(regionDefaults(regions), overrides);
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
  const inputs: Array<{ index: number; notes: TrackNote[]; key: string }> = [];
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
    inputs.push({ index: t.index, notes, key: instrumentKey(t) });
  }

  // Merging adds simultaneous notes, so merge first and only then work out the track
  // spacing and the lead-in.
  if (opts.forceMergeSameInstrument) {
    return buildForcedLayout(mergeByInstrument(inputs), {
      config,
      regions,
      resolve,
      transpose: opts.transpose,
      outOfRange: opts.outOfRange,
    });
  }
  const trackInputs = opts.mergeSameInstrument ? mergeByInstrument(inputs) : inputs;
  const maxSideRows = Math.max(1, Math.min(14, Math.floor(config.dMax)));
  const maxChordNotes = chordCapacity(config.dMax);
  let maxRows = 0;
  let minRt = Number.POSITIVE_INFINITY;
  for (const { notes } of trackInputs) {
    maxRows = Math.max(maxRows, maxChordRows(notes, maxSideRows));
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

  const pitch = config.trackPitch === 'auto' ? 2 * maxRows + 2 : config.trackPitch;

  const warnings: LayoutWarning[] = [];
  // One notice for the whole song. Every track is shifted by the same lead-in, so this
  // is not a per-note problem and must not be reported as one.
  if (base === 1) warnings.push({ code: 'STARTUP_LEAD_IN', ticks: GAME_TICKS_PER_REDSTONE_TICK });
  const tracks = [];
  const placed: LayoutResult['placed'] = [];
  let maxTick = 0;
  let trackSlot = 0;

  for (const { index, notes } of trackInputs) {
    // Groups past the column's chord capacity move to a new track (TRACK_SPLIT). Each
    // track has its own main line and column capacity, and they all start at the same
    // instant: the remaining notes are laid out again on the new track while their
    // trigger times stay unchanged.
    let pending = notes;
    for (let lane = 0; pending.length > 0; lane++) {
      const zBase = maxRows + trackSlot * pitch;
      const {
        track,
        warnings: w,
        overflow,
        placed: pl,
      } = buildTrack({
        trackIndex: index,
        zBase,
        notes: pending,
        config,
        regions,
        resolve,
        transpose: opts.transpose?.[index] ?? 0,
        outOfRange: opts.outOfRange,
        collectOverflow: true,
        // Only the first lane reports: the rest carry notes that were mapped and
        // reported already, and re-reporting them counted one source note several times.
        reportRangeWarnings: lane === 0,
        base,
        plan,
      });

      warnings.push(...w);
      tracks.push(track);
      for (const p of pl) placed.push({ trackIndex: index, zBase, ...p });
      trackSlot++;

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
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = config.circuitY;
  let maxZ = 0;
  let hasBlock = false;
  for (const tr of tracks) {
    for (const p of tr.placements) {
      hasBlock = true;
      minX = Math.min(minX, p.pos.x);
      maxX = Math.max(maxX, p.pos.x);
      minY = Math.min(minY, p.pos.y);
      maxY = Math.max(maxY, p.pos.y);
      minZ = Math.min(minZ, p.pos.z);
      maxZ = Math.max(maxZ, p.pos.z);
    }
  }
  if (!hasBlock) {
    minX = 0;
    minY = 0;
    minZ = 0;
  }

  const size: Vec3 = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 };
  const min: Vec3 = { x: minX, y: minY, z: minZ };

  return { tracks, size, min, totalTicks: maxTick, warnings, placed };
}
