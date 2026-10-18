import { describe, expect, it } from 'vitest';
import {
  DRUM_INSTRUMENTS,
  INSTRUMENTS,
  PIANO_SLOTS,
  PITCHED_INSTRUMENTS,
  instrumentRange,
  isDrumInstrument,
} from '../src/core/palette/instruments';
import {
  GM_INSTRUMENTS,
  detectTrack,
  drumInstrument,
  gmInstrument,
  instrumentFromName,
} from '../src/core/palette/instrumentMap';
import { buildSong } from './helpers/song';

/**
 * The sixteen classic note-block instruments and the rules that pick one.
 *
 * Getting an anchor or a base block wrong is silent: the schematic still builds and
 * still plays, just with the wrong timbre or an octave in the wrong place.
 */

describe('note-block instrument table', () => {
  it('defines the sixteen classic instruments, thirteen pitched and three drums', () => {
    expect(Object.keys(INSTRUMENTS)).toHaveLength(16);
    expect(PITCHED_INSTRUMENTS).toHaveLength(13);
    expect(DRUM_INSTRUMENTS).toHaveLength(3);
    expect(PIANO_SLOTS).toEqual(['bass', 'guitar', 'harp', 'flute', 'bell']);
  });

  it('gives every pitched instrument exactly two octaves above its F# anchor', () => {
    for (const id of PITCHED_INSTRUMENTS) {
      const def = INSTRUMENTS[id];
      expect(def.anchorMidi, id).not.toBeNull();
      expect(def.range, id).toEqual([def.anchorMidi, def.anchorMidi! + 24]);
      expect(isDrumInstrument(id), id).toBe(false);
      expect(instrumentRange(id), id).toEqual(def.range);
    }
  });

  it('leaves the fixed-pitch drums without a range', () => {
    for (const id of DRUM_INSTRUMENTS) {
      expect(isDrumInstrument(id), id).toBe(true);
      expect(instrumentRange(id), id).toBeNull();
      expect(INSTRUMENTS[id].soundEvent, id).toBe(`block.note_block.${id}`);
    }
  });

  it('uses a distinct, namespaced base block per instrument', () => {
    const blocks = Object.values(INSTRUMENTS).map((def) => def.baseBlock);
    expect(new Set(blocks).size).toBe(16);
    for (const block of blocks) expect(block.startsWith('minecraft:')).toBe(true);
  });
});

describe('General MIDI mapping', () => {
  it('covers every program number exactly once', () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
    for (const instrument of GM_INSTRUMENTS) expect(INSTRUMENTS[instrument]).toBeDefined();
  });

  it("maps the programs this project's 16-track fixture uses", () => {
    const expected: Array<[number, string]> = [
      [0, 'harp'],
      [9, 'chime'],
      [10, 'pling'],
      [11, 'iron_xylophone'],
      [13, 'xylophone'],
      [14, 'bell'],
      [25, 'guitar'],
      [33, 'bass'],
      [58, 'didgeridoo'],
      [73, 'flute'],
      [80, 'bit'],
      [105, 'banjo'],
    ];
    for (const [program, instrument] of expected) {
      expect(gmInstrument(program), `program ${program}`).toBe(instrument);
    }
    expect(gmInstrument(128)).toBeNull();
    expect(gmInstrument(undefined)).toBeNull();
  });
});

describe('track-name aliases', () => {
  it('matches the longest, most specific alias first', () => {
    expect(instrumentFromName('Bass Drum - Stone')).toBe('basedrum');
    expect(instrumentFromName('Iron Xylophone - Iron Block')).toBe('iron_xylophone');
    expect(instrumentFromName('Cow Bell - Soul Sand')).toBe('cow_bell');
    expect(instrumentFromName('Click - Glass')).toBe('hat');
    expect(instrumentFromName('Harp - Dirt')).toBe('harp');
    expect(instrumentFromName('Music Box')).toBe('pling');
    expect(instrumentFromName('Tubular Bells')).toBe('bell');
  });

  it('matches on word boundaries, so a longer word does not hit a shorter alias', () => {
    expect(instrumentFromName('Contrabass')).toBe('didgeridoo');
    expect(instrumentFromName('Harpsichord')).toBe('harp');
    expect(instrumentFromName('主旋律')).toBeNull();
  });

  it('understands the Chinese names the interface uses', () => {
    expect(instrumentFromName('电钢琴')).toBe('pling');
    expect(instrumentFromName('铁木琴')).toBe('iron_xylophone');
    expect(instrumentFromName('牛铃')).toBe('cow_bell');
    expect(instrumentFromName('低音提琴')).toBe('didgeridoo');
  });
});

describe('channel-9 drum mapping', () => {
  it('maps the standard kick, snare and hi-hat notes', () => {
    expect(drumInstrument(35)).toBe('basedrum');
    expect(drumInstrument(36)).toBe('basedrum');
    expect(drumInstrument(38)).toBe('snare');
    expect(drumInstrument(40)).toBe('snare');
    expect(drumInstrument(42)).toBe('hat');
    expect(drumInstrument(44)).toBe('hat');
    expect(drumInstrument(46)).toBe('hat');
  });

  it('falls back to the track name for a pitched cow bell', () => {
    expect(drumInstrument(56, 'Cow Bell - Soul Sand')).toBe('cow_bell');
    expect(drumInstrument(56, 'Drums')).toBeNull();
  });
});

describe('per-track detection priority', () => {
  it('prefers the GM program over a misleading track name', () => {
    const song = buildSong({
      tracks: [{ notes: [{ tick: 0, midi: 60 }], name: 'Chime - Packed Ice', program: 0 }],
    });
    expect(detectTrack(song.tracks[0]!)).toMatchObject({ native: 'harp', source: 'gm' });
  });

  it('uses the track name when the GM program is missing', () => {
    const song = buildSong({
      tracks: [{ notes: [{ tick: 0, midi: 60 }], name: 'Chime - Packed Ice' }],
    });
    expect(detectTrack(song.tracks[0]!)).toMatchObject({ native: 'chime', source: 'name' });
  });

  it('falls back to harp when neither source says anything', () => {
    const song = buildSong({ tracks: [{ notes: [{ tick: 0, midi: 60 }], name: 'Main melody' }] });
    expect(detectTrack(song.tracks[0]!)).toMatchObject({ native: 'harp', source: 'fallback' });
  });

  it('treats channel 9 as mixed percussion even when its GM program is a piano', () => {
    const song = buildSong({
      tracks: [
        {
          notes: [{ tick: 0, midi: 36 }],
          name: 'Drums',
          program: 0,
          percussion: true,
        },
      ],
    });
    expect(detectTrack(song.tracks[0]!)).toMatchObject({ native: 'drums', source: 'drum' });
  });
});
