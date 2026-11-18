import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMidi } from '../core/midi/parse';
import type { SongModel } from '../core/midi/types';
import { layout, DEFAULT_LAYOUT_CONFIG } from '../core/layout/index';
import { sliceRegions } from '../core/layout/regions';
import {
  annotationSlice,
  planLaneAnnotation,
  SIGN_COLUMN_GAP,
  type LaneAnnotation,
} from '../core/layout/annotation';
import type { LayoutConfig, LayoutResult, LayoutWarning, TrackInstrumentInfo } from '../core/layout/types';
import {
  assignTracks,
  voicingMap,
  type InstrumentMode,
  type TrackAssignment,
} from '../core/palette/assignment';
import { chooseOctaveOffset } from '../core/palette/instrumentPitch';
import { coveredRange, DEFAULT_REGIONS, type RegionTable } from '../core/palette/pitchMap';
import { buildLitematic, MC_1_20_4_DATA_VERSION, LITEMATIC_VERSION_1_20_4 } from '../core/litematic/build';
import { speedTable } from '../core/tempo/speed';
import { buildCommandPlayback } from '../core/command';
import { secondsToTick } from '../core/tempo/tick';
import { planLaneSharing, type LaneSharePlan, type ShareTrack } from '../core/arrangement/laneSharing';
import { analyze } from './analyze';
import { CoreError } from '../core/errors';
import { describeCoreError } from './messages';
import { buildPreview, toRegionData, EMPTY_PREVIEW } from './preview';
import { sanitizeGenerateOptions } from './options';
import {
  buildLaneOrder,
  classifySong,
  decideMerge,
  midiBounds,
  smartModeFor,
  SMART_RADIUS,
  type MergeMode,
  type SongCategory,
} from './smartSelection';
import type {
  AnalyzeResult,
  GenerateOptions,
  GenerateResult,
  LaneAnnotationInfo,
  LaneRideInfo,
  LaneSharingInfo,
  LayoutMeasure,
  ShareOutcome,
  SmartPlanResult,
  SmartSelectionInfo,
} from './types';

/**
 * The generation pipeline: parse, lay out, slice into regions, encode bytes.
 *
 * Failures do not throw. They come back as `success: false` plus a readable
 * message, so the GUI can render them without wrapping every call.
 */

const DEFAULT_PRESETS = [1.0, 0.75, 0.5, 1.5, 2.0];

/** The five-slot piano palette; fixed instruments get their own base blocks. */
const PALETTE_REGIONS: RegionTable = DEFAULT_REGIONS;

/** New API first; the old `extendedRange` boolean stays as a compatibility alias. */
function resolveMode(options: GenerateOptions): InstrumentMode {
  const mode = options.instrumentMode;
  if (mode === 'native' || mode === 'extended') return mode;
  return options.extendedRange === false ? 'native' : 'extended';
}

/** The piano span, or undefined when no track uses the five-slot extension. */
function pitchRangeFor(assignments: readonly TrackAssignment[]): { low: number; high: number } | undefined {
  if (!assignments.some((assignment) => assignment.voicing.kind === 'pitch')) return undefined;
  const [low, high] = coveredRange(PALETTE_REGIONS);
  return { low, high };
}

/** Assignment-level notices; the layout emits the same ones for the redstone backend. */
function assignmentWarnings(assignments: readonly TrackAssignment[]): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  for (const assignment of assignments) {
    if (assignment.voicing.kind === 'drums') continue;
    if (assignment.source === 'fallback') {
      warnings.push({ code: 'INSTRUMENT_UNKNOWN', trackIndex: assignment.trackIndex });
    }
    if (assignment.substituted && assignment.native !== 'drums' && assignment.voicing.kind === 'instrument') {
      warnings.push({
        code: 'INSTRUMENT_SUBSTITUTED',
        trackIndex: assignment.trackIndex,
        native: assignment.native,
        effective: assignment.voicing.instrument,
      });
    }
  }
  return warnings;
}

/** Per-track summary for the result page and the assignment table. */
function summarizeAssignments(
  song: SongModel,
  assignments: readonly TrackAssignment[],
  transpose: Record<number, number> | undefined,
): TrackInstrumentInfo[] {
  return assignments.map((assignment) => {
    const track = song.tracks.find((entry) => entry.index === assignment.trackIndex);
    let octaveOffset = 0;
    let outsideNotes = 0;
    if (assignment.voicing.kind === 'instrument' && track) {
      const trackTranspose = transpose?.[assignment.trackIndex] ?? 0;
      const fit = chooseOctaveOffset(track.notes, assignment.voicing.instrument, trackTranspose);
      octaveOffset = fit.offset + trackTranspose;
      outsideNotes = fit.outside;
    }
    return {
      trackIndex: assignment.trackIndex,
      native: assignment.native,
      effective:
        assignment.voicing.kind === 'pitch'
          ? 'piano'
          : assignment.voicing.kind === 'drums'
            ? 'drums'
            : assignment.voicing.instrument,
      source: assignment.source,
      substituted: assignment.substituted,
      octaveOffset,
      outsideNotes,
    };
  });
}

