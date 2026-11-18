import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generate, measureLayout } from '../src/main/service';
import type { GenerateOptions } from '../src/main/types';

/**
 * Smart routing must be a shortcut for setting the options by hand, never a second layout.
 *
 * The routing switch only chooses between option presets (instrument mode, merge mode,
 * lane sharing, lead track). Once those options are resolved, the manual path and the
 * smart path run the same builder, so the two files must be identical block for block.
 * These tests resolve the options the router picked and rebuild the song by hand.
 *
 * Forced merges are not covered: the router only measures one when nothing else fits,
 * which needs a song where the same-instrument merge is itself too wide. It is unreachable
 * with the 13 pitched instruments the palette has, so `force` stays a manual-only choice.
 */

interface WrittenTrack {
  /** General MIDI program; alternates so the song classifies as multi-instrument. */
  program: number;
  notes: Array<{ midi: number; tick: number }>;
}

/** Variable-length quantity, the delta-time encoding MIDI uses. */
function vlv(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

/** One MTrk chunk with a program change and note on/off pairs. */
function trackChunk(track: WrittenTrack, channel: number): Buffer {
  const events: Array<{ tick: number; bytes: number[] }> = [
    { tick: 0, bytes: [0xc0 | channel, track.program] },
  ];
  for (const note of track.notes) {
    events.push({ tick: note.tick, bytes: [0x90 | channel, note.midi, 100] });
    events.push({ tick: note.tick + 60, bytes: [0x80 | channel, note.midi, 0] });
  }
  events.sort((a, b) => a.tick - b.tick);
  const out: number[] = [];
  let previous = 0;
  for (const event of events) {
    out.push(...vlv(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  const body = Buffer.from(out);
  const header = Buffer.from([
    0x4d,
    0x54,
    0x72,
    0x6b,
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
  ]);
  return Buffer.concat([header, body]);
}

/** @tonejs/midi cannot write program changes, so the wide fixtures are written by hand. */
function writeSong(path: string, tracks: WrittenTrack[]): void {
  const chunks = tracks.map((track, index) => trackChunk(track, index % 16));
  const header = Buffer.from([
    0x4d,
    0x54,
    0x68,
    0x64,
    0,
    0,
    0,
    6,
    0,
    1,
    (chunks.length >>> 8) & 0xff,
    chunks.length & 0xff,
    0x01,
    0xe0,
  ]);
  writeFileSync(path, Buffer.concat([header, ...chunks]));
}

/** Lanes deep enough (chords) that the hearing radius passes the 30-cell threshold. */
function chordSong(lanes: number): WrittenTrack[] {
  const tracks: WrittenTrack[] = [];
  for (let index = 0; index < lanes; index++) {
    const notes: Array<{ midi: number; tick: number }> = [];
    for (let bar = 0; bar < 6; bar++) {
      for (const midi of [60, 64, 67, 72]) notes.push({ midi, tick: bar * 480 });
    }
    tracks.push({ program: index % 2 === 0 ? 0 : 73, notes });
  }
  return tracks;
}

/** Many lanes, but no two tracks play at the same tick, so folding them is compact. */
function staggeredSong(lanes: number): WrittenTrack[] {
  const tracks: WrittenTrack[] = [];
  for (let index = 0; index < lanes; index++) {
    const notes: Array<{ midi: number; tick: number }> = [];
    for (let bar = 0; bar < 8; bar++) notes.push({ midi: 60 + (index % 12), tick: index * 48 + bar * 480 });
    tracks.push({ program: [0, 73, 40][index % 3]!, notes });
  }
  return tracks;
}

/** Everything that ends up in the file, without the creation timestamp. */
function layoutOf(result: ReturnType<typeof generate>['result']): string {
  return JSON.stringify({
    regions: result.regions.map((region) => ({
      name: region.name,
      trackIndex: region.trackIndex,
      position: region.position,
      size: region.size,
      blockCount: region.blockCount,
    })),
    placed: result.placed.map((entry) => [entry.trackIndex, entry.zBase, entry.tick, entry.actual, entry.x]),
    // Wall-clock timing differs between any two runs, so it cannot be part of the comparison.
    stats: { ...result.stats, elapsedMs: 0 },
    annotation: result.laneAnnotation,
    laneRide: result.laneRide,
    laneSharing: result.laneSharing,
    warnings: result.warnings.map((warning) => warning.code),
  });
}

/** The options a hand-picked run needs to reproduce the router's chosen merge. */
function manualOptions(mode: string): GenerateOptions {
  switch (mode) {
    case 'share':
      return { laneSharing: true };
    case 'same':
      return { laneSharing: true, mergeSameInstrument: true };
    case 'force':
      return { forceMergeSameInstrument: true };
    default:
      return { laneSharing: false };
  }
}

/**
 * Build a fixture for one case and run it. `narrow` is the checked-in 16-track song: it is
 * inside the compact radius, so the router leaves it unmerged and only the preset matters.
 */
function withSong<T>(kind: 'chords' | 'staggered' | 'narrow', run: (path: string) => T): T {
  if (kind === 'narrow') return run(resolve('test/fixtures/happy-birthday-16.mid'));
  const directory = mkdtempSync(join(tmpdir(), 'musicbox-equivalence-'));
  try {
    const path = join(directory, kind + '.mid');
    writeSong(path, kind === 'chords' ? chordSong(16) : staggeredSong(40));
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('smart routing is only an option preset', () => {
  const songs: Array<{ kind: 'chords' | 'staggered' | 'narrow'; label: string }> = [
    { kind: 'chords', label: 'chords' },
    { kind: 'staggered', label: 'staggered' },
    { kind: 'narrow', label: 'narrow' },
  ];

  for (const song of songs) {
    for (const dMax of [8, 14]) {
      for (const laneSharing of [true, false]) {
        it(
          'rebuilds the ' +
            song.label +
            ' song identically by hand (dMax ' +
            dMax +
            ', sharing ' +
            laneSharing +
            ')',
          () => {
            withSong(song.kind, (path) => {
              const smart = generate(path, { smartSelection: true, dMax, laneSharing, laneRide: true });
              expect(smart.result.success).toBe(true);
              const info = smart.result.smartSelection;
              expect(info).not.toBeNull();
              // Pinned so these cases cannot quietly stop covering a merge: the wide songs
              // share the lanes when sharing is on and merge by instrument when it is off,
              // and the narrow song is left alone.
              const expected = song.kind === 'narrow' ? 'off' : laneSharing ? 'share' : 'same';
              expect(info!.mergeMode).toBe(expected);
              const manual = generate(path, {
                ...manualOptions(info!.mergeMode),
                dMax,
                laneRide: true,
                instrumentMode: info!.instrumentMode,
              });
              expect(manual.result.success).toBe(true);
              // The hand-picked run has to land on the same lanes, not merely a similar file.
              expect(manual.result.stats.outputTrackCount).toBe(smart.result.stats.outputTrackCount);
              expect(layoutOf(manual.result)).toBe(layoutOf(smart.result));
            });
          },
        );
      }
    }
  }

  it('reports the same merge in the measurement as in the generated file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'musicbox-equivalence-measure-'));
    try {
      const input = join(directory, 'staggered.mid');
      writeSong(input, staggeredSong(40));
      const options = { dMax: 14, laneSharing: true, laneRide: true } as const;
      const smart = generate(input, { ...options, smartSelection: true });
      const info = smart.result.smartSelection!;
      // measureLayout() is what the configuration step shows before anything is written, so it
      // has to describe the same merge the router chose, and the hand-picked run has to match it.
      const smartMeasure = measureLayout(input, { ...options, smartSelection: true });
      const manualMeasure = measureLayout(input, {
        ...options,
        ...manualOptions(info.mergeMode),
        instrumentMode: info.instrumentMode,
      });
      expect(smartMeasure.trackCount).toBe(smart.result.stats.outputTrackCount);
      expect(smartMeasure.hearingRadius).toBe(info.radiusZ);
      expect(manualMeasure.shareOutcome).toBe(smartMeasure.shareOutcome);
      expect(manualMeasure.hearingRadius).toBe(smartMeasure.hearingRadius);
      expect(manualMeasure.sharedLanes).toBe(smartMeasure.sharedLanes);
      expect(manualMeasure.trackCount).toBe(smartMeasure.trackCount);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
