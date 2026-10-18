import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCommandPlayback } from '../src/core/command';
import { collectEvents } from '../src/core/command/schedule';
import { DEFAULT_LAYOUT_CONFIG, layout } from '../src/core/layout/index';
import { validateForcedTrack } from '../src/core/layout/forcedValidation';
import { sliceRegions } from '../src/core/layout/regions';
import { parseLitematic } from '../src/core/litematic/build';
import { parseMidi } from '../src/core/midi/parse';
import { assignTracks, voicingMap, type TrackAssignment } from '../src/core/palette/assignment';
import { INSTRUMENTS } from '../src/core/palette/instruments';
import { generate } from '../src/main/generate';

/**
 * The sixteen-track fixture end to end.
 *
 * This is the song that motivated the feature: one MIDI track per note-block
 * instrument, including the three fixed-pitch drums and a cow bell on channel 9.
 */

const FIXTURE = 'test/fixtures/happy-birthday-16.mid';
const NOTE_COUNT = 346;

function assignmentsFor(mode: 'native' | 'extended'): TrackAssignment[] {
  return assignTracks(parseMidi(readFileSync(FIXTURE)), mode);
}

function byTrack(assignments: TrackAssignment[]): Record<number, TrackAssignment> {
  const map: Record<number, TrackAssignment> = {};
  for (const assignment of assignments) map[assignment.trackIndex] = assignment;
  return map;
}

function countNoteBlocks(result: ReturnType<typeof layout>): {
  total: number;
  byTrack: Map<number, Map<string, number>>;
} {
  let total = 0;
  const bySource = new Map<number, Map<string, number>>();
  for (const track of result.tracks) {
    let counts = bySource.get(track.trackIndex);
    if (!counts) {
      counts = new Map();
      bySource.set(track.trackIndex, counts);
    }
    for (const block of track.placements) {
      if (block.block !== 'minecraft:note_block') continue;
      total += 1;
      const instrument = block.props?.instrument ?? '?';
      counts.set(instrument, (counts.get(instrument) ?? 0) + 1);
    }
  }
  return { total, byTrack: bySource };
}

function countParsedNoteBlocks(buffer: Buffer): { total: number; instruments: Set<string> } {
  const parsed = parseLitematic(buffer);
  let total = 0;
  const instruments = new Set<string>();
  for (const region of parsed.regions) {
    for (const id of region.indices) {
      const state = region.palette[id];
      if (state?.name !== 'minecraft:note_block') continue;
      total += 1;
      instruments.add(state.properties?.instrument ?? '?');
    }
  }
  return { total, instruments };
}

describe('16-track fixture in native mode', () => {
  const song = parseMidi(readFileSync(FIXTURE));
  const assignments = assignmentsFor('native');
  const result = layout(song, { assignments: byTrack(assignments) });

  it('lays out one track per source track and keeps every note', () => {
    expect(result.tracks).toHaveLength(16);
    expect(countNoteBlocks(result).total).toBe(NOTE_COUNT);
  });

  it('writes every source track with its own instrument and base block', () => {
    const expected: Array<[number, string, number]> = [
      [0, 'harp', 27],
      [1, 'flute', 12],
      [2, 'chime', 13],
      [3, 'bit', 6],
      [4, 'pling', 8],
      [5, 'xylophone', 24],
      [6, 'iron_xylophone', 28],
      [7, 'bell', 4],
      [8, 'guitar', 70],
      [9, 'banjo', 15],
      [10, 'bass', 25],
      [11, 'didgeridoo', 13],
      [12, 'basedrum', 13],
      [13, 'snare', 12],
      [14, 'hat', 72],
      [15, 'cow_bell', 4],
    ];
    const counts = countNoteBlocks(result).byTrack;
    for (const [trackIndex, instrument, notes] of expected) {
      expect(counts.get(trackIndex), `track ${trackIndex}`).toEqual(new Map([[instrument, notes]]));
    }
  });

  it('puts each note on the base block that selects its instrument', () => {
    for (const track of result.tracks) {
      const assignment = assignments.find((entry) => entry.trackIndex === track.trackIndex)!;
      const voicing = assignment.voicing;
      if (voicing.kind !== 'instrument') continue;
      for (const tap of track.taps) {
        for (const note of tap.notes) {
          expect(note.block, `track ${track.trackIndex}`).toBe(INSTRUMENTS[voicing.instrument].baseBlock);
        }
      }
    }
  });

  it('leaves exactly one empty Z row between adjacent tracks', () => {
    const ranges = result.tracks
      .map((track) => {
        const zs = track.placements.map((p) => p.pos.z);
        return { min: Math.min(...zs), max: Math.max(...zs) };
      })
      .sort((a, b) => a.min - b.min);
    const gaps = ranges.slice(1).map((range, index) => range.min - ranges[index]!.max - 1);
    expect(gaps).toEqual(Array.from({ length: gaps.length }, () => 1));
  });

  it('reports the octave shifts and residual notes it had to make', () => {
    const octave = result.warnings.filter((warning) => warning.code === 'INSTRUMENT_OCTAVE_SHIFT');
    expect(octave).toHaveLength(7);
    const residual = result.warnings.filter((warning) => warning.code === 'OUT_OF_RANGE');
    expect(residual).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.code === 'INSTRUMENT_SUBSTITUTED')).toBe(false);
    expect(result.warnings.some((warning) => warning.code === 'DRUM_NOTES_DROPPED')).toBe(false);
  });

  it('reports no piano range, because no track uses the five slots', () => {
    expect(assignments.some((assignment) => assignment.voicing.kind === 'pitch')).toBe(false);
  });
});

