import type { sliceRegions } from '../core/layout/regions';
import type { RegionData } from '../core/litematic/build';
import type { PreviewData } from './types';

/**
 * The top-down preview the renderer draws.
 *
 * Wire, repeaters and note blocks all live on one layer, so the preview cannot be
 * layered by Y. It is split by block type instead and the frontend stacks the
 * layers as floor, then wire, then note blocks.
 */

const EMPTY_LAYER: string[] = [];

export const EMPTY_PREVIEW: PreviewData = {
  size: { x: 0, y: 0, z: 0 },
  origin: { x: 0, z: 0 },
  wireCells: EMPTY_LAYER,
  repeaterDelays: EMPTY_LAYER,
  repeaterFacings: EMPTY_LAYER,
  noteCells: EMPTY_LAYER,
  baseCells: EMPTY_LAYER,
  blocks: [],
};

export function toRegionData(slices: ReturnType<typeof sliceRegions>): RegionData[] {
  return slices.map((s) => ({
    position: s.position,
    size: s.size,
    blocks: s.blocks.map((b) => ({
      x: b.pos.x,
      y: b.pos.y,
      z: b.pos.z,
      state: { name: b.block, properties: b.props ?? {} },
    })),
  }));
}

/** The preview layers by block type: wire / note blocks / floor. */
export function buildPreview(slices: ReturnType<typeof sliceRegions>, topDown = false): PreviewData {
  if (slices.length === 0) {
    return {
      size: { x: 0, y: 0, z: 0 },
      origin: { x: 0, z: 0 },
      wireCells: EMPTY_LAYER,
      repeaterDelays: EMPTY_LAYER,
      repeaterFacings: EMPTY_LAYER,
      noteCells: EMPTY_LAYER,
      baseCells: EMPTY_LAYER,
      blocks: [],
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let maxY = 0;
  for (const s of slices) {
    minX = Math.min(minX, s.position.x);
    minZ = Math.min(minZ, s.position.z);
    maxX = Math.max(maxX, s.position.x + s.size.x);
    maxZ = Math.max(maxZ, s.position.z + s.size.z);
    maxY = Math.max(maxY, s.position.y + s.size.y);
  }
  const width = maxX - minX;
  const depth = maxZ - minZ;

  // Row-major: index = z * width + x
  const wireCells = new Array<string>(width * depth).fill('');
  const repeaterDelays = new Array<string>(width * depth).fill('');
  const repeaterFacings = new Array<string>(width * depth).fill('');
  const noteCells = new Array<string>(width * depth).fill('');
  const baseCells = new Array<string>(width * depth).fill('');
  const baseHeights = topDown ? new Array<number>(width * depth).fill(-Infinity) : [];

  for (const s of slices) {
    for (const b of s.blocks) {
      const gx = s.position.x + b.pos.x - minX;
      const gz = s.position.z + b.pos.z - minZ;
      const idx = gz * width + gx;
      if (idx < 0 || idx >= width * depth) continue;
      const layer =
        b.block === 'minecraft:redstone_wire' || b.block === 'minecraft:repeater'
          ? wireCells
          : b.block === 'minecraft:note_block'
            ? noteCells
            : baseCells;
      // Command mode is vertically packed; show its topmost block at each X/Z.
      if (layer === baseCells && topDown) {
        if (b.pos.y >= baseHeights[idx]!) {
          layer[idx] = b.block;
          baseHeights[idx] = b.pos.y;
        }
      } else if (layer[idx] === '') layer[idx] = b.block;
      if (layer === wireCells && b.block === 'minecraft:repeater') {
        repeaterDelays[idx] = b.props?.delay ?? '';
        repeaterFacings[idx] = b.props?.facing ?? 'west';
      }
    }
  }

  const blocks = new Set<string>();
  for (const layer of [wireCells, noteCells, baseCells]) {
    for (const cell of layer) if (cell) blocks.add(cell);
  }
  return {
    size: { x: width, y: maxY, z: depth },
    origin: { x: minX, z: minZ },
    wireCells,
    repeaterDelays,
    repeaterFacings,
    noteCells,
    baseCells,
    blocks: [...blocks].sort(),
  };
}
