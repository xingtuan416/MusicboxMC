import type { BlockOverrides } from '../core/palette/blockTable';
import type { GenerateOptions } from './types';

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
    options.excludeTracks = input.excludeTracks.filter(
      (value): value is number => Number.isSafeInteger(value) && value >= 0,
    );
  }
  if (isRecord(input.transpose)) {
    const transpose: Record<number, number> = {};
    for (const [key, value] of Object.entries(input.transpose)) {
      const track = Number(key);
      if (Number.isSafeInteger(track) && track >= 0 && typeof value === 'number' && Number.isFinite(value)) {
        transpose[track] = value;
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
    options.speedPresets = input.speedPresets.filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
  }
  if (typeof input.author === 'string') options.author = input.author;
  if (typeof input.mergeSameInstrument === 'boolean') options.mergeSameInstrument = input.mergeSameInstrument;
  if (typeof input.forceMergeSameInstrument === 'boolean') {
    options.forceMergeSameInstrument = input.forceMergeSameInstrument;
  }
  if (typeof input.commandPlayback === 'boolean') options.commandPlayback = input.commandPlayback;
  if (isRecord(input.blocks)) options.blocks = input.blocks as BlockOverrides;

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
