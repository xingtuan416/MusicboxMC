import { createHash } from 'node:crypto';
import type { ScheduledEvent, Voice } from './schedule';

/**
 * Command text for the playback chain.
 *
 * Everything here is a pure string builder: no blocks, no coordinates except the
 * two the caller has to supply. Splitting it out keeps the schedule and the
 * geometry readable on their own.
 */

/** Serialised length of an empty frame list, `[]`. */
const EMPTY_FRAME_LIST_BYTES = 2;

/**
 * Budget for the JSON payload of one bootstrap command.
 *
 * The frame table ships as `data modify storage ... set value [...]` commands, so
 * each one has to fit inside an NBT string, which caps out at 65535 bytes. 24000
 * leaves ample margin.
 */
const COMMAND_CHUNK_BUDGET_BYTES = 24000;

/** The five note-block sound events, in the order the pitch regions use them. */
export const NOTE_BLOCK_INSTRUMENTS = ['bass', 'guitar', 'harp', 'flute', 'bell'] as const;

/**
 * Scoreboard namespace for a set of events.
 *
 * Two exports generated from the same input and options produce the same name and
 * therefore share their storage, so they must not be run at the same time.
 */
export function scoreboardNamespace(events: ScheduledEvent[]): string {
  const digest = createHash('sha256').update(JSON.stringify(events)).digest('hex');
  return `mb${digest.slice(0, 12)}`;
}

export function storageKey(objective: string): string {
  return `musicboxmc:${objective}`;
}

/**
 * The chain that runs once per game tick while playing.
 *
 * The last entry is deliberately left empty: it clears the clock's power block,
 * and its coordinates depend on how long the chain turned out to be, so the caller
 * fills it in once the length is known.
 */
export function buildPlaybackChain(objective: string, storage: string, voices: Voice[]): string[] {
  const gate = `if score #playing ${objective} matches 1`;
  const atEvent = `execute ${gate} if score #tick ${objective} = #next ${objective}`;

  return [
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
}

/**
 * The one-shot setup chain behind the Start control: create the scoreboard, push
 * the whole frame table into storage, then arm playback.
 */
export function buildBootstrap(objective: string, storage: string, frames: number[][]): string[] {
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

  return [
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
}

/** The Stop control: clear the flag, then silence the five note-block sounds. */
export function buildStopCommands(objective: string): string[] {
  return [
    `scoreboard players set #playing ${objective} 0`,
    '',
    ...NOTE_BLOCK_INSTRUMENTS.map(
      (instrument) => `stopsound @a record minecraft:block.note_block.${instrument}`,
    ),
  ];
}
