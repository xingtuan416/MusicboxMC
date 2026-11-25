import type { BlockOverrides } from '../core/palette/blockTable';
import type { InstrumentMode } from '../core/palette/assignment';
import type { NoteBlockInstrument } from '../core/palette/instruments';
import type { LayoutResult, LayoutWarning, TrackInstrumentInfo } from '../core/layout/types';
import type { SpeedRow } from '../core/tempo/speed';
import type { CommandPlaybackInfo } from '../core/command';
import type { LeadBasis } from '../core/arrangement/prominence';

/**
 * The shapes the renderer sees.
 *
 * These cross the IPC boundary, so they stay plain data: no class instances, no
 * functions, nothing that would not survive structured cloning.
 */

/** A path the user accepted in the native save dialog, with its authorization token. */
export interface OutputGrant {
  path: string;
  token: string;
  preferencesPersisted?: boolean;
}

export type GenerationStage = 'read' | 'layout' | 'preview' | 'encode' | 'write';

export type SmartCategory = 'pure-harp' | 'single-instrument' | 'multi-instrument';

/** Which source tracks ended up on a shared lane, and how. */
export interface LaneSharingInfo {
  /** One array per shared lane: the host first, then its guests. */
  groups: number[][];
  borrowed: Array<{ guest: number; host: number }>;
  /** Sparse tracks folded onto a new lane of their own. */
  collector: number[];
  /** Sparse tracks that could not be folded and kept their own lane. */
  kept: number[];
}

/**
 * What the schematic says about its own lanes.
 *
 * The block graph cannot answer "which lane is the lead", and after a merge there is no
 * lead lane at all; the signs carry that answer into the world, so the check step can
 * show the same text the player will read.
 */
export interface LaneAnnotationInfo {
  signs: Array<{
    role: 'lead' | 'secondary' | 'lane' | 'merged';
    /** Source tracks named on this sign, in lane order. */
    sourceTracks: number[];
    /** Z row the sign stands on. */
    z: number;
    /** The four sign lines, top to bottom. */
    lines: string[];
  }>;
  /** Recommended standing spot in schematic coordinates (feet level). */
  player: { x: number; y: number; z: number };
  /** True when the whole song ended up on one spine, so no lane is called the lead. */
  singleLane: boolean;
  /** Farthest Z distance from the player's row to a lane edge, in blocks. */
  spreadZ: number;
}

/**
 * Lanes that take their first power from the lane next to them.
 *
 * A lane whose first note is thousands of blocks in normally pays for a head: one repeater
 * every few cells, all of it cold circuit that a chunk loader has to keep alive. Skipping
 * the head and reading the neighbour's line instead costs one crossing repeater and keeps
 * the lane in step with the neighbour it borrows from.
 */
export interface LaneRideInfo {
  count: number;
  lanes: Array<{
    /** Z row of the lane that borrows. */
    z: number;
    /** Z row of the lane it reads. */
    hostZ: number;
    /** X where the crossing repeater sits. */
    x: number;
    /** Rows crossed between the host's line and this one; one repeater and one tick each. */
    rows: number;
  }>;
}

/**
 * Why the layout under the current options does (not) fold sparse tracks onto shared lanes.
 *
 * A switch that changes nothing is indistinguishable from a broken switch, so the reason
 * travels with the measurement and reaches the developer readout.
 */
export type ShareOutcome =
  'applied' | 'outranked' | 'not-narrower' | 'merged' | 'no-sparse' | 'no-plan' | 'disabled' | 'failed';

export interface SmartSelectionInfo {
  category: SmartCategory;
  instrumentMode: InstrumentMode;
  mergeMode: 'off' | 'share' | 'same' | 'force';
  /** How far the furthest note sits from the player's standing row, in blocks. */
  radiusZ: number;
  compactRadius: number;
  audibleRadius: number;
  resourcePackRecommended: boolean;
  leadTrackIndex: number | null;
  leadBasis: LeadBasis | 'manual' | null;
  candidates: Array<{ mode: 'off' | 'share' | 'same' | 'force'; radiusZ: number }>;
  /**
   * Which tracks ended up sharing a lane. Absent when nothing shares, and on paths that
   * do not run a layout at all (command playback).
   */
  laneSharing?: LaneSharingInfo;
}

/**
 * One layout, measured without building the schematic.
 *
 * `trackCount` is the number of Minecraft tracks the layout needs after merging and
 * splitting, which is not the number of MIDI tracks: a forced merge turns any song into a
 * single track.
 */
