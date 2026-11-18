import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planLaneSharing } from '../src/core/arrangement/laneSharing';
import { chordCapacity } from '../src/core/layout/model';
import { generate, measureLayout } from '../src/main/generate';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');

/** Trigger times spread far enough apart that every note keeps its own column. */
function spread(count: number, step = 4): number[] {
  return Array.from({ length: count }, (_, index) => index * step);
}

describe('lane sharing plan', () => {
  it('folds a sparse track onto a dense lane', () => {
    const plan = planLaneSharing(
      [
        { index: 0, ticks: spread(80) },
        { index: 1, ticks: [2, 6, 10] },
      ],
      { dMax: 14 },
    );
    expect(plan.borrowed).toEqual([{ guest: 1, host: 0 }]);
    expect(plan.groups).toEqual([[0, 1]]);
    expect(plan.sparse).toEqual([1]);
    expect(plan.kept).toEqual([]);
  });

  it('lets the lead host a guest but never borrows the lead itself', () => {
    const hosting = planLaneSharing(
      [
        { index: 0, ticks: spread(80) },
        { index: 1, ticks: [2, 6] },
      ],
      { dMax: 14, leadIndex: 0 },
    );
    expect(hosting.borrowed).toEqual([{ guest: 1, host: 0 }]);

    // The lead keeps its own lane: it is the one the player stands on.
    const alone = planLaneSharing(
      [
        { index: 0, ticks: spread(80) },
        { index: 1, ticks: [2, 6] },
      ],
      { dMax: 14, leadIndex: 1 },
    );
    expect(alone.groups).toEqual([]);
    expect(alone.sparse).toEqual([]);
  });

  it('prefers the host nearest in the lane order', () => {
    const plan = planLaneSharing(
      [
        { index: 0, ticks: spread(80) },
        { index: 1, ticks: spread(80) },
        { index: 2, ticks: spread(80) },
        { index: 3, ticks: [2, 6, 10] },
      ],
      { dMax: 14, order: [0, 1, 2, 3] },
    );
    expect(plan.borrowed).toEqual([{ guest: 3, host: 2 }]);
  });

  it('refuses a host whose column is already full at the shared tick', () => {
    const capacity = chordCapacity(14);
    // A dense host (64 notes, so not sparse) whose first column is already at capacity.
    const hostTicks = [
      ...Array.from({ length: capacity }, () => 0),
      ...spread(50, 6).map((tick) => tick + 2),
    ];
    const plan = planLaneSharing(
      [
        { index: 0, ticks: hostTicks },
        { index: 1, ticks: [40] },
        { index: 2, ticks: [0] },
      ],
      { dMax: 14 },
    );
    // Track 2 would land on the crowded column of tick 0, so only track 1 borrows.
    expect(plan.borrowed).toEqual([{ guest: 1, host: 0 }]);
    expect(plan.kept).toEqual([2]);
  });

  it('gives leftovers one collector lane when together they are dense enough', () => {
    const plan = planLaneSharing(
      [
        { index: 0, ticks: spread(30) },
        { index: 1, ticks: spread(30) },
      ],
      { dMax: 14 },
    );
    expect(plan.collector).toEqual([0, 1]);
    expect(plan.groups).toEqual([[0, 1]]);
    expect(plan.kept).toEqual([]);
  });

  it('keeps near-empty tracks apart rather than paying for an empty collector line', () => {
    const plan = planLaneSharing(
      [
        { index: 0, ticks: [0, 8, 16] },
        { index: 1, ticks: [4, 12, 20] },
      ],
      { dMax: 14 },
    );
    expect(plan.collector).toEqual([]);
    expect(plan.groups).toEqual([]);
    expect(plan.kept).toEqual([0, 1]);
  });

  it('plans nothing when every track is dense', () => {
    const plan = planLaneSharing(
      [
        { index: 0, ticks: spread(60) },
        { index: 1, ticks: spread(60) },
      ],
      { dMax: 14 },
    );
    expect(plan).toEqual({ groups: [], borrowed: [], collector: [], kept: [], sparse: [] });
  });

  it('honours a custom sparse threshold', () => {
    const tracks = [
      { index: 0, ticks: spread(200) },
      { index: 1, ticks: spread(60) },
    ];
    expect(planLaneSharing(tracks, { dMax: 14 }).sparse).toEqual([]);
    expect(planLaneSharing(tracks, { dMax: 14, sparseBelow: 100 }).sparse).toEqual([1]);
  });
});