function generateCommands(
  song: SongModel,
  base: AnalyzeResult,
  options: GenerateOptions,
  start: number,
  assignments: readonly TrackAssignment[],
  smartSelection?: SmartSelectionInfo,
): { result: GenerateResult; buffer: Buffer | null } {
  const presets = options.speedPresets ?? DEFAULT_PRESETS;
  const baseTps = options.baseTps ?? DEFAULT_LAYOUT_CONFIG.baseTps;
  try {
    const compiled = buildCommandPlayback(song, {
      ...options,
      regions: PALETTE_REGIONS,
      assignments: voicingMap(assignments),
    });
    const region = compiled.region;
    const buffer = buildLitematic([region], {
      name: song.name || base.file,
      author: options.author ?? 'MusicboxMC',
      description: `MusicboxMC command playback / ${compiled.info.playedNotes} notes / ${compiled.totalTicks} game ticks`,
      dataVersion: MC_1_20_4_DATA_VERSION,
      version: LITEMATIC_VERSION_1_20_4,
    });
    // Commands are vertically packed; the preview shows their top-down footprint.
    const slice = {
      trackIndex: -1,
      position: region.position,
      size: region.size,
      blocks: region.blocks
        .filter((block) => block.state.name !== 'minecraft:air')
        .map((block) => ({
          pos: { x: block.x, y: block.y, z: block.z },
          block: block.state.name,
          props: block.state.properties,
        })),
    };
    return {
      buffer,
      result: {
        ...base,
        success: true,
        bytes: buffer.length,
        playbackMode: 'command',
        commandPlayback: compiled.info,
        outOfRangeNotes: compiled.warnings.filter((warning) => warning.code === 'OUT_OF_RANGE').length,
        pitchRange: pitchRangeFor(assignments),
        stats: {
          tickCount: compiled.totalTicks,
          noteBlockCount: 0,
          commandBlockCount: compiled.commandBlockCount,
          circuitBlocks: slice.blocks.length,
          regionCount: 1,
          elapsedMs: Date.now() - start,
          outputTrackCount: 1,
          startupDelayTicks: 0,
        },
        speedTable: speedTable(song.durationSec, presets, baseTps),
        warnings: [...assignmentWarnings(assignments), ...compiled.warnings],
        // Command playback places no grouped cells, so there is nothing to point at.
        placed: [],
        // Its own mapping is not counted here yet; see the review note in docs.
        rangeShift: { notes: 0, maxSemitones: 0 },
        trackInstruments: summarizeAssignments(song, assignments, options.transpose),
        ...(smartSelection ? { smartSelection } : {}),
        regions: [
          {
            name: 'region_0',
            trackIndex: -1,
            position: region.position,
            size: region.size,
            blockCount: slice.blocks.length,
          },
        ],
        preview: buildPreview([slice], true),
      },
    };
  } catch (error) {
    const result = failure({
      base,
      durationSec: song.durationSec,
      presets,
      baseTps,
      error: `命令播放生成失败：${describeCoreError(error)}`,
    });
    result.playbackMode = 'command';
    return { result, buffer: null };
  }
}

function layoutOptions(
  options: GenerateOptions,
  assignments: Record<number, TrackAssignment>,
  laneOrder: readonly number[] = [],
  laneGroups?: readonly (readonly number[])[],
  standTrackIndex?: number,
) {
  // Pass through only the options the user set explicitly; layout() merges the rest with defaults
  const config: Partial<LayoutConfig> = {};
  if (options.baseTps !== undefined) config.baseTps = options.baseTps;
  if (options.dMax !== undefined) config.dMax = options.dMax;

  return {
    config,
    regions: PALETTE_REGIONS,
    outOfRange: options.outOfRange,
    excludeTracks: options.excludeTracks,
    transpose: options.transpose,
    blocks: options.blocks,
    mergeSameInstrument: options.mergeSameInstrument,
    forceMergeSameInstrument: options.forceMergeSameInstrument,
    assignments,
    laneOrder,
    // Centring off keeps the historical lane order, but the player still stands on the
    // lead lane: the standing row is what every hearing measurement is taken from.
    ...(standTrackIndex === undefined ? {} : { standTrackIndex }),
    ...(laneGroups && laneGroups.length > 0 ? { laneGroups } : {}),
    // Opt-in: a caller that never set the switch keeps the historical layout byte for byte.
    ...(options.laneRide === true ? { laneRide: true } : {}),
  };
}

/** Column capacity the layout will use, so planning matches what is actually built. */
function layoutDMax(options: GenerateOptions): number {
  return options.dMax ?? DEFAULT_LAYOUT_CONFIG.dMax;
}

/**
 * Propose which sparse tracks could share a lane.
 *
 * Planning works on trigger times, so note times are converted with the same tempo the
 * layout uses; a different grid would juggle a different set of columns than the one that
 * gets built. The result is a proposal only - folding notes onto a host can deepen its
 * chord rows, so the caller still has to lay it out and measure.
 */
function trackTicks(song: SongModel, baseTps: number): Map<number, number[]> {
  // Trigger times are the unit both planners reason in, and both run in the same pass;
  // converting once keeps the two views of a lane on one grid.
  const map = new Map<number, number[]>();
  for (const track of song.tracks) {
    map.set(
      track.index,
      track.notes.map((note) => secondsToTick(note.timeSec, baseTps)),
    );
  }
  return map;
}