export interface LayoutMeasure {
  size: { x: number; y: number; z: number };
  min: { x: number; y: number; z: number };
  /** Row the player stands on: the lead lane's dust line. */
  playerZ: number;
  /** Distance from that row to the furthest note, in blocks. */
  hearingRadius: number;
  trackCount: number;
  /** Active MIDI tracks that contributed notes, before merging. */
  sourceTrackCount: number;
  regionCount: number;
  noteBlockCount: number;
  blockCount: number;
  totalTicks: number;
  mergeMode: 'off' | 'share' | 'same' | 'force';
  /** Lanes that fold more than one source track together. */
  sharedLanes: number;
  /** Why the final layout does or does not fold sparse tracks onto shared lanes. */
  shareOutcome: ShareOutcome;
  /** Hearing radius of every layout candidate that was measured, in the order they ran. */
  candidates: Array<{ mode: 'off' | 'share' | 'same' | 'force'; radiusZ: number }>;
  /** Lane signs the export would carry; 0 when the switch is off. */
  annotatedSigns: number;
  /** Extra X the sign wall adds to the exported schematic. */
  annotatedExtraX: number;
  /** Lanes that borrow their first power from the neighbouring lane. */
  riddenLanes: number;
  elapsedMs: number;
  warnings: number;
}

/**
 * The routing summary the configuration step applies before generating.
 *
 * `info` is null when the measurement failed, and `error` says why: the interface then
 * keeps the manual settings instead of applying a recommendation it could not compute.
 */
export interface SmartPlanResult {
  info: SmartSelectionInfo | null;
  error?: string;
}

/** Options the renderer process may submit; only existing core capabilities, no new semantics. */
export interface GenerateOptions {
  baseTps?: number;
  dMax?: number;
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
  /**
   * Instrument mode. `extended` (the default) keeps the five-slot piano range and
   * plays the other instruments natively; `native` plays every track with its own
   * instrument. `extendedRange` remains as a compatibility alias.
   */
  instrumentMode?: InstrumentMode;
  /**
   * Legacy alias: `false` means native mode, `true`/omitted means extended mode.
   *
   * @deprecated use `instrumentMode`
   */
  extendedRange?: boolean;
  excludeTracks?: number[];
  transpose?: Record<number, number>;
  /** Block selection overrides (per track / pitch region) */
  blocks?: BlockOverrides;
  /** Merge same-instrument tracks into one spine (percussion is its own class) */
  mergeSameInstrument?: boolean;
  /** One connected spine for the whole song, with song-wide branch-delay compensation. */
  forceMergeSameInstrument?: boolean;
  /** Let the main process choose instrument mode, merge mode and resource-pack advice. */
  smartSelection?: boolean;
  /** User-selected lead track; overrides the automatic prominence recommendation. */
  leadTrackIndex?: number;
  /** Fold sparse tracks onto lanes that already exist instead of giving each its own. */
  laneSharing?: boolean;
  /** Below this many notes a track may share a lane; defaults to 50. */
  laneShareSparseBelow?: number;
  /**
   * Center the lead lane in Z so the player stands on it; defaults to on.
   *
   * Turning it off keeps the historical lane order and Z origin, which is sometimes the
   * narrower layout the song needs to stay inside the hearing radius.
   */
  centerLead?: boolean;
  /**
   * Write lane signs into the schematic; defaults to on.
   *
   * A pasted circuit does not say which lane is the lead, and a merged song has no lead
   * lane to point at, so the schematic explains itself instead of leaving the player to
   * guess. Turning it off exports the bare circuit.
   */
  annotateLanes?: boolean;
  /**
   * Let a lane whose first note is far away borrow power from the neighbouring lane
   * instead of building its own head; defaults to on.
   *
   * The head is the part of a long song that a chunk loader has to keep alive from the
   * very first block, and it is also the densest repeater chain in the layout. Borrowing
   * costs one crossing repeater in the free row between the two lanes.
   */
  laneRide?: boolean;
  /** Independent opt-in backend: all retained notes use per-player playsound commands. */
  commandPlayback?: boolean;
  /** Expected world maxCommandChainLength; defaults to the Java 1.20.4 default. */
  commandChainBudget?: number;
  speedPresets?: number[];
  author?: string;
}

export interface TrackSummary {
  index: number;
  name: string;
  channel: number;
  /** General MIDI program number, when the file declares one. */
  program?: number;
  instrument: string;
  percussion: boolean;
  /** Native instrument detection; `drums` for a mixed channel-9 track. */
  detectedInstrument: NoteBlockInstrument | 'drums';
  detectionSource: 'gm' | 'name' | 'drum' | 'fallback';
  noteCount: number;
  minTick: number;
  maxTick: number;
  minMidi: number;
  maxMidi: number;
  /** Source-performance statistics; used for the lead-track recommendation. */
  meanVelocity: number;
  maxVelocity: number;
  activeSeconds: number;
  polyphonicOnsetRatio: number;
  melodicScore: number;
  activityScore: number;
  prominenceScore: number;
}

export interface RegionSummary {
  name: string;
  /** Source track index for this region; preview maps Z rows back, and splits share the index */
  trackIndex: number;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  blockCount: number;
}

