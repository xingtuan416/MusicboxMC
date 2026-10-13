import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMidi } from '../src/core/midi/parse';
import { layout } from '../src/core/layout';
import { CoreError } from '../src/core/errors';
import { expectCoreError } from './helpers/errors';
import { song } from './helpers/song';

/**
 * MIDI files that are legal but were not handled.
 *
 * Both of these came out of an external review with binary fixtures; the fixtures are
 * kept next to the tests so the cases stay reproducible.
 */
const fixture = (name: string): Buffer => readFileSync(resolve('out/review-20261013', name));

describe('MIDI timebase and tempo handling', () => {
  it('refuses an SMPTE timebase instead of producing NaN times', () => {
    // SMPTE division has no ticks-per-quarter-note, so the library leaves ppq undefined
    // and every time becomes NaN. That used to send the layout into an infinite loop.
    expectCoreError(() => parseMidi(fixture('smpte.mid')), 'MIDI_UNSUPPORTED_TIMEBASE');
  });

  it('measures the opening of a song at the default tempo when the first tempo starts late', () => {
    // PPQ 480, first tempo at tick 480 (60 BPM), notes at ticks 240 and 480. The span
    // before the first tempo plays at the specification's 120 BPM, so the notes are at
    // 0.25s and 0.5s. Measuring that span at 60 BPM put the second note at 1.0s.
    const parsed = parseMidi(fixture('delayed-tempo.mid'));
    expect(parsed.ppq).toBe(480);
    expect(parsed.tempos[0]).toMatchObject({ ticks: 0, bpm: 120 });
    const times = parsed.tracks.flatMap((track) => track.notes.map((note) => note.timeSec));
    expect(times).toEqual([0.25, 0.5]);
  });

  it('keeps the declared tempo after the late one', () => {
    const parsed = parseMidi(fixture('delayed-tempo.mid'));
    expect(parsed.tempos).toHaveLength(2);
    expect(parsed.tempos[1]).toMatchObject({ ticks: 480, bpm: 60 });
  });

  it('refuses a tick that cannot be laid out, rather than looping forever', () => {
    // A hand-built model, since the parser now rejects the ways this could arise. The
    // point is that the layout fails instead of spinning: the grouping loop compares
    // times with `===`, and `NaN === NaN` never advances it.
    const broken = song([{ tick: 0, midi: 60 }]);
    broken.tracks[0]!.notes[0]!.timeSec = Number.NaN;
    expectCoreError(() => layout(broken), 'LAYOUT_INVALID_TICK');
  });

  it('reports the failing track for an invalid tick', () => {
    const broken = song([{ tick: 0, midi: 60 }]);
    broken.tracks[0]!.notes[0]!.timeSec = Number.NaN;
    try {
      layout(broken);
      expect.unreachable('layout should have refused the tick');
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).details.track).toBe(0);
    }
  });
});
