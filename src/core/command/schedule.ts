import type { SongModel } from '../midi/types';
import type { TrackVoicing } from '../palette/assignment';
import {
  chooseOctaveOffset,
  mapDrumNote,
  mapPitchToInstrument,
  type InstrumentPitch,
} from '../palette/instrumentPitch';
import { INSTRUMENTS, isDrumInstrument, type NoteBlockInstrument } from '../palette/instruments';
import {
  mapPitch,
  DEFAULT_REGIONS,
  type MappedPitch,
  type OutOfRangePolicy,
  type RegionTable,
} from '../palette/pitchMap';
import type { LayoutWarning } from '../layout/types';
import { secondsToTick } from '../tempo/tick';
import { coreError } from '../errors';

/**
 * Turning a song into a schedule.
 *
 * The obvious implementation of command playback is one command block per note,
 * and it does not scale: a 46,000-note song becomes 46,308 blocks and a 348KB
 * schematic, and the chain has to walk all of it every game tick. Instead the
 * whole song is reduced to a small table here, and the command layer replays it.
 *
 * Nothing in this module knows about commands, blocks or coordinates.
 */

/** Highest value a scoreboard entry can hold. */
export const SCORE_MAX = 2147483646;

/** One retained note, already mapped to a sound event and a playsound pitch. */
export interface ScheduledEvent {
  tick: number;
  sound: string;
  pitch: string;
  /** The note-block instrument, kept so Stop can silence exactly what was used. */
  instrument: NoteBlockInstrument;
}

/** A distinct (sound, pitch) pair, and the most copies of it that sound at once. */
export interface Voice {
  sound: string;
  pitch: string;
  max: number;
}

export interface Schedule {
  events: ScheduledEvent[];
  voices: Voice[];
  /** One row per game tick that has notes: `[tick, countForVoice0, countForVoice1, ...]`. */
  frames: number[][];
  peakNotes: number;
}

export interface ScheduleOptions {
  baseTps: number;
  outOfRange: OutOfRangePolicy;
  /** Which sample slots may be used; see PitchPalette. */
  regions?: RegionTable;
  excludeTracks?: number[];
  transpose?: Record<number, number>;
  /** Per-track voicing; omitted means every track uses the five-slot piano palette. */
  assignments?: Record<number, TrackVoicing>;
}

/**
 * The pitch argument a `playsound` command needs.
 *
 * A note block sample is recorded at its own note 12, so that value maps to 1.0
 * and everything else is a power of two away from it.
 */
