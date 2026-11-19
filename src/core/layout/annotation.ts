import { nbt, TagType, type NbtCompound } from '../nbt/tag';
import type { RegionSlice } from './regions';
import { boundsOf, sizeOf } from './placement';
import type { BlockPlacement, Vec3 } from './types';

/**
 * Signs that say which lane is the lead.
 *
 * A pasted schematic is unreadable on its own: every lane looks the same, so the
 * player cannot tell which one the arrangement treats as the main voice, and in a
 * merged layout there is no lead at all. One sign per lane fixes that, plus a wall
 * of them at the start gives the layout a readable legend.
 *
 * The signs live in their own region so they can be deleted or moved in Litematica
 * without touching the circuit.
 */

export type LaneRole =
  /** The lane holding the highest-ranked source track. */
  | 'lead'
  /** Any other lane while a lead exists. */
  | 'secondary'
  /** A numbered lane in a layout that claims no lead (manual routing, no lead track). */
  | 'lane'
  /** The whole song ended up on one spine, so no lane is the lead. */
  | 'merged';

export interface LaneInfo {
  /** Source tracks this lane carries, in layout order. */
  sourceTracks: readonly number[];
  /** The lane's main line, after the lead lane was moved onto z = 0. */
  zBase: number;
  /** Occupied Z range of the lane, inclusive. */
  zMin: number;
  zMax: number;
}

export interface LaneSign {
  role: LaneRole;
  sourceTracks: number[];
  /** Z row the sign stands on. */
  z: number;
  /** Support block, next to the sign. */
  support: Vec3;
  /** Sign block. */
  pos: Vec3;
  /** Four lines, top to bottom; short lines are padded by the game. */
  lines: string[];
}

export interface LaneAnnotation {
  signs: LaneSign[];
  blocks: BlockPlacement[];
  /** Where the player should stand, in layout coordinates (feet level). */
  player: Vec3;
  /** True when the whole song is on one spine. */
  singleLane: boolean;
  /** Largest Z distance from the player's row to any lane edge, in blocks. */
  spreadZ: number;
}

export interface AnnotationOptions {
  lanes: readonly LaneInfo[];
  /** Index into `lanes` of the lane carrying the lead track, or null when none does. */
  leadLane: number | null;
  /** Left edge of the circuit; the sign wall sits directly before it. */
  minX: number;
  /** Circuit layer; the sign stands here and its support one block below. */
  y: number;
  /** Short label for a lane, e.g. `轨 3` or `轨 3+7`. */
  label: (sourceTracks: readonly number[]) => string;
  /** Loudness intent of the lane's strongest source track, e.g. `力度 94%`. */
  strength: (sourceTracks: readonly number[]) => string | null;
  /**
   * Row the layout decided the player stands on, from `LayoutResult.playerZ`.
   *
   * Passed in rather than derived here so the sign and the routing decision can never
   * disagree about which row "stand here" means.
   */
  playerZ?: number;
  /** Farthest note block from that row; the number the 48-block rule judges. */
  spreadZ?: number;
  /**
   * Column to name as the standing spot, from the average note column of the song.
   *
   * A redstone song is walked, not stood still in: the player starts at the first note and
   * keeps moving east. Naming the first column put the spot thousands of blocks away from
   * most of the music, so the mean note column is the honest answer. Absent means "start".
   */
  playerX?: number;
}

/**
 * Blocks between the sign column and the circuit.
 *
 * Three: a wall sign needs its support block on the far side, which leaves one cell
 * between that support and the first circuit column. The signs face -X, so a player
 * standing in front of them at the start of the song reads them without turning.
 */
export const SIGN_COLUMN_GAP = 3;

/** Wall sign block id; the command player already ships the same vanilla block. */
const SIGN_BLOCK = 'minecraft:oak_wall_sign';

/** Support block differs by role, so the lead is findable from a distance. */
const SUPPORT_BLOCK: Record<LaneRole, string> = {
  lead: 'minecraft:gold_block',
  secondary: 'minecraft:copper_block',
  lane: 'minecraft:copper_block',
  merged: 'minecraft:gold_block',
};

/**
 * Plan the sign wall and the recommended standing spot.
 *
 * Every lane gets one sign at its own Z row, all in the same column before the
 * circuit, so the wall reads as a legend in lane order. The lead lane (or the whole
 * spine, when the song collapsed into one) is the only one that says "stand here".
 */
