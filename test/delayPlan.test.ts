import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { gameTickToRedstone } from '../src/core/layout/track';
import { song, songOfTracks } from './helpers/song';

const cfg = { ...DEFAULT_LAYOUT_CONFIG };

/** Repeater delays along the main row (z = zBase), ordered by X. */
function mainRepeaterDelays(res: ReturnType<typeof layout>, trackIdx = 0): number[] {
  const tr = res.tracks[trackIdx]!;
  return tr.placements
    .filter((p) => p.block === 'minecraft:repeater' && p.pos.z === tr.zBase)
    .sort((a, b) => a.pos.x - b.pos.x)
    .map((p) => Number(p.props?.delay));
}

describe('gameTickToRedstone (redstone-tick quantisation: 1 rt = 2 game ticks = 0.1s)', () => {
  it('rounds onto the 0.1s grid', () => {
    expect([0, 1, 2, 3, 4, 5, 9, 10].map(gameTickToRedstone)).toEqual([0, 1, 1, 2, 2, 3, 5, 5]);
  });
});

describe('group gap -> repeater delay breakdown (dust has no delay, only repeaters do)', () => {
  it('gap <= 4 rt: a single final repeater carries the whole gap', () => {
    // rt 0 and rt 4 (ticks 0 and 8) with the song-wide +1 redstone tick lead-in:
    // group 1 R1, group 2 R4
    const res = layout(
      song([
        { tick: 0, midi: 60 },
        { tick: 8, midi: 62 },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(mainRepeaterDelays(res)).toEqual([1, 4]);
  });

  it('gap > 4 rt: chained pre-group repeaters (greedy 4s) plus the final repeater', () => {
    // rt 5 and rt 10 (ticks 10 and 20), no lead-in: group 1 has gap 5, so rest 1 and the
    // final repeater is R4;
    // group 2 also has gap 5, so rest 1 and R4. Main-line delays [1, 4, 1, 4]
    const res = layout(
      song([
        { tick: 10, midi: 60 },
        { tick: 20, midi: 62 },
      ]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(mainRepeaterDelays(res)).toEqual([1, 4, 1, 4]);
  });

  it('repeater delays sum to the last group rt plus the lead-in (cumulative timing holds)', () => {
    const ticks = [10, 23, 47, 100, 101, 260];
    const res = layout(song(ticks.map((t, i) => ({ tick: t, midi: 54 + (i % 5) }))), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    const delays = mainRepeaterDelays(res);
    const rts = ticks.map((t) => gameTickToRedstone(t));
    const base = rts[0] === 0 ? 1 : 0;
    const total = delays.reduce((s, d) => s + d, 0);
    expect(total).toBe(rts[rts.length - 1]! + base);
  });
});

describe('quantisation error (not zero, but bounded at 1 game tick per note and conserved)', () => {
  it('every placed entry lands on the redstone grid: actual = 2*(rt + base)', () => {
    const ticks = [0, 3, 7, 20, 55];
    const res = layout(song(ticks.map((t, i) => ({ tick: t, midi: 54 + (i % 5) }))), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    for (const p of res.placed) {
      const rt = gameTickToRedstone(p.tick);
      expect(p.actual - 2 * rt).toBe(2); // first group at rt 0, so the song-wide base is 1
    }
  });

  it('first group at rt 0: the song gets one STARTUP_LEAD_IN, not one warning per track', () => {
    const res = layout(song([{ tick: 0, midi: 60 }]), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    expect(res.placed[0]!.actual).toBe(2);
    expect(res.warnings).toContainEqual({ code: 'STARTUP_LEAD_IN', ticks: 2 });
    // The lead-in shifts every track equally, so it is not a per-note timing problem and
    // must not be reported as one.
    expect(res.warnings.filter((w) => w.code === 'TIMING_ADJUSTED')).toHaveLength(0);
  });

  it('reports the lead-in once no matter how many tracks start at rt 0', () => {
    const multi = layout(
      songOfTracks([[{ tick: 0, midi: 60 }], [{ tick: 0, midi: 64 }], [{ tick: 0, midi: 67 }]]),
      { config: cfg, regions: DEFAULT_REGIONS },
    );
    expect(multi.warnings.filter((w) => w.code === 'STARTUP_LEAD_IN')).toHaveLength(1);
    expect(multi.warnings.filter((w) => w.code === 'TIMING_ADJUSTED')).toHaveLength(0);
  });

  it('first group at rt >= 1: no lead-in, no warning, actual equals the original game tick', () => {
    const res = layout(song([{ tick: 10, midi: 60 }]), {
      config: cfg,
      regions: DEFAULT_REGIONS,
    });
    expect(res.placed[0]!.actual).toBe(10);
    expect(res.warnings.some((w) => w.code === 'STARTUP_LEAD_IN')).toBe(false);
    expect(res.warnings.some((w) => w.code === 'TIMING_ADJUSTED')).toBe(false);
  });

  it('adjacent groups differ by 2*(redstone tick difference), over 200 random scores', () => {
    for (let seed = 0; seed < 200; seed++) {
      let t = 0;
      const notes = [];
      for (let i = 0; i < 12; i++) {
        notes.push({ tick: t, midi: 54 + ((seed + i) % 8) });
        t += 1 + ((seed * 7 + i * 13) % 17);
      }
      const res = layout(song(notes), { config: cfg, regions: DEFAULT_REGIONS });
      const placed = [...res.placed].sort((a, b) => a.tick - b.tick);
      for (let i = 1; i < placed.length; i++) {
        const dExp = (gameTickToRedstone(placed[i]!.tick) - gameTickToRedstone(placed[i - 1]!.tick)) * 2;
        expect(placed[i]!.actual - placed[i - 1]!.actual).toBe(dExp);
      }
    }
  });
});
