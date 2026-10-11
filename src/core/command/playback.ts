import { createHash } from 'node:crypto';
import type { SongModel } from '../midi/types';
import { mapPitch, DEFAULT_REGIONS, type OutOfRangePolicy } from '../palette/pitchMap';
import { nbt, TagType, type NbtCompound } from '../nbt/tag';
import type { RegionData } from '../litematic/build';
import type { LayoutWarning, Vec3 } from '../layout/types';
import { secondsToTick } from '../tempo/tick';

/** Conservative Java 1.20.4 default; the actual world rule must be at least the generated chain length. */
export const DEFAULT_COMMAND_CHAIN_BUDGET = 65536;
const EDGE = 32;
const SCORE_MAX = 2147483646;
/** The user's original vanilla note-box concurrency boundary; command mode warns above it. */
export const COMMAND_SOUND_WARNING_THRESHOLD = 31;

/**
 * Safe reference value for the command block count.
 *
 * A command chain is traversed in full every game tick, and the blocks themselves are written one
 * by one as block entities on paste, so "block count" drives both paste time and the per-tick
 * overhead. A healthy structure only grows with "frames + voices + reusable slots" and is
 * **independent** of the total note count: this implementation's Rush E is 798 blocks. The
 * historical implementation placed one command block per note (46291 notes → 46308 blocks, chain
 * length 46293), which both inflated the schematic to 348KB and forced 46k commands to run every
 * tick, freezing the game.
 *
 * 4096 is taken here as the "structure out of control" warning line: an order of magnitude above
 * normal results, yet far below the per-note block count, so it catches this kind of regression
 * without false-positiving on normal songs.
 */
export const COMMAND_STRUCTURE_WARNING_BLOCKS = 4096;

/**
 * Budget for the JSON payload of one bootstrap command.
 *
 * The frame table is shipped as `data modify storage ... set value [...]` commands,
 * so each one has to fit inside an NBT string, which caps out at 65535 bytes. 24000
 * leaves ample margin.
 */
const COMMAND_CHUNK_BUDGET_BYTES = 24000;

/** Serialised length of an empty frame list, `[]`. */
const EMPTY_FRAME_LIST_BYTES = 2;

/** Command mode reuses pitch mapping but not redstone topology or merge overrides. */
export interface CommandPlaybackOptions {
  baseTps?: number;
  outOfRange?: OutOfRangePolicy;
  excludeTracks?: number[];
  transpose?: Record<number, number>;
  commandChainBudget?: number;
}

/** Coordinates are relative to the schematic origin; identical exports share an objective. */
export interface CommandPlaybackInfo {
  objective: string;
  playedNotes: number;
  peakNotes: number;
  chainLength: number;
  chainBudget: number;
  /** Tick groups stored as compact arrays, rather than one command per MIDI note. */
  scheduledEvents: number;
  distinctVoices: number;
  /** Maximum per-voice simultaneous multiplicities; every original note is preserved. */
  reusableSlots: number;
  start: Vec3;
  stop: Vec3;
  clock: Vec3;
  power: Vec3;
}

/** One self-contained schematic, with all command block/sign NBT and a game-tick clock. */
export interface CommandPlaybackResult {
  region: RegionData;
  info: CommandPlaybackInfo;
  warnings: LayoutWarning[];
  totalTicks: number;
  commandBlockCount: number;
}

/** Serialize command block state. Impulse/repeating blocks need redstone; chain blocks are automatic. */
function commandEntity(pos: Vec3, command: string, automatic: boolean, name: string): NbtCompound {
  return nbt.compound({
    id: nbt.string('minecraft:command_block'),
    x: nbt.int(pos.x),
    y: nbt.int(pos.y),
    z: nbt.int(pos.z),
    Command: nbt.string(command),
    CustomName: nbt.string(JSON.stringify({ text: name })),
    auto: nbt.byte(automatic ? 1 : 0),
    powered: nbt.byte(0),
    conditionMet: nbt.byte(0),
    TrackOutput: nbt.byte(0),
    SuccessCount: nbt.int(0),
    UpdateLastExecution: nbt.byte(1),
  });
}

