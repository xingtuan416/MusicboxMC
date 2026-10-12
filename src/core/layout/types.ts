export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlacedNote {
  /** Note block position. */
  notePos: Vec3;
  /** Base block position, directly under the note block. */
  blockPos: Vec3;
  /** Note block pitch value, 0-24. */
  note: number;
  /** Base block id, which is what selects the instrument. */
  block: string;
  /** Cells from the tap point to this note block, excluding the start and including the end. */
  path: Vec3[];
}

/**
 * One tap point on the main line: a group of notes that fires on the same redstone tick.
 *
 * `x` is the cell the branch column sits on, `t` the redstone tick at which the main
 * line reaches it.
 */
export interface Tap {
  /** X of the branch column. */
  x: number;
  /** Redstone tick at which the main line reaches this tap point. */
  t: number;
  notes: PlacedNote[];
}

export interface BlockPlacement {
  pos: Vec3;
  /** Block id. */
  block: string;
  props?: Record<string, string>;
}

export interface TrackSkeleton {
  trackIndex: number;
  zBase: number;
  placements: BlockPlacement[];
  taps: Tap[];
}

export type LayoutWarning =
  | { code: 'COMMAND_PLAYBACK_REQUIREMENTS'; chainLength: number; budget: number }
  | { code: 'COMMAND_SOUND_PRESSURE'; peakNotes: number }
  /**
   * The command player holds more blocks than the safe reference count, so pasting
   * and loading it become noticeably slow.
   *
   * A healthy structure grows with frames, voices and reusable slots only - never
   * with the note count. The per-note compiler this project replaced emitted one
   * command block per note (46291 notes -> 46308 blocks); this warning exists to
   * catch that class of regression.
   */
  | { code: 'COMMAND_STRUCTURE_SIZE'; commandBlocks: number; limit: number }
  | { code: 'POLYPHONY_EXCEEDED'; tick: number; n: number; limit: number }
  /**
   * The whole circuit fires one redstone tick after song time zero, because the group
   * at redstone tick 0 still needs a repeater to drive it. Relative timing is unchanged.
   *
   * Reported **once for the song**. Reporting it per track made a by-design, song-wide
   * shift read as one timing problem per track, with no note to point at.
   */
  | { code: 'STARTUP_LEAD_IN'; ticks: number }
  /** `trackIndex` and `tick` are what let the interface say which note is meant. */
  | { code: 'OUT_OF_RANGE'; midi: number; action: string; trackIndex: number; tick: number }
  /** `x` and `z` are the cell the note block was placed at, so the view can point at it. */
  | {
      code: 'TIMING_ADJUSTED';
      tick: number;
      actual: number;
      trackIndex: number;
      x: number;
      z: number;
    }
  /** A dense group did not fit and was re-emitted on a new track. */
  | { code: 'TRACK_SPLIT'; tick: number; notes: number }
  /** Song-wide startup compensation in game ticks; music-relative timing is unchanged. */
  | { code: 'FORCE_MERGE_LEAD_IN'; ticks: number; peakNotes: number; sectionCapacity: number }
  /** One chord's bus was extended with renewed power, not split into playback tracks. */
  | { code: 'FANOUT_EXPANDED'; tick: number; n: number; limit: number; stages: number }
  /** This group could not be padded with dust to reach the shared X reference line.
   *  Reports the residual drift in cells; no timing is altered and no note is dropped. */
  | { code: 'SPATIAL_DRIFT'; tick: number; drift: number };

export interface LayoutResult {
  tracks: TrackSkeleton[];
  size: Vec3;
  /** Minimum x/y/z over the whole layout, used to translate into litematic local space. */
  min: Vec3;
  totalTicks: number;
  /** Uniform startup latency in game ticks for the opt-in forced layout. */
  startupDelayTicks?: number;
  warnings: LayoutWarning[];
  /** Intended and actual trigger tick of every placed group, in track order. */
  placed: Array<{ trackIndex: number; zBase: number; tick: number; actual: number }>;
}

export interface LayoutConfig {
  baseTps: number;
  /**
   * Circuit layer: redstone dust, repeaters and note blocks all live here.
   *
   * There is only one layer because a note block **must have air directly above it**
   * to sound, so dust cannot sit on top of a note block and has to be adjacent on the
   * same layer instead.
   */
  circuitY: number;
  /** Floor layer, directly under the circuit layer, so dust does not pop off. */
  floorY: number;
  /** How many rows a branch column may extend to one side; total chord capacity is 2*dMax + 1. */
  dMax: number;
  trackPitch: number | 'auto';
}