function shareLanesFor(
  options: GenerateOptions,
  ticks: ReadonlyMap<number, number[]>,
  excluded: ReadonlySet<number>,
  leadIndex: number | null,
  order: readonly number[],
): LaneSharePlan | null {
  // Opt-in only: a caller that never heard of lane sharing keeps its old layout exactly.
  if (options.laneSharing !== true) return null;
  const tracks: ShareTrack[] = [];
  for (const [index, perTrack] of ticks) {
    if (excluded.has(index)) continue;
    tracks.push({ index, ticks: perTrack });
  }
  const plan = planLaneSharing(tracks, {
    dMax: layoutDMax(options),
    leadIndex,
    order,
    ...(options.laneShareSparseBelow === undefined ? {} : { sparseBelow: options.laneShareSparseBelow }),
  });
  return plan.groups.length > 0 ? plan : null;
}

/**
 * Propose which sparse *lanes* could share a lane, once lanes have been merged.
 *
 * A merge collapses instruments before lanes exist, so the source-level plan above can no
 * longer see the result: a lane that inherited four tracks counts as dense even when the
 * line it draws is nearly empty. Planning on the lanes the merge just produced is the only
 * way to fold those without touching the merge decision itself.
 */
function laneFoldPlan(
  options: GenerateOptions,
  result: LayoutResult,
  ticks: ReadonlyMap<number, number[]>,
  leadIndex: number | null,
  order: readonly number[],
): { plan: LaneSharePlan; sources: Map<number, number[]> } | null {
  if (options.laneSharing !== true) return null;
  const lanes = result.tracks.filter((track) => track.placements.length > 0);
  if (lanes.length < 2) return null;
  const sourcesByRep = new Map<number, number[]>();
  const laneTracks: ShareTrack[] = [];
  for (const track of lanes) {
    const sources =
      track.sourceIndices.length > 0
        ? [...track.sourceIndices]
        : track.trackIndex >= 0
          ? [track.trackIndex]
          : [];
    const rep = sources[0] ?? track.trackIndex;
    sourcesByRep.set(rep, sources);
    laneTracks.push({ index: rep, ticks: sources.flatMap((source) => ticks.get(source) ?? []) });
  }
  // The order is expressed in source tracks; point it at the lane that now carries them.
  const laneOrder: number[] = [];
  for (const source of order) {
    for (const [rep, sources] of sourcesByRep) {
      if (!sources.includes(source)) continue;
      if (!laneOrder.includes(rep)) laneOrder.push(rep);
      break;
    }
  }
  const leadRep =
    leadIndex === null
      ? null
      : ([...sourcesByRep].find(([, sources]) => sources.includes(leadIndex))?.[0] ?? null);
  const plan = planLaneSharing(laneTracks, {
    dMax: layoutDMax(options),
    leadIndex: leadRep,
    order: laneOrder,
    // Never build a new lane here: that would re-mix the instruments the merge separated.
    allowCollector: false,
    ...(options.laneShareSparseBelow === undefined ? {} : { sparseBelow: options.laneShareSparseBelow }),
  });
  return plan.groups.length > 0 ? { plan, sources: sourcesByRep } : null;
}

/**
 * Keep only the facts the interface needs to explain a shared layout.
 *
 * A lane-level plan names one track per lane, because that is what the layout addresses;
 * the interface lists source tracks, so the representative is expanded back to all of them.
 */
function laneSharingInfo(plan: LaneSharePlan, expand?: (index: number) => number[]): LaneSharingInfo {
  return {
    groups: plan.groups.map((group) => group.flatMap((index) => (expand ? expand(index) : [index]))),
    borrowed: plan.borrowed,
    collector: plan.collector,
    kept: plan.kept,
  };
}

/**
 * Signs that name the lanes, plus the spot the player should stand on.
 *
 * A pasted circuit cannot say which lane carries the lead voice, and a forced merge leaves
 * no lead lane at all, so the schematic explains itself instead of leaving the player to
 * guess from the block graph.
 */
function laneLegend(
  result: LayoutResult,
  tracks: AnalyzeResult['tracks'],
  leadTrackIndex: number | null,
): { annotation: LaneAnnotation; info: LaneAnnotationInfo } | null {
  const velocity = new Map(tracks.map((track) => [track.index, track.meanVelocity]));
  const lanes = result.tracks
    .filter((track) => track.placements.length > 0)
    .map((track) => {
      const zs = track.placements.map((placement) => placement.pos.z);
      return {
        sourceTracks: track.sourceIndices.length > 0 ? [...track.sourceIndices] : [track.trackIndex],
        zBase: track.zBase,
        zMin: Math.min(...zs),
        zMax: Math.max(...zs),
      };
    });
  if (lanes.length === 0) return null;
  const leadLane =
    lanes.length > 1 && leadTrackIndex !== null
      ? lanes.findIndex((lane) => lane.sourceTracks.includes(leadTrackIndex))
      : -1;
  const annotation = planLaneAnnotation({
    lanes,
    leadLane: leadLane >= 0 ? leadLane : null,
    minX: result.min.x,
    // The routing decision and the sign must name the same row, so both read the layout.
    playerZ: result.playerZ,
    spreadZ: result.hearingRadius,
    // Stand the posts on the top of the circuit so nothing is buried under wire.
    y: Math.max(...result.tracks.flatMap((track) => track.placements.map((p) => p.pos.y))),
    label: (sourceTracks) =>
      sourceTracks.length <= 3
        ? `轨 ${sourceTracks.map((index) => index + 1).join('+')}`
        : `共 ${sourceTracks.length} 轨`,
    strength: (sourceTracks) => {
      const best = Math.max(...sourceTracks.map((index) => velocity.get(index) ?? 0));
      return best > 0 ? `力度 ${Math.round(best * 100)}%` : null;
    },
  });
  if (!annotation) return null;
  return {
    annotation,
    info: {
      signs: annotation.signs.map((sign) => ({
        role: sign.role,
        sourceTracks: sign.sourceTracks,
        z: sign.z,
        lines: sign.lines,
      })),
      player: annotation.player,
      singleLane: annotation.singleLane,
      spreadZ: annotation.spreadZ,
    },
  };
}

