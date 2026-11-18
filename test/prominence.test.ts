import { describe, expect, it } from 'vitest';
import {
  chooseLeadTrack,
  rankProminence,
  trackProminence,
  type ProminenceTrack,
} from '../src/core/arrangement/prominence';

function track(index: number, velocity: number, times: number[], percussion = false): ProminenceTrack {
  const notes = times.map((timeSec) => ({ timeSec, durationSec: 0.5, velocity }));
  return {
    index,
    percussion,
    ...trackProminence(notes, 10),
  };
}

describe('track prominence', () => {
  it('measures velocity, activity, and monophonic onsets', () => {
    const stats = trackProminence(
      [
        { timeSec: 0, durationSec: 1, velocity: 0.5 },
        { timeSec: 0, durationSec: 1, velocity: 0.9 },
        { timeSec: 4, durationSec: 1, velocity: 0.7 },
      ],
      10,
    );
    expect(stats.noteCount).toBe(3);
    expect(stats.meanVelocity).toBeCloseTo(0.7);
    expect(stats.activeSeconds).toBe(5);
    expect(stats.activityScore).toBeCloseTo(0.5);
    expect(stats.polyphonicOnsetRatio).toBeCloseTo(0.5);
    expect(stats.melodicScore).toBeCloseTo(0.5);
  });

  it('chooses the loudest pitched track before activity or melody', () => {
    const choice = chooseLeadTrack([track(0, 0.9, [0, 1]), track(1, 0.4, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5])]);
    expect(choice).toEqual({ index: 0, basis: 'velocity' });
  });

  it('keeps the louder track even when the quieter one plays far more notes', () => {
    // Loudness is the only thing that decides the lead: a busy line is not "in front".
    const choice = chooseLeadTrack([track(0, 0.6, [0]), track(1, 0.61, [0, 1, 2, 3, 4])]);
    expect(choice).toEqual({ index: 1, basis: 'velocity' });
  });

  it('breaks an exact velocity tie by note count, then by file order', () => {
    const busy = rankProminence([track(0, 0.5, [0]), track(1, 0.5, [0, 1, 2])]);
    expect(busy.map((entry) => entry.index)).toEqual([1, 0]);
    const same = rankProminence([track(0, 0.5, [0, 1]), track(1, 0.5, [0, 1])]);
    expect(same.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it('lets a loud drum track lead, because instrument type is not a criterion', () => {
    const mixed = rankProminence([track(0, 1, [0], true), track(1, 0.2, [0])]);
    expect(mixed.map((entry) => entry.index)).toEqual([0, 1]);
    expect(chooseLeadTrack([track(0, 1, [0], true), track(1, 0.2, [0])])).toEqual({
      index: 0,
      basis: 'velocity',
    });
  });
});
