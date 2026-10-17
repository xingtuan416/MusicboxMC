import { coreError } from '../errors';

/**
 * Java's Modified UTF-8, which is what NBT strings actually use.
 *
 * `DataInput.readUTF` / `DataOutput.writeUTF` do not speak standard UTF-8. They encode
 * UTF-16 code units one at a time, so:
 *
 * - U+0000 is two bytes (0xC0 0x80) rather than one, because a NUL byte would have
 *   terminated a C string in the original design.
 * - Anything above U+FFFF is written as its surrogate pair, each half in three bytes, so
 *   it takes six bytes and a four-byte sequence never appears.
 *
 * A reader that expects this rejects a four-byte sequence outright. That is why an emoji
 * in the author name made Java throw `UTFDataFormatException` on a schematic this project
 * had written and read back without complaint: BMP characters, Chinese included, encode
 * identically in both forms, so the difference is invisible until something outside the
 * BMP shows up.
 */

/** Longest string NBT can store: the length prefix is an unsigned 16-bit byte count. */
export const MAX_MODIFIED_UTF8_BYTES = 0xffff;

/** Encode a string the way `DataOutput.writeUTF` does. */
export function encodeModifiedUtf8(value: string): Buffer {
  const bytes = Buffer.allocUnsafe(value.length * 3);
  let at = 0;
  // Iterate UTF-16 code units, not code points: a surrogate pair has to stay two
  // three-byte sequences rather than becoming one four-byte sequence.
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0x0001 && unit <= 0x007f) {
      bytes[at++] = unit;
    } else if (unit <= 0x07ff) {
      bytes[at++] = 0xc0 | (unit >> 6);
      bytes[at++] = 0x80 | (unit & 0x3f);
    } else {
      bytes[at++] = 0xe0 | (unit >> 12);
      bytes[at++] = 0x80 | ((unit >> 6) & 0x3f);
      bytes[at++] = 0x80 | (unit & 0x3f);
    }
  }
  return bytes.subarray(0, at);
}

/** Decode Modified UTF-8, rejecting what `DataInput.readUTF` would reject. */
export function decodeModifiedUtf8(buffer: Buffer, start = 0): string {
  const units: number[] = [];
  let at = 0;
  while (at < buffer.length) {
    const first = buffer[at]!;
    if (first < 0x80) {
      units.push(first);
      at += 1;
      continue;
    }
    if ((first & 0xe0) === 0xc0) {
      const second = buffer[at + 1];
      if (second === undefined || (second & 0xc0) !== 0x80) {
        throw coreError('NBT_INVALID_UTF8', { position: start + at });
      }
      units.push(((first & 0x1f) << 6) | (second & 0x3f));
      at += 2;
      continue;
    }
    if ((first & 0xf0) === 0xe0) {
      const second = buffer[at + 1];
      const third = buffer[at + 2];
      if (
        second === undefined ||
        third === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80
      ) {
        throw coreError('NBT_INVALID_UTF8', { position: start + at });
      }
      units.push(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      at += 3;
      continue;
    }
    // A four-byte lead byte, or a continuation byte with nothing before it.
    throw coreError('NBT_INVALID_UTF8', { position: start + at });
  }

  // Chunked, because spreading a large array into `fromCharCode` overflows the stack.
  let text = '';
  const CHUNK = 4096;
  for (let index = 0; index < units.length; index += CHUNK) {
    text += String.fromCharCode(...units.slice(index, index + CHUNK));
  }
  return text;
}