/**
 * Which lanes borrow their first power instead of building a head, for the interface.
 *
 * Only the three facts a user can act on are kept: which row borrows, which row it reads,
 * and where the crossing sits. Everything else about the ride is layout bookkeeping.
 */
function laneRideInfo(result: LayoutResult): LaneRideInfo | undefined {
  const lanes: LaneRideInfo['lanes'] = [];
  for (const track of result.tracks) {
    const ride = track.ride;
    if (ride) lanes.push({ z: track.zBase, hostZ: ride.hostZ, x: ride.x, rows: ride.corridor?.length ?? 1 });
  }
  return lanes.length > 0 ? { count: lanes.length, lanes } : undefined;
}

interface FailureContext {
  base: AnalyzeResult;
  /** Song duration, used to compute the speed table */
  durationSec: number;
  error: string;
  presets: number[];
  baseTps: number;
}

function failure(ctx: FailureContext): GenerateResult {
  return {
    ...ctx.base,
    success: false,
    error: ctx.error,
    bytes: 0,
    outOfRangeNotes: 0,
    stats: {
      tickCount: 0,
      noteBlockCount: 0,
      circuitBlocks: 0,
      regionCount: 0,
      elapsedMs: 0,
      outputTrackCount: 0,
      startupDelayTicks: 0,
    },
    speedTable: speedTable(ctx.durationSec, ctx.presets, ctx.baseTps),
    warnings: [],
    placed: [],
    rangeShift: { notes: 0, maxSemitones: 0 },
    trackInstruments: [],
    regions: [],
    preview: EMPTY_PREVIEW,
  };
}

interface PlanContext {
  song: SongModel;
  options: GenerateOptions;
  byTrack: Record<number, TrackAssignment>;
  excluded: ReadonlySet<number>;
  baseTps: number;
  lanePlan: ReturnType<typeof buildLaneOrder>;
  /** Apply the lead-centred lane order; false keeps the historical order and Z origin. */
  centerLead: boolean;
  category: SongCategory;
  smartEnabled: boolean;
  instrumentMode: InstrumentMode;
  resourcePackRecommended: boolean;
}

interface PlannedLayout {
  result: ReturnType<typeof layout>;
  mergeMode: MergeMode;
  smartSelection?: SmartSelectionInfo;
  laneSharing?: LaneSharingInfo;
  shareOutcome: ShareOutcome;
  candidates: Array<{ mode: MergeMode; radiusZ: number }>;
}

/**
 * Run the layout candidates and pick the one to keep.
 *
 * Both the generator and the configuration-step readout go through this function, so the
 * numbers the interface reports cannot drift from the file it would write.
 */