describe('16-track fixture in extended mode', () => {
  const song = parseMidi(readFileSync(FIXTURE));
  const assignments = assignmentsFor('extended');
  const result = layout(song, { assignments: byTrack(assignments) });

  it('keeps every note and substitutes the four occupied instruments', () => {
    expect(countNoteBlocks(result).total).toBe(NOTE_COUNT);
    const substituted = result.warnings.filter((warning) => warning.code === 'INSTRUMENT_SUBSTITUTED');
    expect(substituted).toHaveLength(4);
  });

  it('sends the piano track to the five-slot range and keeps free instruments native', () => {
    const info = new Map(result.trackInstruments.map((entry) => [entry.trackIndex, entry]));
    expect(info.get(0)?.effective).toBe('piano');
    expect(info.get(1)?.effective).toBe('bit');
    expect(info.get(7)?.effective).toBe('chime');
    expect(info.get(8)?.effective).toBe('banjo');
    expect(info.get(10)?.effective).toBe('didgeridoo');
    expect(info.get(15)?.effective).toBe('drums');
  });

  it('merges by effective instrument, so the 16 source tracks become 12 spines', () => {
    const merged = layout(song, {
      assignments: byTrack(assignments),
      mergeSameInstrument: true,
    });
    // guitar→banjo and the native banjo share one spine; flute→bit joins bit;
    // bass→didgeridoo joins didgeridoo; bell→chime joins chime.
    expect(merged.tracks).toHaveLength(12);
    expect(countNoteBlocks(merged).total).toBe(NOTE_COUNT);
  });
});

describe('the generated litematic', () => {
  for (const mode of ['native', 'extended'] as const) {
    it(`contains every note with a valid instrument in ${mode} mode`, () => {
      const { result, buffer } = generate(FIXTURE, { instrumentMode: mode });
      expect(result.success).toBe(true);
      expect(buffer).not.toBeNull();
      expect(result.trackInstruments).toHaveLength(16);

      const parsed = countParsedNoteBlocks(buffer!);
      expect(parsed.total).toBe(NOTE_COUNT);
      if (mode === 'native') {
        expect(parsed.instruments.size).toBe(16);
        expect(result.pitchRange).toBeUndefined();
      } else {
        expect(parsed.instruments.has('harp')).toBe(true);
        expect(parsed.instruments.has('banjo')).toBe(true);
        expect(parsed.instruments.has('basedrum')).toBe(true);
        expect(result.pitchRange).toEqual({ low: 30, high: 102 });
      }
    });
  }
});

describe('command playback', () => {
  it('uses the real instrument sound events and a fixed pitch for drums', () => {
    const song = parseMidi(readFileSync(FIXTURE));
    const assignments = assignmentsFor('native');
    const { events } = collectEvents(song, {
      baseTps: 20,
      outOfRange: 'warn',
      assignments: voicingMap(assignments),
    });
    expect(events).toHaveLength(NOTE_COUNT);

    const kick = events.find((event) => event.instrument === 'basedrum')!;
    expect(kick.sound).toBe('minecraft:block.note_block.basedrum');
    expect(kick.pitch).toBe('1');
    expect(events.some((event) => event.sound === 'minecraft:block.note_block.harp')).toBe(true);
    expect(events.some((event) => event.sound === 'minecraft:block.note_block.chime')).toBe(true);
  });

  it('reports every instrument it used and stays within a normal chain budget', () => {
    const song = parseMidi(readFileSync(FIXTURE));
    const assignments = assignmentsFor('native');
    const compiled = buildCommandPlayback(song, {
      assignments: voicingMap(assignments),
      commandChainBudget: 65536,
    });
    expect(compiled.info.playedNotes).toBe(NOTE_COUNT);
    expect(compiled.info.instruments).toHaveLength(16);
    expect(compiled.info.chainLength).toBeLessThan(65536);
  });
});

describe('forced single-spine merge on the 16-track fixture', () => {
  const song = parseMidi(readFileSync(FIXTURE));
  const assignments = assignmentsFor('native');
  const result = layout(song, {
    assignments: byTrack(assignments),
    forceMergeSameInstrument: true,
  });

  it('puts all sixteen source tracks on one connected spine', () => {
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]!.trackIndex).toBe(-1);
    expect(countNoteBlocks(result).total).toBe(NOTE_COUNT);
    expect(result.trackInstruments).toHaveLength(16);
    expect(new Set(result.placed.map((entry) => entry.trackIndex)).size).toBe(16);
    expect(sliceRegions(result)).toHaveLength(1);
  });

  it('passes the block-graph audit and still exports one region', () => {
    const track = result.tracks[0]!;
    const audit = validateForcedTrack(
      track,
      DEFAULT_LAYOUT_CONFIG.circuitY,
      track.taps.map((tap) => tap.t * 2 + result.startupDelayTicks!),
    );
    expect(audit.noteCount).toBe(NOTE_COUNT);

    const generated = generate(FIXTURE, {
      instrumentMode: 'native',
      forceMergeSameInstrument: true,
    });
    expect(generated.result.success).toBe(true);
    expect(generated.result.stats.outputTrackCount).toBe(1);
    expect(generated.result.stats.noteBlockCount).toBe(NOTE_COUNT);
    expect(parseLitematic(generated.buffer!).regions).toHaveLength(1);
  });
});
