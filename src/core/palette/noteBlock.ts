/** Note block blockstate serialization. */

import type { NoteBlockInstrument } from './pitchMap';

export interface BlockState {
  /** Full block id, e.g. minecraft:note_block */
  name: string;
  /** Blockstate properties, all values are strings */
  properties?: Record<string, string>;
}

/** Note block: note 0-24; instrument is written explicitly to avoid harp fallback on paste. */
export function noteBlock(note: number, instrument: NoteBlockInstrument = 'harp'): BlockState {
  return {
    name: 'minecraft:note_block',
    properties: { instrument, note: String(clampNote(note)), powered: 'false' },
  };
}

/** Redstone wire: power 0-15. */
export function redstoneWire(power = 0): BlockState {
  return {
    name: 'minecraft:redstone_wire',
    properties: { power: String(Math.max(0, Math.min(15, power))) },
  };
}

export type RepeaterFacing = 'north' | 'south' | 'east' | 'west';

/**
 * Redstone repeater: delay 1-4.
 *
 * `facing` points at the **input**, not the output: vanilla's `DiodeBlock` reads its
 * input from `pos.relative(facing)`, so a repeater facing west is powered from the west
 * and drives the block to its east. Getting this backwards produces a circuit that looks
 * right and never fires.
 */
export function repeater(facing: RepeaterFacing, delay: number): BlockState {
  return {
    name: 'minecraft:repeater',
    properties: {
      facing,
      delay: String(clampDelay(delay)),
      locked: 'false',
      powered: 'false',
    },
  };
}

/** A plain block with no properties (base blocks and the like). */
export function plainBlock(name: string): BlockState {
  return { name };
}

function clampNote(n: number): number {
  return Math.max(0, Math.min(24, Math.round(n)));
}

function clampDelay(d: number): number {
  return Math.max(1, Math.min(4, Math.round(d)));
}

/** Stable palette key, used for deduplication. */
export function stateKey(s: BlockState): string {
  if (!s.properties) return s.name;
  const keys = Object.keys(s.properties).sort();
  return `${s.name}[${keys.map((k) => `${k}=${s.properties![k]}`).join(',')}]`;
}
