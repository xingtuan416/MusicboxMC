import { describe, expect, it } from 'vitest';
import { sanitizeGenerateOptions } from '../src/main/options';

describe('generate option sanitisation at the IPC boundary', () => {
  it('drops invalid modes, policies, numbers and non-booleans', () => {
    expect(
      sanitizeGenerateOptions({
        instrumentMode: 'native\0',
        outOfRange: 'explode',
        baseTps: 0,
        dMax: 99,
        mergeSameInstrument: 'yes',
        commandPlayback: 1,
      }),
    ).toEqual({});
    expect(sanitizeGenerateOptions(null)).toEqual({});
    expect(sanitizeGenerateOptions([])).toEqual({});
  });

  it('accepts only known block slots, regions and plain namespaced block ids', () => {
    expect(
      sanitizeGenerateOptions({
        blocks: {
          tracks: {
            0: { noteBase: 'minecraft:stone', wireSupport: 'minecraft:dirt', unknown: 'minecraft:air' },
            '-1': { floor: 'minecraft:stone' },
            2: { floor: 'minecraft:oak_stairs[facing=east]' },
          },
          regions: {
            A: { wireSupport: 'minecraft:stone' },
            Z: { wireSupport: 'minecraft:stone' },
            B: { noteBase: 'not-namespaced' },
          },
          extra: 'ignored',
        },
      }),
    ).toEqual({
      blocks: {
        tracks: {
          0: { noteBase: 'minecraft:stone', wireSupport: 'minecraft:dirt' },
        },
        regions: {
          A: { wireSupport: 'minecraft:stone' },
        },
      },
    });
  });

  it('keeps valid fields and filters arrays and transpose entries', () => {
    expect(
      sanitizeGenerateOptions({
        instrumentMode: 'native',
        outOfRange: 'drop',
        excludeTracks: [0, -1, 1.5, 'x', 2],
        transpose: { 0: 1, x: 2, 1: Number.POSITIVE_INFINITY, 2: -1 },
        baseTps: 20,
        dMax: 14,
        speedPresets: [1, 0.5, 0],
        author: 'test',
        mergeSameInstrument: true,
        forceMergeSameInstrument: false,
        commandPlayback: true,
        smartSelection: true,
        leadTrackIndex: 2,
      }),
    ).toEqual({
      instrumentMode: 'native',
      outOfRange: 'drop',
      excludeTracks: [0, 2],
      transpose: { 0: 1, 2: -1 },
      baseTps: 20,
      dMax: 14,
      speedPresets: [1, 0.5],
      author: 'test',
      mergeSameInstrument: true,
      forceMergeSameInstrument: false,
      commandPlayback: true,
      smartSelection: true,
      leadTrackIndex: 2,
    });
  });
});
