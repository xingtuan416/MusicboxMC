import type { BlockState } from '../palette/noteBlock';
import type { BlockPlacement, Vec3 } from './types';

/**
 * Combine a block state with a position to form one placement in the layout result.
 *
 * The layout works with positioned blocks (BlockPlacement) while the palette describes
 * block states (name plus properties). Keeping the conversion here means **every block
 * the generator emits comes from a palette constructor**, so blockstate values and
 * their semantics - the repeater facing convention, a note block's powered flag, the
 * valid range of a dust block's power - are defined once and cannot be lost by hand-
 * writing a literal in the layout code.
 */
export function place(pos: Vec3, state: BlockState): BlockPlacement {
  return { pos, block: state.name, props: state.properties };
}

/**
 * Axis-aligned bounds of a set of placements, or null when there are none.
 *
 * Two callers need this - the whole layout, and each region it is split into - and both
 * used to accumulate it by hand. They disagreed on where the maximum starts, which only
 * shows up for a layout that happens to sit at the origin.
 */
export function boundsOf(blocks: readonly BlockPlacement[]): { min: Vec3; max: Vec3 } | null {
  if (blocks.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    minX = Math.min(minX, block.pos.x);
    minY = Math.min(minY, block.pos.y);
    minZ = Math.min(minZ, block.pos.z);
    maxX = Math.max(maxX, block.pos.x);
    maxY = Math.max(maxY, block.pos.y);
    maxZ = Math.max(maxZ, block.pos.z);
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/** Size in cells of an inclusive axis-aligned box. */
export function sizeOf(min: Vec3, max: Vec3): Vec3 {
  return { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
}
