import { writeFileSync } from 'node:fs';

/** Minimal hand-written MIDI writer: @tonejs/midi cannot write program changes. */
export interface WrittenTrack {
  /** General MIDI program, so the song classifies as multi-instrument. */
  program: number;
  notes: Array<{ midi: number; tick: number }>;
}

/** Variable-length quantity, the delta-time encoding MIDI uses. */
function vlv(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

/** One MTrk chunk with a program change and note on/off pairs. */
function trackChunk(track: WrittenTrack, channel: number): Buffer {
  const events: Array<{ tick: number; bytes: number[] }> = [
    { tick: 0, bytes: [0xc0 | channel, track.program] },
  ];
  for (const note of track.notes) {
    events.push({ tick: note.tick, bytes: [0x90 | channel, note.midi, 100] });
    events.push({ tick: note.tick + 60, bytes: [0x80 | channel, note.midi, 0] });
  }
  events.sort((a, b) => a.tick - b.tick);
  const out: number[] = [];
  let previous = 0;
  for (const event of events) {
    out.push(...vlv(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  const body = Buffer.from(out);
  const header = Buffer.from([
    0x4d,
    0x54,
    0x72,
    0x6b,
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
  ]);
  return Buffer.concat([header, body]);
}

/** Write a format-1 MIDI file with the given tracks. */
export function writeSong(path: string, tracks: WrittenTrack[]): void {
  const chunks = tracks.map((track, index) => trackChunk(track, index % 16));
  const header = Buffer.from([
    0x4d,
    0x54,
    0x68,
    0x64,
    0,
    0,
    0,
    6,
    0,
    1,
    (chunks.length >>> 8) & 0xff,
    chunks.length & 0xff,
    0x01,
    0xe0,
  ]);
  writeFileSync(path, Buffer.concat([header, ...chunks]));
}
