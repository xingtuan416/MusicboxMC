import type { BlockOverrides, BlockTable } from '../core/palette/blockTable';
import type { PitchRegion } from '../core/palette/pitchMap';
import type { GenerateOptions } from './types';

const BLOCK_SLOTS: ReadonlyArray<keyof BlockTable> = ['wireSupport', 'noteBase', 'floor'];
const PITCH_REGIONS: ReadonlySet<string> = new Set(['A', 'B', 'C', 'D', 'E']);
const BLOCK_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const MAX_TRACK_KEYS = 4096;
const MAX_PRESETS = 32;
const MAX_AUTHOR_LENGTH = 100;

/**
 * The renderer is not trusted: `song:generate` receives a structured-cloned object,
 * not a TypeScript value. Validate the option surface here instead of letting a bad
 * string silently fall through to a default deep inside the layout.
 */
export function sanitizeGenerateOptions(raw: unknown): GenerateOptions {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const options: GenerateOptions = {};

  if (input.instrumentMode === 'native' || input.instrumentMode === 'extended') {
    options.instrumentMode = input.instrumentMode;
  }
  if (typeof input.extendedRange === 'boolean') options.extendedRange = input.extendedRange;
  if (
    input.outOfRange === 'warn' ||
    input.outOfRange === 'clamp' ||
    input.outOfRange === 'octave' ||
    input.outOfRange === 'drop'
  ) {
    options.outOfRange = input.outOfRange;
  }
  if (Array.isArray(input.excludeTracks)) {
    options.excludeTracks = [
      ...new Set(
        input.excludeTracks.filter((value): value is number => Number.isSafeInteger(value) && value >= 0),
      ),
    ].slice(0, MAX_TRACK_KEYS);
  }
  if (isRecord(input.transpose)) {
    const transpose: Record<number, number> = {};
    let count = 0;
    for (const [key, value] of Object.entries(input.transpose)) {
      if (count >= MAX_TRACK_KEYS) break;
      const track = Number(key);
      if (Number.isSafeInteger(track) && track >= 0 && typeof value === 'number' && Number.isFinite(value)) {
        transpose[track] = value;
        count += 1;
      }
    }
    options.transpose = transpose;
  }
  if (typeof input.baseTps === 'number' && Number.isFinite(input.baseTps) && input.baseTps > 0) {
    options.baseTps = input.baseTps;
  }
  if (Number.isSafeInteger(input.dMax) && (input.dMax as number) >= 1 && (input.dMax as number) <= 14) {
    options.dMax = input.dMax as number;
  }
  if (
    typeof input.commandChainBudget === 'number' &&
    Number.isSafeInteger(input.commandChainBudget) &&
    input.commandChainBudget > 0
  ) {
    options.commandChainBudget = input.commandChainBudget;
  }
  if (Array.isArray(input.speedPresets)) {
    options.speedPresets = input.speedPresets
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
      .slice(0, MAX_PRESETS);
  }
  if (typeof input.author === 'string') options.author = input.author.trim().slice(0, MAX_AUTHOR_LENGTH);
  if (typeof input.mergeSameInstrument === 'boolean') options.mergeSameInstrument = input.mergeSameInstrument;
  if (typeof input.forceMergeSameInstrument === 'boolean') {
    options.forceMergeSameInstrument = input.forceMergeSameInstrument;
  }
  if (typeof input.commandPlayback === 'boolean') options.commandPlayback = input.commandPlayback;
  const blocks = sanitizeBlocks(input.blocks);
  if (blocks) options.blocks = blocks;

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the three real slots, with a namespaced plain block id and no state string. */
function sanitizeBlockTable(raw: unknown): Partial<BlockTable> | null {
  if (!isRecord(raw)) return null;
  const table: Partial<BlockTable> = {};
  for (const slot of BLOCK_SLOTS) {
    const value = raw[slot];
    if (typeof value === 'string' && BLOCK_ID.test(value)) table[slot] = value;
  }
  return Object.keys(table).length > 0 ? table : null;
}

function sanitizeBlocks(raw: unknown): BlockOverrides | null {
  if (!isRecord(raw)) return null;
  const overrides: BlockOverrides = {};

  if (isRecord(raw.tracks)) {
    const tracks: Record<number, Partial<BlockTable>> = {};
    let count = 0;
    for (const [key, value] of Object.entries(raw.tracks)) {
      if (count >= MAX_TRACK_KEYS) break;
      const track = Number(key);
      if (!Number.isSafeInteger(track) || track < 0) continue;
      const table = sanitizeBlockTable(value);
      if (table) {
        tracks[track] = table;
        count += 1;
      }
    }
    if (count > 0) overrides.tracks = tracks;
  }

  if (isRecord(raw.regions)) {
    const regions: Partial<Record<PitchRegion, Partial<BlockTable>>> = {};
    let count = 0;
    for (const [key, value] of Object.entries(raw.regions)) {
      if (!PITCH_REGIONS.has(key)) continue;
      const table = sanitizeBlockTable(value);
      if (table) {
        regions[key as PitchRegion] = table;
        count += 1;
      }
    }
    if (count > 0) overrides.regions = regions;
  }

  return overrides.tracks || overrides.regions ? overrides : null;
}