function planLayout(ctx: PlanContext): PlannedLayout {
  const { song, options, byTrack, excluded, baseTps, lanePlan, category, smartEnabled } = ctx;
  // Centring is a user setting, so every candidate is built in the order the file will use.
  const laneOrder = ctx.centerLead ? lanePlan.laneOrder : [];
  const ticks = trackTicks(song, baseTps);
  const candidates: Array<{ mode: MergeMode; layout: ReturnType<typeof layout> }> = [];
  // Without a lane order the lead lane is still the standing row, so it is passed on its own.
  const standTrack = laneOrder.length > 0 ? undefined : (lanePlan.leadTrackIndex ?? undefined);
  const build = (mode: MergeMode, laneGroups?: readonly (readonly number[])[]): ReturnType<typeof layout> =>
    layout(song, {
      ...layoutOptions(options, byTrack, laneOrder, laneGroups, standTrack),
      mergeSameInstrument: mode === 'same',
      forceMergeSameInstrument: mode === 'force',
    });
  const runLayout = (
    mode: MergeMode,
    laneGroups?: readonly (readonly number[])[],
  ): ReturnType<typeof layout> => {
    const value = build(mode, laneGroups);
    candidates.push({ mode, layout: value });
    return value;
  };
  let shareOutcome: ShareOutcome = 'disabled';
  let shareRejected = false;

  /**
   * Fold sparse tracks onto existing lanes, if that actually saves a lane.
   *
   * Runs whenever the switch is on: the saving is a lane, and a lane that plays four notes
   * is worth removing even when the song already fits the hearing radius.
   */
  const attemptShare = (
    off: ReturnType<typeof layout>,
  ): { value: ReturnType<typeof layout>; plan: LaneSharePlan } | null => {
    if (options.laneSharing !== true) return null;
    const plan = shareLanesFor(options, ticks, excluded, lanePlan.leadTrackIndex, lanePlan.laneOrder);
    if (plan === null) {
      shareOutcome = 'no-plan';
      return null;
    }
    const value = runLayout('share', plan.groups);
    // Fewer lanes is the saving. The radius only has a veto when folding pushes the song
    // out of the hearing radius: staying inside it is what the player can actually hear,
    // so a fold that spreads the lanes a little but removes one is still worth taking.
    const budget = Math.max(off.hearingRadius, SMART_RADIUS.audible);
    if (value.tracks.length < off.tracks.length && value.hearingRadius <= budget) {
      return { value, plan };
    }
    shareRejected = true;
    shareOutcome = 'not-narrower';
    return null;
  };

  let laneFoldOutcome: 'applied' | 'no-sparse' | 'not-narrower' | 'failed' | null = null;

  /**
   * Fold sparse lanes onto their neighbours after a merge produced them.
   *
   * A merge already decided how instruments collapse; this only removes lanes that the
   * merge left nearly empty. The result is measured, because folding deepens the host's
   * chord rows and can make the layout wider instead of narrower.
   */
  const attemptLaneFold = (
    merged: ReturnType<typeof layout>,
  ): { value: ReturnType<typeof layout>; plan: LaneSharePlan; sources: Map<number, number[]> } | null => {
    if (options.laneSharing !== true) return null;
    const folded = laneFoldPlan(options, merged, ticks, lanePlan.leadTrackIndex, lanePlan.laneOrder);
    if (folded === null) {
      laneFoldOutcome = 'no-sparse';
      return null;
    }
    let value: ReturnType<typeof layout>;
    try {
      value = build('same', folded.plan.groups);
    } catch (error) {
      // A geometric refusal only means these lanes cannot share; anything else is a bug.
      if (!(error instanceof CoreError)) throw error;
      laneFoldOutcome = 'failed';
      return null;
    }
    const budget = Math.max(merged.hearingRadius, SMART_RADIUS.audible);
    if (value.tracks.length < merged.tracks.length && value.hearingRadius <= budget) {
      laneFoldOutcome = 'applied';
      return { value, plan: folded.plan, sources: folded.sources };
    }
    laneFoldOutcome = 'not-narrower';
    return null;
  };

  let result;
  let mergeMode: MergeMode;
  let smartSelection: SmartSelectionInfo | undefined;
  let laneSharing: LaneSharingInfo | undefined;

  if (!smartEnabled) {
    mergeMode = options.forceMergeSameInstrument ? 'force' : options.mergeSameInstrument ? 'same' : 'off';
    result = runLayout(mergeMode);
    // The sharing switch is a visible setting, so it applies without smart routing too.
    // Merging already collapses lanes, so sharing only runs on the unmerged path.
    if (mergeMode === 'off') {
      try {
        const shared = attemptShare(result);
        if (shared !== null) {
          result = shared.value;
          mergeMode = 'share';
          laneSharing = laneSharingInfo(shared.plan);
        }
      } catch (error) {
        // A geometric refusal only means sharing is not available here; anything else is
        // a bug and must surface instead of quietly falling back.
        if (!(error instanceof CoreError)) throw error;
        shareOutcome = 'failed';
        result.warnings.push({ code: 'SMART_MERGE_FAILED', mode: 'share', fallback: 'off' });
      }
    } else if (mergeMode === 'same') {
      // Sharing runs after the merge, on the lanes the merge produced: a merged lane can
      // still be nearly empty while its track count makes the source-level plan skip it.
      const folded = attemptLaneFold(result);
      if (folded !== null) {
        result = folded.value;
        // The candidate list is the map of what was tried: it must show the width that won.
        candidates[candidates.length - 1] = { mode: mergeMode, layout: result };
        laneSharing = laneSharingInfo(folded.plan, (index) => folded.sources.get(index) ?? [index]);
      }
    } else {
      // Nothing to borrow from: the forced merge already collapsed every lane into one.
      shareOutcome = 'merged';
    }
    // A manual layout still has to say when it misses the hearing radius: the interface
    // reads the width from this warning, so a 49-cell song used to build silently.
    if (result.hearingRadius > SMART_RADIUS.audible) {
      result.warnings.push({
        code: 'SMART_HEARING_UNREACHED',
        radiusZ: result.hearingRadius,
        limit: SMART_RADIUS.audible,
        attempted: false,
      });
    }
  } else {
    const off = runLayout('off');

    let shared: { value: ReturnType<typeof layout>; plan: LaneSharePlan } | null = null;
    let same: ReturnType<typeof layout> | null = null;
    let foldedSame: { plan: LaneSharePlan; sources: Map<number, number[]> } | null = null;
    let force: ReturnType<typeof layout> | null = null;
    const failed: Array<'share' | 'same' | 'force'> = [];
    // Sharing is tried before any merge: it keeps every instrument and only spends
    // columns on a lane that already exists.
    try {
      shared = attemptShare(off);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      failed.push('share');
      shareOutcome = 'failed';
    }
    // Once sharing brings the layout back inside the radius there is nothing left to fix,
    // so the merge candidates are not measured at all.
    const shareFits = shared !== null && shared.value.hearingRadius <= SMART_RADIUS.audible;
    if (!shareFits && category === 'multi-instrument' && off.hearingRadius >= SMART_RADIUS.compact) {
      try {
        same = runLayout('same');
      } catch (error) {
        // Only a geometric refusal is a routing outcome; anything else is a bug and
        // must not be turned into "the merge did not fit".
        if (!(error instanceof CoreError)) throw error;
        failed.push('same');
        same = null;
      }
      if (same !== null) {
        // The merge is the user's choice; folding only removes lanes it left nearly empty.
        const folded = attemptLaneFold(same);
        if (folded !== null) {
          same = folded.value;
          foldedSame = folded;
          // One merge, one width: keep the narrower of the two under the same label.
          candidates[candidates.length - 1] = { mode: 'same', layout: same };
        }
      }
      if (off.hearingRadius > SMART_RADIUS.audible && (!same || same.hearingRadius > SMART_RADIUS.audible)) {
        try {
          force = runLayout('force');
        } catch (error) {
          // The forced graph can refuse geometrically unsafe output; that is reported
          // below. A non-geometric failure is a bug and is rethrown.
          if (!(error instanceof CoreError)) throw error;
          failed.push('force');
        }
      }
    }
    const choice = decideMerge(category, {
      off: off.hearingRadius,
      ...(shared ? { share: shared.value.hearingRadius } : {}),
      ...(same ? { same: same.hearingRadius } : {}),
      ...(force ? { force: force.hearingRadius } : {}),
    });
    const measured: Record<MergeMode, ReturnType<typeof layout> | null> = {
      off,
      share: shared?.value ?? null,
      same,
      force,
    };
    result = measured[choice.mode] ?? off;
    // Report the layout that is actually in the file, not the one that was requested: a
    // candidate that threw leaves the fallback in place, and a summary that names an
    // unapplied merge is worse than no summary.
    mergeMode =
      result === shared?.value ? 'share' : result === same ? 'same' : result === force ? 'force' : 'off';
    const shareUsed = mergeMode === 'share' ? shared : null;
    // A lane fold rides on top of a merge, so it is only the kept layout when that merge won.
    const foldUsed = mergeMode === 'same' ? foldedSame : null;
    if (result.hearingRadius > SMART_RADIUS.audible) {
      result.warnings.push({
        code: 'SMART_HEARING_UNREACHED',
        radiusZ: result.hearingRadius,
        limit: SMART_RADIUS.audible,
        // A candidate that threw is still an attempt; only a category that never tries
        // to merge should read as "no merge was attempted".
        attempted: category === 'multi-instrument' && (candidates.length > 1 || failed.length > 0),
      });
    }
    for (const mode of failed) {
      result.warnings.push({ code: 'SMART_MERGE_FAILED', mode, fallback: mergeMode });
    }
    smartSelection = {
      category,
      instrumentMode: ctx.instrumentMode,
      mergeMode,
      radiusZ: result.hearingRadius,
      compactRadius: SMART_RADIUS.compact,
      audibleRadius: SMART_RADIUS.audible,
      resourcePackRecommended: ctx.resourcePackRecommended,
      leadTrackIndex: lanePlan.leadTrackIndex,
      leadBasis: lanePlan.leadBasis,
      candidates: candidates.map((candidate) => ({
        mode: candidate.mode,
        radiusZ: candidate.layout.hearingRadius,
      })),
      ...(shareUsed ? { laneSharing: laneSharingInfo(shareUsed.plan) } : {}),
      ...(foldUsed
        ? { laneSharing: laneSharingInfo(foldUsed.plan, (index) => foldUsed.sources.get(index) ?? [index]) }
        : {}),
    };
    // The check step explains the borrows even when the smart summary is absent, so the
    // plan is reported on its own field as well.
    laneSharing = shareUsed
      ? laneSharingInfo(shareUsed.plan)
      : foldUsed
        ? laneSharingInfo(foldUsed.plan, (index) => foldUsed.sources.get(index) ?? [index])
        : undefined;
  }

  // A share candidate that lost to a narrower merge is not a failure, it simply did not win.
  if (mergeMode === 'share' || laneFoldOutcome === 'applied') shareOutcome = 'applied';
  else if (mergeMode === 'force') shareOutcome = 'merged';
  else if (mergeMode === 'same') {
    // "Merged into one lane" was the wrong story here: the merge kept several lanes, and
    // the fold either ran out of sparse lanes or was not on.
    shareOutcome = laneFoldOutcome ?? (options.laneSharing === true ? 'no-sparse' : 'disabled');
  } else if (shareRejected) shareOutcome = 'not-narrower';
  else if (candidates.some((candidate) => candidate.mode === 'share')) shareOutcome = 'outranked';

  return {
    result,
    mergeMode,
    smartSelection,
    laneSharing,
    shareOutcome,
    candidates: candidates.map((candidate) => ({
      mode: candidate.mode,
      radiusZ: candidate.layout.hearingRadius,
    })),
  };
}

