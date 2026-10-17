import { describe, expect, it } from 'vitest';
import { decodeModifiedUtf8 } from '../src/core/nbt/modifiedUtf8';
import { writeNbt } from '../src/core/nbt/writer';
import { nbt } from '../src/core/nbt/tag';

/**
 * Two diagnostics that pointed at the wrong thing.
 *
 * Found by an external review running over a single commit. Both are small and neither
 * changes what the code accepts - which is exactly why they would have survived unnoticed.
 */

/** Run `fn` and return the CoreError code and details it threw. */
function thrown(fn: () => void): { code?: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (error) {
    const core = error as { code?: string; details?: Record<string, unknown> };
    return { code: core.code, details: core.details };
  }
  return {};
}

describe('NBT diagnostics', () => {
  it('reports a position relative to the file, not to the string being decoded', () => {
    // `0xFF` is not a valid Modified UTF-8 lead byte. Decoding it with a start offset of
    // 100 must report byte 102 of the stream, not byte 2 of the slice: every other NBT
    // diagnostic reports an absolute offset, and a caller hunting through a schematic
    // cannot use a position that silently means something else.
    const bytes = Buffer.from([0x41, 0x41, 0xff]);
    const { code, details } = thrown(() => decodeModifiedUtf8(bytes, 100));

    expect(code).toBe('NBT_INVALID_UTF8');
    expect(details?.position).toBe(102);
  });

  it('rejects an oversized string before allocating for it', () => {
    // Modified UTF-8 needs at least one byte per UTF-16 code unit, so a string this long
    // cannot fit whatever the encoder would do with it. Checking first avoids allocating
    // three times its length only to throw.
    const huge = 'a'.repeat(70_000);
    const { code } = thrown(() => writeNbt('', nbt.string(huge)));

    expect(code).toBe('NBT_STRING_TOO_LONG');
  });

  it('still accepts a string that fits', () => {
    const justInside = 'a'.repeat(65_535);
    expect(() => writeNbt('', nbt.string(justInside))).not.toThrow();
  });
});
