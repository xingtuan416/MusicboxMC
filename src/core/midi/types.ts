/** A single normalized note event (times already converted to seconds, straight from MIDI). */
export interface NoteEvent {
  /** MIDI pitch 0-127 */
  midi: number;
  /** Start time (seconds) */
  timeSec: number;
  /** Duration (seconds) */
  durationSec: number;
  /** Velocity 0-1 */
  velocity: number;
  /** MIDI channel; 9/10 is percussion */
  channel: number;
}

export interface TempoSegment {
  /** Start tick of this segment (in file PPQ units) */
  ticks: number;
  /** Start time of this segment (seconds) */
  timeSec: number;
  /** BPM */
  bpm: number;
}

export interface TrackModel {
  index: number;
  name: string;
  channel: number;
  instrument: string;
  percussion: boolean;
  notes: NoteEvent[];
}

export interface SongModel {
  name: string;
  /** File PPQ (pulses per quarter note) */
  ppq: number;
  /** Total duration (seconds), up to the end of the last note */
  durationSec: number;
  /** Base BPM: taken from the first tempo event in the file */
  baseBpm: number;
  tempos: TempoSegment[];
  timeSignature: [number, number] | null;
  tracks: TrackModel[];
}
