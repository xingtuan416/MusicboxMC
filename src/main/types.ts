import type { BlockOverrides } from '../core/palette/blockTable';
import type { LayoutResult, LayoutWarning } from '../core/layout/types';
import type { SpeedRow } from '../core/tempo/speed';
import type { CommandPlaybackInfo } from '../core/command';

/**
 * The shapes the renderer sees.
 *
 * These cross the IPC boundary, so they stay plain data: no class instances, no
 * functions, nothing that would not survive structured cloning.
 */

/** Options the renderer process may submit; only existing core capabilities, no new semantics. */
export interface GenerateOptions {
  baseTps?: number;
  dMax?: number;
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
  /**
   * Use all five note-block instruments to reach F#1-F#7 (the default), or the harp
   * slot alone for F#3-F#5. Only the wide palette benefits from the companion
   * resource pack; the narrow one never needs it.
   */
  extendedRange?: boolean;
  excludeTracks?: number[];
  transpose?: Record<number, number>;
  /** Block selection overrides (per track / pitch region) */
  blocks?: BlockOverrides;
  /** Merge same-instrument tracks into one spine (percussion is its own class) */
  mergeSameInstrument?: boolean;
  /** One connected spine per instrument, with song-wide branch-delay compensation. */
  forceMergeSameInstrument?: boolean;
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
  instrument: string;
  percussion: boolean;
  noteCount: number;
  minTick: number;
  maxTick: number;
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
  wireCells: string[];
  /** Same length as wireCells: repeater delay (1–4), '' for non-repeaters */
  repeaterDelays: string[];
  /** Direction of repeater input, matching Minecraft facing blockstate. */
  repeaterFacings: string[];
  /** Note blocks */
  noteCells: string[];
  /** Floor (base blocks) */
  baseCells: string[];
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
  /** ±½ game tick: the command backend rounds once. */
  commandErrorMs: number;
  /** ±1.5 game ticks: the redstone backend rounds onto the game-tick grid, then again. */
  layoutErrorMs: number;
}

export interface AnalyzeResult {
  path: string;
  file: string;
  song: SongSummary;
  tracks: TrackSummary[];
  tempoSegments: Array<{ ticks: number; timeSec: number; bpm: number }>;
}

export interface GenerateResult extends AnalyzeResult {
  success: boolean;
  /** Human-readable reason when generation fails */
  error?: string;
  /** Schematic path written to disk (only set by generateToFile) */
  outputPath?: string;
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
  regions: RegionSummary[];
  preview: PreviewData;
}