export function playbackPitch(note: number): string {
  return Math.pow(2, (note - 12) / 12)
    .toFixed(8)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/** Map every retained note to a game tick, a sound event and a pitch. */
export function collectEvents(
  song: SongModel,
  options: ScheduleOptions,
): { events: ScheduledEvent[]; warnings: LayoutWarning[] } {
  const warnings: LayoutWarning[] = [];
  const events: ScheduledEvent[] = [];
  const excluded = new Set(options.excludeTracks ?? []);

  for (const track of song.tracks) {
    if (excluded.has(track.index)) continue;
    const transpose = options.transpose?.[track.index] ?? 0;
    if (!Number.isFinite(transpose)) throw coreError('COMMAND_INVALID_TRANSPOSE');
    const voicing: TrackVoicing = options.assignments?.[track.index] ?? { kind: 'pitch' };

    let octaveOffset = 0;
    if (voicing.kind === 'instrument') {
      const fit = chooseOctaveOffset(track.notes, voicing.instrument, transpose);
      octaveOffset = fit.offset;
      // The warning describes the automatic range fit, not the user's own transpose.
      // Reporting the net value would claim a fit that did not happen (transpose +1,
      // offset 0) and hide a real fit that the transpose cancelled (offset -1, +1).
      if (fit.offset !== 0) {
        warnings.push({
          code: 'INSTRUMENT_OCTAVE_SHIFT',
          trackIndex: track.index,
          instrument: voicing.instrument,
          octaves: fit.offset,
          notes: track.notes.length,
        });
      }
      if (track.notes.length > 0) {
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        for (const note of track.notes) {
          const midi = note.midi + 12 * transpose;
          low = Math.min(low, midi);
          high = Math.max(high, midi);
        }
        const span = high - low;
        if (span > 24) {
          warnings.push({
            code: 'INSTRUMENT_RANGE_OVERFLOW',
            trackIndex: track.index,
            instrument: voicing.instrument,
            span,
            outside: fit.outside,
          });
        }
      }
    }

    // Depends only on the track-level voicing, so it belongs outside the note loop.
    let rangeFields: { instrument?: NoteBlockInstrument; low?: number; high?: number } = {};
    if (voicing.kind === 'instrument') {
      const range = INSTRUMENTS[voicing.instrument].range;
      if (range !== null) {
        rangeFields = { instrument: voicing.instrument, low: range[0], high: range[1] };
      }
    }

    let droppedDrums = 0;
    for (const note of track.notes) {
      let mapped: MappedPitch | InstrumentPitch;
      if (voicing.kind === 'pitch') {
        mapped = mapPitch(note.midi, options.regions ?? DEFAULT_REGIONS, options.outOfRange, transpose);
      } else if (voicing.kind === 'instrument') {
        mapped = mapPitchToInstrument(
          note.midi,
          voicing.instrument,
          options.outOfRange,
          transpose,
          octaveOffset,
        );
      } else {
        const drum = mapDrumNote(note.midi, track.name);
        if (drum === null) {
          droppedDrums += 1;
          continue;
        }
        mapped = drum;
      }

      // Resolved before the drop check so a warning can name the tick it is about.
      const tick = secondsToTick(note.timeSec, options.baseTps);
      if (mapped.dropped || (mapped.degraded && options.outOfRange !== 'octave')) {
        warnings.push({
          code: 'OUT_OF_RANGE',
          midi: note.midi,
          action: mapped.dropped ? 'drop' : options.outOfRange,
          trackIndex: track.index,
          tick,
          ...rangeFields,
        });
      }
      if (mapped.dropped) continue;

      if (!Number.isSafeInteger(tick) || tick < 0 || tick > SCORE_MAX) {
        throw coreError('COMMAND_TIME_OUT_OF_RANGE');
      }
      events.push({
        tick,
        sound: `minecraft:${INSTRUMENTS[mapped.instrument].soundEvent}`,
        // Fixed-pitch drums ignore the note value, so they always play at 1.0.
        pitch: isDrumInstrument(mapped.instrument) ? '1' : playbackPitch(mapped.note),
        instrument: mapped.instrument,
      });
    }

    if (droppedDrums > 0) {
      warnings.push({ code: 'DRUM_NOTES_DROPPED', trackIndex: track.index, count: droppedDrums });
    }
  }

  events.sort((a, b) => a.tick - b.tick);
  if (events.length === 0) {
    throw coreError('COMMAND_NO_NOTES');
  }
  return { events, warnings };
}

/**
 * Fold the event list into per-tick frames plus a voice table.
 *
 * A frame stores how many copies of each voice sound on that tick. The command
 * layer then needs only as many playsound commands as the largest count any voice
 * ever reaches, rather than one per note.
 */
export function encodeFrames(events: ScheduledEvent[]): {
  voices: Voice[];
  frames: number[][];
  peakNotes: number;
} {
  const voices: Voice[] = [];
  const voiceIndex = new Map<string, number>();
  for (const event of events) {
    const key = `${event.sound}|${event.pitch}`;
    if (!voiceIndex.has(key)) {
      voiceIndex.set(key, voices.length);
      voices.push({ sound: event.sound, pitch: event.pitch, max: 0 });
    }
  }

  const frames: number[][] = [];
  for (const event of events) {
    let frame = frames[frames.length - 1];
    if (!frame || frame[0] !== event.tick) {
      frame = [event.tick, ...Array<number>(voices.length).fill(0)];
      frames.push(frame);
    }
    const index = voiceIndex.get(`${event.sound}|${event.pitch}`)!;
    frame[index + 1] = frame[index + 1]! + 1;
    voices[index]!.max = Math.max(voices[index]!.max, frame[index + 1]!);
  }

  let peakNotes = 0;
  for (const frame of frames) {
    let total = 0;
    for (let i = 1; i < frame.length; i++) total += frame[i]!;
    peakNotes = Math.max(peakNotes, total);
  }

  return { voices, frames, peakNotes };
}

/** Collect the events and fold them into a schedule. */
export function buildSchedule(
  song: SongModel,
  options: ScheduleOptions,
): { schedule: Schedule; warnings: LayoutWarning[] } {
  const { events, warnings } = collectEvents(song, options);
  const { voices, frames, peakNotes } = encodeFrames(events);
  return { schedule: { events, voices, frames, peakNotes }, warnings };
}
