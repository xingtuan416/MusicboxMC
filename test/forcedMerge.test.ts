import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import { layout } from '../src/core/layout/index';
import { validateForcedTrack } from '../src/core/layout/forcedValidation';
import type { SongModel } from '../src/core/midi/types';
import { generate, generateToFile } from '../src/main/service';
import { parseLitematic } from '../src/core/litematic/build';
import { buildSong, denseSong } from './helpers/song';
import { expectCoreError } from './helpers/errors';

function multiTrackSong(
  specs: Array<{ instrument?: string; percussion?: boolean; ticks: number[] }>,
): SongModel {
  return buildSong({
    name: 'dense',
    durationSec: 2000,
    tracks: specs.map((spec) => ({
      instrument: spec.instrument ?? 'piano',
      percussion: spec.percussion,
      notes: spec.ticks.map((tick, i) => ({ tick, midi: 48 + (i % 36) })),
    })),
  });
}

const countNotes = (result: ReturnType<typeof layout>): number =>
  result.tracks.reduce(
    (sum, track) => sum + track.placements.filter((p) => p.block === 'minecraft:note_block').length,
    0,
  );

describe('forced instrument merge', () => {
  it('folds interleaved instruments and arbitrary gaps onto one spine, preserving exclusions', () => {
    const source = multiTrackSong([
      { ticks: [0] },
      { instrument: 'violin', ticks: [4] },
      { ticks: [20000] },
      { ticks: [2] },
      { percussion: true, instrument: 'drums', ticks: [8] },
      { percussion: true, instrument: 'woodblock', ticks: [10] },
    ]);
    const result = layout(source, { forceMergeSameInstrument: true, excludeTracks: [3] });
    expect(result.tracks.map((track) => track.trackIndex)).toEqual([-1]);
    expect(countNotes(result)).toBe(5);
    expect(result.tracks[0]!.taps).toHaveLength(5);
    // One placement entry per source track at each group, so warnings can still locate.
    expect(new Set(result.placed.map((entry) => entry.trackIndex))).toEqual(new Set([0, 1, 2, 4, 5]));
    expect(result.trackInstruments).toHaveLength(5);
  });

  it.each([1, 3, 14, 15, 28, 29, 30, 80, 470, 616])(
    'preserves %i same-time notes on one connected spine',
    (n) => {
      const result = layout(multiTrackSong([{ ticks: Array(n).fill(0) }]), {
        forceMergeSameInstrument: true,
      });
      expect(result.tracks).toHaveLength(1);
      expect(countNotes(result)).toBe(n);
      expect(result.placed).toHaveLength(1);
      expect(result.warnings.some((w) => w.code === 'TRACK_SPLIT' || w.code === 'POLYPHONY_EXCEEDED')).toBe(
        false,
      );
      const audit = validateForcedTrack(
        result.tracks[0]!,
        1,
        result.placed.map((p) => p.actual),
      );
      expect(audit.noteCount).toBe(n);
      expect(audit.minWireStrength).toBeGreaterThan(0);
    },
  );

  it('uses one global compensation with dense adjacent groups and multiple instruments', () => {
    const result = layout(
      multiTrackSong([
        { ticks: [...Array(80).fill(0), ...Array(30).fill(2), 4, 21] },
        { instrument: 'violin', ticks: [0, 2, 3, 4, 200] },
      ]),
      { forceMergeSameInstrument: true },
    );
    expect(countNotes(result)).toBe(117);
    expect(result.tracks).toHaveLength(1);
    for (const p of result.placed) {
      expect(p.actual - Math.round(p.tick / 2) * 2).toBe(result.startupDelayTicks);
    }
    const track = result.tracks[0]!;
    validateForcedTrack(
      track,
      1,
      track.taps.map((tap) => tap.t * 2 + result.startupDelayTicks!),
    );
  });

  it('legacy behavior is unchanged; forcing takes precedence if both options reach the API', () => {
    const source = multiTrackSong([{ ticks: Array(80).fill(0) }, { ticks: [0] }]);
    expect(layout(source).tracks.length).toBeGreaterThan(1);
    expect(layout(source, { mergeSameInstrument: true }).tracks).toHaveLength(3);
    const forced = layout(source, { forceMergeSameInstrument: true, mergeSameInstrument: true });
    expect(forced.tracks).toHaveLength(1);
    expect(countNotes(forced)).toBe(81);
  });

  it('applies first-track transpose, block overrides and drop policy before planning', () => {
    const source = multiTrackSong([{ ticks: [0] }, { ticks: [2] }]);
    source.tracks[0]!.notes[0]!.midi = 10;
    source.tracks[1]!.notes[0]!.midi = 60;
    const result = layout(source, {
      forceMergeSameInstrument: true,
      outOfRange: 'drop',
      transpose: { 0: 1, 1: -2 },
      // The override follows the note's own source track now that both tracks share
      // one spine; a per-spine override would have no single owner.
      blocks: { tracks: { 1: { noteBase: 'minecraft:gold_block' } } },
    });
    expect(countNotes(result)).toBe(1);
    const note = result.tracks[0]!.taps[0]!.notes[0]!;
    expect(note.block).toBe('minecraft:gold_block');
    expect(note.note).toBe(6); // MIDI 36 after -2 octaves, bass region starting at 30.
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'OUT_OF_RANGE', midi: 10, action: 'drop' }),
    );
  });

  it('rejects unsafe fanout instead of discarding or independently splitting notes', () => {
    expectCoreError(
      () => layout(multiTrackSong([{ ticks: Array(617).fill(0) }]), { forceMergeSameInstrument: true }),
      'FORCED_BRANCH_TOO_DEEP',
    );
    expectCoreError(
      () =>
        layout(multiTrackSong([{ ticks: [0] }]), {
          forceMergeSameInstrument: true,
          blocks: { tracks: { 0: { wireSupport: 'minecraft:air' } } },
        }),
      'FORCED_SUPPORT_IS_AIR',
    );
    // The ordinary layout has to refuse it too: it used to write dust and repeaters
    // sitting on nothing and report success.
    expectCoreError(
      () =>
        layout(multiTrackSong([{ ticks: [0] }]), {
          blocks: { tracks: { 0: { wireSupport: 'minecraft:air' } } },
        }),
      'LAYOUT_SUPPORT_IS_AIR',
    );
    const dropped = multiTrackSong([{ ticks: [0] }]);
    dropped.tracks[0]!.notes[0]!.midi = 10;
    expect(layout(dropped, { forceMergeSameInstrument: true, outOfRange: 'drop' }).tracks).toHaveLength(0);
    expectCoreError(
      () =>
        layout(multiTrackSong([{ ticks: [0] }]), {
          forceMergeSameInstrument: true,
          config: { baseTps: Infinity },
        }),
      // Rejected upstream of the forced layout, which is where the TPS is first used.
      'LAYOUT_INVALID_CONFIG',
    );
  });

  it.each([1, 2, 3, 7, 14])(
    'respects per-section dMax=%i with random dense sequences on one spine',
    (dMax) => {
      const n = Math.min(dMax, 7) * 12;
      const ticks = Array.from({ length: 12 }, (_, i) =>
        Array.from({ length: 1 + ((i * 17) % n) }, () => i * 2 + (i % 3 === 0 ? 1 : 0)),
      ).flat();
      const result = layout(multiTrackSong([{ ticks }, { instrument: 'violin', ticks: [0, 100] }]), {
        forceMergeSameInstrument: true,
        config: { dMax, trackPitch: 1 },
      });
      expect(result.tracks).toHaveLength(1);
      expect(countNotes(result)).toBe(ticks.length + 2);
      const track = result.tracks[0]!;
      validateForcedTrack(
        track,
        1,
        track.taps.map((tap) => tap.t * 2 + result.startupDelayTicks!),
      );
      for (const p of result.placed)
        expect(p.actual - Math.round(p.tick / 2) * 2).toBe(result.startupDelayTicks);
    },
  );

  it('detects actual miswiring rather than trusting planned actual timestamps', () => {
    const result = layout(multiTrackSong([{ ticks: Array(80).fill(0) }]), { forceMergeSameInstrument: true });
    const track = result.tracks[0]!;
    const relay = track.placements.find(
      (p) => p.block === 'minecraft:repeater' && p.props?.facing === 'north',
    )!;
    relay.props!.facing = 'south';
    expect(() =>
      validateForcedTrack(
        track,
        1,
        result.placed.map((p) => p.actual),
      ),
    ).toThrow();
  });

  it('service exports one region, roundtrips every note, and never overwrites on unsafe input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'musicbox-forced-'));
    try {
      const midi = new Midi();
      for (let i = 0; i < 3; i++) {
        const track = midi.addTrack();
        for (let n = 0; n < 30; n++) track.addNote({ midi: 48 + (n % 24), time: 0, duration: 0.1 });
      }
      const input = join(directory, 'dense.mid');
      writeFileSync(input, Buffer.from(midi.toArray()));
      const { result, buffer } = generate(input, { forceMergeSameInstrument: true });
      expect(result.success).toBe(true);
      expect(result.stats.outputTrackCount).toBe(1);
      expect(result.stats.noteBlockCount).toBe(90);
      const exported = parseLitematic(buffer!);
      expect(exported.regions).toHaveLength(1);
      const region = exported.regions[0]!;
      expect(
        Array.from(region.indices).filter((id) => region.palette[id]!.name === 'minecraft:note_block'),
      ).toHaveLength(90);
      const unsafe = new Midi();
      const track = unsafe.addTrack();
      for (let i = 0; i < 617; i++) track.addNote({ midi: 48 + (i % 24), time: 0, duration: 0.1 });
      writeFileSync(input, Buffer.from(unsafe.toArray()));
      const output = join(directory, 'existing.litematic');
      writeFileSync(output, 'unchanged');
      expect(generateToFile(input, output, { forceMergeSameInstrument: true }).success).toBe(false);
      expect(readFileSync(output, 'utf8')).toBe('unchanged');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a dense multi-track song on one spine with song-wide constant latency', () => {
    const source = denseSong();
    const noteCount = source.tracks.reduce((sum, track) => sum + track.notes.length, 0);
    const result = layout(source, { forceMergeSameInstrument: true });

    expect(result.tracks).toHaveLength(1);
    expect(countNotes(result)).toBe(noteCount);

    const track = result.tracks[0]!;
    const audit = validateForcedTrack(
      track,
      1,
      track.taps.map((tap) => tap.t * 2 + result.startupDelayTicks!),
    );
    expect(audit.noteCount).toBe(noteCount);
    expect(audit.minWireStrength).toBeGreaterThan(0);
    expect(result.startupDelayTicks).toBeGreaterThan(0);
  }, 30000);
});