export function planLaneAnnotation(opts: AnnotationOptions): LaneAnnotation | null {
  // Resolve the lead lane before filtering so an empty lane ahead of it cannot shift the index.
  const leadInfo = opts.leadLane === null ? null : (opts.lanes[opts.leadLane] ?? null);
  const lanes = opts.lanes.filter((lane) => lane.sourceTracks.length > 0);
  if (lanes.length === 0) return null;

  const singleLane = lanes.length === 1;
  const lead = singleLane || leadInfo === null ? null : lanes.indexOf(leadInfo);
  const leadLane = lead === null || lead < 0 ? null : (lanes[lead] ?? null);
  const playerZ =
    opts.playerZ ??
    (leadLane !== null
      ? leadLane.zBase
      : Math.round(
          (Math.min(...lanes.map((lane) => lane.zMin)) + Math.max(...lanes.map((lane) => lane.zMax))) / 2,
        ));

  const signX = opts.minX - SIGN_COLUMN_GAP;
  const supportX = signX + 1;
  const blocks: BlockPlacement[] = [];
  const signs: LaneSign[] = [];

  lanes.forEach((lane, index) => {
    const role: LaneRole = singleLane
      ? 'merged'
      : index === lead
        ? 'lead'
        : lead === null
          ? 'lane'
          : 'secondary';
    const label = opts.label(lane.sourceTracks);
    const strength = opts.strength(lane.sourceTracks);
    const distance = Math.abs(lane.zBase - playerZ);
    const lines =
      role === 'merged'
        ? ['全曲主线', label, '站这里', '主线行']
        : role === 'lead'
          ? ['主音轨', label, strength ?? '', '站这里']
          : role === 'secondary'
            ? ['副轨', label, strength ?? '', `距主轨 ${distance}`]
            : ['音轨', label, strength ?? '', '未指定主轨'];

    const supportY = opts.y;
    const z = lane.zBase;
    const support: Vec3 = { x: supportX, y: supportY, z };
    const pos: Vec3 = { x: signX, y: supportY, z };
    blocks.push({ pos: { x: supportX, y: supportY - 1, z }, block: SUPPORT_BLOCK[role] });
    blocks.push({ pos: support, block: SUPPORT_BLOCK[role] });
    blocks.push({ pos, block: SIGN_BLOCK, props: { facing: 'west', waterlogged: 'false' } });
    signs.push({ role, sourceTracks: [...lane.sourceTracks], z, support, pos, lines });
  });

  const spreadZ =
    opts.spreadZ ??
    lanes.reduce(
      (widest, lane) => Math.max(widest, Math.abs(lane.zMin - playerZ), Math.abs(lane.zMax - playerZ)),
      0,
    );

  return {
    signs,
    blocks,
    player: { x: opts.playerX ?? opts.minX - 1, y: opts.y, z: playerZ },
    singleLane,
    spreadZ,
  };
}

/**
 * The sign's block entity, with region-local coordinates.
 *
 * The text is stored as JSON strings, exactly like the command player writes them:
 * plain text in `messages` loads as an empty sign in modern versions.
 */
export function signEntity(sign: LaneSign, offset: Vec3): NbtCompound {
  const text = nbt.compound({
    messages: nbt.list(
      TagType.String,
      Array.from({ length: 4 }, (_, i) => sign.lines[i] ?? '').map((line) =>
        nbt.string(JSON.stringify({ text: line })),
      ),
    ),
    color: nbt.string('black'),
    has_glowing_text: nbt.byte(0),
  });
  return nbt.compound({
    id: nbt.string('minecraft:sign'),
    x: nbt.int(sign.pos.x - offset.x),
    y: nbt.int(sign.pos.y - offset.y),
    z: nbt.int(sign.pos.z - offset.z),
    front_text: text,
    back_text: text,
    is_waxed: nbt.byte(1),
  });
}

/**
 * Package the annotation as its own region.
 *
 * `trackIndex` is -2: not a note track and not the forced spine, so the interface can
 * tell the legend apart from the music.
 */
export function annotationSlice(annotation: LaneAnnotation | null): RegionSlice | null {
  const all: BlockPlacement[] = annotation?.blocks ?? [];
  const bounds = boundsOf(all);
  if (!bounds) return null;
  const { min, max } = bounds;
  return {
    trackIndex: -2,
    position: min,
    size: sizeOf(min, max),
    blocks: all.map((block) => ({
      ...block,
      pos: { x: block.pos.x - min.x, y: block.pos.y - min.y, z: block.pos.z - min.z },
    })),
    ...(annotation ? { tileEntities: annotation.signs.map((sign) => signEntity(sign, min)) } : {}),
  };
}
