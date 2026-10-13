import { coreError } from '../errors';

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

/**
 * The sample slots a generation may use.
 *
 * Partial on purpose: the single-instrument palette exposes exactly one slot, so
 * every lookup below has to cope with a slot being absent.
 */
export type RegionTable = Readonly<Partial<Record<PitchRegion, RegionDef>>>;

/**
 * Instrument events of the Minecraft Java note block.
 *
 * These events each have a different pitch range; this project can use the five
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
 * This arrangement corresponds exactly to harp1..harp5 in the companion resource
 * pack. The previous dirt / grass_block / bedrock would wrongly drop low and high
 * notes onto harp or basedrum, using neither guitar/flute and never yielding a
 * continuous piano timbre.
 */
export const DEFAULT_REGIONS: RegionTable = {
  A: { baseBlock: 'minecraft:oak_planks', baseMidi: 30, instrument: 'bass' },
  B: { baseBlock: 'minecraft:white_wool', baseMidi: 42, instrument: 'guitar' },
  C: { baseBlock: 'minecraft:dirt', baseMidi: 54, instrument: 'harp' },
  D: { baseBlock: 'minecraft:clay', baseMidi: 66, instrument: 'flute' },
  E: { baseBlock: 'minecraft:gold_block', baseMidi: 78, instrument: 'bell' },
};

/**
 * How much of the note-block range a generation may use.
 *
 * One note block covers two octaves on its own. `full` spreads notes across all five
 * note-block instruments to reach F#1–F#7. All five are vanilla instruments, so this
 * plays correctly with no resource pack at all — but they sound different from one
 * another, and the companion resource pack exists to replace those five events with
 * piano samples so the whole range sounds like a single piano.
 *
 * `piano` uses the harp slot alone. It never needs a resource pack, at the cost of
 * everything outside F#3–F#5, which then falls to the out-of-range policy.
 */
export type PitchPalette = 'full' | 'piano';

/** The harp slot on its own: F#3–F#5, one instrument, no resource pack. */
export const PIANO_REGIONS: RegionTable = {
  C: { baseBlock: 'minecraft:dirt', baseMidi: 54, instrument: 'harp' },
};

export function regionsFor(palette: PitchPalette): RegionTable {
  return palette === 'piano' ? PIANO_REGIONS : DEFAULT_REGIONS;
}

/** Stable low-to-high tie order; the actual choice uses distance to the sample center. */
const REGION_PRIORITY: PitchRegion[] = ['A', 'B', 'C', 'D', 'E'];

/** Every slot the table actually defines, in low-to-high order. */
function slots(regions: RegionTable): Array<{ region: PitchRegion; def: RegionDef }> {
  const present = REGION_PRIORITY.flatMap((region) => {
    const def = regions[region];
    return def ? [{ region, def }] : [];
  });
  if (present.length === 0) throw coreError('PALETTE_EMPTY');
  return present;
}

/** Covered MIDI pitch range (endpoints inclusive). */
export function coveredRange(regions: RegionTable): [number, number] {
  const lows = slots(regions).map((slot) => slot.def.baseMidi);
  return [Math.min(...lows), Math.max(...lows) + REGION_SEMITONES];
}

/** The lowest slot in the table; used only where a note does not fit anywhere. */
function lowestSlot(regions: RegionTable): { region: PitchRegion; def: RegionDef } {
  return slots(regions).reduce((low, slot) => (slot.def.baseMidi < low.def.baseMidi ? slot : low));
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
    return {
      dropped: false,
      midi,
      note: selected.note,
      region: selected.region,
      block: selected.def.baseBlock,
      instrument: selected.def.instrument,
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
    const slot = selected ?? lowestSlot(regions);
    return {
      dropped: false,
      midi,
      note: selected ? selected.note : 0,
      region: slot.region,
      block: slot.def.baseBlock,
      instrument: slot.def.instrument,
      degraded: true,
    };
  };

  if (policy === 'drop') {
    // A dropped note is never placed, so its block and instrument exist only to keep
    // the shape total. Prefer the harp slot, which every palette defines.
    const harp = regions.C;
    const slot = harp ? { region: 'C' as PitchRegion, def: harp } : lowestSlot(regions);
    return {
      dropped: true,
      midi,
      note: 0,
      region: slot.region,
      block: slot.def.baseBlock,
      instrument: slot.def.instrument,
      degraded: true,
    };
  }
  if (policy === 'clamp') {
    return pick(p < low ? low : high);
  }
  // Both 'warn' and 'octave' shift back into the usable range by whole octaves; they
  // differ only in whether the caller notifies the user.
  return pick(shiftIntoRange(p, regions, low, high));
}

/**
 * Move a pitch into the covered range by the **fewest whole octaves** that suffice.
 *
 * The previous formula anchored on the low end and folded anything above the range all
 * the way down to the bottom, so MIDI 103 - one semitone above the top - came back as
 * MIDI 31, 72 semitones lower and four instrument slots away, when dropping a single
 * octave to 91 was available. Low notes happened to land on the nearest octave, which is
 * why the asymmetry went unnoticed. A note above the range now moves down only as far as
 * it must, and one below moves up only as far as it must.
 *
 * A palette may have holes between its slots, so if the nearest octave is still not
 * covered the search steps outward until it reaches one.
 */
function shiftIntoRange(p: number, regions: RegionTable, low: number, high: number): number {
  if (p >= low && p <= high) return p;

  const nearest = p < low ? p + 12 * Math.ceil((low - p) / 12) : p - 12 * Math.ceil((p - high) / 12);
  if (selectRegion(nearest, regions)) return nearest;

  const MAX_OCTAVE_SEARCH = 10;
  for (let step = 1; step <= MAX_OCTAVE_SEARCH; step++) {
    const up = nearest + 12 * step;
    if (selectRegion(up, regions)) return up;
    const down = nearest - 12 * step;
    if (selectRegion(down, regions)) return down;
  }
  return nearest;
}

function selectRegion(
  midi: number,
  regions: RegionTable,
): { region: PitchRegion; def: RegionDef; note: number } | null {
  let best: { region: PitchRegion; def: RegionDef; note: number; distance: number } | null = null;
  for (const region of REGION_PRIORITY) {
    const def = regions[region];
    if (!def) continue;
    const note = midi - def.baseMidi;
    if (note < 0 || note > REGION_SEMITONES) continue;
    const distance = Math.abs(note - 12);
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && def.baseMidi > best.def.baseMidi)
    ) {
      best = { region, def, note, distance };
    }
  }
  return best ? { region: best.region, def: best.def, note: best.note } : null;
}
