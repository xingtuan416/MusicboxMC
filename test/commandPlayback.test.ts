import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import {
  buildCommandPlayback,
  commandChainPosition,
  COMMAND_STRUCTURE_WARNING_BLOCKS,
} from '../src/core/command';
import { buildLitematic, parseLitematic, blockIndex, type RegionData } from '../src/core/litematic/build';
import { TagType, nbt, type NbtCompound } from '../src/core/nbt/tag';
import { generate, generateToFile } from '../src/main/service';
import type { SongModel } from '../src/core/midi/types';
import { mapPitch } from '../src/core/palette/pitchMap';
import { buildSong, denseSong } from './helpers/song';
import { expectCoreError } from './helpers/errors';

function stackedSong(ticks: number[]): SongModel {
  return buildSong({
    name: 'command-test',
    durationSec: 10,
    tracks: [{ instrument: 'piano', notes: ticks.map((tick, i) => ({ tick, midi: 48 + (i % 24) })) }],
  });
}

/**
 * `frames` quantised frames with `notesPerFrame` notes each, three game ticks apart.
 *
 * The pitch pool is fixed at 48..67, so songs with different `notesPerFrame` share an
 * **identical** set of voices, frame count and per-voice slot count - only the total
 * note count differs. That is exactly the control needed to show that the structure
 * must be independent of the note count.
 */
function frameSong(frames: number, notesPerFrame: number): SongModel {
  const notes: SongModel['tracks'][number]['notes'] = [];
  for (let frame = 0; frame < frames; frame++) {
    for (let k = 0; k < notesPerFrame; k++) {
      notes.push({
        midi: 48 + ((frame + k) % 20),
        timeSec: (frame * 3) / 20,
        durationSec: 0.1,
        velocity: 1,
        channel: 0,
      });
    }
  }
  return {
    ...stackedSong([]),
    tracks: [{ index: 0, name: 'piano', channel: 0, percussion: false, instrument: 'piano', notes }],
  };
}

function text(entity: NbtCompound, field: string): string {
  const tag = entity.value.get(field);
  if (tag?.type !== TagType.String) throw new Error(`Missing string ${field}`);
  return tag.value;
}

function number(entity: NbtCompound, field: string): number {
  const tag = entity.value.get(field);
  if (tag?.type !== TagType.Int && tag?.type !== TagType.Byte) throw new Error(`Missing number ${field}`);
  return tag.value;
}

const meta = { name: 'commands', author: 'test', description: '', dataVersion: 3700, version: 6 };

function storedFrames(entities: NbtCompound[]): number[][] {
  return entities.flatMap((entity) => {
    const tag = entity.value.get('Command');
    if (tag?.type !== TagType.String) return [];
    const match = tag.value.match(/ chunk set value (\[.*\])$/);
    return match ? (JSON.parse(match[1]!) as number[][]) : [];
  });
}

/** Walk the exported count queue and slot guards, not the compiler's input events. */
function scheduledNotes(
  entities: NbtCompound[],
  totalTicks: number,
): Array<{ tick: number; sound: string; pitch: string }> {
  const queue = storedFrames(entities);
  const slots = entities.flatMap((entity) => {
    const tag = entity.value.get('Command');
    if (tag?.type !== TagType.String) return [];
    const match = tag.value.match(
      /if score #v(\d+) \w+ matches (\d+)\.\. as @a at @s run playsound (\S+) record @s ~ ~ ~ 1 (\S+)$/,
    );
    return match
      ? [{ voice: Number(match[1]), threshold: Number(match[2]), sound: match[3]!, pitch: match[4]! }]
      : [];
  });
  const heard: Array<{ tick: number; sound: string; pitch: string }> = [];
  for (let tick = 0; tick <= totalTicks; tick++) {
    const frame = queue[0];
    if (!frame || frame[0] !== tick) continue;
    for (const slot of slots) {
      if (frame[slot.voice + 1]! >= slot.threshold)
        heard.push({ tick, sound: slot.sound, pitch: slot.pitch });
    }
    queue.shift();
  }
  expect(queue).toHaveLength(0);
  return heard;
}

