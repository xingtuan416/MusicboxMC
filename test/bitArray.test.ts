import { describe, expect, it } from 'vitest';
import { packLongArray, requiredBits, unpackLongArray } from '../src/core/litematic/bitArray';

describe('bitArray', () => {
  it('signed NBT longs preserve entries crossing the sign bit', () => {
    const indices = Array.from({ length: 500 }, (_, i) => (i * 17) % 90);
    const bits = requiredBits(90);
    const signed = packLongArray(indices, bits).map((value) => BigInt.asIntN(64, value));
    expect([...unpackLongArray(signed, indices.length, bits)]).toEqual(indices);
  });
  it('bit width = max(2, ceil(log2(paletteSize)))', () => {
    expect(requiredBits(1)).toBe(2);
    expect(requiredBits(2)).toBe(2);
    expect(requiredBits(3)).toBe(2);
    expect(requiredBits(4)).toBe(2);
    expect(requiredBits(5)).toBe(3);
    expect(requiredBits(11)).toBe(4);
    expect(requiredBits(20)).toBe(5);
    expect(requiredBits(36)).toBe(6);
    expect(requiredBits(128)).toBe(7);
    expect(requiredBits(257)).toBe(9);
  });

  it('round-trips stably on small structures', () => {
    const indices = Array.from({ length: 27 }, (_, i) => i % 9);
    const bits = requiredBits(9);
    const longs = packLongArray(indices, bits);
    const back = unpackLongArray(longs, indices.length, bits);
    expect([...back]).toEqual(indices);
  });

  it('packs tightly across the 64-bit boundary (3 bits x 100)', () => {
    const bits = 3;
    const indices = Array.from({ length: 100 }, (_, i) => i % 8);
    const longs = packLongArray(indices, bits);
    expect(longs).toHaveLength(Math.ceil((100 * bits) / 64));
    expect([...unpackLongArray(longs, 100, bits)]).toEqual(indices);
  });

  it('lets entries span word boundaries contiguously (tight, not aligned)', () => {
    // With bits=3, entry 21 starts at bit 63 and spans words 0 and 1.
    const bits = 3;
    const indices = new Array(30).fill(0);
    indices[21] = 7;
    const longs = packLongArray(indices, bits);
    const back = unpackLongArray(longs, 30, bits);
    expect(back[21]).toBe(7);
    expect(back[20]).toBe(0);
    expect(back[22]).toBe(0);
    // Packed tightly, 30*3=90 bits need only 2 longs. Word-aligned packing also needs 2,
    // but the low bits combine differently.
    expect(longs).toHaveLength(2);
  });

  it('round-trips at the minimum width of 2 bits', () => {
    const indices = [0, 1, 2, 3, 3, 2, 1, 0, 1, 3];
    const longs = packLongArray(indices, 2);
    expect([...unpackLongArray(longs, indices.length, 2)]).toEqual(indices);
  });

  it('keeps the largest index in range', () => {
    for (const paletteSize of [2, 5, 17, 100, 257]) {
      const bits = requiredBits(paletteSize);
      const maxVal = paletteSize - 1;
      const indices = Array.from({ length: 50 }, (_, i) => (i * 7) % paletteSize);
      const longs = packLongArray(indices, bits);
      const back = unpackLongArray(longs, 50, bits);
      for (const v of back) expect(v).toBeLessThanOrEqual(maxVal);
      expect([...back]).toEqual(indices);
    }
  });
});
