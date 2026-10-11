import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMidi } from '../core/midi/parse';
import type { SongModel } from '../core/midi/types';
import { layout, DEFAULT_LAYOUT_CONFIG } from '../core/layout/index';
import { sliceRegions } from '../core/layout/regions';
import type { LayoutConfig, LayoutWarning } from '../core/layout/types';
import { DEFAULT_REGIONS } from '../core/palette/pitchMap';
import {
  buildLitematic,
  MC_1_20_4_DATA_VERSION,
  LITEMATIC_VERSION_1_20_4,
  type RegionData,
} from '../core/litematic/build';
import { formatDuration, speedTable, type SpeedRow } from '../core/tempo/speed';
import type { BlockOverrides } from '../core/palette/blockTable';
import { MAX_QUANTIZE_ERROR_MS, secondsToTick } from '../core/tempo/tick';
import { buildCommandPlayback, type CommandPlaybackInfo } from '../core/command/playback';

/** Options the renderer process may submit; only existing core capabilities, no new semantics. */
export interface GenerateOptions {
  baseTps?: number;
  dMax?: number;
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
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
  quantizeErrorMs: number;
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
  /** Notes outside the resource-pack pitch range (F#1-F#7) that the frontend must report */
  outOfRangeNotes: number;
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
  regions: RegionSummary[];
  preview: PreviewData;
}

const DEFAULT_PRESETS = [1.0, 0.75, 0.5, 1.5, 2.0];

const EMPTY_LAYER: string[] = [];

const EMPTY_PREVIEW: PreviewData = {
  size: { x: 0, y: 0, z: 0 },
  origin: { x: 0, z: 0 },
  wireCells: EMPTY_LAYER,
  repeaterDelays: EMPTY_LAYER,
  repeaterFacings: EMPTY_LAYER,
  noteCells: EMPTY_LAYER,
  baseCells: EMPTY_LAYER,
  blocks: [],
};

function summarizeTracks(song: SongModel): TrackSummary[] {
  return song.tracks.map((t) => {
    const ticks = t.notes.map((n) => secondsToTick(n.timeSec));
    return {
      index: t.index,
      name: t.name,
      channel: t.channel,
      instrument: t.instrument,
      percussion: t.percussion,
      noteCount: t.notes.length,
      minTick: ticks.length > 0 ? Math.min(...ticks) : 0,
      maxTick: ticks.length > 0 ? Math.max(...ticks) : 0,
    };
  });
}

function analyze(song: SongModel, path: string): AnalyzeResult {
  return {
    path,
    file: basename(path),
    song: {
      name: song.name,
      ppq: song.ppq,
      durationSec: song.durationSec,
      durationText: formatDuration(song.durationSec),
      baseBpm: song.baseBpm,
      timeSignature: song.timeSignature,
      trackCount: song.tracks.length,
      noteCount: song.tracks.reduce((s, t) => s + t.notes.length, 0),
      quantizeErrorMs: MAX_QUANTIZE_ERROR_MS,
    },
    tracks: summarizeTracks(song),
    tempoSegments: song.tempos,
  };
}

function toRegionData(slices: ReturnType<typeof sliceRegions>): RegionData[] {
  return slices.map((s) => ({
    position: s.position,
    size: s.size,
    blocks: s.blocks.map((b) => ({
      x: b.pos.x,
      y: b.pos.y,
      z: b.pos.z,
      state: { name: b.block, properties: b.props ?? {} },
    })),
  }));
}