/**
 * Top-down preview.
 *
 * In the new geometry redstone wire, repeaters and note blocks are **all on the same layer** (the
 * space directly above a note block must be left empty), so output can no longer be layered by Y —
 * instead it is split into three layers by block type, and the frontend stacks them as
 * "floor → wire → note block", which shows both the wiring and the note placements clearly.
 */
export interface PreviewData {
  size: { x: number; y: number; z: number };
  /** X/Z of the preview grid's top-left corner in whole-schematic coordinates */
  origin: { x: number; z: number };
  /** Redstone wire / repeaters */
  wireCells: Record<number, string>;
  /** Repeater delay keyed by row-major cell index. */
  repeaterDelays: Record<number, string>;
  /** Direction of repeater input, matching Minecraft facing blockstate. */
  repeaterFacings: Record<number, string>;
  /** Note blocks keyed by row-major cell index. */
  noteCells: Record<number, string>;
  /** Floor (base blocks) keyed by row-major cell index. */
  baseCells: Record<number, string>;
  /** Deduplicated list of block ids that occur, used by the frontend for coloring */
  blocks: string[];
}

export interface SongSummary {
  name: string;
  ppq: number;
  durationSec: number;
  durationText: string;
  baseBpm: number;
  timeSignature: [number, number] | null;
  trackCount: number;
  noteCount: number;
  /** Tick scale used for this summary and the track tick bounds. */
  summaryTps: number;
  /** ±½ game tick: the command backend rounds once. */
  commandErrorMs: number;
  /** ±1.5 game ticks: the redstone backend rounds onto the game-tick grid, then again. */
  layoutErrorMs: number;
}

export interface AnalyzeResult {
  path: string;
  /** File revision used by the desktop so track indices stay bound to the imported MIDI. */
  sourceRevision?: string;
  file: string;
  song: SongSummary;
  tracks: TrackSummary[];
  /** Recommended lead track over all non-empty tracks, before the user excludes any. */
  recommendedLeadTrackIndex: number | null;
  recommendedLeadBasis: LeadBasis | null;
  tempoSegments: Array<{ ticks: number; timeSec: number; bpm: number }>;
}

export interface GenerateResult extends AnalyzeResult {
  success: boolean;
  /** Human-readable reason when generation fails */
  error?: string;
  /** Schematic path set after the file has been published. */
  outputPath?: string;
  /** The destination changed after the native dialog closed. */
  chooseOutputAgain?: boolean;
  /** Schematic size in bytes */
  bytes: number;
  /** Backend actually used for this generation, not the current UI setting. */
  playbackMode?: 'redstone' | 'command';
  /** Command-mode controls, score namespace and execution budgets. */
  commandPlayback?: CommandPlaybackInfo;
  /** Notes outside the selected palette's range that the frontend must report */
  outOfRangeNotes: number;
  /** MIDI span the selected palette can sound, so the interface can name it. */
  pitchRange?: { low: number; high: number };
  stats: {
    tickCount: number;
    noteBlockCount: number;
    circuitBlocks: number;
    regionCount: number;
    elapsedMs: number;
    /** Actual generated spines, not the original MIDI track count. */
    outputTrackCount: number;
    /** Uniform startup compensation, in game ticks. */
    startupDelayTicks: number;
    /** Zero in redstone mode. Command mode emits no note blocks. */
    commandBlockCount?: number;
  };
  speedTable: SpeedRow[];
  warnings: LayoutWarning[];
  /** Where each placed group landed, so the interface can point at one. */
  placed: LayoutResult['placed'];
  /**
   * How many notes the out-of-range policy moved, and the largest move in semitones.
   *
   * Separate from `outOfRangeNotes`, which counts warnings: the `octave` policy is
   * deliberately silent, so a song whose notes were all shifted reported zero.
   */
  rangeShift: { notes: number; maxSemitones: number };
  /** What each source track became after mode selection and detection. */
  trackInstruments: TrackInstrumentInfo[];
  /** Present when the renderer enabled smart selection. */
  smartSelection?: SmartSelectionInfo;
  /**
   * Present when the layout folds sparse tracks onto shared lanes, with or without smart
   * routing: the check step names the borrowed lanes, so it must not depend on the
   * smart summary existing.
   */
  laneSharing?: LaneSharingInfo;
  /** Signs and the recommended standing spot, absent when annotation is off. */
  laneAnnotation?: LaneAnnotationInfo;
  /** Lanes that borrow power from their neighbour, absent when none do. */
  laneRide?: LaneRideInfo;
  /** External power points for the independent redstone heads, relative to the schematic. */
  startInputs?: Array<{ x: number; y: number; z: number }>;
  /** True when surviving notes use a non-harp slot of the extended piano palette. */
  resourcePackRecommended?: boolean;
  /** Multiple source tracks in one redstone lane. */
  mergedAllTracks?: boolean;
  regions: RegionSummary[];
  preview: PreviewData;
  /** Layout-space start and center row of each redstone lane. */
  previewLanes?: Array<{ trackIndex: number; x: number; z: number }>;
}
