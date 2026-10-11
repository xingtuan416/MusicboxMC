import { mapPitch, type MappedPitch, type RegionTable } from '../palette/pitchMap';
import type { BlockResolver } from '../palette/blockTable';
import {
  noteBlock,
  plainBlock,
  redstoneWire,
  repeater,
  type BlockState,
  type RepeaterFacing,
} from '../palette/noteBlock';
import { place } from './placement';
import {
  chordCapacity,
  gameTickToRedstone,
  GAME_TICKS_PER_REDSTONE_TICK,
  MAX_PAD_RUN,
  MAX_REPEATER_DELAY,
  MAX_SIDE_ROWS,
  type TrackNote,
} from './track';
import type {
  BlockPlacement,
  DelayStep,
  LayoutConfig,
  LayoutResult,
  LayoutWarning,
  PlacedNote,
  Tap,
  TrackSkeleton,
  Vec3,
} from './types';
import { validateForcedTrack } from './forcedValidation';

/** A globally merged instrument, retaining the first included source track's identity. */
export interface ForcedInput {
  index: number;
  notes: TrackNote[];
}

/** Dependencies and source-track overrides for the opt-in single-spine layout. */
export interface ForcedOptions {
  config: LayoutConfig;
  regions: RegionTable;
  resolve: BlockResolver;
  transpose?: Record<number, number>;
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
}

interface Group {
  rt: number;
  tick: number;
  notes: MappedPitch[];
}

/** Exact per-section budget: notes are two rows apart to prevent neighbor activation. */
export function forcedNotesPerSide(dMax: number): number {
  return Math.min(MAX_SIDE_ROWS >> 1, (chordCapacity(dMax) - 1) / 2);
}

/**
 * Build one connected time spine per instrument, never an overflow playback lane.
 * Side buses renew power before exhaustion; individual repeater chains compensate
 * their bus stages to one song-wide latency. Throws before export if geometry is unsafe.
 */
