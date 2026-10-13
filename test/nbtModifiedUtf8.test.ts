import { describe, expect, it } from 'vitest';
import { decodeModifiedUtf8, encodeModifiedUtf8 } from '../src/core/nbt/modifiedUtf8';
import { buildLitematic, parseLitematic } from '../src/core/litematic/build';

/**
 * Byte sequences produced by Java's `DataOutputStream.writeUTF`, with the two-byte length
 * prefix removed.
 *
 * NBT strings are written with that method, so these are the bytes a schematic has to
 * contain. Comparing against this project's own writer alone would not prove it: a
 * self-consistent wrong encoding round-trips perfectly, which is exactly how plain UTF-8
 * survived here until something outside the BMP showed up.
 */
const JAVA_BYTES: Array<[name: string, text: string, hex: string]> = [
  ['ascii', 'Piano', '5069616e6f'],
  ['chinese', 'hello 红石', '68656c6c6f20e7baa2e79fb3'],
  ['latin1', 'café', '636166c3a9'],
  ['nul', 'a\u0000b', '61c08062'],
  ['emoji', 'review 🎵', '72657669657720eda0bcedbeb5'],
  ['gbk-decoded name', '主旋律', 'e4b8bbe6978be5be8b'],
];

const meta = {
  name: 'review 🎵',
  author: 'review 🎵',
  description: '主旋律',
  dataVersion: 3700,
  version: 6,
};
const region = {
  trackIndex: 0,
  position: { x: 0, y: 0, z: 0 },
  size: { x: 1, y: 1, z: 1 },
  blocks: [{ x: 0, y: 0, z: 0, state: { name: 'minecraft:stone' } }],
};

describe('NBT strings use Java Modified UTF-8', () => {
  it.each(JAVA_BYTES)('encodes %s exactly as Java does', (_name, text, hex) => {
    expect(encodeModifiedUtf8(text).toString('hex')).toBe(hex);
  });

  it.each(JAVA_BYTES)('decodes %s back', (_name, text, hex) => {
    expect(decodeModifiedUtf8(Buffer.from(hex, 'hex'))).toBe(text);
  });

  it('writes U+0000 as two bytes rather than a NUL byte', () => {
    // A NUL byte would have terminated the string in the original C design.
    expect(encodeModifiedUtf8('\u0000').toString('hex')).toBe('c080');
  });

  it('writes an astral character as a surrogate pair rather than four bytes', () => {
    // Standard UTF-8 would be f09f8eb5. Java's readUTF rejects that outright.
    expect(encodeModifiedUtf8('🎵').toString('hex')).toBe('eda0bcedbeb5');
    expect(encodeModifiedUtf8('🎵').length).toBe(6);
  });

  it('rejects the four-byte form, as Java does', () => {
    expect(() => decodeModifiedUtf8(Buffer.from('f09f8eb5', 'hex'))).toThrow();
  });

  it('rejects a truncated sequence', () => {
    expect(() => decodeModifiedUtf8(Buffer.from('e4b8', 'hex'))).toThrow();
    expect(() => decodeModifiedUtf8(Buffer.from('c3', 'hex'))).toThrow();
  });

  it('round-trips an emoji name and author through a schematic', () => {
    const parsed = parseLitematic(buildLitematic([region], meta));
    expect(parsed.metadata.name).toBe('review 🎵');
    expect(parsed.metadata.author).toBe('review 🎵');
    expect(parsed.metadata.description).toBe('主旋律');
  });
});
