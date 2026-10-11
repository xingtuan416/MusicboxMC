import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import { layout } from '../src/core/layout/index';
import { validateForcedTrack } from '../src/core/layout/forcedValidation';
import { parseMidi } from '../src/core/midi/parse';
import type { SongModel } from '../src/core/midi/types';
import { generate, generateToFile } from '../src/main/service';
import { parseLitematic } from '../src/core/litematic/build';

function song(specs: Array<{ instrument?: string; percussion?: boolean; ticks: number[] }>): SongModel {
  return {
    name: 'dense',
    ppq: 480,
    baseBpm: 120,
    durationSec: 2000,
    tempos: [{ ticks: 0, timeSec: 0, bpm: 120 }],
    timeSignature: null,
    tracks: specs.map((spec, index) => ({
      index,
      channel: spec.percussion ? 9 : index,
      instrument: spec.instrument ?? 'piano',
      percussion: spec.percussion ?? false,
      name: `track-${index}`,
      notes: spec.ticks.map((tick, i) => ({
        midi: 48 + (i % 36),
        timeSec: tick / 20,
        durationSec: 0.1,
        velocity: 1,
        channel: index,
      })),
    })),
  };
}

const countNotes = (result: ReturnType<typeof layout>): number =>
  result.tracks.reduce(
    (sum, track) => sum + track.placements.filter((p) => p.block === 'minecraft:note_block').length,
    0,
  );

describe('forced instrument merge', () => {
  it('globally groups interleaved instruments and arbitrary gaps, preserving exclusions and first indices', () => {
    const source = song([
      { ticks: [0] },
      { instrument: 'violin', ticks: [4] },
      { ticks: [20000] },
      { ticks: [2] },
      { percussion: true, instrument: 'drums', ticks: [8] },
      { percussion: true, instrument: 'woodblock', ticks: [10] },
    ]);
    const result = layout(source, { forceMergeSameInstrument: true, excludeTracks: [3] });
    expect(result.tracks.map((track) => track.trackIndex)).toEqual([0, 1, 4]);
    expect(countNotes(result)).toBe(5);
    expect(result.tracks[0]!.segments[0]!.taps).toHaveLength(2);
  });

  it.each([1, 3, 14, 15, 28, 29, 30, 80, 470, 616])(
    'preserves %i same-time notes on one connected spine',
    (n) => {
      const result = layout(song([{ ticks: Array(n).fill(0) }]), { forceMergeSameInstrument: true });
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
      song([
        { ticks: [...Array(80).fill(0), ...Array(30).fill(2), 4, 21] },
        { instrument: 'violin', ticks: [0, 2, 3, 4, 200] },
      ]),
      { forceMergeSameInstrument: true },
    );
    expect(countNotes(result)).toBe(117);
    expect(result.tracks).toHaveLength(2);
    for (const p of result.placed) {
      expect(p.actual - Math.round(p.tick / 2) * 2).toBe(result.startupDelayTicks);
    }
    for (const track of result.tracks) {
      validateForcedTrack(
        track,
        1,
        result.placed.filter((p) => p.trackIndex === track.trackIndex).map((p) => p.actual),
      );
    }
  });

  it('legacy behavior is unchanged; forcing takes precedence if both options reach the API', () => {
    const source = song([{ ticks: Array(80).fill(0) }, { ticks: [0] }]);
    expect(layout(source).tracks.length).toBeGreaterThan(1);
    expect(layout(source, { mergeSameInstrument: true }).tracks).toHaveLength(3);
    const forced = layout(source, { forceMergeSameInstrument: true, mergeSameInstrument: true });
    expect(forced.tracks).toHaveLength(1);
    expect(countNotes(forced)).toBe(81);
  });

  it('applies first-track transpose, block overrides and drop policy before planning', () => {
    const source = song([{ ticks: [0] }, { ticks: [2] }]);
    source.tracks[0]!.notes[0]!.midi = 10;
    source.tracks[1]!.notes[0]!.midi = 60;
    const result = layout(source, {
      forceMergeSameInstrument: true,
      outOfRange: 'drop',
      transpose: { 0: 1, 1: -2 },
      blocks: { tracks: { 0: { noteBase: 'minecraft:gold_block' } } },
    });
    expect(countNotes(result)).toBe(1);
    const note = result.tracks[0]!.segments[0]!.taps[0]!.notes[0]!;
    expect(note.block).toBe('minecraft:gold_block');
    expect(note.note).toBe(6); // MIDI 72, flute region starting at 66.
    expect(result.warnings).toContainEqual({ code: 'OUT_OF_RANGE', midi: 10, action: 'drop' });
  });

  it('rejects unsafe fanout instead of discarding or independently splitting notes', () => {
    expect(() => layout(song([{ ticks: Array(617).fill(0) }]), { forceMergeSameInstrument: true })).toThrow(
      '未生成投影',
    );
    expect(() =>
      layout(song([{ ticks: [0] }]), {
        forceMergeSameInstrument: true,
        blocks: { tracks: { 0: { wireSupport: 'minecraft:air' } } },
      }),
    ).toThrow('不能为空气');
    const dropped = song([{ ticks: [0] }]);
    dropped.tracks[0]!.notes[0]!.midi = 10;
    expect(layout(dropped, { forceMergeSameInstrument: true, outOfRange: 'drop' }).tracks).toHaveLength(0);
    expect(() =>
      layout(song([{ ticks: [0] }]), {
        forceMergeSameInstrument: true,
        config: { baseTps: Infinity },
      }),
    ).toThrow('有效的 TPS');
  });

  it.each([1, 2, 3, 7, 14])(
    'respects per-section dMax=%i with random dense sequences and safe track spacing',
    (dMax) => {
      const n = Math.min(dMax, 7) * 12;
      const ticks = Array.from({ length: 12 }, (_, i) =>
        Array.from({ length: 1 + ((i * 17) % n) }, () => i * 2 + (i % 3 === 0 ? 1 : 0)),
      ).flat();
      const result = layout(song([{ ticks }, { instrument: 'violin', ticks: [0, 100] }]), {
        forceMergeSameInstrument: true,
        config: { dMax, trackPitch: 1 },
      });
      expect(countNotes(result)).toBe(ticks.length + 2);
      const ranges = result.tracks.map((track) => {
        const zs = track.placements.map((p) => p.pos.z);
        return { min: Math.min(...zs), max: Math.max(...zs) };
      });
      expect(ranges[1]!.min - ranges[0]!.max).toBeGreaterThan(1);
      for (const p of result.placed)
        expect(p.actual - Math.round(p.tick / 2) * 2).toBe(result.startupDelayTicks);
    },
  );

  it('detects actual miswiring rather than trusting planned actual timestamps', () => {
    const result = layout(song([{ ticks: Array(80).fill(0) }]), { forceMergeSameInstrument: true });
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

  it.skipIf(!existsSync('Rush E.mid'))(
    'validates the local Rush E: all 46291 notes, one spine, constant latency',
    () => {
      const source = parseMidi(readFileSync('Rush E.mid'));
      const result = layout(source, { forceMergeSameInstrument: true });
      expect(result.tracks).toHaveLength(1);
      expect(countNotes(result)).toBe(source.tracks.reduce((sum, track) => sum + track.notes.length, 0));
      const audit = validateForcedTrack(
        result.tracks[0]!,
        1,
        result.placed.map((p) => p.actual),
      );
      expect(audit.noteCount).toBe(46291);
      expect(audit.minWireStrength).toBeGreaterThan(0);
      expect(result.startupDelayTicks).toBe(70);
    },
    30000,
  );
});
