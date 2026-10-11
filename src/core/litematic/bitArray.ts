/**
 * Litematica's tightly packed BlockStates bit packing.
 *
 * Unlike vanilla Minecraft's BitArray, Litematica entries **span across 64-bit
 * boundaries** and are not aligned per word. Writes use little-endian bit order
 * (lowest bit first).
 *
 *   bits   = max(2, ceil(log2(paletteSize)))
 *   length = ceil(volume * bits / 64)
 *   entry i start bit   start = i * bits
 *   word index          startArrIndex = start >>> 6
 *   across word bounds  endArrIndex = (start + bits - 1) >>> 6
 */

/** Bit width per entry from the palette size (minimum 2 bits). */
export function requiredBits(paletteSize: number): number {
  return Math.max(2, bitLength(paletteSize - 1));
}

function bitLength(n: number): number {
  let bits = 0;
  let v = n;
  while (v > 0) {
    bits++;
    v = Math.floor(v / 2);
  }
  return bits;
}

/** Long array length. */
export function longArrayLength(volume: number, bits: number): number {
  return Math.ceil((volume * bits) / 64);
}

const MASK64 = (1n << 64n) - 1n;

/** Pack an index array (each element < 2^bits) into a long array. */
export function packLongArray(indices: ArrayLike<number>, bits: number): bigint[] {
  const volume = indices.length;
  const longs = new Array<bigint>(longArrayLength(volume, bits)).fill(0n);
  const mask = (1n << BigInt(bits)) - 1n;

  for (let i = 0; i < volume; i++) {
    const value = BigInt(indices[i]!) & mask;
    const start = i * bits;
    const startWord = start >>> 6;
    const startOffset = start & 63;
    const endWord = (start + bits - 1) >>> 6;

    longs[startWord] = (longs[startWord]! | ((value << BigInt(startOffset)) & MASK64)) & MASK64;

    const remaining = bits - (64 - startOffset);
    if (remaining > 0) {
      longs[endWord] = (longs[endWord]! | (value >> BigInt(64 - startOffset))) & MASK64;
    }
  }

  return longs;
}

/** Unpack an index array from a long array. */
export function unpackLongArray(longs: bigint[], volume: number, bits: number): Uint32Array {
  const out = new Uint32Array(volume);
  const mask = (1n << BigInt(bits)) - 1n;

  for (let i = 0; i < volume; i++) {
    const start = i * bits;
    const startWord = start >>> 6;
    const startOffset = start & 63;
    const endWord = (start + bits - 1) >>> 6;

    // NBT reads signed longs. Normalize before shifting across a word boundary,
    // otherwise the sign bit fills the following palette entry with ones.
    let value = BigInt.asUintN(64, longs[startWord]!) >> BigInt(startOffset);
    if (endWord !== startWord) {
      value |= BigInt.asUintN(64, longs[endWord]!) << BigInt(64 - startOffset);
    }
    out[i] = Number(value & mask);
  }

  return out;
}
