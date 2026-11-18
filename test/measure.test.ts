import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, measureLayout } from '../src/main/generate';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');

describe('layout measurement for the developer readout', () => {
  it('agrees with a real generation about tracks, regions and note blocks', () => {
    const measure = measureLayout(FIXTURE, { dMax: 8 });
    const { result } = generate(FIXTURE, { dMax: 8 });
    expect(measure.trackCount).toBe(result.stats.outputTrackCount);
    expect(measure.regionCount).toBe(result.stats.regionCount);
    expect(measure.noteBlockCount).toBe(result.stats.noteBlockCount);
    expect(measure.totalTicks).toBe(result.stats.tickCount);
    expect(measure.size.x).toBeGreaterThan(0);
    expect(measure.size.y).toBeGreaterThan(0);
    expect(measure.size.z).toBeGreaterThan(0);
    // Every region has to fit inside the measured box.
    for (const region of result.regions) {
      expect(region.position.x + region.size.x).toBeLessThanOrEqual(measure.size.x);
      expect(region.position.z + region.size.z).toBeLessThanOrEqual(measure.size.z);
    }
  });

  it('routes exactly like a real generation when smart selection runs', () => {
    const options = { dMax: 8, smartSelection: true, laneSharing: true };
    const measure = measureLayout(FIXTURE, options);
    const { result } = generate(FIXTURE, options);
    expect(measure.mergeMode).toBe(result.smartSelection?.mergeMode);
    expect(measure.hearingRadius).toBe(result.smartSelection?.radiusZ);
    expect(measure.trackCount).toBe(result.stats.outputTrackCount);
    // The candidates are the widths the decision was made on, so the chosen mode has to be
    // one of them and has to carry the width that was kept.
    const chosen = measure.candidates.find((candidate) => candidate.mode === measure.mergeMode);
    expect(chosen?.radiusZ).toBe(measure.hearingRadius);
  });

  it('explains why lane sharing did or did not apply', () => {
    expect(measureLayout(FIXTURE, { dMax: 8 }).shareOutcome).toBe('disabled');
    expect(measureLayout(FIXTURE, { dMax: 8, forceMergeSameInstrument: true }).shareOutcome).toBe('merged');
    const plain = measureLayout(FIXTURE, { dMax: 8 });
    const shared = measureLayout(FIXTURE, { dMax: 8, laneSharing: true });
    expect(shared.shareOutcome).toBe('applied');
    expect(shared.sharedLanes).toBeGreaterThan(0);
    expect(shared.trackCount).toBeLessThan(plain.trackCount);
    // Folding may deepen the host's chord rows, so the radius is what must not grow.
    expect(shared.hearingRadius).toBeLessThanOrEqual(Math.max(plain.hearingRadius, 48));
    expect(shared.candidates.some((candidate) => candidate.mode === 'share')).toBe(true);
  });

  it('counts Minecraft tracks, so a forced merge reports one', () => {
    const plain = measureLayout(FIXTURE);
    const forced = measureLayout(FIXTURE, { forceMergeSameInstrument: true });
    expect(plain.trackCount).toBeGreaterThan(1);
    expect(forced.trackCount).toBe(1);
  });
});
