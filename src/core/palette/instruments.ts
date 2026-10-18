/**
 * The sixteen classic note-block instruments.
 *
 * A pitched instrument spans 25 note values (0-24) starting at its own F# anchor.
 * basedrum, snare and hat are fixed-pitch percussion: their note value does not change
 * the sample, so they have no range and every note is written at 0.
 *
 * Minecraft has no piano instrument. The harp sample (dirt and most other blocks) is
 * the closest thing, and it is what tutorials usually call "piano"; this project keeps
 * that wording only for the five-slot piano extension, never for a vanilla instrument.
 */

export type NoteBlockInstrument =
  | 'harp'
  | 'bass'
  | 'basedrum'
  | 'snare'
  | 'hat'
  | 'guitar'
  | 'flute'
  | 'bell'
  | 'chime'
  | 'xylophone'
  | 'iron_xylophone'
  | 'cow_bell'
  | 'didgeridoo'
  | 'bit'
  | 'banjo'
  | 'pling';

export interface InstrumentDef {
  /** Block directly under the note block, which selects the sample. */
  baseBlock: string;
  /** MIDI pitch at note 0; null for fixed-pitch percussion. */
  anchorMidi: number | null;
  /** Inclusive MIDI range; null for fixed-pitch percussion. */
  range: readonly [number, number] | null;
  /** Java sound event used by the command backend. */
  soundEvent: string;
}

/**
 * Anchor and base block for every instrument.
 *
 * Sources: Minecraft Wiki "Note Block" instrument table. The anchors are the F#
 * each instrument starts at, so a range is always `anchor..anchor + 24`.
 */
export const INSTRUMENTS: Record<NoteBlockInstrument, InstrumentDef> = {
  harp: {
    baseBlock: 'minecraft:dirt',
    anchorMidi: 54,
    range: [54, 78],
    soundEvent: 'block.note_block.harp',
  },
  bass: {
    baseBlock: 'minecraft:oak_planks',
    anchorMidi: 30,
    range: [30, 54],
    soundEvent: 'block.note_block.bass',
  },
  basedrum: {
    baseBlock: 'minecraft:stone',
    anchorMidi: null,
    range: null,
    soundEvent: 'block.note_block.basedrum',
  },
  snare: {
    baseBlock: 'minecraft:sand',
    anchorMidi: null,
    range: null,
    soundEvent: 'block.note_block.snare',
  },
  hat: {
    baseBlock: 'minecraft:glass',
    anchorMidi: null,
    range: null,
    soundEvent: 'block.note_block.hat',
  },
  guitar: {
    baseBlock: 'minecraft:white_wool',
    anchorMidi: 42,
    range: [42, 66],
    soundEvent: 'block.note_block.guitar',
  },
  flute: {
    baseBlock: 'minecraft:clay',
    anchorMidi: 66,
    range: [66, 90],
    soundEvent: 'block.note_block.flute',
  },
  bell: {
    baseBlock: 'minecraft:gold_block',
    anchorMidi: 78,
    range: [78, 102],
    soundEvent: 'block.note_block.bell',
  },
  chime: {
    baseBlock: 'minecraft:packed_ice',
    anchorMidi: 78,
    range: [78, 102],
    soundEvent: 'block.note_block.chime',
  },
  xylophone: {
    baseBlock: 'minecraft:bone_block',
    anchorMidi: 78,
    range: [78, 102],
    soundEvent: 'block.note_block.xylophone',
  },
  iron_xylophone: {
    baseBlock: 'minecraft:iron_block',
    anchorMidi: 54,
    range: [54, 78],
    soundEvent: 'block.note_block.iron_xylophone',
  },
  cow_bell: {
    baseBlock: 'minecraft:soul_sand',
    anchorMidi: 66,
    range: [66, 90],
    soundEvent: 'block.note_block.cow_bell',
  },
  didgeridoo: {
    baseBlock: 'minecraft:pumpkin',
    anchorMidi: 30,
    range: [30, 54],
    soundEvent: 'block.note_block.didgeridoo',
  },
  bit: {
    baseBlock: 'minecraft:emerald_block',
    anchorMidi: 54,
    range: [54, 78],
    soundEvent: 'block.note_block.bit',
  },
  banjo: {
    baseBlock: 'minecraft:hay_block',
    anchorMidi: 54,
    range: [54, 78],
    soundEvent: 'block.note_block.banjo',
  },
  pling: {
    baseBlock: 'minecraft:glowstone',
    anchorMidi: 54,
    range: [54, 78],
    soundEvent: 'block.note_block.pling',
  },
};

/** Instruments whose note value changes the pitch. */
export const PITCHED_INSTRUMENTS: readonly NoteBlockInstrument[] = [
  'harp',
  'bass',
  'guitar',
  'flute',
  'bell',
  'chime',
  'xylophone',
  'iron_xylophone',
  'cow_bell',
  'didgeridoo',
  'bit',
  'banjo',
  'pling',
];

/** Fixed-pitch percussion; their note value is ignored by the game. */
export const DRUM_INSTRUMENTS: readonly NoteBlockInstrument[] = ['basedrum', 'snare', 'hat'];

/**
 * The five slots the piano extension occupies.
 *
 * In extended mode these instruments are reserved for the five-slot piano range, so a
 * track that natively uses one of them is substituted with a similar free instrument.
 */
export const PIANO_SLOTS: readonly NoteBlockInstrument[] = ['bass', 'guitar', 'harp', 'flute', 'bell'];

/** Inclusive MIDI range for a pitched instrument, or null for a drum. */
export function instrumentRange(id: NoteBlockInstrument): readonly [number, number] | null {
  return INSTRUMENTS[id].range;
}

export function isDrumInstrument(id: NoteBlockInstrument): boolean {
  return INSTRUMENTS[id].range === null;
}

/** The Java sound event for an instrument. */
export function instrumentSoundEvent(id: NoteBlockInstrument): string {
  return INSTRUMENTS[id].soundEvent;
}
