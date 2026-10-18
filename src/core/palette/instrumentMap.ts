import type { TrackModel } from '../midi/types';
import type { NoteBlockInstrument } from './instruments';

/**
 * Mapping a MIDI track to one of the sixteen note-block instruments.
 *
 * The order matters, and it is the one the project owner asked for: the General MIDI
 * program is the most reliable signal, then the drum channel, then the track name,
 * then harp. Channel 9 is special-cased: its GM program is "standard kit", which is
 * not a melodic program, so the note number decides the drum first.
 */

/** One instrument per General MIDI program number (0-127). */
export const GM_INSTRUMENTS: readonly NoteBlockInstrument[] = [
  // 0-7: pianos
  'harp',
  'harp',
  'harp',
  'harp',
  'pling',
  'pling',
  'harp',
  'pling',
  // 8-15: chromatic percussion
  'chime',
  'chime',
  'pling',
  'iron_xylophone',
  'xylophone',
  'xylophone',
  'bell',
  'banjo',
  // 16-23: organs
  'harp',
  'harp',
  'bit',
  'harp',
  'harp',
  'bit',
  'bit',
  'bit',
  // 24-31: guitars
  'guitar',
  'guitar',
  'guitar',
  'pling',
  'guitar',
  'bit',
  'bit',
  'pling',
  // 32-39: basses
  'bass',
  'bass',
  'bass',
  'bass',
  'bass',
  'bass',
  'bass',
  'bass',
  // 40-47: strings
  'harp',
  'harp',
  'didgeridoo',
  'didgeridoo',
  'harp',
  'guitar',
  'harp',
  'basedrum',
  // 48-55: ensembles
  'harp',
  'harp',
  'harp',
  'harp',
  'harp',
  'harp',
  'harp',
  'basedrum',
  // 56-63: brass
  'bit',
  'didgeridoo',
  'didgeridoo',
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  // 64-71: reeds
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  'didgeridoo',
  'bit',
  // 72-79: pipes
  'flute',
  'flute',
  'flute',
  'flute',
  'flute',
  'flute',
  'flute',
  'flute',
  // 80-87: synth leads
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  'bit',
  // 88-95: synth pads
  'harp',
  'harp',
  'harp',
  'harp',
  'harp',
  'chime',
  'chime',
  'chime',
  // 96-103: synth effects
  'pling',
  'chime',
  'chime',
  'chime',
  'pling',
  'bit',
  'pling',
  'pling',
  // 104-111: ethnic
  'banjo',
  'banjo',
  'banjo',
  'banjo',
  'pling',
  'didgeridoo',
  'harp',
  'bit',
  // 112-119: percussive
  'bell',
  'cow_bell',
  'xylophone',
  'hat',
  'basedrum',
  'basedrum',
  'snare',
  'hat',
  // 120-127: sound effects
  'guitar',
  'flute',
  'harp',
  'flute',
  'bell',
  'didgeridoo',
  'snare',
  'basedrum',
];

export type DetectionSource = 'gm' | 'name' | 'drum' | 'fallback';

export interface TrackDetection {
  /** `drums` means the track is mixed percussion and is mapped note by note. */
  native: NoteBlockInstrument | 'drums';
  source: DetectionSource;
  program?: number;
}

/** The instrument a GM program maps to, or null when the number is not one. */
export function gmInstrument(program: number | undefined): NoteBlockInstrument | null {
  if (program === undefined || !Number.isInteger(program)) return null;
  return GM_INSTRUMENTS[program] ?? null;
}

interface NameAlias {
  alias: string;
  instrument: NoteBlockInstrument;
}

/**
 * Track-name aliases, most specific first.
 *
 * Longest-first is what keeps "Bass Drum" from becoming Bass and "Iron Xylophone"
 * from becoming Xylophone. English aliases match on word boundaries so "Contrabass"
 * does not hit "bass"; Chinese aliases match as substrings.
 */
