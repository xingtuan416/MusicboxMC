import type { NbtCompound } from '../nbt/tag';
import type { BlockPlacement, LayoutResult } from './types';

export interface RegionSlice {
  /** Index of the originating track; regions split off the same track share it. */
  trackIndex: number;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  blocks: BlockPlacement[];
  /** Block entities in region-local coordinates; only the lane signs emit any. */
  tileEntities?: NbtCompound[];
}

interface Column {
  x: number;
  z: number;
  trackIndex: number;
  blocks: BlockPlacement[];
}

interface Band {
  trackIndex: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  columns: Column[];
}

function columnKey(x: number, z: number): string {
  return `${x},${z}`;
}

/**
 * Split the layout into litematic regions.
 *
 * Litematica stores one dense block array per region, and the larger the region the
 * more memory that array costs, so a track gets its own region instead of the whole
 * schematic sharing one.
 *
 * Regions must not overlap, and that is not automatic: a lane-ride corridor runs
 * through the Z rows of the tracks between the host and the guest, so a tall track
 * (one with deep chord branches) has a bounding box that swallows another track's
 * corridor column. Litematica then holds two claims for the same coordinate - "air"
 * from the tall track and "repeater" from the corridor owner - and whichever claim a
 * tool honours, one of them is silently discarded. Whichever region is stored first
 * wins, so a corridor can vanish on paste.
 *
 * The fix is to slice each track into bands: a band covers one contiguous run of Z
 * rows whose blocks all sit in the same X range, and the X range stops at any column
 * that another track occupies. Bands of the same track never overlap each other, and
 * two different tracks can never claim the same column, so no cell is claimed twice.
 *
 * The important detail: coordinates inside a region must be >= 0, while layout
 * coordinates can be negative (chord branches extend along -Z). Each region therefore
 * takes its own minimum as origin and translates its blocks by -(minX, minY, minZ).
 */
export function sliceRegions(result: LayoutResult): RegionSlice[] {
  const columns = new Map<string, Column>();
  for (const tr of result.tracks) {
    for (const block of tr.placements) {
      const key = columnKey(block.pos.x, block.pos.z);
      const existing = columns.get(key);
      if (existing) {
        existing.blocks.push(block);
        continue;
      }
      columns.set(key, { x: block.pos.x, z: block.pos.z, trackIndex: tr.trackIndex, blocks: [block] });
    }
  }

  const rowCells = new Map<number, Column[]>();
  for (const column of columns.values()) {
    const row = rowCells.get(column.z);
    if (row) row.push(column);
    else rowCells.set(column.z, [column]);
  }
  for (const row of rowCells.values()) row.sort((a, b) => a.x - b.x);

  /** True when [x0..x1] x [z0..z1] holds a block of a track other than trackIndex. */
  function holdsForeignBlock(trackIndex: number, x0: number, x1: number, z0: number, z1: number): boolean {
    for (let z = z0; z <= z1; z += 1) {
      const row = rowCells.get(z);
      if (!row) continue;
      let low = 0;
      let high = row.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        const cell = row[mid];
        if (cell === undefined || cell.x < x0) low = mid + 1;
        else high = mid;
      }
      for (let index = low; index < row.length; index += 1) {
        const cell = row[index];
        if (cell === undefined || cell.x > x1) break;
        if (cell.trackIndex !== trackIndex) return true;
      }
    }
    return false;
  }

  const bands: Band[] = [];
  const open = new Map<string, Band>();
  const rowKeys = [...rowCells.keys()].sort((a, b) => a - b);
  for (const z of rowKeys) {
    const row = rowCells.get(z) ?? [];
    const runs: Band[] = [];
    let run: Band | null = null;
    for (const column of row) {
      if (run && run.trackIndex === column.trackIndex) {
        run.x1 = column.x;
        run.columns.push(column);
        continue;
      }
      run = { trackIndex: column.trackIndex, x0: column.x, x1: column.x, z0: z, z1: z, columns: [column] };
      runs.push(run);
    }

    const next = new Map<string, Band>();
    for (const candidate of runs) {
      const key = `${candidate.trackIndex}:${candidate.x0}:${candidate.x1}`;
      const previous = open.get(key);
      if (previous && previous.z1 === z - 1) {
        previous.z1 = z;
        for (const column of candidate.columns) previous.columns.push(column);
        next.set(key, previous);
        continue;
      }
      bands.push(candidate);
      next.set(key, candidate);
    }
    open.clear();
    for (const [key, band] of next) open.set(key, band);
  }

  // A track whose own bounding box already avoids every other track can stay one region; the
  // bands only exist to carve out the columns that a taller track would otherwise claim as air.
  const merged = new Map<
    number,
    { trackIndex: number; x0: number; x1: number; z0: number; z1: number; columns: Column[] }
  >();
  for (const band of bands) {
    const box = merged.get(band.trackIndex);
    if (box) {
      box.x0 = Math.min(box.x0, band.x0);
      box.x1 = Math.max(box.x1, band.x1);
      box.z0 = Math.min(box.z0, band.z0);
      box.z1 = Math.max(box.z1, band.z1);
      for (const column of band.columns) box.columns.push(column);
      continue;
    }
    merged.set(band.trackIndex, {
      trackIndex: band.trackIndex,
      x0: band.x0,
      x1: band.x1,
      z0: band.z0,
      z1: band.z1,
      columns: [...band.columns],
    });
  }

  const keepWhole = new Set<number>();
  for (const [trackIndex, box] of merged) {
    if (!holdsForeignBlock(trackIndex, box.x0, box.x1, box.z0, box.z1)) keepWhole.add(trackIndex);
  }

  const groups: { trackIndex: number; x0: number; x1: number; z0: number; z1: number; columns: Column[] }[] =
    [];
  for (const band of bands) {
    const whole = keepWhole.has(band.trackIndex) ? merged.get(band.trackIndex) : undefined;
    if (whole) {
      if (!groups.includes(whole)) groups.push(whole);
      continue;
    }
    groups.push({
      trackIndex: band.trackIndex,
      x0: band.x0,
      x1: band.x1,
      z0: band.z0,
      z1: band.z1,
      columns: band.columns,
    });
  }

  const slices: RegionSlice[] = [];
  for (const group of groups) {
    const blocks: BlockPlacement[] = [];
    for (const column of group.columns) blocks.push(...column.blocks);
    if (blocks.length === 0) continue;

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const block of blocks) {
      if (block.pos.y < minY) minY = block.pos.y;
      if (block.pos.y > maxY) maxY = block.pos.y;
    }

    const position = { x: group.x0, y: minY, z: group.z0 };
    slices.push({
      trackIndex: group.trackIndex,
      position,
      size: { x: group.x1 - group.x0 + 1, y: maxY - minY + 1, z: group.z1 - group.z0 + 1 },
      blocks: blocks.map((block) => ({
        ...block,
        pos: { x: block.pos.x - position.x, y: block.pos.y - position.y, z: block.pos.z - position.z },
      })),
    });
  }

  return slices;
}
