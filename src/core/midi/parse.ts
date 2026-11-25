import { Header, Track } from '@tonejs/midi';
import { parseMidi as parseRawMidi, type MidiEvent } from 'midi-file';
import type { SongModel, TempoSegment, TrackModel } from './types';
import { decodeMidiText } from './textEncoding';
import { coreError } from '../errors';

const DEFAULT_BPM = 120;

interface PendingNote {
  track: Omit<TrackModel, 'index'>;
  tick: number;
  velocity: number;
}

/** Pair each release with its attack, even if the channel changed program in between. */
function parseTrack(events: MidiEvent[], header: Header): Omit<TrackModel, 'index'>[] {
  const nameEvent = events.find((event) => event.type === 'trackName');
  const name = decodeMidiText(nameEvent?.text ?? '');
  const programs = new Map<number, number>();
  const groups = new Map<number, Omit<TrackModel, 'index'>>();
  const pending = new Map<number, PendingNote[]>();
  let tick = 0;

  function trackFor(channel: number): Omit<TrackModel, 'index'> {
    const program = programs.get(channel);
    const key = channel * 129 + (program ?? 128);
    const found = groups.get(key);
    if (found) return found;

    const tone = new Track([], header);
    tone.channel = channel;
    tone.instrument.number = program ?? 0;
    const track = {
      name,
      channel,
      program,
      instrument: tone.instrument.name,
      percussion: channel === 9,
      notes: [],
    };
    groups.set(key, track);
    return track;
  }

  for (const event of events) {
    tick += event.deltaTime;
    if (!('channel' in event)) continue;
    const channel = event.channel;
    if (event.type === 'programChange') programs.set(channel, event.programNumber);

    if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
      const key = channel * 128 + event.noteNumber;
      const queue = pending.get(key);
      const attack = queue?.shift();
      if (queue?.length === 0) pending.delete(key);
      if (!attack) continue;
      const timeSec = header.ticksToSeconds(attack.tick);
      const durationSec = header.ticksToSeconds(tick) - timeSec;
      attack.track.notes.push({
        midi: event.noteNumber,
        timeSec,
        durationSec,
        velocity: attack.velocity,
        channel,
      });
    } else {
      const track = trackFor(channel);
      if (event.type !== 'noteOn') continue;
      const key = channel * 128 + event.noteNumber;
      const queue = pending.get(key) ?? [];
      queue.push({ track, tick, velocity: event.velocity / 127 });
      pending.set(key, queue);
    }
  }
  return groups.size > 0 ? [...groups.values()] : [trackFor(0)];
}

/** Parse MIDI binary into a normalized SongModel. */
export function parseMidi(buffer: Buffer | Uint8Array): SongModel {
  const raw = parseRawMidi(buffer);
  if (raw.header.format !== 0 && raw.header.format !== 1) {
    throw coreError('MIDI_UNSUPPORTED_FORMAT', { format: raw.header.format });
  }
  const ppq = raw.header.ticksPerBeat;
  if (ppq === undefined || !Number.isSafeInteger(ppq) || ppq <= 0) {
    throw coreError('MIDI_UNSUPPORTED_TIMEBASE');
  }
  // Tone's Header needs absolute event times. Use it for tempo and time signatures
  // without sending the note stream through Tone's program-based track splitter.
  for (const track of raw.tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      Object.assign(event, { absoluteTime: tick });
    }
  }
  const header = new Header({ ...raw, tracks: raw.tracks.length > 0 ? raw.tracks : [[]] });
  if (!header.tempos.some((tempo) => tempo.ticks === 0)) {
    header.tempos.push({ ticks: 0, bpm: DEFAULT_BPM });
    header.update();
  }
  const tempos: TempoSegment[] = header.tempos.map((tempo) => ({
    ticks: tempo.ticks,
    timeSec: tempo.time ?? 0,
    bpm: tempo.bpm,
  }));
  const ts = header.timeSignatures[0];
  const timeSignature: [number, number] | null = ts ? [ts.timeSignature[0]!, ts.timeSignature[1]!] : null;

  const logical = raw.tracks.flatMap((track) => parseTrack(track, header));
  if (raw.header.format === 1 && logical[0]?.notes.length === 0) logical.shift();
  let durationSec = 0;
  const tracks: TrackModel[] = logical.map((track, index) => {
    track.notes.sort((a, b) => a.timeSec - b.timeSec || a.midi - b.midi);
    for (const note of track.notes) {
      if (!Number.isFinite(note.timeSec) || !Number.isFinite(note.durationSec) || note.timeSec < 0) {
        throw coreError('MIDI_INVALID_TIMING', { track: index });
      }
      durationSec = Math.max(durationSec, note.timeSec + note.durationSec);
    }
    return { ...track, index };
  });

  return {
    name: decodeMidiText(header.name),
    ppq,
    durationSec,
    baseBpm: tempos[0]!.bpm,
    tempos,
    timeSignature,
    tracks,
  };
}