/**
 * Full pipeline: parse → layout → slice regions → litematic bytes.
 * Failures do not throw; they return success=false + error so the GUI can show them directly.
 */
export function generate(
  path: string,
  rawOptions: GenerateOptions = {},
): { result: GenerateResult; buffer: Buffer | null } {
  const options = sanitizeGenerateOptions(rawOptions);
  const start = Date.now();
  const presets = options.speedPresets ?? DEFAULT_PRESETS;
  const baseTps = options.baseTps ?? DEFAULT_LAYOUT_CONFIG.baseTps;

  const song = parseMidi(readFileSync(path));
  const base = analyze(song, path);
  const excluded = new Set(options.excludeTracks ?? []);
  const activeTrackIndices = new Set(
    base.tracks
      .filter((track) => !excluded.has(track.index) && track.noteCount > 0)
      .map((track) => track.index),
  );
  const nativeAssignments = assignTracks(song, 'native');
  const category: SongCategory = classifySong(nativeAssignments, activeTrackIndices);
  const smartEnabled = options.smartSelection === true;
  const smartMode = smartEnabled ? smartModeFor(category, midiBounds(base.tracks, activeTrackIndices)) : null;
  const instrumentMode = smartMode?.mode ?? resolveMode(options);
  const assignments = assignTracks(song, instrumentMode);
  // Excluded tracks must disappear from every derived view, not just from the notes:
  // warnings, the assignment table and the piano span all follow this filtered list.
  const activeAssignments = assignments.filter((assignment) => !excluded.has(assignment.trackIndex));
  const byTrack: Record<number, TrackAssignment> = {};
  for (const assignment of activeAssignments) byTrack[assignment.trackIndex] = assignment;
  const centerLead = options.centerLead !== false;
  // Every song has a lead track: the player stands on its line, and the lanes are laid out
  // by how loud each one is. A layout without a lead would leave the player standing at a
  // Z that belongs to no lane, so this is no longer conditional on smart routing.
  const lanePlan = buildLaneOrder(base.tracks, excluded, options.leadTrackIndex);

  if (options.commandPlayback) {
    const commandSmart: SmartSelectionInfo | undefined = smartEnabled
      ? {
          category,
          instrumentMode,
          mergeMode: 'off',
          radiusZ: 0,
          compactRadius: SMART_RADIUS.compact,
          audibleRadius: SMART_RADIUS.audible,
          resourcePackRecommended: false,
          leadTrackIndex: lanePlan.leadTrackIndex,
          leadBasis: lanePlan.leadBasis,
          candidates: [],
        }
      : undefined;
    return generateCommands(song, base, options, start, activeAssignments, commandSmart);
  }

  const included = song.tracks.filter((t) => t.notes.length > 0 && !excluded.has(t.index));
  if (included.length === 0) {
    return {
      result: failure({
        base,
        durationSec: song.durationSec,
        error: '没有可生成的音轨（全部为空或被排除）',
        presets,
        baseTps,
      }),
      buffer: null,
    };
  }

  let planned: PlannedLayout;
  try {
    planned = planLayout({
      song,
      options,
      byTrack,
      excluded,
      baseTps,
      lanePlan,
      centerLead,
      category,
      smartEnabled,
      instrumentMode,
      resourcePackRecommended: smartMode?.resourcePackRecommended ?? false,
    });
  } catch (e) {
    return {
      result: failure({
        base,
        durationSec: song.durationSec,
        error: `电路布局失败：${describeCoreError(e)}`,
        presets,
        baseTps,
      }),
      buffer: null,
    };
  }
  const { result, smartSelection, laneSharing } = planned;
  const ride = laneRideInfo(result);

  const slices = sliceRegions(result);
  const legend =
    options.annotateLanes === false ? null : laneLegend(result, base.tracks, lanePlan.leadTrackIndex);
  const decoration = legend ? annotationSlice(legend.annotation) : null;
  if (decoration) slices.push(decoration);
  if (!result.tracks.some((track) => track.placements.length > 0)) {
    const f = failure({
      base,
      durationSec: song.durationSec,
      error: '没有可生成的音符（可能全部被音域策略丢弃）',
      presets,
      baseTps,
    });
    f.warnings = result.warnings;
    f.outOfRangeNotes = result.warnings.filter((w) => w.code === 'OUT_OF_RANGE').length;
    return { result: f, buffer: null };
  }
  let buffer: Buffer;
  try {
    buffer = buildLitematic(toRegionData(slices), {
      name: song.name || basename(path),
      author: options.author ?? 'MusicboxMC',
      description: `MusicboxMC — ${result.tracks.length} 轨 / ${result.totalTicks} ticks`,
      dataVersion: MC_1_20_4_DATA_VERSION,
      version: LITEMATIC_VERSION_1_20_4,
    });
  } catch (e) {
    const f = failure({
      base,
      durationSec: song.durationSec,
      error: `litematic 写入失败：${describeCoreError(e)}`,
      presets,
      baseTps,
    });
    f.warnings = result.warnings;
    return { result: f, buffer: null };
  }

  const outOfRangeNotes = result.warnings.filter((w) => w.code === 'OUT_OF_RANGE').length;
  const noteBlockCount = result.tracks.reduce(
    (s, t) => s + t.placements.filter((p) => p.block === 'minecraft:note_block').length,
    0,
  );

  return {
    result: {
      ...base,
      success: true,
      playbackMode: 'redstone',
      bytes: buffer.length,
      outOfRangeNotes,
      pitchRange: pitchRangeFor(activeAssignments),
      stats: {
        tickCount: result.totalTicks,
        noteBlockCount,
        circuitBlocks: result.tracks.reduce((s, t) => s + t.placements.length, 0),
        regionCount: slices.length,
        elapsedMs: Date.now() - start,
        outputTrackCount: result.tracks.length,
        startupDelayTicks: result.startupDelayTicks ?? 0,
      },
      speedTable: speedTable(song.durationSec, presets, baseTps),
      warnings: result.warnings,
      placed: result.placed,
      rangeShift: result.rangeShift,
      trackInstruments: result.trackInstruments,
      ...(smartSelection ? { smartSelection } : {}),
      ...(laneSharing ? { laneSharing } : {}),
      ...(legend ? { laneAnnotation: legend.info } : {}),
      ...(ride ? { laneRide: ride } : {}),
      regions: slices.map((s, i) => ({
        name: `region_${i}`,
        trackIndex: s.trackIndex,
        position: s.position,
        size: s.size,
        blockCount: s.blocks.length,
      })),
      preview: buildPreview(slices),
    },
    buffer,
  };
}