describe('command playback', () => {
  it('folds a 65536-step chain into adjacent 3D cells without crossings', () => {
    const seen = new Set<string>();
    let prev = commandChainPosition(0);
    for (let i = 0; i < 65536; i++) {
      const pos = commandChainPosition(i);
      const key = `${pos.x},${pos.y},${pos.z}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (i) expect(Math.abs(pos.x - prev.x) + Math.abs(pos.y - prev.y) + Math.abs(pos.z - prev.z)).toBe(1);
      expect(pos.x).toBeLessThan(32);
      expect(pos.z).toBeLessThan(35);
      prev = pos;
    }
  });

  it.each([1, 31, 32, 470, 617])(
    'retains %i simultaneous notes without redstone limits or per-note delays',
    (n) => {
      const result = buildCommandPlayback(stackedSong(Array(n).fill(0)));
      const commands = result.region.tileEntities!.filter(
        (entity) => text(entity, 'id') === 'minecraft:command_block',
      );
      const plays = commands
        .map((entity) => text(entity, 'Command'))
        .filter((command) => command.includes('playsound'));
      expect(plays).toHaveLength(n);
      expect(
        plays.every((command) => command.includes('= #next') && command.includes('record @s ~ ~ ~')),
      ).toBe(true);
      expect(scheduledNotes(result.region.tileEntities!, result.totalTicks)).toHaveLength(n);
      expect(result.info.peakNotes).toBe(n);
      expect(result.region.blocks.some((block) => block.state.name === 'minecraft:note_block')).toBe(false);
      expect(result.info.reusableSlots).toBe(n);
    },
  );

  it('uses one game-tick clock, including odd ticks, zero and initial rests', () => {
    for (const ticks of [
      [0, 0, 1, 2, 7],
      [5, 5, 6, 20],
    ]) {
      const result = buildCommandPlayback(stackedSong(ticks));
      const entities = result.region.tileEntities!;
      const commands = entities
        .filter((entity) => text(entity, 'id') === 'minecraft:command_block')
        .map((entity) => text(entity, 'Command'));
      expect(commands).toContain(`scoreboard players set #tick ${result.info.objective} -1`);
      expect(commands[0]).toContain('players add #tick');
      const heard = scheduledNotes(entities, result.totalTicks).map((note) => note.tick);
      expect(heard).toEqual(ticks);
      expect(commands.at(-1)).toContain('stopsound'); // Stop controller terminates with sound cleanup.
      expect(
        commands.some(
          (command) =>
            command.includes('unless data storage') &&
            command.includes('frames[0] run scoreboard players set #playing'),
        ),
      ).toBe(true);
    }
  });

  it('exports a physical chain whose facings follow all horizontal/vertical turns', () => {
    const result = buildCommandPlayback(stackedSong(Array(2300).fill(0)));
    const blocks = new Map(result.region.blocks.map((block) => [`${block.x},${block.y},${block.z}`, block]));
    const move: Record<string, [number, number, number]> = {
      east: [1, 0, 0],
      west: [-1, 0, 0],
      north: [0, 0, -1],
      south: [0, 0, 1],
      up: [0, 1, 0],
    };
    let pos = { ...result.info.clock };
    for (let i = 0; i <= result.info.chainLength; i++) {
      const local = { x: pos.x - result.region.position.x, y: pos.y, z: pos.z - result.region.position.z };
      const block = blocks.get(`${local.x},${local.y},${local.z}`)!;
      expect(block.state.name).toBe(
        i === 0 ? 'minecraft:repeating_command_block' : 'minecraft:chain_command_block',
      );
      expect(block.state.properties!.conditional).toBe('false');
      const delta = move[block.state.properties!.facing!]!;
      pos = { x: pos.x + delta[0], y: pos.y + delta[1], z: pos.z + delta[2] };
    }
  });

  it('reuses slots over multiple frames without deduplicating same-voice multiplicity', () => {
    const ticks = Array.from({ length: 1800 }, (_, i) => Math.floor(i / 70) * 3);
    const result = buildCommandPlayback(stackedSong(ticks));
    const parsed = parseLitematic(buildLitematic([result.region], meta)).regions[0]!;
    const heard = scheduledNotes(parsed.tileEntities, result.totalTicks);
    expect(heard.map((note) => note.tick)).toEqual(ticks);
    expect(result.info.reusableSlots).toBeLessThan(100);
    expect(result.commandBlockCount).toBeLessThan(150);
    expect(
      storedFrames(parsed.tileEntities)
        .flatMap((frame) => frame.slice(1))
        .reduce((sum, count) => sum + count, 0),
    ).toBe(1800);
    const sort = (notes: typeof heard) =>
      notes.map((note) => `${note.tick}|${note.sound}|${note.pitch}`).sort();
    const expected = stackedSong(ticks).tracks[0]!.notes.map((note) => {
      const mapped = mapPitch(note.midi);
      return {
        tick: Math.round(note.timeSec * 20),
        sound: `minecraft:block.note_block.${mapped.instrument}`,
        pitch: Math.pow(2, (mapped.note - 12) / 12)
          .toFixed(8)
          .replace(/0+$/, '')
          .replace(/\.$/, ''),
      };
    });
    expect(sort(heard)).toEqual(sort(expected));
  });

  it('keeps the player proportional to frames/voices/slots instead of the note count', () => {
    // 20x the notes with identical frames, voices and slots: the player has to match on
    // every one of them.
    const sparse = buildCommandPlayback(frameSong(400, 1));
    const dense = buildCommandPlayback(frameSong(400, 20));
    expect(sparse.info.playedNotes).toBe(400);
    expect(dense.info.playedNotes).toBe(8000);
    for (const key of ['scheduledEvents', 'distinctVoices', 'reusableSlots', 'chainLength'] as const) {
      expect(dense.info[key]).toBe(sparse.info[key]);
    }
    expect(dense.commandBlockCount).toBe(sparse.commandBlockCount);
    expect(dense.region.size).toEqual(sparse.region.size);
    // 8000 notes is still a small player; the per-note compiler put a command block on
    // every single one.
    expect(dense.commandBlockCount).toBeLessThan(dense.info.playedNotes / 50);
    expect(buildLitematic([dense.region], meta).length).toBeLessThan(32 * 1024);
    expect(dense.warnings.map((warning) => warning.code)).not.toContain('COMMAND_STRUCTURE_SIZE');
  });

  it('warns before export when the command structure itself is oversized', () => {
    const healthy = buildCommandPlayback(stackedSong(Array(2300).fill(0)));
    expect(healthy.commandBlockCount).toBeLessThanOrEqual(COMMAND_STRUCTURE_WARNING_BLOCKS);
    expect(healthy.warnings.map((warning) => warning.code)).not.toContain('COMMAND_STRUCTURE_SIZE');

    // 5000 notes on one tick means 5000 reusable slots, so the structure itself is out
    // of hand - but it is still valid, so warn rather than refuse.
    const oversized = buildCommandPlayback(stackedSong(Array(5000).fill(0)));
    expect(oversized.commandBlockCount).toBeGreaterThan(COMMAND_STRUCTURE_WARNING_BLOCKS);
    expect(oversized.info.playedNotes).toBe(5000);
    expect(oversized.warnings).toContainEqual({
      code: 'COMMAND_STRUCTURE_SIZE',
      commandBlocks: oversized.commandBlockCount,
      limit: COMMAND_STRUCTURE_WARNING_BLOCKS,
    });
  });

  it('preserves mapping, octave transposition, exclusions and drop policy without changing the legacy layout', () => {
    const source = stackedSong([0, 1]);
    source.tracks[0]!.notes[0]!.midi = 10;
    source.tracks.push({ ...source.tracks[0]!, index: 1, notes: [source.tracks[0]!.notes[1]!] });
    const result = buildCommandPlayback(source, {
      outOfRange: 'drop',
      excludeTracks: [1],
      transpose: { 0: 1 },
    });
    expect(result.info.playedNotes).toBe(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'OUT_OF_RANGE', midi: 10, action: 'drop' }),
    );
    const command = result.region
      .tileEntities!.map((entity) => entity.value.get('Command'))
      .find((tag) => tag?.type === TagType.String && tag.value.includes('playsound'));
    expect(command?.value).toContain('minecraft:block.note_block.harp');
    expectCoreError(() => buildCommandPlayback(source, { excludeTracks: [0, 1] }), 'COMMAND_NO_NOTES');
  });

  it('validates timing, per-world chain budgets and sound pressure', () => {
    expectCoreError(
      () => buildCommandPlayback(stackedSong([0]), { baseTps: Infinity }),
      'COMMAND_INVALID_TPS',
    );
    // A budget outside the accepted range is rejected up front...
    expectCoreError(
      () => buildCommandPlayback(stackedSong([0]), { commandChainBudget: 0 }),
      'COMMAND_INVALID_BUDGET',
    );
    // ...while a valid but too-small budget fails later, once the chain length is
    // known. These used to be one assertion matching the word "budget", which
    // appeared in both messages and therefore never distinguished them.
    expectCoreError(
      () => buildCommandPlayback(stackedSong([0]), { commandChainBudget: 3 }),
      'COMMAND_CHAIN_TOO_LONG',
    );
    const minimum = buildCommandPlayback(stackedSong([0])).info.chainLength + 1;
    expect(() => buildCommandPlayback(stackedSong([0]), { commandChainBudget: minimum })).not.toThrow();
    expectCoreError(() => buildCommandPlayback(stackedSong([NaN])), 'COMMAND_TIME_OUT_OF_RANGE');
    expectCoreError(() => buildCommandPlayback(stackedSong([2147483647])), 'COMMAND_TIME_OUT_OF_RANGE');
    expect(buildCommandPlayback(stackedSong(Array(32).fill(0))).warnings).toContainEqual({
      code: 'COMMAND_SOUND_PRESSURE',
      peakNotes: 32,
    });
  });

  it('roundtrips all command/sign NBT and rejects orphaned, duplicate or out-of-bounds entities', () => {
    const result = buildCommandPlayback(stackedSong([0, 1, 1]));
    const parsed = parseLitematic(buildLitematic([result.region], meta)).regions[0]!;
    expect(parsed.tileEntities).toEqual(result.region.tileEntities);
    for (const entity of parsed.tileEntities) {
      const id =
        parsed.indices[
          blockIndex(
            number(entity, 'x'),
            number(entity, 'y'),
            number(entity, 'z'),
            parsed.size.x,
            parsed.size.z,
          )
        ]!;
      expect(parsed.palette[id]!.name).not.toBe('minecraft:air');
      if (text(entity, 'id') === 'minecraft:command_block') {
        expect(number(entity, 'TrackOutput')).toBe(0);
        expect(number(entity, 'auto')).toBe(
          parsed.palette[id]!.name === 'minecraft:chain_command_block' ? 1 : 0,
        );
      }
    }
    const entity = nbt.compound({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) });
    const region: RegionData = {
      position: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 },
      blocks: [],
      tileEntities: [entity],
    };
    expectCoreError(() => buildLitematic([region], meta), 'LITEMATIC_ENTITY_WITHOUT_BLOCK');
    region.blocks.push({ x: 0, y: 0, z: 0, state: { name: 'minecraft:command_block' } });
    region.tileEntities!.push(entity);
    expectCoreError(() => buildLitematic([region], meta), 'LITEMATIC_DUPLICATE_ENTITY');
    region.tileEntities = [nbt.compound({ x: nbt.int(1), y: nbt.int(0), z: nbt.int(0) })];
    expectCoreError(() => buildLitematic([region], meta), 'LITEMATIC_ENTITY_OUT_OF_BOUNDS');
  });

  it('integrates with service, reports mode correctly and does not overwrite files on failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'musicbox-command-'));
    try {
      const midi = new Midi();
      midi.addTrack().addNote({ midi: 60, time: 0, duration: 0.1 });
      const input = join(directory, 'input.mid');
      const output = join(directory, 'output.litematic');
      writeFileSync(input, Buffer.from(midi.toArray()));
      const command = generateToFile(input, output, {
        commandPlayback: true,
        forceMergeSameInstrument: true,
        dMax: 1,
      });
      expect(command.success).toBe(true);
      expect(command.playbackMode).toBe('command');
      expect(command.stats.noteBlockCount).toBe(0);
      expect(command.commandPlayback!.playedNotes).toBe(1);
      expect(parseLitematic(readFileSync(output)).regions[0]!.tileEntities.length).toBeGreaterThan(0);
      const legacy = generate(input).result;
      expect(legacy.playbackMode).toBe('redstone');
      expect(legacy.stats.noteBlockCount).toBe(1);
      const before = readFileSync(output);
      expect(generateToFile(input, output, { commandPlayback: true, commandChainBudget: 1 }).success).toBe(
        false,
      );
      expect(readFileSync(output)).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('compiles a dense multi-track song into a compact player without dropping notes', () => {
    const source = denseSong();
    const noteCount = source.tracks.reduce((sum, track) => sum + track.notes.length, 0);
    const result = buildCommandPlayback(source);

    expect(result.info.playedNotes).toBe(noteCount);
    expect(result.info.peakNotes).toBeGreaterThan(31);
    // The player must not grow with the note count: this is the regression
    // that once produced 46308 command blocks and a 348KB schematic.
    expect(result.commandBlockCount).toBeLessThan(1000);
    expect(result.commandBlockCount).toBeLessThanOrEqual(COMMAND_STRUCTURE_WARNING_BLOCKS);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('COMMAND_STRUCTURE_SIZE');
    expect(result.region.size.x).toBeLessThan(50);
    expect(result.region.size.y).toBe(3);

    const buffer = buildLitematic([result.region], meta);
    expect(buffer.length).toBeLessThan(64 * 1024);

    const parsed = parseLitematic(buffer);
    expect(scheduledNotes(parsed.regions[0]!.tileEntities, result.totalTicks)).toHaveLength(noteCount);
  }, 30000);
});
