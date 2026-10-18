import { Midi } from '@tonejs/midi';
import type { NoteEvent, SongModel, TempoSegment, TrackModel } from './types';
import { decodeMidiText } from './textEncoding';
import { coreError } from '../errors';

/** Tempo a MIDI file plays at until its first tempo event, per the SMF specification. */
const DEFAULT_BPM = 120;

/** Parse MIDI binary into a normalized SongModel. */
export function parseMidi(buffer: Buffer | Uint8Array): SongModel {
  const midi = new Midi(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

  // Time division is either ticks per quarter note or SMPTE frames per second. The
  // library leaves `ppq` undefined for SMPTE, which makes every derived time NaN; a NaN
  // used to send the layout into an infinite loop, so refuse the file up front instead.
  if (!Number.isFinite(midi.header.ppq) || midi.header.ppq <= 0) {
    throw coreError('MIDI_UNSUPPORTED_TIMEBASE');
  }

  // Every time is derived from the first tempo event, including the span before it: the
  // library measures that span at the first event's own tempo, so a file whose first
  // tempo starts late would have its opening played at the wrong speed. State the
  // specification's default at tick 0 and recompute. `Note.time` is a getter, so this
  // corrects the notes as well, provided it happens before any of them is read.
  if (!midi.header.tempos.some((tempo) => tempo.ticks === 0)) {
    midi.header.tempos.push({ ticks: 0, bpm: DEFAULT_BPM });
    midi.header.update();
  }

  const tempos: TempoSegment[] = midi.header.tempos.map((t) => ({
    ticks: t.ticks,
    timeSec: t.time ?? 0,
    bpm: t.bpm,
  }));
  // `tempos[0]` is guaranteed here: the block above inserts a tick-0 tempo whenever the
  // file has none, so a fallback at this point would be unreachable and would give the
  // default tempo a second definition.

  const ts = midi.header.timeSignatures[0];
  const timeSignature: [number, number] | null = ts ? [ts.timeSignature[0]!, ts.timeSignature[1]!] : null;

  const tracks: TrackModel[] = midi.tracks.map((track, index) => {
    const notes: NoteEvent[] = track.notes.map((n) => {
      // Nothing downstream can lay out a note at an unrepresentable time, and a
      // non-finite one would spin rather than fail, so this is checked here instead of
      // being trusted to the parser.
      if (!Number.isFinite(n.time) || !Number.isFinite(n.duration) || n.time < 0) {
        throw coreError('MIDI_INVALID_TIMING', { track: index });
      }
      return {
        midi: n.midi,
        timeSec: n.time,
        durationSec: n.duration,
        velocity: n.velocity,
        channel: track.channel,
      };
    });
    notes.sort((a, b) => a.timeSec - b.timeSec || a.midi - b.midi);
    return {
      index,
      name: decodeMidiText(track.name),
      channel: track.channel,
      program: track.instrument?.number,
      instrument: track.instrument?.name ?? 'unknown',
      percussion: track.instrument?.percussion ?? false,
      notes,
    };
  });

  return {
    name: decodeMidiText(midi.name || ''),
    ppq: midi.header.ppq,
    durationSec: midi.duration,
    baseBpm: tempos[0]!.bpm,
    tempos,
    timeSignature,
    tracks,
  };
}
