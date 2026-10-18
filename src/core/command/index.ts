import type { SongModel } from '../midi/types';
import type { TrackVoicing } from '../palette/assignment';
import type { NoteBlockInstrument } from '../palette/instruments';
import type { OutOfRangePolicy, RegionTable } from '../palette/pitchMap';
import type { RegionData } from '../litematic/build';
import type { LayoutWarning, Vec3 } from '../layout/types';
import { buildSchedule } from './schedule';
import {
  buildBootstrap,
  buildPlaybackChain,
  buildStopCommands,
  scoreboardNamespace,
  storageKey,
} from './commands';
import { buildPlayer, commandChainPosition, relativePosition, type Control } from './player';

export { commandChainPosition, COMMAND_CHAIN_EDGE } from './player';
import { coreError } from '../errors';

/**
 * Command-block playback: an alternative backend that emits no redstone at all.
 *
 * Every retained note becomes a `playsound` command executed for each online
 * player at their own position, so it has neither the distance limit nor the
 * polyphony limit of a redstone circuit. The output is still a Java 1.20.4
 * `.litematic`.
 *
 * The work is split across three modules: `schedule.ts` reduces the song to a
 * small table, `commands.ts` renders that table into command text, and `player.ts`
 * lays the chain and its controls out in space. This file only orchestrates them
 * and decides the warnings.
 */

/** Conservative Java 1.20.4 default; the world rule must be at least the generated chain length. */
export const DEFAULT_COMMAND_CHAIN_BUDGET = 65536;

/** The vanilla note-block concurrency boundary; command mode warns above it. */
export const COMMAND_SOUND_WARNING_THRESHOLD = 31;

/**
 * Safe reference value for the command block count.
 *
 * A command chain is walked in full every game tick, and the blocks themselves are
 * written one by one as block entities on paste, so "block count" drives both paste
 * time and the per-tick overhead. A healthy structure only grows with frames,
 * voices and reusable slots, and is **independent** of the note count: this
 * implementation's Rush E is 798 blocks. The per-note compiler this replaced
 * emitted one command block per note (46291 notes to 46308 blocks, chain length
 * 46293), which both inflated the schematic to 348KB and forced 46k commands to run
 * every tick.
 *
 * 4096 is the "structure out of control" line: an order of magnitude above normal
 * results, yet far below a per-note block count, so it catches that class of
 * regression without false-positiving on ordinary songs.
 */
export const COMMAND_STRUCTURE_WARNING_BLOCKS = 4096;

/** Command mode reuses pitch mapping but not redstone topology or merge overrides. */
export interface CommandPlaybackOptions {
  baseTps?: number;
  outOfRange?: OutOfRangePolicy;
  /** Which sample slots may be used; see PitchPalette. */
  regions?: RegionTable;
  excludeTracks?: number[];
  transpose?: Record<number, number>;
  /** Per-track voicing; omitted means every track uses the five-slot piano palette. */
  assignments?: Record<number, TrackVoicing>;
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
  /** Instruments that actually appear in the schedule, for Stop and for reporting. */
  instruments: NoteBlockInstrument[];
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
  if (!Number.isFinite(baseTps) || baseTps <= 0) throw coreError('COMMAND_INVALID_TPS');
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > DEFAULT_COMMAND_CHAIN_BUDGET) {
    throw coreError('COMMAND_INVALID_BUDGET', { max: DEFAULT_COMMAND_CHAIN_BUDGET });
  }

  const { schedule, warnings } = buildSchedule(song, {
    baseTps,
    outOfRange: opts.outOfRange ?? 'warn',
    regions: opts.regions,
    excludeTracks: opts.excludeTracks,
    transpose: opts.transpose,
    assignments: opts.assignments,
  });
  const { events, voices, frames, peakNotes } = schedule;
  const instruments = [...new Set(events.map((event) => event.instrument))];

  const objective = scoreboardNamespace(events);
  const storage = storageKey(objective);

  const clock = commandChainPosition(0);
  const power: Vec3 = { x: clock.x - 1, y: clock.y, z: clock.z };
  const start: Vec3 = { x: 0, y: 1, z: 0 };
  const stop: Vec3 = { x: 8, y: 1, z: 0 };

  const commands = buildPlaybackChain(objective, storage, voices);
  commands[commands.length - 1] =
    `execute if score #playing ${objective} matches 0 run setblock ` +
    `${relativePosition(commandChainPosition(commands.length - 1), power)} air`;

  const bootstrap = buildBootstrap(objective, storage, frames);
  const chainLength = Math.max(commands.length - 1, bootstrap.length - 1, 6);
  if (chainLength >= budget) {
    throw coreError('COMMAND_CHAIN_TOO_LONG', { chainLength, budget });
  }

  const controls: Control[] = [
    { pos: start, label: 'Start / Restart', commands: bootstrap },
    { pos: stop, label: 'Stop', commands: buildStopCommands(objective, instruments) },
  ];
  const player = buildPlayer({ commands, controls, power });

  const reusableSlots = voices.reduce((sum, voice) => sum + voice.max, 0);
  const commandBlockCount =
    commands.length + controls.reduce((sum, control) => sum + control.commands.length, 0);

  warnings.push({ code: 'COMMAND_PLAYBACK_REQUIREMENTS', chainLength, budget });
  if (peakNotes > COMMAND_SOUND_WARNING_THRESHOLD) {
    warnings.push({ code: 'COMMAND_SOUND_PRESSURE', peakNotes });
  }
  if (commandBlockCount > COMMAND_STRUCTURE_WARNING_BLOCKS) {
    warnings.push({
      code: 'COMMAND_STRUCTURE_SIZE',
      commandBlocks: commandBlockCount,
      limit: COMMAND_STRUCTURE_WARNING_BLOCKS,
    });
  }

  return {
    region: {
      position: player.min,
      size: player.size,
      blocks: player.blocks,
      tileEntities: player.entities,
    },
    info: {
      objective,
      playedNotes: events.length,
      peakNotes,
      chainLength,
      chainBudget: budget,
      scheduledEvents: frames.length,
      distinctVoices: voices.length,
      reusableSlots,
      instruments,
      start,
      stop: player.stop,
      clock,
      power,
    },
    warnings,
    totalTicks: events[events.length - 1]!.tick,
    commandBlockCount,
  };
}
