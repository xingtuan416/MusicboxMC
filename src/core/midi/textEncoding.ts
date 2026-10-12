/**
 * MIDI text events have no declared encoding.
 *
 * A text event is a byte string. Western files use ASCII or Latin-1, and Chinese files
 * almost always use GBK. `@tonejs/midi` reads one byte per character, so a GBK name
 * arrives as Latin-1 mojibake: 主旋律 becomes "Ö÷ÐýÂÉ". Every track of every Chinese
 * song reads that way, which is a poor first impression for most of this project's
 * users.
 *
 * The bytes are recoverable, because each character is exactly one byte, so the value
 * can be re-decoded. UTF-8 is tried first, since a UTF-8 name read the same way is the
 * other common case, and then GBK.
 *
 * What a decoder does with a malformed sequence is not portable - Node 22 rejects a
 * stray high byte and Node 20 maps it to some character and carries on - so the shape of
 * the bytes is checked here rather than inferred from whether decoding threw. Otherwise
 * the same file would produce different names on different runtimes.
 */

const LATIN1_MAX = 0xff;

/** Anything here means the bytes did not decode to text: controls, format, private use. */
const NOT_TEXT = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\uFFFD]/u;

/** A decode is only usable if it produced something and turned a high byte into a character. */
function looksRecovered(decoded: string): boolean {
  if (decoded.length === 0 || NOT_TEXT.test(decoded)) return false;
  for (const character of decoded) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

/**
 * Whether the bytes have GBK's structure: ASCII on its own, otherwise a lead byte in
 * 0x81-0xFE followed by a trail byte in 0x40-0xFE, 0x7F excluded.
 */
function isGbkShaped(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte < 0x80) continue;
    if (byte < 0x81 || byte > 0xfe) return false;
    const trail = bytes[index + 1];
    if (trail === undefined || trail < 0x40 || trail > 0xfe || trail === 0x7f) return false;
    index++;
  }
  return true;
}

/** Decode with one encoding, or null when the runtime cannot or the result is unusable. */
function tryDecode(encoding: string, bytes: Uint8Array): string | null {
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return looksRecovered(decoded) ? decoded : null;
  } catch {
    // The runtime has no decoder for this encoding, or it rejected the bytes.
    return null;
  }
}

/** Recover a MIDI text event that was written in a legacy encoding. */
export function decodeMidiText(value: string): string {
  if (!value) return value;

  let hasHighByte = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // A real character beyond Latin-1 means it already decoded correctly.
    if (code > LATIN1_MAX) return value;
    if (code >= 0x80) hasHighByte = true;
  }
  // Plain ASCII, so there is nothing to recover.
  if (!hasHighByte) return value;

  const bytes = Uint8Array.from([...value].map((character) => (character.codePointAt(0) ?? 0) & 0xff));

  const utf8 = tryDecode('utf-8', bytes);
  if (utf8 !== null) return utf8;

  if (isGbkShaped(bytes)) {
    const gbk = tryDecode('gbk', bytes);
    if (gbk !== null) return gbk;
  }

  return value;
}
