import { describe, expect, it } from 'vitest';
import { analyze } from '../src/main/analyze';
import {
  buildLaneOrder,
  classifySong,
  decideMerge,
  smartModeFor,
  SMART_RADIUS,
} from '../src/main/smartSelection';
import type { TrackAssignment } from '../src/core/palette/assignment';
import { songOfSpecs } from './helpers/song';

function assignment(index: number, native: TrackAssignment['native']): TrackAssignment {
  return {
    trackIndex: index,
    native,
    source: 'gm',
    voicing: native === 'drums' ? { kind: 'drums' } : { kind: 'instrument', instrument: native },
    substituted: false,
  };
}

describe('smart song classification', () => {
  it('separates pure harp, other single instruments, and multi-instrument songs', () => {
    const active = new Set([0, 1, 2]);
    expect(classifySong([assignment(0, 'harp'), assignment(1, 'drums')], active)).toBe('pure-harp');
    expect(classifySong([assignment(0, 'flute'), assignment(1, 'flute')], active)).toBe('single-instrument');
    expect(classifySong([assignment(0, 'flute'), assignment(1, 'guitar')], active)).toBe('multi-instrument');
  });

  it('extends only a pure harp song, and always pairs that with the pack', () => {
    // Inside the single harp slot F#3-F#5: plain harp, no pack.
    expect(smartModeFor('pure-harp', { min: 60, max: 72 })).toBe('native');
    // Crosses the slot but stays inside F#1-F#7: the five-slot piano, and the pack is what
    // turns those five slots into one instrument, so it is part of the recommendation.
    expect(smartModeFor('pure-harp', { min: 40, max: 90 })).toBe('extended');
    // Beyond F#1-F#7 the pack could not help; the out-of-range policy is what applies.
    expect(smartModeFor('pure-harp', { min: 10, max: 120 })).toBe('extended');
    // Everything else keeps its own instruments and needs no pack: extended mode would
    // force the companion pack on a song that has a use for neither.
    expect(smartModeFor('single-instrument', { min: 40, max: 90 })).toBe('native');
    expect(smartModeFor('multi-instrument', { min: 10, max: 120 })).toBe('native');
  });
});

describe('smart merge thresholds', () => {
  it('uses off below 30, same at 30-48, and the narrowest candidate above 48', () => {
    expect(decideMerge('multi-instrument', { off: 29 })).toEqual({ mode: 'off', radiusZ: 29 });
    expect(decideMerge('multi-instrument', { off: 30, same: 28 })).toEqual({
      mode: 'same',
      radiusZ: 28,
    });
    expect(decideMerge('multi-instrument', { off: 48, same: 31 })).toEqual({
      mode: 'same',
      radiusZ: 31,
    });
    expect(decideMerge('multi-instrument', { off: 70, same: 45 })).toEqual({
      mode: 'same',
      radiusZ: 45,
    });
    expect(decideMerge('multi-instrument', { off: 70, same: 60, force: 40 })).toEqual({
      mode: 'force',
      radiusZ: 40,
    });
    expect(decideMerge('multi-instrument', { off: 70, same: 60, force: 55 })).toEqual({
      mode: 'force',
      radiusZ: 55,
    });
    // Merging can widen the layout: a 40-cell song that becomes 55 is not merged just
    // because it is above the compact threshold, since the merge would leave the radius.
    expect(decideMerge('multi-instrument', { off: 40, same: 55 })).toEqual({ mode: 'off', radiusZ: 40 });
    // Nor does a 50-cell merge win over an unmerged layout that already fits.
    expect(decideMerge('multi-instrument', { off: 46, same: 50 })).toEqual({ mode: 'off', radiusZ: 46 });
    // A pure harp song is never merged, however narrow the merge would be.
    expect(decideMerge('pure-harp', { off: 80, same: 20, force: 12 })).toEqual({ mode: 'off', radiusZ: 80 });
    // At 30-48 cells same-instrument merging is the preference, not the widest option.
    expect(decideMerge('multi-instrument', { off: 31, same: 33 })).toEqual({ mode: 'same', radiusZ: 33 });
    expect(SMART_RADIUS).toEqual({ compact: 30, audible: 48 });
  });
});

describe('lead lane plan', () => {
  it('puts a manual lead first and preserves all active tracks', () => {
    const song = songOfSpecs([
      { notes: [{ tick: 0, midi: 60 }], program: 73 },
      { notes: [{ tick: 0, midi: 64 }], program: 73 },
      { notes: [{ tick: 0, midi: 67 }], program: 73 },
    ]);
    const base = analyze(song, 'tracks.mid');
    const plan = buildLaneOrder(base.tracks, new Set(), 2);
    expect(plan.leadTrackIndex).toBe(2);
    expect(plan.leadBasis).toBe('manual');
    expect(plan.laneOrder[0]).toBe(2);
    expect(plan.laneOrder).toHaveLength(3);
  });
});