export function buildForcedLayout(inputs: ForcedInput[], opts: ForcedOptions): LayoutResult {
  const { config, regions, resolve } = opts;
  if (
    !Number.isFinite(config.baseTps) ||
    config.baseTps <= 0 ||
    !Number.isInteger(config.circuitY) ||
    !Number.isInteger(config.floorY) ||
    (config.trackPitch !== 'auto' && (!Number.isFinite(config.trackPitch) || config.trackPitch <= 0))
  ) {
    throw new Error('强制合并要求有效的 TPS、电路层坐标和主线间距');
  }
  if (config.floorY !== config.circuitY - 1) {
    throw new Error('强制合并要求支撑层位于电路层正下方');
  }
  const warnings: LayoutWarning[] = [];
  const perSide = forcedNotesPerSide(config.dMax);
  const runSpan = perSide * 2;
  let minRt = Infinity;
  let peakNotes = 0;
  const prepared = inputs.map((input) => {
    const byRt = new Map<number, Group>();
    for (const note of input.notes) {
      if (!Number.isSafeInteger(note.tick) || note.tick < 0)
        throw new Error('强制合并音符时间必须是非负整数游戏刻');
      const mapped = mapPitch(
        note.midi,
        regions,
        opts.outOfRange ?? 'warn',
        opts.transpose?.[input.index] ?? 0,
      );
      if (mapped.dropped || (mapped.degraded && opts.outOfRange !== 'octave')) {
        warnings.push({
          code: 'OUT_OF_RANGE',
          midi: note.midi,
          action: mapped.dropped ? 'drop' : (opts.outOfRange ?? 'warn'),
        });
      }
      if (mapped.dropped) continue;
      const rt = gameTickToRedstone(note.tick);
      const group = byRt.get(rt) ?? { rt, tick: note.tick, notes: [] };
      group.tick = Math.min(group.tick, note.tick);
      group.notes.push(mapped);
      byRt.set(rt, group);
      minRt = Math.min(minRt, rt);
      peakNotes = Math.max(peakNotes, group.notes.length);
    }
    return { index: input.index, groups: [...byRt.values()].sort((a, b) => a.rt - b.rt) };
  });

  // A relay at odd Z follows each bounded run; notes only tap even Z dust.
  const maxStage = peakNotes === 0 ? 0 : Math.floor((Math.ceil(peakNotes / 2) - 1) / perSide);
  const branchDelay = maxStage + 1;
  const branchCells = Math.ceil(branchDelay / MAX_REPEATER_DELAY);
  // Leave two isolation cells after the longest note chain. Main-line padding
  // cannot borrow extra repeaters: doing so would change dense consecutive beats.
  const mainRun = branchCells + 2;
  if (mainRun > MAX_PAD_RUN) {
    throw new Error(
      `强制合并峰值 ${peakNotes} 音需要 ${branchDelay} 红石刻同步补偿，` +
        `主线需 ${mainRun} 格连续红石粉，超过安全预算 ${MAX_PAD_RUN}；未生成投影`,
    );
  }
  const base = minRt === 0 ? 1 : 0;
  const startupDelayTicks = (base + branchDelay) * GAME_TICKS_PER_REDSTONE_TICK;
  if (peakNotes > 0) {
    warnings.push({
      code: 'FORCE_MERGE_LEAD_IN',
      ticks: startupDelayTicks,
      peakNotes,
      sectionCapacity: perSide * 2,
    });
  }

  const tracks: TrackSkeleton[] = [];
  const placed: LayoutResult['placed'] = [];
  const maxRows = 2 * Math.ceil(peakNotes / 2);
  const pitch = config.trackPitch === 'auto' ? 2 * maxRows + 2 : Math.max(config.trackPitch, 2 * maxRows + 2);
  let totalTicks = 0;

  for (const input of prepared) {
    if (input.groups.length === 0) continue;
    const zBase = maxRows + tracks.length * pitch;
    const placements: BlockPlacement[] = [];
    const occupied = new Map<string, BlockPlacement>();
    const steps: DelayStep[] = [];
    const taps: Tap[] = [];
    const support = resolve({ slot: 'wireSupport', trackIndex: input.index });
    if (support === 'minecraft:air') throw new Error('强制合并的红石粉和中继器支撑方块不能为空气');
    const key = (pos: Vec3): string => `${pos.x},${pos.y},${pos.z}`;
    const put = (x: number, y: number, z: number, state: BlockState): void => {
      const placement = place({ x, y, z }, state);
      if (occupied.has(key(placement.pos))) throw new Error(`强制合并电路坐标冲突：${key(placement.pos)}`);
      occupied.set(key(placement.pos), placement);
      placements.push(placement);
    };
    const supported = (x: number, z: number, state: BlockState): void => {
      put(x, config.circuitY, z, state);
      put(x, config.floorY, z, plainBlock(support));
    };
    const wire = (x: number, z: number, main = false): void => {
      supported(x, z, redstoneWire(0));
      if (main) steps.push({ kind: 'wire', ticks: 1 });
    };
    const relay = (x: number, z: number, delay: number, facing: RepeaterFacing, main = false): void => {
      supported(x, z, repeater(facing, delay));
      if (main) steps.push({ kind: 'repeater', ticks: delay as 1 | 2 | 3 | 4 });
    };
    let x = 0;
    let prevRt = 0;
    wire(x++, zBase, true);
    for (const group of input.groups) {
      let gap = group.rt + base - prevRt;
      while (gap > 0) {
        const delay = Math.min(MAX_REPEATER_DELAY, gap);
        relay(x++, zBase, delay, 'west', true);
        gap -= delay;
      }
      const rootX = x++;
      // Use a dedicated solid feed block, not a sounding note or a user-overridden material.
      supported(rootX, zBase, plainBlock('minecraft:stone'));
      const rows = [Math.ceil(group.notes.length / 2), Math.floor(group.notes.length / 2)];
      for (let sideIndex = 0; sideIndex < rows.length; sideIndex++) {
        const sign = sideIndex === 0 ? 1 : -1;
        const reach = rows[sideIndex]! * 2;
        for (let row = 1; row <= reach; row++) {
          const z = zBase + sign * row;
          if (row > runSpan && (row - 1) % runSpan === 0) {
            relay(rootX, z, 1, sign === 1 ? 'north' : 'south');
          } else {
            wire(rootX, z);
          }
        }
      }
      const notePlacements: PlacedNote[] = [];
      group.notes.forEach((note, i) => {
        const sign = i % 2 === 0 ? 1 : -1;
        const row = Math.floor(i / 2) + 1;
        const z = zBase + sign * row * 2;
        const stage = Math.floor((row - 1) / perSide);
        let remaining = branchDelay - stage;
        let noteX = rootX + 1;
        const path: Vec3[] = [];
        // The bus is shared; store only the local tap-to-note chain instead of
        // copying the whole bus once per note (quadratic memory on dense chords).
        path.push({ x: rootX, y: config.circuitY, z });
        while (remaining > 0) {
          const delay = Math.min(MAX_REPEATER_DELAY, remaining);
          relay(noteX, z, delay, 'west');
          path.push({ x: noteX++, y: config.circuitY, z });
          remaining -= delay;
        }
        const notePos = { x: noteX, y: config.circuitY, z };
        const blockPos = { x: noteX, y: config.floorY, z };
        const block = resolve({ slot: 'noteBase', trackIndex: input.index, region: note.region });
        put(notePos.x, notePos.y, notePos.z, noteBlock(note.note, note.instrument));
        put(blockPos.x, blockPos.y, blockPos.z, plainBlock(block));
        notePlacements.push({ notePos, blockPos, note: note.note, block, path });
      });
      taps.push({ id: taps.length, x: rootX, t: group.rt, d: branchDelay, notes: notePlacements });
      placed.push({
        trackIndex: input.index,
        zBase,
        tick: group.tick,
        actual: group.rt * 2 + startupDelayTicks,
      });
      totalTicks = Math.max(totalTicks, group.tick);
      if (group.notes.length > perSide * 2) {
        warnings.push({
          code: 'FANOUT_EXPANDED',
          tick: group.tick,
          n: group.notes.length,
          limit: perSide * 2,
          stages: Math.floor((Math.ceil(group.notes.length / 2) - 1) / perSide) + 1,
        });
      }
      prevRt = group.rt + base;
      // A new chord starts beyond all previous note branches; powered stone resets
      // the main wire's budget, independently of the lateral bus budget.
      if (group !== input.groups[input.groups.length - 1]) {
        for (let pad = 0; pad < mainRun; pad++) wire(x++, zBase, true);
      }
    }

    const directions = [
      { name: 'east', dx: 1, dz: 0 },
      { name: 'west', dx: -1, dz: 0 },
      { name: 'south', dx: 0, dz: 1 },
      { name: 'north', dx: 0, dz: -1 },
    ];
    for (const p of placements) {
      if (p.block !== 'minecraft:redstone_wire') continue;
      for (const dir of directions) {
        const neighbor = occupied.get(key({ x: p.pos.x + dir.dx, y: p.pos.y, z: p.pos.z + dir.dz }));
        const connected =
          neighbor?.block === 'minecraft:redstone_wire' ||
          neighbor?.block === 'minecraft:stone' ||
          (neighbor?.block === 'minecraft:repeater' &&
            (dir.dx !== 0 ? ['east', 'west'] : ['north', 'south']).includes(neighbor.props?.facing ?? ''));
        p.props![dir.name] = connected ? 'side' : 'none';
      }
    }
    const track: TrackSkeleton = {
      trackIndex: input.index,
      zBase,
      placements,
      bridges: [],
      segments: [
        {
          startTick: 0,
          endTick: prevRt,
          startX: 0,
          endX: x,
          dir: 1,
          yRow: config.circuitY,
          steps,
          taps,
        },
      ],
    };
    validateForcedTrack(
      track,
      config.circuitY,
      input.groups.map((group) => group.rt * 2 + startupDelayTicks),
    );
    tracks.push(track);
  }
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const track of tracks)
    for (const p of track.placements) {
      for (const axis of ['x', 'y', 'z'] as const) {
        min[axis] = Math.min(min[axis], p.pos[axis]);
        max[axis] = Math.max(max[axis], p.pos[axis]);
      }
    }
  const size =
    tracks.length === 0
      ? { x: 1, y: 2, z: 1 }
      : { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  return {
    tracks,
    min: tracks.length === 0 ? { x: 0, y: 0, z: 0 } : min,
    size,
    totalTicks,
    warnings,
    placed,
    startupDelayTicks,
  };
}