function direction(from: Vec3, to: Vec3): string {
  const delta = [to.x - from.x, to.y - from.y, to.z - from.z];
  if (delta.reduce((sum, value) => sum + Math.abs(value), 0) !== 1) {
    throw new Error('命令方块链不连续');
  }
  const [dx, dy, dz] = delta as [number, number, number];
  return dx ? (dx > 0 ? 'east' : 'west') : dy ? (dy > 0 ? 'up' : 'down') : dz > 0 ? 'south' : 'north';
}

function relative(from: Vec3, to: Vec3): string {
  return (['x', 'y', 'z'] as const).map((axis) => `~${to[axis] - from[axis] || ''}`).join(' ');
}

/** Compact continuous 3D serpentine, including a vertical edge between successive layers. */
export function commandChainPosition(index: number): Vec3 {
  const layer = Math.floor(index / (EDGE * EDGE));
  let local = index % (EDGE * EDGE);
  if (layer % 2) local = EDGE * EDGE - 1 - local;
  const row = Math.floor(local / EDGE);
  return { x: row % 2 ? EDGE - 1 - (local % EDGE) : local % EDGE, y: layer + 1, z: row + 3 };
}

/**
 * Store tick/count frames once, then reuse bounded per-voice playsound slots.
 * Duplicate voices retain their multiplicity; no sound is deduplicated or dropped.
 * Throws on unsafe score values or insufficient command-chain budget, before export.
 * Warns when the structure itself is oversized, since block count drives paste cost.
 */
