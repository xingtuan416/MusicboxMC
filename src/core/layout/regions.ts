import type { BlockPlacement, LayoutResult } from './types';

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

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const p of all) {
      minX = Math.min(minX, p.pos.x);
      maxX = Math.max(maxX, p.pos.x);
      minY = Math.min(minY, p.pos.y);
      maxY = Math.max(maxY, p.pos.y);
      minZ = Math.min(minZ, p.pos.z);
      maxZ = Math.max(maxZ, p.pos.z);
    }

    slices.push({
      trackIndex: tr.trackIndex,
      position: { x: minX, y: minY, z: minZ },
      size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
      blocks: all.map((p) => ({
        ...p,
        pos: { x: p.pos.x - minX, y: p.pos.y - minY, z: p.pos.z - minZ },
      })),
    });
  }

  return slices;
}
