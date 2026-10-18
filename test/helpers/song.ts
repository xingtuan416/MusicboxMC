import type { NoteEvent, SongModel, TrackModel } from '../../src/core/midi/types';

/**
 * SongModel builders for tests.
 *
 * Ten test files used to hand-write their own SongModel / TrackModel / NoteEvent
 * literals, all nearly identical, so changing the model meant ten edits. It lives here
 * once, and each test describes only what it cares about: tracks, notes, instruments.
 *
 * Convention: `tick` is in game ticks (20 per second), matching the layout layer's
 * time base. Duration and velocity are fixed at 0.1s / 1.0 because the generator uses
 * neither.
 */

export const TEST_TPS = 20;

export interface NoteSpec {
  /** Trigger time, in game ticks. */
  tick: number;
  midi: number;
}

export interface TrackSpec {
  notes: NoteSpec[];
  instrument?: string;
  /** General MIDI program number, when the test wants GM-first detection. */
  program?: number;
  percussion?: boolean;
  name?: string;
  /** Override the track index; defaults to the array position. */
  index?: number;
}

export interface SongSpec {
  tracks: TrackSpec[];
  name?: string;
  durationSec?: number;
}

/** Expand the shorthand into full note events. */
function toEvents(notes: NoteSpec[], channel: number): NoteEvent[] {
  return notes.map((note) => ({
    midi: note.midi,
    timeSec: note.tick / TEST_TPS,
    durationSec: 0.1,
    velocity: 1,
    channel,
  }));
}

/** Full form: notes, instrument and percussion flag per track. */
export function buildSong(spec: SongSpec): SongModel {
  return {
    name: spec.name ?? 'test-song',
    ppq: 480,
    durationSec: spec.durationSec ?? 8,
    baseBpm: 120,
    tempos: [{ ticks: 0, timeSec: 0, bpm: 120 }],
    timeSignature: null,
    tracks: spec.tracks.map((track, position): TrackModel => {
      const index = track.index ?? position;
      const channel = track.percussion ? 9 : index;
      return {
        index,
        name: track.name ?? `track-${index}`,
        channel,
        program: track.program,
        instrument: track.instrument ?? 'acoustic grand piano',
        percussion: track.percussion ?? false,
        notes: toEvents(track.notes, channel),
      };
    }),
  };
}

/** The common case: a single piano track. */
export function song(notes: NoteSpec[], overrides: Partial<SongSpec> = {}): SongModel {
  return buildSong({ ...overrides, tracks: [{ notes }] });
}

/** Several tracks, each given notes only, with no instrument information. */
export function songOfTracks(tracks: NoteSpec[][], overrides: Partial<SongSpec> = {}): SongModel {
  return buildSong({ ...overrides, tracks: tracks.map((notes) => ({ notes })) });
}

/** Several tracks, each with its own instrument and percussion flag. */
export function songOfSpecs(tracks: TrackSpec[], overrides: Partial<SongSpec> = {}): SongModel {
  return buildSong({ ...overrides, tracks });
}

export interface DenseSongOptions {
  /** Number of tracks; defaults to 12. */
  tracks?: number;
  durationSec?: number;
  /** Total notes in the song; defaults to 40000. */
  notes?: number;
  /** Pitch span in semitones; defaults to 48. */
  pitchSpan?: number;
  /** Lowest MIDI pitch used; defaults to 36. */
  baseMidi?: number;
  /** Number of burst chords; defaults to 200. */
  bursts?: number;
  /** Notes per burst chord; defaults to 60. */
  burstSize?: number;
}

/**
 * A dense fixture: many tracks, a long duration, tens of thousands of notes and a lot
 * of simultaneous chords.
 *
 * What the generator actually struggles with is a dense score where notes greatly
 * outnumber moments, not any particular song. The defining feature is the **burst
 * chord** - dozens of notes landing on one game tick - because it drives chord
 * capacity, branch depth and command playback peak pressure. This synthesises an
 * input of comparable scale deterministically, so the tests **depend on no external
 * MIDI file** and run the same on anyone's machine and in CI. A test that depends on
 * a local file skips silently, which means the author runs more tests than a
 * contributor does.
 */
export function denseSong(options: DenseSongOptions = {}): SongModel {
  const trackCount = options.tracks ?? 12;
  const durationSec = options.durationSec ?? 140;
  const noteCount = options.notes ?? 40000;
  const pitchSpan = options.pitchSpan ?? 48;
  const baseMidi = options.baseMidi ?? 36;
  const bursts = options.bursts ?? 200;
  const burstSize = options.burstSize ?? 60;

  const totalTicks = durationSec * TEST_TPS;
  const burstNotes = Math.min(noteCount, bursts * burstSize);
  const spreadNotes = noteCount - burstNotes;

  const tracks: TrackSpec[] = Array.from({ length: trackCount }, () => ({ notes: [] }));
  let placed = 0;
  const push = (tick: number, midi: number): void => {
    tracks[placed % trackCount]!.notes.push({ tick, midi });
    placed += 1;
  };

  // Burst chords, spread evenly through the song, standing in for the simultaneous
  // note clusters of a dense passage.
  for (let b = 0; b < bursts && placed < burstNotes; b++) {
    const tick = Math.floor(((b + 0.5) * totalTicks) / bursts);
    for (let k = 0; k < burstSize && placed < burstNotes; k++) {
      push(tick, baseMidi + ((b * 13 + k) % pitchSpan));
    }
  }

  // Spread the rest evenly so the song has content throughout rather than a few spikes.
  for (let i = 0; i < spreadNotes; i++) {
    push(Math.floor((i * totalTicks) / spreadNotes), baseMidi + ((i * 7) % pitchSpan));
  }

  return buildSong({ name: 'dense-fixture', durationSec, tracks });
}