/**
 * Measure one layout without building the schematic.
 *
 * The configuration step shows X/Y/Z and how many Minecraft tracks the result needs.
 * That is `layout()` plus `sliceRegions()` - not the litematic bytes - so this stays cheap
 * enough to run whenever an option changes.
 */
export function measureLayout(path: string, rawOptions: GenerateOptions = {}): LayoutMeasure {
  const started = Date.now();
  const options = sanitizeGenerateOptions(rawOptions);
  const song = parseMidi(readFileSync(path));
  const base = analyze(song, path);
  const excluded = new Set(options.excludeTracks ?? []);
  const activeTrackIndices = new Set(
    base.tracks
      .filter((track) => !excluded.has(track.index) && track.noteCount > 0)
      .map((track) => track.index),
  );
  const nativeAssignments = assignTracks(song, 'native');
  const category = classifySong(nativeAssignments, activeTrackIndices);
  const smartEnabled = options.smartSelection === true;
  const smartMode = smartEnabled ? smartModeFor(category, midiBounds(base.tracks, activeTrackIndices)) : null;
  const instrumentMode = smartMode?.mode ?? resolveMode(options);
  const assignments = assignTracks(song, instrumentMode);
  const byTrack: Record<number, TrackAssignment> = {};
  for (const assignment of assignments) {
    if (!excluded.has(assignment.trackIndex)) byTrack[assignment.trackIndex] = assignment;
  }
  // Same routing rules as generate(): the lead track exists for every song and the lanes
  // are ordered by loudness, whether or not smart routing is on.
  const centerLead = options.centerLead !== false;
  const lanePlan = buildLaneOrder(base.tracks, excluded, options.leadTrackIndex);
  const baseTps = options.baseTps ?? DEFAULT_LAYOUT_CONFIG.baseTps;
  // The very same planner the generator runs, so the readout cannot describe a file the
  // user would not get: smart decisions, merges and lane sharing all happen here.
  const planned = planLayout({
    song,
    options,
    byTrack,
    excluded,
    baseTps,
    lanePlan,
    centerLead,
    category,
    smartEnabled,
    instrumentMode,
    resourcePackRecommended: smartMode?.resourcePackRecommended ?? false,
  });
  const result = planned.result;
  const slices = sliceRegions(result);
  const placements = result.tracks.flatMap((track) => track.placements);
  const annotatedSigns =
    options.annotateLanes === false ? 0 : result.tracks.filter((track) => track.placements.length > 0).length;
  return {
    size: result.size,
    min: result.min,
    playerZ: result.playerZ,
    hearingRadius: result.hearingRadius,
    trackCount: result.tracks.length,
    sourceTrackCount: activeTrackIndices.size,
    // The sign wall is a region of its own, so the exported file has one more than the circuit.
    regionCount: slices.length + (annotatedSigns > 0 ? 1 : 0),
    noteBlockCount: placements.filter((placement) => placement.block === 'minecraft:note_block').length,
    blockCount: placements.length,
    totalTicks: result.totalTicks,
    mergeMode: planned.mergeMode,
    sharedLanes: planned.laneSharing?.groups.length ?? 0,
    shareOutcome: planned.shareOutcome,
    candidates: planned.candidates,
    annotatedSigns,
    annotatedExtraX: annotatedSigns > 0 ? SIGN_COLUMN_GAP : 0,
    riddenLanes: result.tracks.filter((track) => track.ride !== undefined).length,
    elapsedMs: Date.now() - started,
    warnings: result.warnings.length,
  };
}

/**
 * Measure the smart routing without writing anything.
 *
 * The configuration step applies the recommendation before generating, so the values the
 * user sees are the ones the generator will use. This runs the same pipeline and keeps
 * only the routing summary; the litematic bytes are built and discarded.
 */
export function planSmartSelection(path: string, rawOptions: GenerateOptions = {}): SmartPlanResult {
  const { result } = generate(path, { ...rawOptions, smartSelection: true });
  if (!result.success) return { info: null, error: result.error ?? '生成器没有给出原因。' };
  return { info: result.smartSelection ?? null };
}

/** Generate and write to disk. */
export function generateToFile(
  path: string,
  outputPath: string,
  options: GenerateOptions = {},
): GenerateResult {
  const { result, buffer } = generate(path, options);
  if (!result.success || buffer === null) return result;
  writeFileSync(outputPath, buffer);
  return { ...result, outputPath };
}