/** The preview layers by block type: wire / note blocks / floor. */
function buildPreview(slices: ReturnType<typeof sliceRegions>, topDown = false): PreviewData {
  if (slices.length === 0) {
    return {
      size: { x: 0, y: 0, z: 0 },
      origin: { x: 0, z: 0 },
      wireCells: EMPTY_LAYER,
      repeaterDelays: EMPTY_LAYER,
      repeaterFacings: EMPTY_LAYER,
      noteCells: EMPTY_LAYER,
      baseCells: EMPTY_LAYER,
      blocks: [],
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let maxY = 0;
  for (const s of slices) {
    minX = Math.min(minX, s.position.x);
    minZ = Math.min(minZ, s.position.z);
    maxX = Math.max(maxX, s.position.x + s.size.x);
    maxZ = Math.max(maxZ, s.position.z + s.size.z);
    maxY = Math.max(maxY, s.position.y + s.size.y);
  }
  const width = maxX - minX;
  const depth = maxZ - minZ;

  // Row-major: index = z * width + x
  const wireCells = new Array<string>(width * depth).fill('');
  const repeaterDelays = new Array<string>(width * depth).fill('');
  const repeaterFacings = new Array<string>(width * depth).fill('');
  const noteCells = new Array<string>(width * depth).fill('');
  const baseCells = new Array<string>(width * depth).fill('');
  const baseHeights = topDown ? new Array<number>(width * depth).fill(-Infinity) : [];

  for (const s of slices) {
    for (const b of s.blocks) {
      const gx = s.position.x + b.pos.x - minX;
      const gz = s.position.z + b.pos.z - minZ;
      const idx = gz * width + gx;
      if (idx < 0 || idx >= width * depth) continue;
      const layer =
        b.block === 'minecraft:redstone_wire' || b.block === 'minecraft:repeater'
          ? wireCells
          : b.block === 'minecraft:note_block'
            ? noteCells
            : baseCells;
      // Command mode is vertically packed; show its topmost block at each X/Z.
      if (layer === baseCells && topDown) {
        if (b.pos.y >= baseHeights[idx]!) {
          layer[idx] = b.block;
          baseHeights[idx] = b.pos.y;
        }
      } else if (layer[idx] === '') layer[idx] = b.block;
      if (layer === wireCells && b.block === 'minecraft:repeater') {
        repeaterDelays[idx] = b.props?.delay ?? '';
        repeaterFacings[idx] = b.props?.facing ?? 'west';
      }
    }
  }

  const blocks = new Set<string>();
  for (const layer of [wireCells, noteCells, baseCells]) {
    for (const cell of layer) if (cell) blocks.add(cell);
  }
  return {
    size: { x: width, y: maxY, z: depth },
    origin: { x: minX, z: minZ },
    wireCells,
    repeaterDelays,
    repeaterFacings,
    noteCells,
    baseCells,
    blocks: [...blocks].sort(),
  };
}

function generateCommands(
  song: SongModel,
  base: AnalyzeResult,
  options: GenerateOptions,
  start: number,
): { result: GenerateResult; buffer: Buffer | null } {
  const presets = options.speedPresets ?? DEFAULT_PRESETS;
  const baseTps = options.baseTps ?? DEFAULT_LAYOUT_CONFIG.baseTps;
  try {
    const compiled = buildCommandPlayback(song, options);
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
        warnings: compiled.warnings,
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
      error: `命令播放生成失败：${(error as Error).message}`,
    });
    result.playbackMode = 'command';
    return { result, buffer: null };
  }
}

/** Parse only, without generating circuits. Used to show file info right after import. */
export function analyzeFile(path: string): AnalyzeResult {
  return analyze(parseMidi(readFileSync(path)), path);
}

function layoutOptions(options: GenerateOptions) {
  // Pass through only the options the user set explicitly; layout() merges the rest with defaults
  const config: Partial<LayoutConfig> = {};
  if (options.baseTps !== undefined) config.baseTps = options.baseTps;
  if (options.dMax !== undefined) config.dMax = options.dMax;

  return {
    config,
    regions: DEFAULT_REGIONS,
    outOfRange: options.outOfRange,
    excludeTracks: options.excludeTracks,
    transpose: options.transpose,
    blocks: options.blocks,
    mergeSameInstrument: options.mergeSameInstrument,
    forceMergeSameInstrument: options.forceMergeSameInstrument,
  };
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
    regions: [],
    preview: EMPTY_PREVIEW,
  };
}

/**
 * Full pipeline: parse → layout → slice regions → litematic bytes.
 * Failures do not throw; they return success=false + error so the GUI can show them directly.
 */
export function generate(
  path: string,
  options: GenerateOptions = {},
): { result: GenerateResult; buffer: Buffer | null } {
  const start = Date.now();
  const presets = options.speedPresets ?? DEFAULT_PRESETS;
  const baseTps = options.baseTps ?? DEFAULT_LAYOUT_CONFIG.baseTps;

  const song = parseMidi(readFileSync(path));
  const base = analyze(song, path);
  if (options.commandPlayback) return generateCommands(song, base, options, start);

  const included = song.tracks.filter(
    (t) => t.notes.length > 0 && !(options.excludeTracks ?? []).includes(t.index),
  );
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

  let result;
  try {
    result = layout(song, layoutOptions(options));
  } catch (e) {
    return {
      result: failure({
        base,
        durationSec: song.durationSec,
        error: `电路布局失败：${(e as Error).message}`,
        presets,
        baseTps,
      }),
      buffer: null,
    };
  }

  const slices = sliceRegions(result);
  if (slices.length === 0) {
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
      error: `litematic 写入失败：${(e as Error).message}`,
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
