import { Midi } from '@tonejs/midi';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMidi as rawMidi, writeMidi } from 'midi-file';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_CONFIG, layout, layoutResolver } from '../src/core/layout';
import { buildTrack } from '../src/core/layout/track';
import { parseMidi } from '../src/core/midi/parse';
import { DEFAULT_REGIONS } from '../src/core/palette/pitchMap';
import { detectTrack } from '../src/core/palette/instrumentMap';
import { formatDuration, speedTable } from '../src/core/tempo/speed';
import { analyzeFile } from '../src/main/analyze';
import { encodeGeneration, generate, generateToFile, prepareGeneration } from '../src/main/generate';
import { buildPreview } from '../src/main/preview';
import { sanitizeGenerateOptions } from '../src/main/options';
import { song, songOfTracks } from './helpers/song';

function withMidi(midi: Midi, run: (file: string, folder: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'musicbox-audit-'));
  try {
    const file = join(folder, 'input.mid');
    writeFileSync(file, midi.toArray());
    run(file, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('generator audit regressions', () => {
  it.each([
    [8, 4000],
    [1, 40000],
  ])(
    'exports %i tracks of %i notes with annotations',
    (tracks, count) => {
      const midi = new Midi();
      for (let i = 0; i < tracks; i++) {
        const track = midi.addTrack();
        for (let j = 0; j < count; j++) {
          track.addNote({ midi: 60, ticks: j * 120, duration: 60 });
        }
      }
      withMidi(midi, (file) => {
        const { result, buffer } = generate(file);
        expect(result.success).toBe(true);
        expect(result.stats.noteBlockCount).toBe(tracks * count);
        expect(result.laneAnnotation).toBeDefined();
        expect(buffer?.length).toBeGreaterThan(0);
      });
    },
    20000,
  );

  it('detects an omitted program by name while retaining explicit programs and percussion', () => {
    const midi = new Midi();
    for (const [name, channel, program] of [
      ['Bass', 0, 0],
      ['Flute', 1, 0],
      ['Cow Bell', 2, 0],
      ['Bass', 3, 0],
      ['Other', 4, 33],
      ['Drums', 9, 0],
    ] as const) {
      const track = midi.addTrack();
      track.name = name;
      track.channel = channel;
      track.instrument.number = program;
      track.addNote({ midi: 60, ticks: 0, duration: 60 });
    }
    const raw = rawMidi(midi.toArray());
    raw.tracks = raw.tracks.map((track, i) =>
      i >= 1 && i <= 3 ? track.filter((event) => event.type !== 'programChange') : track,
    );
    const parsed = parseMidi(Uint8Array.from(writeMidi(raw)));
    expect(parsed.tracks.map((track) => track.program)).toEqual([undefined, undefined, undefined, 0, 33, 0]);
    expect(parsed.tracks.map((track) => detectTrack(track).native)).toEqual([
      'bass',
      'flute',
      'cow_bell',
      'harp',
      'bass',
      'drums',
    ]);
  });

  it('does not commit a new export over an existing file without explicit permission', () => {
    const midi = new Midi();
    midi.addTrack().addNote({ midi: 60, ticks: 0, duration: 60 });
    withMidi(midi, (file, folder) => {
      const target = join(folder, 'result.litematic');
      writeFileSync(target, 'existing');
      expect(() => generateToFile(file, target)).toThrow('EEXIST');
      expect(readFileSync(target, 'utf8')).toBe('existing');
      expect(readdirSync(folder).sort()).toEqual(['input.mid', 'result.litematic']);

      const replaced = generateToFile(file, target, {}, true);
      expect(replaced.success).toBe(true);
      expect(readFileSync(target)).toHaveLength(replaced.bytes);
      expect(readdirSync(folder).sort()).toEqual(['input.mid', 'result.litematic']);
    });
  });

  it('keeps a format-0 track split aligned with the original declarations', () => {
    const makeNote = (channel: number, midi: number) =>
      [
        { deltaTime: 0, type: 'noteOn', channel, noteNumber: midi, velocity: 80 },
        { deltaTime: 120, type: 'noteOff', channel, noteNumber: midi, velocity: 0 },
      ] as const;
    const bytes = writeMidi({
      header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'trackName', text: 'Bass', meta: true },
          ...makeNote(1, 48),
          { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 0 },
          ...makeNote(0, 60),
          { deltaTime: 0, type: 'programChange', channel: 1, programNumber: 73 },
          ...makeNote(1, 72),
          { deltaTime: 0, type: 'endOfTrack', meta: true },
        ],
      ],
    });
    expect(parseMidi(Uint8Array.from(bytes)).tracks.map((track) => [track.channel, track.program])).toEqual([
      [1, undefined],
      [0, 0],
      [1, 73],
    ]);
  });

  it('pairs notes by channel and pitch before separating programs', () => {
    const bytes = writeMidi({
      header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'trackName', text: 'Flute', meta: true },
          { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 0 },
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 120, type: 'programChange', channel: 0, programNumber: 73 },
          { deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 0, type: 'noteOn', channel: 1, noteNumber: 76, velocity: 100 },
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 72, velocity: 100 },
          { deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 72, velocity: 0 },
          { deltaTime: 0, type: 'noteOff', channel: 1, noteNumber: 76, velocity: 0 },
          { deltaTime: 0, type: 'endOfTrack', meta: true },
        ],
      ],
    });
    expect(
      parseMidi(Uint8Array.from(bytes)).tracks.map((t) => [t.name, t.program, t.notes.map((n) => n.midi)]),
    ).toEqual([
      ['Flute', 0, [60]],
      ['Flute', 73, [72]],
      ['Flute', undefined, [76]],
    ]);
  });

  it('rejects the independent patterns of SMF format 2', () => {
    const bytes = writeMidi({
      header: { format: 2, numTracks: 2, ticksPerBeat: 480 },
      tracks: [[], []],
    });
    expect(() => parseMidi(Uint8Array.from(bytes))).toThrow('MIDI_UNSUPPORTED_FORMAT');
  });

  it('preserves every excluded track within the SMF track-ID capacity', () => {
    const excludeTracks = Array.from({ length: 4097 }, (_, index) => index);
    expect(sanitizeGenerateOptions({ excludeTracks }).excludeTracks).toEqual(excludeTracks);
  });

  it('reports the normal redstone startup delay in the result as well as the warning', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    for (const ticks of [0, 480]) track.addNote({ midi: 60, ticks, durationTicks: 60 });
    withMidi(midi, (file) => {
      const result = generate(file).result;
      expect(result.placed.map((note) => note.actual)).toEqual([2, 12]);
      expect(result.stats.startupDelayTicks).toBe(2);
      expect(result.stats.tickCount).toBe(12);
    });
  });

  it('fails the check when the MIDI title will not fit in NBT', () => {
    const midi = new Midi();
    midi.name = 'x'.repeat(66000);
    midi.addTrack().addNote({ midi: 60, ticks: 0, durationTicks: 60 });
    withMidi(midi, (file) => {
      for (const commandPlayback of [false, true]) {
        const prepared = prepareGeneration(file, { commandPlayback });
        expect(prepared.result.success).toBe(false);
        expect(prepared.result.error).toContain('66000');
        expect(prepared.encode).toBeUndefined();
      }
    });
  });

  it.each([false, true])(
    'advises the pack from surviving piano slots (commandPlayback = %s)',
    (commandPlayback) => {
      const midi = new Midi();
      const track = midi.addTrack();
      for (const [index, pitch] of [36, 60, 84, 110].entries()) {
        track.addNote({ midi: pitch, ticks: index * 480, durationTicks: 60 });
      }
      withMidi(midi, (file) => {
        const options = { commandPlayback, outOfRange: 'drop', smartSelection: true } as const;
        const result = generate(file, options).result;
        expect(result.success).toBe(true);
        expect(result.outOfRangeNotes).toBe(1);
        expect(result.resourcePackRecommended).toBe(true);
        expect(result.smartSelection?.resourcePackRecommended).toBe(true);
      });
    },
  );

  it('keeps the lead and its lane sign on a track that sounds', () => {
    const midi = new Midi();
    for (const [channel, pitch, velocity] of [
      [0, 60, 0.25],
      [9, 127, 1],
    ] as const) {
      const track = midi.addTrack();
      track.channel = channel;
      track.addNote({ midi: pitch, ticks: 0, durationTicks: 60, velocity });
    }
    withMidi(midi, (file) => {
      const result = generate(file, { smartSelection: true, leadTrackIndex: 1 }).result;
      expect(result.success).toBe(true);
      expect(result.smartSelection?.leadTrackIndex).toBe(0);
      expect(result.mergedAllTracks).toBe(false);
      expect(result.laneAnnotation?.signs.map(({ role }) => role)).toEqual(['lead']);
    });
  });

  it('offers only world tick rates accepted by the target Minecraft version', () => {
    expect(speedTable(12, [0.5, 0.75, 1, 10_001], 1).map(({ tickRate }) => tickRate)).toEqual([1]);
  });

  it('prepares checks and routing advice without encoding bytes', () => {
    const midi = new Midi();
    midi.addTrack().addNote({ midi: 60, ticks: 0, duration: 60 });
    withMidi(midi, (file) => {
      const stages: string[] = [];
      const check = prepareGeneration(file, {}, false, (stage) => stages.push(stage));
      expect(check.result.success).toBe(true);
      expect(check.result.bytes).toBe(0);
      expect(stages).toEqual(['read', 'layout', 'preview']);
      expect(encodeGeneration(check, (stage) => stages.push(stage)).buffer?.length).toBeGreaterThan(0);
      expect(stages.at(-1)).toBe('encode');
      const route = prepareGeneration(file, { smartSelection: true }, true);
      expect(route.result.smartSelection).toBeDefined();
      expect(route.encode).toBeUndefined();
    });
  });

  it('checks the block budget before allocating a long row of delay cells', () => {
    expect(() =>
      buildTrack({
        trackIndex: 0,
        zBase: 0,
        notes: [{ tick: 800, midi: 60 }],
        config: DEFAULT_LAYOUT_CONFIG,
        regions: DEFAULT_REGIONS,
        resolve: layoutResolver(),
        blockBudget: 40,
      }),
    ).toThrow('LAYOUT_BLOCK_LIMIT');
  });

  it('stores occupied preview cells for layouts with large empty gaps', () => {
    const block = { pos: { x: 0, y: 0, z: 0 }, block: 'minecraft:stone' };
    const result = buildPreview(
      [0, 1000].map((x) => ({
        trackIndex: 0,
        position: { x, y: 0, z: x },
        size: { x: 1, y: 1, z: 1 },
        blocks: [block],
      })),
    );
    expect(result.size).toEqual({ x: 1001, y: 1, z: 1001 });
    expect(result.baseCells).toEqual({ 0: 'minecraft:stone', 1002000: 'minecraft:stone' });
    expect(Object.keys(result.wireCells)).toHaveLength(0);
  });

  it('reports per-note range shifts for command playback', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 18, ticks: 0, duration: 60 });
    track.addNote({ midi: 60, ticks: 480, duration: 60 });
    withMidi(midi, (file) => {
      const options = { outOfRange: 'octave' } as const;
      const redstone = generate(file, options).result;
      const command = generate(file, { ...options, commandPlayback: true }).result;
      expect(command.success).toBe(true);
      expect(command.rangeShift).toEqual({ notes: 1, maxSemitones: 12 });
      expect(command.rangeShift).toEqual(redstone.rangeShift);
    });
  });

  it('only accepts the TPS range exposed by the interface', () => {
    for (const bad of [0.000001, 1.5, 101, 1000000]) {
      expect(sanitizeGenerateOptions({ baseTps: bad })).toEqual({});
    }
    for (const baseTps of [1, 20, 100]) {
      expect(sanitizeGenerateOptions({ baseTps })).toEqual({ baseTps });
    }
  });

  it('reports import and export tick bounds with their own scales', () => {
    const midi = new Midi();
    midi.addTrack().addNote({ midi: 60, ticks: 480, duration: 60 });
    withMidi(midi, (file) => {
      const imported = analyzeFile(file);
      const exported = generate(file, { baseTps: 40 }).result;
      expect(imported.song.summaryTps).toBe(20);
      expect(exported.song.summaryTps).toBe(40);
      expect(exported.tracks[0]!.maxTick).toBe(2 * imported.tracks[0]!.maxTick);
    });
  });

  it('rounds the duration before splitting minutes and seconds', () => {
    expect([59.94, 59.97, 119.97].map(formatDuration)).toEqual(['0:59.9', '1:00.0', '2:00.0']);
  });

  it('rejects an invalid dMax before calculating lane coordinates', () => {
    expect(() => layout(song([{ tick: 0, midi: 60 }]), { config: { dMax: NaN } })).toThrow('dMax');
  });

  it('does not widen the X plan when a fourth chord note is dropped', () => {
    const played = [
      { tick: 2, midi: 60 },
      { tick: 2, midi: 61 },
      { tick: 2, midi: 62 },
      { tick: 4, midi: 60 },
      { tick: 10, midi: 60 },
    ];
    const other = [2, 4, 10].map((tick) => ({ tick, midi: 60 }));
    const baseline = layout(songOfTracks([played, other]), { outOfRange: 'drop' });
    const withDrop = layout(songOfTracks([[...played, { tick: 2, midi: 0 }], other]), { outOfRange: 'drop' });
    expect(withDrop.placed).toEqual(baseline.placed);
    expect(withDrop.warnings).toContainEqual(expect.objectContaining({ code: 'OUT_OF_RANGE', midi: 0 }));
  });

  it('aligns the first chord of a borrowing lane that still has repeater delay left', () => {
    const ticks = [
      [
        0, 2, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 58,
        60, 64, 66, 68, 70, 0,
      ],
      [4, 12, 14, 16, 18, 24, 26, 28, 32, 34, 36, 38, 40, 44, 48, 54, 56, 60, 62, 64, 66],
      [0, 4, 6, 12, 16, 18, 24, 26, 32, 46, 52, 54, 56, 60, 62, 66],
      [66, 70],
    ];
    const music = songOfTracks(ticks.map((row, i) => row.map((tick) => ({ tick, midi: 55 + i }))));
    const built = layout(music, { laneRide: true });
    expect(built.tracks[3]?.ride).toBeDefined();
    const columns = built.tracks.map((track) => track.taps.find((tap) => tap.t === 33)?.notes[0]?.notePos.x);
    expect(columns.every((x) => x === columns[0])).toBe(true);
    expect(built.warnings.some((warning) => warning.code === 'SPATIAL_DRIFT')).toBe(false);
  });
});
