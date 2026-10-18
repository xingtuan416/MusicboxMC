import { describe, expect, it } from 'vitest';
import { decodeMidiText } from '../src/core/midi/textEncoding';

/**
 * MIDI text has no declared encoding, and the library this project reads files with
 * gives back one character per byte. A GBK track name therefore arrives as Latin-1
 * mojibake, which is what a Chinese user saw for every track of every song.
 */
const asLatin1 = (bytes: number[]): string => String.fromCharCode(...bytes);

describe('MIDI text decoding', () => {
  it('recovers a GBK name read as Latin-1', () => {
    // The GBK bytes D6 F7 D0 FD C2 C9 are the name this test expects back.
    expect(decodeMidiText(asLatin1([0xd6, 0xf7, 0xd0, 0xfd, 0xc2, 0xc9]))).toBe('主旋律');
  });

  it('recovers a UTF-8 name read as Latin-1', () => {
    // "Café" in UTF-8 is 43 61 66 C3 A9.
    expect(decodeMidiText(asLatin1([0x43, 0x61, 0x66, 0xc3, 0xa9]))).toBe('Café');
  });

  it('leaves plain ASCII alone', () => {
    expect(decodeMidiText('Piano')).toBe('Piano');
    expect(decodeMidiText('Lead 1')).toBe('Lead 1');
  });

  it('leaves text that already decoded correctly alone', () => {
    expect(decodeMidiText('主旋律')).toBe('主旋律');
    expect(decodeMidiText('ピアノ')).toBe('ピアノ');
  });

  it('leaves an empty name alone', () => {
    expect(decodeMidiText('')).toBe('');
  });

  it('refuses a GBK decode when the bytes are not GBK-shaped', () => {
    // 0xFF is not a GBK lead byte, so it must not reach the decoder at all: Node 22
    // rejects it and Node 20 maps it to a character, and the same file has to produce
    // the same name on both.
    expect(decodeMidiText(asLatin1([0xff, 0x41]))).toBe(asLatin1([0xff, 0x41]));
    // A lead byte with no trail byte, and a lead byte whose trail is the excluded 0x7F,
    // are equally malformed.
    expect(decodeMidiText(asLatin1([0xd6]))).toBe(asLatin1([0xd6]));
    expect(decodeMidiText(asLatin1([0xd6, 0x7f]))).toBe(asLatin1([0xd6, 0x7f]));
  });

  it('leaves bytes that decode as neither encoding alone', () => {
    // A lone 0xFF is invalid UTF-8. Node 22's GBK decoder rejects it too, but Node 20's
    // silently drops it, so a decode that recovers no character at all is refused as
    // well - otherwise the name would come back quietly truncated.
    expect(decodeMidiText(asLatin1([0xff]))).toBe(asLatin1([0xff]));
    expect(decodeMidiText(asLatin1([0x41, 0xff, 0x41]))).toBe(asLatin1([0x41, 0xff, 0x41]));
  });

  it('accepts a GBK pair followed by ASCII', () => {
    // One GBK pair followed by a plain ASCII 0x41: a complete decode, not a failure.
    expect(decodeMidiText(asLatin1([0xd6, 0xf7, 0x41]))).toBe('主A');
  });
});
