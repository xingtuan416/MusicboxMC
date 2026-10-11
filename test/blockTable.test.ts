import { describe, expect, it } from 'vitest';
import {
  AIR,
  createBlockResolver,
  DEFAULT_BLOCK_TABLE,
  isAir,
  type BlockTable,
} from '../src/core/palette/blockTable';

const base = { global: DEFAULT_BLOCK_TABLE };

describe('blockTable material resolver', () => {
  it('falls back to the global default when nothing overrides it', () => {
    const r = createBlockResolver(base);
    expect(r({ slot: 'wireSupport' })).toBe(DEFAULT_BLOCK_TABLE.wireSupport);
    expect(r({ slot: 'noteBase' })).toBe(DEFAULT_BLOCK_TABLE.noteBase);
    expect(r({ slot: 'floor' })).toBe(DEFAULT_BLOCK_TABLE.floor);
  });

  it('supports per-region defaults, since base blocks already differ by region', () => {
    const r = createBlockResolver({
      global: DEFAULT_BLOCK_TABLE,
      regions: { A: { noteBase: 'minecraft:dirt' }, C: { noteBase: 'minecraft:bedrock' } },
    });
    expect(r({ slot: 'noteBase', region: 'A' })).toBe('minecraft:dirt');
    expect(r({ slot: 'noteBase', region: 'C' })).toBe('minecraft:bedrock');
    // A slot with no region default still falls back to the global default.
    expect(r({ slot: 'noteBase', region: 'B' })).toBe(DEFAULT_BLOCK_TABLE.noteBase);
  });

  it('applies a track-level override without affecting other tracks', () => {
    const r = createBlockResolver(base, {
      tracks: { 0: { wireSupport: 'minecraft:stone' } },
    });
    expect(r({ slot: 'wireSupport', trackIndex: 0 })).toBe('minecraft:stone');
    expect(r({ slot: 'wireSupport', trackIndex: 1 })).toBe(DEFAULT_BLOCK_TABLE.wireSupport);
    expect(r({ slot: 'wireSupport' })).toBe(DEFAULT_BLOCK_TABLE.wireSupport);
  });

  it('prefers overrides to defaults, with region overrides above track overrides', () => {
    const r = createBlockResolver(
      { global: DEFAULT_BLOCK_TABLE, regions: { A: { noteBase: 'minecraft:dirt' } } },
      {
        tracks: { 0: { noteBase: 'minecraft:stone' } },
        regions: { A: { noteBase: 'minecraft:obsidian' } },
      },
    );
    // A region override beats a track override.
    expect(r({ slot: 'noteBase', trackIndex: 0, region: 'A' })).toBe('minecraft:obsidian');
    // A slot the region does not override falls through to the track override.
    expect(r({ slot: 'wireSupport', trackIndex: 0, region: 'A' })).toBe(DEFAULT_BLOCK_TABLE.wireSupport);
    // A region override beats a region default.
    expect(r({ slot: 'noteBase', region: 'A' })).toBe('minecraft:obsidian');
  });

  it('allows resolving any slot to air', () => {
    const r = createBlockResolver(base, { regions: { C: { wireSupport: AIR } } });
    const got = r({ slot: 'wireSupport', region: 'C' });
    expect(got).toBe(AIR);
    expect(isAir(got)).toBe(true);
  });

  it('lets an override table be partial, falling back slot by slot', () => {
    const partial: Partial<BlockTable> = { floor: 'minecraft:bedrock' };
    const r = createBlockResolver(base, { tracks: { 2: partial } });
    expect(r({ slot: 'floor', trackIndex: 2 })).toBe('minecraft:bedrock');
    expect(r({ slot: 'noteBase', trackIndex: 2 })).toBe(DEFAULT_BLOCK_TABLE.noteBase);
  });

  it('recognises only minecraft:air as air', () => {
    expect(isAir(AIR)).toBe(true);
    expect(isAir('minecraft:dirt')).toBe(false);
  });
});