const NAME_ALIASES: readonly NameAlias[] = (
  [
    ['bass drum', 'basedrum'],
    ['iron xylophone', 'iron_xylophone'],
    ['cow bell', 'cow_bell'],
    ['tubular bells', 'bell'],
    ['electric piano', 'pling'],
    ['reverse cymbal', 'hat'],
    ['steel drums', 'xylophone'],
    ['synth bass', 'bass'],
    ['synth drum', 'snare'],
    ['hi-hat', 'hat'],
    ['glockenspiel', 'chime'],
    ['harpsichord', 'harp'],
    ['vibraphone', 'iron_xylophone'],
    ['music box', 'pling'],
    ['bag pipe', 'didgeridoo'],
    ['bagpipe', 'didgeridoo'],
    ['contrabass', 'didgeridoo'],
    ['woodblock', 'hat'],
    ['e.piano', 'pling'],
    ['e. piano', 'pling'],
    ['basedrum', 'basedrum'],
    ['bassdrum', 'basedrum'],
    ['marimba', 'xylophone'],
    ['piccolo', 'flute'],
    ['recorder', 'flute'],
    ['harmonica', 'bit'],
    ['accordion', 'bit'],
    ['clarinet', 'bit'],
    ['trumpet', 'bit'],
    ['trombone', 'didgeridoo'],
    ['timpani', 'basedrum'],
    ['taiko', 'basedrum'],
    ['applause', 'snare'],
    ['gunshot', 'basedrum'],
    ['celesta', 'chime'],
    ['clavinet', 'pling'],
    ['dulcimer', 'banjo'],
    ['sitar', 'banjo'],
    ['shamisen', 'banjo'],
    ['koto', 'banjo'],
    ['fiddle', 'harp'],
    ['violin', 'harp'],
    ['viola', 'harp'],
    ['cello', 'didgeridoo'],
    ['tuba', 'didgeridoo'],
    ['bassoon', 'didgeridoo'],
    ['organ', 'harp'],
    ['choir', 'harp'],
    ['strings', 'harp'],
    ['piano', 'harp'],
    ['bells', 'bell'],
    ['bell', 'bell'],
    ['chime', 'chime'],
    ['xylophone', 'xylophone'],
    ['flute', 'flute'],
    ['guitar', 'guitar'],
    ['banjo', 'banjo'],
    ['didgeridoo', 'didgeridoo'],
    ['pling', 'pling'],
    ['click', 'hat'],
    ['hihat', 'hat'],
    ['snare', 'snare'],
    ['kick', 'basedrum'],
    ['bass', 'bass'],
    ['harp', 'harp'],
    ['bit', 'bit'],
    ['square', 'bit'],
    ['synth', 'bit'],
    ['hat', 'hat'],
    // Chinese aliases; longest first is handled by the same sort.
    ['低音提琴', 'didgeridoo'],
    ['迪吉里杜管', 'didgeridoo'],
    ['铁木琴', 'iron_xylophone'],
    ['颤音琴', 'iron_xylophone'],
    ['电钢琴', 'pling'],
    ['马林巴', 'xylophone'],
    ['西塔琴', 'banjo'],
    ['三味线', 'banjo'],
    ['钟琴', 'chime'],
    ['牛铃', 'cow_bell'],
    ['踩镲', 'hat'],
    ['军鼓', 'snare'],
    ['小鼓', 'snare'],
    ['底鼓', 'basedrum'],
    ['大鼓', 'basedrum'],
    ['贝斯', 'bass'],
    ['低音', 'bass'],
    ['长笛', 'flute'],
    ['短笛', 'flute'],
    ['竖笛', 'flute'],
    ['吉他', 'guitar'],
    ['班卓', 'banjo'],
    ['钢琴', 'harp'],
    ['竖琴', 'harp'],
    ['方波', 'bit'],
    ['合成', 'bit'],
    ['比特', 'bit'],
    ['木琴', 'xylophone'],
    ['铃', 'bell'],
    ['钟', 'bell'],
    ['镲', 'hat'],
    ['筝', 'banjo'],
  ] as Array<[string, NoteBlockInstrument]>
)
  .map(([alias, instrument]) => ({ alias, instrument }))
  .sort((a, b) => b.alias.length - a.alias.length);

const CJK = /[\u4e00-\u9fff]/;

function aliasMatches(name: string, alias: string): boolean {
  if (CJK.test(alias)) return name.includes(alias);
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(name);
}

/** Instrument named by a track title, or null when the title says nothing usable. */
export function instrumentFromName(name: string): NoteBlockInstrument | null {
  if (!name) return null;
  for (const { alias, instrument } of NAME_ALIASES) {
    if (aliasMatches(name, alias)) return instrument;
  }
  return null;
}

/**
 * General MIDI percussion notes that map cleanly onto the three fixed-pitch drums.
 *
 * 56 (cow bell) is deliberately absent: it is a pitched instrument, and a track that
 * actually plays it is normally titled "Cow Bell", which the name fallback catches.
 */
const DRUM_NOTES: Readonly<Record<number, NoteBlockInstrument>> = {
  35: 'basedrum',
  36: 'basedrum',
  38: 'snare',
  40: 'snare',
  42: 'hat',
  44: 'hat',
  46: 'hat',
};

/** The drum for a channel-9 note, with the track title as the last resort. */
export function drumInstrument(note: number, trackName = ''): NoteBlockInstrument | null {
  return DRUM_NOTES[note] ?? instrumentFromName(trackName);
}

/** Which instrument a track should natively play. */
export function detectTrack(track: TrackModel): TrackDetection {
  if (track.channel === 9) {
    return { native: 'drums', source: 'drum' };
  }
  const byProgram = gmInstrument(track.program);
  if (byProgram) {
    return { native: byProgram, source: 'gm', program: track.program };
  }
  const byName = instrumentFromName(track.name);
  if (byName) return { native: byName, source: 'name' };
  return { native: 'harp', source: 'fallback' };
}