describe('lane sharing through generation', () => {
  it('keeps the old layout when the option is absent or off', () => {
    const plain = generate(FIXTURE);
    const off = generate(FIXTURE, { laneSharing: false });
    expect(plain.result.laneSharing).toBeUndefined();
    expect(off.result.laneSharing).toBeUndefined();
    expect(off.result.stats.outputTrackCount).toBe(plain.result.stats.outputTrackCount);
    expect(off.result.regions.map((region) => region.position.z)).toEqual(
      plain.result.regions.map((region) => region.position.z),
    );
  });

  it('spends fewer lanes and no more Z, without losing notes', () => {
    const plain = generate(FIXTURE);
    const shared = generate(FIXTURE, { laneSharing: true });
    const info = shared.result.laneSharing;
    expect(info).toBeDefined();
    expect(info!.groups.length).toBeGreaterThan(0);
    expect(shared.result.stats.outputTrackCount).toBeLessThan(plain.result.stats.outputTrackCount);
    expect(shared.result.stats.noteBlockCount).toBe(plain.result.stats.noteBlockCount);
  });

  // Z is measured, never assumed: folding notes onto a host may deepen its chord rows, and
  // the layout only keeps a shared candidate when it is at least as narrow.
  it('never measures wider than not sharing', () => {
    const plain = measureLayout(FIXTURE);
    const shared = measureLayout(FIXTURE, { laneSharing: true });
    expect(shared.trackCount).toBeLessThan(plain.trackCount);
    expect(shared.size.z).toBeLessThanOrEqual(plain.size.z);
  });

  it('measures the shared layout the same way generation builds it', () => {
    const generated = generate(FIXTURE, { laneSharing: true });
    const measure = measureLayout(FIXTURE, { laneSharing: true });
    expect(measure.mergeMode).toBe('share');
    expect(measure.sharedLanes).toBe(generated.result.laneSharing!.groups.length);
    expect(measure.trackCount).toBe(generated.result.stats.outputTrackCount);
    expect(measure.noteBlockCount).toBe(generated.result.stats.noteBlockCount);
  });

  // A merge decides how instruments collapse; a lane it produces can still be nearly empty.
  // Planning on that lane is the only way to remove it without touching the merge decision.
  it('folds lanes a same-instrument merge left behind', () => {
    const merged = generate(FIXTURE, { mergeSameInstrument: true });
    const folded = generate(FIXTURE, { mergeSameInstrument: true, laneSharing: true });
    expect(merged.result.laneSharing).toBeUndefined();
    expect(folded.result.laneSharing).toBeDefined();
    expect(folded.result.stats.outputTrackCount).toBeLessThan(merged.result.stats.outputTrackCount);
    expect(folded.result.stats.noteBlockCount).toBe(merged.result.stats.noteBlockCount);
    const plain = measureLayout(FIXTURE, { mergeSameInstrument: true });
    const shared = measureLayout(FIXTURE, { mergeSameInstrument: true, laneSharing: true });
    expect(shared.mergeMode).toBe('same');
    expect(shared.shareOutcome).toBe('applied');
    expect(shared.sharedLanes).toBeGreaterThan(0);
    expect(shared.trackCount).toBeLessThan(plain.trackCount);
    expect(shared.size.z).toBeLessThanOrEqual(plain.size.z);
  });

  it('says so when a merge left no sparse lane to fold', () => {
    // Nothing counts as sparse, so the merge keeps every lane; the readout must not claim
    // the queue was empty because the song was merged into one line.
    const measure = measureLayout(FIXTURE, {
      mergeSameInstrument: true,
      laneSharing: true,
      laneShareSparseBelow: 1,
    });
    expect(measure.mergeMode).toBe('same');
    expect(measure.sharedLanes).toBe(0);
    expect(measure.shareOutcome).toBe('no-sparse');
  });

  it('keeps the forced single line exempt from borrowing', () => {
    const measure = measureLayout(FIXTURE, { forceMergeSameInstrument: true, laneSharing: true });
    expect(measure.mergeMode).toBe('force');
    expect(measure.trackCount).toBe(1);
    expect(measure.shareOutcome).toBe('merged');
  });

  it('reports the borrowing plan alongside the smart summary', () => {
    const { result } = generate(FIXTURE, { smartSelection: true, leadTrackIndex: 1, laneSharing: true });
    const smart = result.smartSelection;
    expect(smart).toBeDefined();
    if (smart?.mergeMode === 'share') {
      expect(smart.laneSharing).toBeDefined();
      expect(result.laneSharing).toEqual(smart.laneSharing);
    } else {
      expect(smart?.laneSharing).toBeUndefined();
    }
  });
});
