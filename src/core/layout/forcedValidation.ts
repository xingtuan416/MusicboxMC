import type { BlockPlacement, TrackSkeleton } from './types';
import { GAME_TICKS_PER_REDSTONE_TICK, WIRE_STRENGTH } from './track';
import { coreError } from '../errors';

/** Diagnostics from an actual block graph, independent of planned note paths. */
export interface ForcedValidation {
  noteCount: number;
  minWireStrength: number;
  lastTriggerTick: number;
}

const DIRECTIONS = [
  { name: 'west', opposite: 'east', dx: -1, dz: 0 },
  { name: 'east', opposite: 'west', dx: 1, dz: 0 },
  { name: 'north', opposite: 'south', dx: 0, dz: -1 },
  { name: 'south', opposite: 'north', dx: 0, dz: 1 },
] as const;

/**
 * Audit the forced mode's planar dust/repeater/solid-feed topology from one input.
 * Dust has zero modeled delay, repeaters renew strength after their configured
 * delay, and solid feed blocks only conduct a direct repeater output. This is a
 * rising-edge graph check, not a full Minecraft update-order or pulse simulator.
 * Throws on unreachable/early notes, coordinate collisions, locking, or missing supports.
 *
 * **What passing does not mean.** It is not a general "this geometry is safe" check, and
 * must not be read as one. It does not verify that every registered note actually exists,
 * that the block above a note block is air, that a support block can really carry dust or
 * a repeater, that nothing collides on another Y layer, that separate tracks are
 * connected to each other, or anything about rising edges after the first. Passing means
 * the topology is self-consistent with respect to the checks listed above, nothing more.
 */
export function validateForcedTrack(
  track: TrackSkeleton,
  circuitY: number,
  expectedTicks: number[],
): ForcedValidation {
  const key = (x: number, z: number): string => `${x},${z}`;
  const byPos = new Map<string, BlockPlacement>();
  const supports = new Set<string>();
  for (const block of track.placements) {
    const k = key(block.pos.x, block.pos.z);
    if (block.pos.y === circuitY - 1 && block.block !== 'minecraft:air') supports.add(k);
    if (block.pos.y !== circuitY) continue;
    if (byPos.has(k)) throw coreError('FORCED_VALIDATION_BLOCK_OVERLAP', { position: k });
    byPos.set(k, block);
  }
  const expected = new Map<string, number>();
  const taps = track.taps;
  if (taps.length !== expectedTicks.length) throw coreError('FORCED_VALIDATION_TAP_MISMATCH');
  taps.forEach((tap, i) => {
    for (const note of tap.notes) expected.set(key(note.notePos.x, note.notePos.z), expectedTicks[i]!);
  });
  for (const [k, block] of byPos) {
    if (!supports.has(k)) throw coreError('FORCED_VALIDATION_MISSING_SUPPORT', { position: k });
    if (block.block === 'minecraft:note_block' && !expected.has(k)) {
      throw coreError('FORCED_VALIDATION_UNREGISTERED_NOTE', { position: k });
    }
    if (block.block === 'minecraft:repeater') {
      const facing = DIRECTIONS.find((dir) => dir.name === block.props?.facing);
      const delay = Number(block.props?.delay);
      if (!facing || !Number.isInteger(delay) || delay < 1 || delay > 4) {
        throw coreError('FORCED_VALIDATION_BAD_REPEATER', { position: k });
      }
      // A repeater output pointing into another repeater's side locks it.
      for (const side of DIRECTIONS.filter((dir) => (facing.dx !== 0 ? dir.dz !== 0 : dir.dx !== 0))) {
        const neighbor = byPos.get(key(block.pos.x + side.dx, block.pos.z + side.dz));
        if (neighbor?.block === 'minecraft:repeater' && neighbor.props?.facing === side.name) {
          throw coreError('FORCED_VALIDATION_REPEATER_LOCKED', { position: k });
        }
      }
    }
  }
  interface Signal {
    block: BlockPlacement;
    tick: number;
    strength: number;
  }
  const queue: Signal[] = [];
  const arrivals = new Map<string, { tick: number; strength: number }>();
  const emit = (block: BlockPlacement | undefined, tick: number, strength: number): void => {
    if (!block || strength < 1) return;
    const k = key(block.pos.x, block.pos.z);
    const previous = arrivals.get(k);
    if (previous && (previous.tick < tick || (previous.tick === tick && previous.strength >= strength)))
      return;
    arrivals.set(k, { tick, strength });
    queue.push({ block, tick, strength });
  };
  const source = byPos.get(key(0, track.zBase));
  if (source?.block !== 'minecraft:redstone_wire') throw coreError('FORCED_VALIDATION_NO_ENTRY');
  emit(source, 0, WIRE_STRENGTH);
  for (let head = 0; head < queue.length; head++) {
    const signal = queue[head]!;
    const { block, tick, strength } = signal;
    // A powered note block conducts one hop, exactly like the ordinary layout's
    // inline note: it lights the adjacent note blocks and the dust that continues the
    // main line. Treating it as a sink made every inline note break reachability.
    const output =
      block.block === 'minecraft:repeater'
        ? DIRECTIONS.find((dir) => dir.opposite === block.props?.facing)
        : undefined;
    for (const dir of output ? [output] : DIRECTIONS) {
      const neighbor = byPos.get(key(block.pos.x + dir.dx, block.pos.z + dir.dz));
      if (!neighbor) continue;
      if (neighbor.block === 'minecraft:redstone_wire') {
        if (block.block === 'minecraft:redstone_wire') {
          if (block.props?.[dir.name] === 'none' || neighbor.props?.[dir.opposite] === 'none') continue;
          emit(neighbor, tick, strength - 1);
        } else emit(neighbor, tick, WIRE_STRENGTH);
      } else if (neighbor.block === 'minecraft:repeater') {
        if (neighbor.props?.facing !== dir.opposite) continue;
        emit(neighbor, tick + Number(neighbor.props.delay) * GAME_TICKS_PER_REDSTONE_TICK, WIRE_STRENGTH);
      } else if (neighbor.block === 'minecraft:stone') {
        if (output) emit(neighbor, tick, WIRE_STRENGTH);
      } else if (neighbor.block === 'minecraft:note_block') {
        emit(neighbor, tick, WIRE_STRENGTH);
      }
    }
  }
  let minWireStrength = WIRE_STRENGTH;
  let lastTriggerTick = 0;
  for (const [k, block] of byPos) {
    const signal = arrivals.get(k);
    if (!signal) {
      throw coreError('FORCED_VALIDATION_UNREACHABLE', { block: block.block, position: k });
    }
    if (block.block === 'minecraft:redstone_wire')
      minWireStrength = Math.min(minWireStrength, signal.strength);
    if (block.block === 'minecraft:note_block') {
      if (signal.tick !== expected.get(k)) {
        throw coreError('FORCED_VALIDATION_WRONG_TICK', {
          position: k,
          actual: signal.tick,
          expected: expected.get(k)!,
        });
      }
      lastTriggerTick = Math.max(lastTriggerTick, signal.tick);
    }
  }
  return { noteCount: expected.size, minWireStrength, lastTriggerTick };
}
