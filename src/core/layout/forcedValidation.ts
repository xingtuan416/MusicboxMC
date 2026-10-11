import type { BlockPlacement, TrackSkeleton } from './types';
import { GAME_TICKS_PER_REDSTONE_TICK, WIRE_STRENGTH } from './track';

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
    if (byPos.has(k)) throw new Error(`强制合并校验：方块重叠 ${k}`);
    byPos.set(k, block);
  }
  const expected = new Map<string, number>();
  const taps = track.segments.flatMap((segment) => segment.taps);
  if (taps.length !== expectedTicks.length) throw new Error('强制合并校验：音群时刻数不一致');
  taps.forEach((tap, i) => {
    for (const note of tap.notes) expected.set(key(note.notePos.x, note.notePos.z), expectedTicks[i]!);
  });
  for (const [k, block] of byPos) {
    if (!supports.has(k)) throw new Error(`强制合并校验：缺少支撑方块 ${k}`);
    if (block.block === 'minecraft:note_block' && !expected.has(k)) {
      throw new Error(`强制合并校验：未登记音符盒 ${k}`);
    }
    if (block.block === 'minecraft:repeater') {
      const facing = DIRECTIONS.find((dir) => dir.name === block.props?.facing);
      const delay = Number(block.props?.delay);
      if (!facing || !Number.isInteger(delay) || delay < 1 || delay > 4) {
        throw new Error(`强制合并校验：无效中继器状态 ${k}`);
      }
      // A repeater output pointing into another repeater's side locks it.
      for (const side of DIRECTIONS.filter((dir) => (facing.dx !== 0 ? dir.dz !== 0 : dir.dx !== 0))) {
        const neighbor = byPos.get(key(block.pos.x + side.dx, block.pos.z + side.dz));
        if (neighbor?.block === 'minecraft:repeater' && neighbor.props?.facing === side.name) {
          throw new Error(`强制合并校验：中继器可能被侧向锁定 ${k}`);
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
  if (source?.block !== 'minecraft:redstone_wire') throw new Error('强制合并校验：缺少单主线接电入口');
  emit(source, 0, WIRE_STRENGTH);
  for (let head = 0; head < queue.length; head++) {
    const signal = queue[head]!;
    const { block, tick, strength } = signal;
    if (block.block === 'minecraft:note_block') continue;
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
    if (!signal) throw new Error(`强制合并校验：信号无法到达 ${block.block} (${k})`);
    if (block.block === 'minecraft:redstone_wire')
      minWireStrength = Math.min(minWireStrength, signal.strength);
    if (block.block === 'minecraft:note_block') {
      if (signal.tick !== expected.get(k)) {
        throw new Error(`强制合并校验：音符盒 (${k}) 实际 ${signal.tick} 游戏刻，期望 ${expected.get(k)}`);
      }
      lastTriggerTick = Math.max(lastTriggerTick, signal.tick);
    }
  }
  return { noteCount: expected.size, minWireStrength, lastTriggerTick };
}
