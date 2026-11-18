import { describe, expect, it } from 'vitest';
import { layout } from '../src/core/layout';
import { sliceRegions } from '../src/core/layout/regions';
import { songOfTracks } from './helpers/song';

function notes(rt: number, midi: number): Array<{ tick: number; midi: number }> {
  return [{ tick: rt * 2, midi }];
}

describe('lead-track lane ordering', () => {
  it('keeps the historical order when laneOrder is omitted', () => {
    const song = songOfTracks([notes(2, 60), notes(2, 64), notes(2, 67)]);
    const result = layout(song);
    expect(result.tracks.map((track) => track.trackIndex)).toEqual([0, 1, 2]);
  });

  it('lays the lanes out in priority order, nearest the player first', () => {
    const song = songOfTracks([notes(2, 60), notes(2, 64), notes(2, 67), notes(2, 70), notes(2, 72)]);
    const order = [3, 0, 4, 1, 2];
    const result = layout(song, { laneOrder: order });
    expect(result.tracks.map((track) => track.trackIndex)).toEqual(order);
    const lead = result.tracks.find((track) => track.trackIndex === 3)!;
    expect(lead.zBase).toBe(0);
    // Distance from the player's row is monotone in the priority order.
    const distances = result.tracks.map((track) => Math.abs(track.zBase));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    const lanes = result.tracks.map((track) => track.zBase);
    expect(Math.min(...lanes)).toBeLessThan(0);
    expect(Math.max(...lanes)).toBeGreaterThan(0);
  });

  // The player's lane sits on z = 0 and the other lanes take the closer side, so Z goes
  // negative as well as positive. Each region takes its own minimum as origin, so this
  // proves the export coordinates still come out valid.
  it('keeps every block inside its own region when lanes sit on both sides', () => {
    const song = songOfTracks([notes(2, 60), notes(2, 64), notes(2, 67), notes(2, 70), notes(2, 72)]);
    const result = layout(song, { laneOrder: [3, 0, 4, 1, 2] });
    expect(result.min.z).toBeLessThan(0);
    const regions = sliceRegions(result);
    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) {
      for (const block of region.blocks) {
        expect(block.pos.x).toBeGreaterThanOrEqual(0);
        expect(block.pos.y).toBeGreaterThanOrEqual(0);
        expect(block.pos.z).toBeGreaterThanOrEqual(0);
        expect(block.pos.x).toBeLessThan(region.size.x);
        expect(block.pos.y).toBeLessThan(region.size.y);
        expect(block.pos.z).toBeLessThan(region.size.z);
      }
    }
  });

  it('preserves note count and relative timing while reordering', () => {
    const song = songOfTracks([notes(2, 60), notes(5, 64), notes(8, 67)]);
    const plain = layout(song);
    const ordered = layout(song, { laneOrder: [1, 0, 2] });
    expect(ordered.placed).toHaveLength(plain.placed.length);
    expect(ordered.tracks.reduce((sum, track) => sum + track.placements.length, 0)).toBe(
      plain.tracks.reduce((sum, track) => sum + track.placements.length, 0),
    );
    const plainTiming = plain.placed.map((entry) => entry.actual).sort((a, b) => a - b);
    const orderedTiming = ordered.placed.map((entry) => entry.actual).sort((a, b) => a - b);
    expect(orderedTiming).toEqual(plainTiming);
  });
});
