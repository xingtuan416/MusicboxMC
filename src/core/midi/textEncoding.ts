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
 * can be re-decoded. UTF-8 is tried first: the other common case is a UTF-8 name read
 * the same way, and a clean decode is a strong signal that it was. GBK is tried only
 * after that, and only a decode that consumes every byte is accepted.
 */

const LATIN1_MAX = 0xff;
const ENCODINGS = ['utf-8', 'gbk'];

/**
 * Whether a decode actually recovered the high bytes.
 *
 * `fatal: true` is not enough on its own: Node 20's GBK decoder silently drops a stray
 * high byte and returns the rest, so a name could come back truncated with no error.
 * A recovery is only accepted when it produced something, produced no replacement
 * character, and turned at least one high byte into a real character.
 */
function looksRecovered(decoded: string): boolean {
  if (decoded.length === 0 || decoded.includes('\uFFFD')) return false;
  for (const character of decoded) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
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
  for (const encoding of ENCODINGS) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (looksRecovered(decoded)) return decoded;
    } catch {
      // Not this encoding, or this runtime has no decoder for it; try the next.
    }
  }
  return value;
}
