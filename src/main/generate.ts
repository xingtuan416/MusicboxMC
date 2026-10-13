import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMidi } from '../core/midi/parse';
import type { SongModel } from '../core/midi/types';
import { layout, DEFAULT_LAYOUT_CONFIG } from '../core/layout/index';
import { sliceRegions } from '../core/layout/regions';
import type { LayoutConfig } from '../core/layout/types';
import { coveredRange, regionsFor, type RegionTable } from '../core/palette/pitchMap';
import { buildLitematic, MC_1_20_4_DATA_VERSION, LITEMATIC_VERSION_1_20_4 } from '../core/litematic/build';
import { speedTable } from '../core/tempo/speed';
import { buildCommandPlayback } from '../core/command';
import { analyze } from './analyze';
import { describeCoreError } from './messages';
import { buildPreview, toRegionData, EMPTY_PREVIEW } from './preview';
import type { AnalyzeResult, GenerateOptions, GenerateResult } from './types';

/**
 * The generation pipeline: parse, lay out, slice into regions, encode bytes.
 *
 * Failures do not throw. They come back as `success: false` plus a readable
 * message, so the GUI can render them without wrapping every call.
 */

const DEFAULT_PRESETS = [1.0, 0.75, 0.5, 1.5, 2.0];

/**
 * The note-block palette the user asked for.
 *
 * The five-slot palette is the default. Turning it off drops to the harp slot alone,
 * which needs no resource pack at all but only reaches F#3-F#5; notes outside then
 * fall to the out-of-range policy like any other out-of-range note.
 */
function paletteRegions(options: GenerateOptions): RegionTable {
  return regionsFor(options.extendedRange === false ? 'piano' : 'full');
}

/** The MIDI span the chosen palette can sound, so the interface can name it. */
function paletteRange(options: GenerateOptions): { low: number; high: number } {
  const [low, high] = coveredRange(paletteRegions(options));
  return { low, high };
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
    const compiled = buildCommandPlayback(song, { ...options, regions: paletteRegions(options) });
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
        pitchRange: paletteRange(options),
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
        // Command playback places no grouped cells, so there is nothing to point at.
        placed: [],
        // Its own mapping is not counted here yet; see the review note in docs.
        rangeShift: { notes: 0, maxSemitones: 0 },
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

function layoutOptions(options: GenerateOptions) {
  // Pass through only the options the user set explicitly; layout() merges the rest with defaults
  const config: Partial<LayoutConfig> = {};
  if (options.baseTps !== undefined) config.baseTps = options.baseTps;
  if (options.dMax !== undefined) config.dMax = options.dMax;

  return {
    config,
    regions: paletteRegions(options),
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
    placed: [],
    rangeShift: { notes: 0, maxSemitones: 0 },
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
        error: `电路布局失败：${describeCoreError(e)}`,
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
      pitchRange: paletteRange(options),
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
