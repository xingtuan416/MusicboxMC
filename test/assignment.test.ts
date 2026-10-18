import { describe, expect, it } from 'vitest';
import { assignTrack, assignTracks, voicingMap } from '../src/core/palette/assignment';
import { buildSong } from './helpers/song';

/**
 * How a mode turns detection into a voicing.
 *
 * Native mode is the simple case. Extended mode is the interesting one: the five piano
 * slots are reserved, so a native bass/guitar/flute/bell track is substituted rather
 * than folded into the piano.
 */

const track = (overrides: Parameters<typeof buildSong>[0]['tracks'][number]) =>
  buildSong({ tracks: [overrides] }).tracks[0]!;

describe('native mode', () => {
  it('keeps every detected instrument', () => {
    expect(assignTrack(track({ notes: [], program: 33, name: 'Bass' }), 'native').voicing).toEqual({
      kind: 'instrument',
      instrument: 'bass',
    });
    expect(assignTrack(track({ notes: [], program: 9, name: 'Chime' }), 'native').voicing).toEqual({
      kind: 'instrument',
      instrument: 'chime',
    });
  });

  it('keeps channel-9 tracks as mixed percussion', () => {
    const assignment = assignTrack(track({ notes: [], percussion: true, name: 'Drums' }), 'native');
    expect(assignment).toMatchObject({
      native: 'drums',
      source: 'drum',
      voicing: { kind: 'drums' },
    });
  });
});

describe('extended mode', () => {
  it('sends harp and unidentified tracks to the five-slot piano range', () => {
    expect(assignTrack(track({ notes: [], program: 0, name: 'Piano' }), 'extended').voicing).toEqual({
      kind: 'pitch',
    });
    expect(assignTrack(track({ notes: [], name: 'Main melody' }), 'extended').voicing).toEqual({
      kind: 'pitch',
    });
  });

  it('substitutes the five occupied instruments with similar free timbres', () => {
    const cases: Array<[number, string, string]> = [
      [33, 'bass', 'didgeridoo'],
      [25, 'guitar', 'banjo'],
      [73, 'flute', 'bit'],
      [14, 'bell', 'chime'],
    ];
    for (const [program, native, effective] of cases) {
      const assignment = assignTrack(track({ notes: [], program, name: native }), 'extended');
      expect(assignment.native, native).toBe(native);
      expect(assignment.substituted, native).toBe(true);
      expect(assignment.voicing).toEqual({ kind: 'instrument', instrument: effective });
    }
  });

  it('leaves the other instruments alone', () => {
    for (const [program, instrument] of [
      [9, 'chime'],
      [13, 'xylophone'],
      [11, 'iron_xylophone'],
      [105, 'banjo'],
      [80, 'bit'],
      [10, 'pling'],
      [58, 'didgeridoo'],
    ] as Array<[number, string]>) {
      const assignment = assignTrack(track({ notes: [], program, name: instrument }), 'extended');
      expect(assignment.substituted, instrument).toBe(false);
      expect(assignment.voicing).toEqual({ kind: 'instrument', instrument });
    }
  });

  it('keeps channel-9 tracks as mixed percussion', () => {
    const assignment = assignTrack(track({ notes: [], percussion: true, name: 'Drum kit' }), 'extended');
    expect(assignment.voicing).toEqual({ kind: 'drums' });
  });
});

describe('voicing map', () => {
  it('is keyed by source track index', () => {
    const song = buildSong({
      tracks: [
        { notes: [], program: 0, name: 'Piano' },
        { notes: [], program: 33, name: 'Bass' },
      ],
    });
    const map = voicingMap(assignTracks(song, 'extended'));
    expect(map[0]).toEqual({ kind: 'pitch' });
    expect(map[1]).toEqual({ kind: 'instrument', instrument: 'didgeridoo' });
  });
});
