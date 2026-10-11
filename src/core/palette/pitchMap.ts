export type PitchRegion = 'A' | 'B' | 'C' | 'D' | 'E';
export type OutOfRangePolicy = 'warn' | 'clamp' | 'octave' | 'drop';

export interface RegionDef {
  /** Base block id (determines the instrument/timbre) */
  baseBlock: string;
  /** The MIDI pitch this pitch region sounds at when note = 0 */
  baseMidi: number;
  /** The instrument event to write into the note block blockstate. */
  instrument: NoteBlockInstrument;
}

export type RegionTable = Record<PitchRegion, RegionDef>;

/**
 * Instrument events of the Minecraft Java note block.
 *
 * These events each have a different pitch range; this project uses the five
 * slots bass / guitar / harp / flute / bell to assemble F#1–F#7.
 */
export type NoteBlockInstrument = 'bass' | 'guitar' | 'harp' | 'flute' | 'bell';

export interface MappedPitch {
  /** Whether it was dropped (may be true when outOfRange = 'drop') */
  dropped: boolean;
  midi: number;
  /** Note block note 0-24 */
  note: number;
  region: PitchRegion;
  /** Base block */
  block: string;
  /** The instrument value in the note block blockstate. */
  instrument: NoteBlockInstrument;
  /** Whether it was degraded for exceeding the pitch range */
  degraded: boolean;
}

/** Semitone span of one pitch region: note 0..24 is 25 steps across 24 semitones. */
export const REGION_SEMITONES = 24;

/**
 * The five sample slots are arranged by the vanilla note block's F# anchors:
 * - A: planks → bass, starting at F#1 (MIDI 30)
 * - B: wool → guitar, starting at F#2 (MIDI 42)
 * - C: normal block → harp/piano, starting at F#3 (MIDI 54)
 * - D: clay → flute, starting at F#4 (MIDI 66)
 * - E: gold block → bell, starting at F#5 (MIDI 78)
 *
 * This arrangement corresponds exactly to harp1..harp5 in the resource pack. The
 * previous dirt / grass_block / bedrock would wrongly drop low and high notes onto
 * harp or basedrum, using neither guitar/flute and never yielding a continuous
 * piano timbre.
 */
export const DEFAULT_REGIONS: RegionTable = {
  A: { baseBlock: 'minecraft:oak_planks', baseMidi: 30, instrument: 'bass' },
  B: { baseBlock: 'minecraft:white_wool', baseMidi: 42, instrument: 'guitar' },
  C: { baseBlock: 'minecraft:dirt', baseMidi: 54, instrument: 'harp' },
  D: { baseBlock: 'minecraft:clay', baseMidi: 66, instrument: 'flute' },
  E: { baseBlock: 'minecraft:gold_block', baseMidi: 78, instrument: 'bell' },
};

/** Stable low-to-high tie order; the actual choice uses distance to the sample center. */
const REGION_PRIORITY: PitchRegion[] = ['A', 'B', 'C', 'D', 'E'];

/** Covered MIDI pitch range (endpoints inclusive). */
export function coveredRange(regions: RegionTable): [number, number] {
  const lows = (Object.keys(regions) as PitchRegion[]).map((k) => regions[k].baseMidi);
  return [Math.min(...lows), Math.max(...lows) + REGION_SEMITONES];
}

/**
 * MIDI pitch → (note, pitch region, base block).
 *
 * note=12 of each sample is its original recorded pitch (F#2..F#6). When several
 * pitch regions overlap, the region closest to note=12 is chosen, to minimize the
 * resource pack's pitch-shift distortion; on a tie the higher region is chosen, so
 * boundaries connect upward stably.
 */
export function mapPitch(
  midi: number,
  regions: RegionTable = DEFAULT_REGIONS,
  policy: OutOfRangePolicy = 'warn',
  transpose = 0,
): MappedPitch {
  const p = midi + 12 * transpose;

  const selected = selectRegion(p, regions);
  if (selected) {
    const def = regions[selected.region];
    return {
      dropped: false,
      midi,
      note: selected.note,
      region: selected.region,
      block: def.baseBlock,
      instrument: def.instrument,
      degraded: false,
    };
  }

  return applyOutOfRange(p, midi, regions, policy);
}

function applyOutOfRange(
  p: number,
  midi: number,
  regions: RegionTable,
  policy: OutOfRangePolicy,
): MappedPitch {
  const [low, high] = coveredRange(regions);
  const pick = (pp: number): MappedPitch => {
    const selected = selectRegion(pp, regions);
    if (selected) {
      const def = regions[selected.region];
      return {
        dropped: false,
        midi,
        note: selected.note,
        region: selected.region,
        block: def.baseBlock,
        instrument: def.instrument,
        degraded: true,
      };
    }
    // Theoretically unreachable
    return {
      dropped: true,
      midi,
      note: 0,
      region: 'C',
      block: regions.C.baseBlock,
      instrument: regions.C.instrument,
      degraded: true,
    };
  };

  if (policy === 'drop') {
    return {
      dropped: true,
      midi,
      note: 0,
      region: 'C',
      block: regions.C.baseBlock,
      instrument: regions.C.instrument,
      degraded: true,
    };
  }
  if (policy === 'clamp') {
    return pick(p < low ? low : high);
  }
  // Both 'warn' and 'octave' shift back into the usable pitch range by whole octaves;
  // they differ only in whether the caller notifies the user
  const octaves = Math.ceil((low - p) / 12);
  let shifted = p + 12 * octaves;
  if (shifted > high) shifted -= 12;
  return pick(shifted);
}

function selectRegion(midi: number, regions: RegionTable): { region: PitchRegion; note: number } | null {
  let best: { region: PitchRegion; note: number; distance: number } | null = null;
  for (const region of REGION_PRIORITY) {
    const def = regions[region];
    const note = midi - def.baseMidi;
    if (note < 0 || note > REGION_SEMITONES) continue;
    const distance = Math.abs(note - 12);
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && def.baseMidi > regions[best.region].baseMidi)
    ) {
      best = { region, note, distance };
    }
  }
  return best ? { region: best.region, note: best.note } : null;
}