export function buildCommandPlayback(
  song: SongModel,
  opts: CommandPlaybackOptions = {},
): CommandPlaybackResult {
  const baseTps = opts.baseTps ?? 20;
  const budget = opts.commandChainBudget ?? DEFAULT_COMMAND_CHAIN_BUDGET;
  if (!Number.isFinite(baseTps) || baseTps <= 0) throw new Error('命令播放要求有效的 TPS');
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > DEFAULT_COMMAND_CHAIN_BUDGET) {
    throw new Error(`命令链预算必须是 1–${DEFAULT_COMMAND_CHAIN_BUDGET} 的整数`);
  }
  const warnings: LayoutWarning[] = [];
  const events: Array<{ tick: number; sound: string; pitch: string }> = [];
  const excluded = new Set(opts.excludeTracks ?? []);
  for (const track of song.tracks) {
    if (excluded.has(track.index)) continue;
    const transpose = opts.transpose?.[track.index] ?? 0;
    if (!Number.isFinite(transpose)) throw new Error('命令播放移调必须是有限数值');
    for (const note of track.notes) {
      const mapped = mapPitch(note.midi, DEFAULT_REGIONS, opts.outOfRange ?? 'warn', transpose);
      if (mapped.dropped || (mapped.degraded && opts.outOfRange !== 'octave')) {
        warnings.push({
          code: 'OUT_OF_RANGE',
          midi: note.midi,
          action: mapped.dropped ? 'drop' : (opts.outOfRange ?? 'warn'),
        });
      }
      if (mapped.dropped) continue;
      const tick = secondsToTick(note.timeSec, baseTps);
      if (!Number.isSafeInteger(tick) || tick < 0 || tick > SCORE_MAX)
        throw new Error('命令播放时间超出计分板安全范围');
      events.push({
        tick,
        sound: `minecraft:block.note_block.${mapped.instrument}`,
        pitch: Math.pow(2, (mapped.note - 12) / 12)
          .toFixed(8)
          .replace(/0+$/, '')
          .replace(/\.$/, ''),
      });
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  if (events.length === 0) throw new Error('没有可生成的音符（可能全部被排除或音域策略丢弃）');
  const objective = `mb${createHash('sha256').update(JSON.stringify(events)).digest('hex').slice(0, 12)}`;
  const storage = `musicboxmc:${objective}`;
  const gate = `if score #playing ${objective} matches 1`;
  const clock = commandChainPosition(0);
  const power = { x: clock.x - 1, y: clock.y, z: clock.z };
  const start = { x: 0, y: 1, z: 0 };
  const stop = { x: 8, y: 1, z: 0 };
  const voices: Array<{ sound: string; pitch: string; max: number }> = [];
  const voiceIndex = new Map<string, number>();
  for (const event of events) {
    const key = `${event.sound}|${event.pitch}`;
    if (!voiceIndex.has(key)) {
      voiceIndex.set(key, voices.length);
      voices.push({ sound: event.sound, pitch: event.pitch, max: 0 });
    }
  }
  const frames: number[][] = [];
  for (const event of events) {
    let frame = frames[frames.length - 1];
    if (!frame || frame[0] !== event.tick) {
      frame = [event.tick, ...Array<number>(voices.length).fill(0)];
      frames.push(frame);
    }
    const index = voiceIndex.get(`${event.sound}|${event.pitch}`)!;
    frame[index + 1] = frame[index + 1]! + 1;
    voices[index]!.max = Math.max(voices[index]!.max, frame[index + 1]!);
  }
  const atEvent = `execute ${gate} if score #tick ${objective} = #next ${objective}`;
  const reusableSlots = voices.reduce((sum, voice) => sum + voice.max, 0);
  const commands = [
    `execute ${gate} run scoreboard players add #tick ${objective} 1`,
    `execute ${gate} store result score #next ${objective} run data get storage ${storage} frames[0][0]`,
    ...voices.map(
      (_, index) =>
        `${atEvent} store result score #v${index} ${objective} run data get storage ${storage} frames[0][${index + 1}]`,
    ),
    ...voices.flatMap((voice, index) =>
      Array.from(
        { length: voice.max },
        (_, slot) =>
          `${atEvent} if score #v${index} ${objective} matches ${slot + 1}.. as @a at @s run ` +
          `playsound ${voice.sound} record @s ~ ~ ~ 1 ${voice.pitch}`,
      ),
    ),
    `${atEvent} run data remove storage ${storage} frames[0]`,
    `execute ${gate} unless data storage ${storage} frames[0] run scoreboard players set #playing ${objective} 0`,
    '',
  ];
  commands[commands.length - 1] =
    `execute if score #playing ${objective} matches 0 run setblock ` +
    `${relative(commandChainPosition(commands.length - 1), power)} air`;
  // Keep bootstrap commands below NBT's 65535-byte String limit with ample margin.
  const chunks: number[][][] = [];
  let chunk: number[][] = [];
  let bytes = EMPTY_FRAME_LIST_BYTES;
  for (const frame of frames) {
    const frameBytes = JSON.stringify(frame).length + 1;
    if (bytes + frameBytes > COMMAND_CHUNK_BUDGET_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = EMPTY_FRAME_LIST_BYTES;
    }
    chunk.push(frame);
    bytes += frameBytes;
  }
  if (chunk.length) chunks.push(chunk);
  const bootstrap = [
    `scoreboard objectives add ${objective} dummy`,
    `scoreboard players set #playing ${objective} 0`,
    '',
    `data modify storage ${storage} frames set value []`,
    ...chunks.flatMap((part) => [
      `data modify storage ${storage} chunk set value ${JSON.stringify(part)}`,
      `data modify storage ${storage} frames append from storage ${storage} chunk[]`,
    ]),
    `data remove storage ${storage} chunk`,
    `scoreboard players set #tick ${objective} -1`,
    `scoreboard players set #playing ${objective} 1`,
    '',
  ];
  const chainLength = Math.max(commands.length - 1, bootstrap.length - 1, 6);
  if (chainLength >= budget) {
    throw new Error(`命令播放需 ${chainLength} 个链步骤，必须小于预算 ${budget}；未生成投影`);
  }
  const blocks: RegionData['blocks'] = [];
  const entities: NbtCompound[] = [];
  const put = (pos: Vec3, name: string, properties: Record<string, string>): void => {
    blocks.push({ ...pos, state: { name, properties } });
  };
  const addCommand = (
    pos: Vec3,
    command: string,
    name: string,
    facing: string,
    label: string,
    conditional = false,
  ): void => {
    put(pos, name, { facing, conditional: String(conditional) });
    entities.push(commandEntity(pos, command, name === 'minecraft:chain_command_block', label));
  };
  commands.forEach((command, i) => {
    const pos = commandChainPosition(i);
    const facing = i + 1 < commands.length ? direction(pos, commandChainPosition(i + 1)) : 'up';
    addCommand(
      pos,
      command,
      i === 0 ? 'minecraft:repeating_command_block' : 'minecraft:chain_command_block',
      facing,
      'MusicboxMC',
    );
  });
  const controls = [
    { pos: start, label: 'Start / Restart', commands: bootstrap },
    {
      pos: stop,
      label: 'Stop',
      commands: [
        `scoreboard players set #playing ${objective} 0`,
        '',
        ...['bass', 'guitar', 'harp', 'flute', 'bell'].map(
          (instrument) => `stopsound @a record minecraft:block.note_block.${instrument}`,
        ),
      ],
    },
  ];
  // Separate the stop control from the variable-length bootstrap chain.
  stop.x = bootstrap.length + 3;
  for (const control of controls) {
    const isStart = control === controls[0];
    if (isStart) {
      control.commands[2] = `setblock ${relative({ ...control.pos, x: control.pos.x + 2 }, power)} air`;
    }
    const powerIndex = isStart ? control.commands.length - 1 : 1;
    const powerPos = { ...control.pos, x: control.pos.x + powerIndex };
    control.commands[powerIndex] =
      `setblock ${relative(powerPos, power)} ${isStart ? 'redstone_block' : 'air'}`;
    control.commands.forEach((command, i) =>
      addCommand(
        { ...control.pos, x: control.pos.x + i },
        command,
        i === 0 ? 'minecraft:command_block' : 'minecraft:chain_command_block',
        'east',
        control.label,
      ),
    );
    put({ ...control.pos, z: control.pos.z - 1 }, 'minecraft:stone_button', {
      face: 'wall',
      facing: 'north',
      powered: 'false',
    });
    const signPos = { ...control.pos, y: 2 };
    put(signPos, 'minecraft:oak_sign', { rotation: '8', waterlogged: 'false' });
    const signText = nbt.compound({
      messages: nbt.list(
        TagType.String,
        [control.label, 'MusicboxMC', '', ''].map((text) => nbt.string(JSON.stringify({ text }))),
      ),
      color: nbt.string('black'),
      has_glowing_text: nbt.byte(0),
    });
    entities.push(
      nbt.compound({
        id: nbt.string('minecraft:sign'),
        x: nbt.int(signPos.x),
        y: nbt.int(signPos.y),
        z: nbt.int(signPos.z),
        front_text: signText,
        back_text: signText,
        is_waxed: nbt.byte(1),
      }),
    );
  }
  // Reserve empty clock power position so both relative setblock controls stay inside the schematic bounds.
  put(power, 'minecraft:air', {});
  const min = { x: -1, y: 0, z: -1 };
  const size = {
    x: Math.max(EDGE + 1, stop.x + controls[1]!.commands.length + 1),
    y: Math.max(3, commandChainPosition(commands.length - 1).y + 1),
    z: EDGE + 4,
  };
  for (const block of blocks) {
    block.x -= min.x;
    block.y -= min.y;
    block.z -= min.z;
  }
  for (const entity of entities) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const tag = entity.value.get(axis)!;
      if (tag.type === TagType.Int) tag.value -= min[axis];
    }
  }
  const counts = new Map<number, number>();
  for (const event of events) counts.set(event.tick, (counts.get(event.tick) ?? 0) + 1);
  let peakNotes = 0;
  for (const count of counts.values()) peakNotes = Math.max(peakNotes, count);
  const commandBlockCount =
    commands.length + controls.reduce((sum, control) => sum + control.commands.length, 0);
  warnings.push({ code: 'COMMAND_PLAYBACK_REQUIREMENTS', chainLength, budget });
  if (peakNotes > COMMAND_SOUND_WARNING_THRESHOLD)
    warnings.push({ code: 'COMMAND_SOUND_PRESSURE', peakNotes });
  if (commandBlockCount > COMMAND_STRUCTURE_WARNING_BLOCKS) {
    warnings.push({
      code: 'COMMAND_STRUCTURE_SIZE',
      commandBlocks: commandBlockCount,
      limit: COMMAND_STRUCTURE_WARNING_BLOCKS,
    });
  }
  return {
    region: { position: min, size, blocks, tileEntities: entities },
    info: {
      objective,
      playedNotes: events.length,
      peakNotes,
      chainLength,
      chainBudget: budget,
      scheduledEvents: frames.length,
      distinctVoices: voices.length,
      reusableSlots,
      start,
      stop,
      clock,
      power,
    },
    warnings,
    totalTicks: events[events.length - 1]!.tick,
    commandBlockCount,
  };
}
