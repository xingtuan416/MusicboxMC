import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout';
import { songOfTracks } from './helpers/song';

/**
 * A chord past the column's capacity is re-emitted onto another lane, and every lane
 * re-maps the notes it carries. Reporting the range warning on each lane counted one
 * source note several times: 60 notes at one tick produced 93 `OUT_OF_RANGE` notices and
 * the interface reported 93 out-of-range notes for a song that had 60.
 */
describe('range warnings count each source note once', () => {
  it('does not report a note again when its chord overflows onto another lane', () => {
    const notes = Array.from({ length: 60 }, () => ({ tick: 0, midi: 10 }));
    const result = layout(songOfTracks([notes]));

    // The overflow has to actually happen for this to mean anything.
    expect(result.tracks.length).toBeGreaterThan(1);

    const rangeWarnings = result.warnings.filter((w) => w.code === 'OUT_OF_RANGE');
    expect(rangeWarnings).toHaveLength(60);
  });

  it('never reports more out-of-range notes than the song has', () => {
    for (const count of [29, 30, 60, 90]) {
      const notes = Array.from({ length: count }, () => ({ tick: 0, midi: 10 }));
      const result = layout(songOfTracks([notes]));
      const rangeWarnings = result.warnings.filter((w) => w.code === 'OUT_OF_RANGE');
      expect(rangeWarnings.length, `${count} notes`).toBeLessThanOrEqual(count);
    }
  });

  it('still reports every note of a chord that fits in one column', () => {
    const notes = Array.from({ length: 29 }, () => ({ tick: 0, midi: 10 }));
    const result = layout(songOfTracks([notes]));
    expect(result.warnings.filter((w) => w.code === 'OUT_OF_RANGE')).toHaveLength(29);
  });
});
