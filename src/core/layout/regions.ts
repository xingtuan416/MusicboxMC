import type { BlockPlacement, LayoutResult } from './types';
import { boundsOf, sizeOf } from './placement';

export interface RegionSlice {
  /** Index of the originating track; regions split off the same track share it. */
  trackIndex: number;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  blocks: BlockPlacement[];
}

/**
 * Split the layout into litematic regions.
 *
 * Litematica stores one dense block array per region, and the larger the region the
 * more memory that array costs, so regions are split per track rather than covering
 * the whole schematic. A track's Z range is contiguous and tracks are separated by at
 * least one trackPitch, so the regions never overlap.
 *
 * The important detail: coordinates inside a region must be >= 0, while layout
 * coordinates can be negative (chord branches extend along -Z). Each region therefore
 * takes its own minimum as origin and translates its blocks by -(minX, minY, minZ).
 */
export function sliceRegions(result: LayoutResult): RegionSlice[] {
  const slices: RegionSlice[] = [];

  for (const tr of result.tracks) {
    const all = tr.placements;
    if (all.length === 0) continue;

    const bounds = boundsOf(all);
    if (!bounds) continue;
    const { min, max } = bounds;

    slices.push({
      trackIndex: tr.trackIndex,
      position: min,
      size: sizeOf(min, max),
      blocks: all.map((p) => ({
        ...p,
        pos: { x: p.pos.x - min.x, y: p.pos.y - min.y, z: p.pos.z - min.z },
      })),
    });
  }

  return slices;
}
