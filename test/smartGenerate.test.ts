import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, planSmartSelection } from '../src/main/generate';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');

describe('smart generation integration', () => {
  it('routes a multi-instrument song by measured hearing radius without losing notes', () => {
    const smart = generate(FIXTURE, { smartSelection: true, leadTrackIndex: 1 });
    const plain = generate(FIXTURE);
    expect(smart.result.success).toBe(true);
    const info = smart.result.smartSelection;
    expect(info?.category).toBe('multi-instrument');
    expect(info?.leadTrackIndex).toBe(1);
    expect(info?.leadBasis).toBe('manual');
    expect(info?.radiusZ).toBeLessThanOrEqual(info!.audibleRadius);
    // The mode that won is the closest candidate inside the radius; below the compact
    // threshold the song is left alone instead of being merged for no audible gain.
    const inside = info!.candidates.filter((candidate) => candidate.radiusZ <= info!.audibleRadius);
    if (info!.mergeMode === 'off' && info!.radiusZ < info!.compactRadius) {
      expect(info!.candidates.every((candidate) => candidate.radiusZ >= info!.radiusZ)).toBe(true);
    } else {
      expect(Math.min(...inside.map((candidate) => candidate.radiusZ))).toBe(info!.radiusZ);
    }
    expect(smart.result.stats.noteBlockCount).toBe(plain.result.stats.noteBlockCount);
    expect(info?.resourcePackRecommended).toBe(false);
  });

  it('omits smart metadata when smart selection is off', () => {
    const result = generate(FIXTURE, { smartSelection: false });
    expect(result.result.success).toBe(true);
    expect(result.result.smartSelection).toBeUndefined();
  });

  // The configuration step applies the recommendation before generating, so the
  // measurement has to agree with what generation then does.
  it('measures the routing without writing anything', () => {
    const plan = planSmartSelection(FIXTURE, { leadTrackIndex: 1 });
    expect(plan.error).toBeUndefined();
    expect(plan.info?.category).toBe('multi-instrument');
    // The fixture's harp track stays inside F#3-F#5, so a multi-instrument song keeps its
    // own instruments instead of paying the extended-mode substitution.
    expect(plan.info?.instrumentMode).toBe('native');
    expect(plan.info?.leadTrackIndex).toBe(1);
    expect(plan.info?.radiusZ).toBeGreaterThan(0);
  });

  it('reports no Z span for command playback', () => {
    const plan = planSmartSelection(FIXTURE, { commandPlayback: true });
    expect(plan.info?.radiusZ).toBe(0);
    expect(plan.info?.candidates).toEqual([]);
  });
});
