import { gzipSync, gunzipSync } from 'node:zlib';
import { packLongArray, requiredBits, unpackLongArray } from './bitArray';
import { NbtCompound, NbtTag, TagType, nbt, nbtIntVec3 } from '../nbt/tag';
import { readNbt } from '../nbt/reader';
import { writeNbt } from '../nbt/writer';
import { BlockState, stateKey } from '../palette/noteBlock';
import { coreError } from '../errors';

export interface RegionData {
  /** Region origin (whole-map coordinate system) */
  position: { x: number; y: number; z: number };
  /** Size, all positive */
  size: { x: number; y: number; z: number };
  /** Blocks in the region, coordinates relative to the region origin */
  blocks: Array<{ x: number; y: number; z: number; state: BlockState }>;
  /** Block entities use region-local x/y/z, as required by Litematica. */
  tileEntities?: NbtCompound[];
}

export interface LitematicMeta {
  name: string;
  author: string;
  description: string;
  /** MC data version (1.20.4 = 3700) */
  dataVersion: number;
  /** litematic format version (1.20.4 = 6) */
  version: number;
}

export const MC_1_20_4_DATA_VERSION = 3700;
export const LITEMATIC_VERSION_1_20_4 = 6;

/** Index order: index = y * (sizeX * sizeZ) + z * sizeX + x */
export function blockIndex(x: number, y: number, z: number, sizeX: number, sizeZ: number): number {
  return y * (sizeX * sizeZ) + z * sizeX + x;
}

interface PackedRegion {
  compound: NbtCompound;
  paletteSize: number;
  volume: number;
  nonAirCount: number;
}

function buildRegion(region: RegionData): PackedRegion {
  const { x: sx, y: sy, z: sz } = region.size;
  const volume = sx * sy * sz;
  const blockPositions = region.tileEntities?.length
    ? new Set(region.blocks.map((block) => `${block.x},${block.y},${block.z}`))
    : new Set<string>();
  const entityPositions = new Set<string>();
  for (const entity of region.tileEntities ?? []) {
    const pos = ['x', 'y', 'z'].map((axis) => getInt(entity, axis));
    if (pos.some((value, i) => value < 0 || value >= [sx, sy, sz][i]!)) {
      throw coreError('LITEMATIC_ENTITY_OUT_OF_BOUNDS');
    }
    if (!blockPositions.has(pos.join(','))) {
      throw coreError('LITEMATIC_ENTITY_WITHOUT_BLOCK');
    }
    if (entityPositions.has(pos.join(','))) throw coreError('LITEMATIC_DUPLICATE_ENTITY');
    entityPositions.add(pos.join(','));
  }

  // Palette: ID 0 must be minecraft:air
  const palette: BlockState[] = [{ name: 'minecraft:air' }];
  const paletteIndex = new Map<string, number>([[stateKey(palette[0]!), 0]]);

  const indices = new Uint32Array(volume); // default 0 = air
  let nonAirCount = 0;

  for (const b of region.blocks) {
    if (b.x < 0 || b.y < 0 || b.z < 0 || b.x >= sx || b.y >= sy || b.z >= sz) {
      throw coreError('LITEMATIC_BLOCK_OUT_OF_BOUNDS', {
        x: b.x,
        y: b.y,
        z: b.z,
        sizeX: sx,
        sizeY: sy,
        sizeZ: sz,
      });
    }
    const key = stateKey(b.state);
    let id = paletteIndex.get(key);
    if (id === undefined) {
      id = palette.length;
      palette.push(b.state);
      paletteIndex.set(key, id);
    }
    indices[blockIndex(b.x, b.y, b.z, sx, sz)] = id;
  }

  // Count the final grid: duplicate coordinates and explicit air must not count as non-air.
  for (const id of indices) {
    if (palette[id]?.name !== 'minecraft:air') nonAirCount++;
  }

  const bits = requiredBits(palette.length);
  const longs = packLongArray(indices, bits);

  const paletteList = palette.map((s) => {
    const entries = new Map<string, NbtTag>();
    entries.set('Name', nbt.string(s.name));
    if (s.properties) {
      const props = new Map<string, NbtTag>();
      for (const [k, v] of Object.entries(s.properties)) props.set(k, nbt.string(v));
      entries.set('Properties', nbt.compound(props));
    }
    return nbt.compound(entries);
  });

  const compound = nbt.compound(
    new Map<string, NbtTag>([
      ['Position', nbtIntVec3(region.position.x, region.position.y, region.position.z)],
      ['Size', nbtIntVec3(sx, sy, sz)],
      ['BlockStatePalette', nbt.list(TagType.Compound, paletteList)],
      ['BlockStates', nbt.longArray(longs)],
      ['TileEntities', nbt.list(TagType.Compound, region.tileEntities ?? [])],
      ['Entities', nbt.list(TagType.Compound, [])],
      ['PendingBlockTicks', nbt.list(TagType.Compound, [])],
      ['PendingFluidTicks', nbt.list(TagType.Compound, [])],
    ]),
  );

  return { compound, paletteSize: palette.length, volume, nonAirCount };
}

/** Assemble the root NBT of a .litematic and gzip it. */
export function buildLitematic(regions: RegionData[], meta: LitematicMeta): Buffer {
  const packed = regions.map(buildRegion);

  const regionMap = new Map<string, NbtTag>();
  packed.forEach((p, i) => regionMap.set(`region_${i}`, p.compound));

  const totalVolume = packed.reduce((s, p) => s + p.volume, 0);
  const totalBlocks = packed.reduce((s, p) => s + p.nonAirCount, 0);

  const bounds = regions.reduce(
    (acc, r) => ({
      minX: Math.min(acc.minX, r.position.x),
      minY: Math.min(acc.minY, r.position.y),
      minZ: Math.min(acc.minZ, r.position.z),
      maxX: Math.max(acc.maxX, r.position.x + r.size.x),
      maxY: Math.max(acc.maxY, r.position.y + r.size.y),
      maxZ: Math.max(acc.maxZ, r.position.z + r.size.z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
  const enclosing =
    regions.length === 0
      ? { x: 0, y: 0, z: 0 }
      : {
          x: bounds.maxX - bounds.minX,
          y: bounds.maxY - bounds.minY,
          z: bounds.maxZ - bounds.minZ,
        };

  const now = BigInt(Date.now());

  const metadata = nbt.compound(
    new Map<string, NbtTag>([
      ['Name', nbt.string(meta.name)],
      ['Author', nbt.string(meta.author)],
      ['Description', nbt.string(meta.description)],
      ['RegionCount', nbt.int(regions.length)],
      ['TotalVolume', nbt.int(totalVolume)],
      ['TotalBlocks', nbt.int(totalBlocks)],
      ['TimeCreated', nbt.long(now)],
      ['TimeModified', nbt.long(now)],
      ['EnclosingSize', nbtIntVec3(enclosing.x, enclosing.y, enclosing.z)],
    ]),
  );

  // Write order: Version → MinecraftDataVersion → Metadata → Regions
  const root = nbt.compound(
    new Map<string, NbtTag>([
      ['Version', nbt.int(meta.version)],
      ['MinecraftDataVersion', nbt.int(meta.dataVersion)],
      ['Metadata', metadata],
      ['Regions', nbt.compound(regionMap)],
    ]),
  );

  return gzipSync(writeNbt('', root));
}

// ---- Read-back verification ----

export interface ParsedRegion {
  name: string;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  palette: BlockState[];
  /** Unpacked palette indices, queryable via blockIndex with (x,y,z) */
  indices: Uint32Array;
  /** Raw region-local block entities, preserved for export roundtrip verification. */
  tileEntities: NbtCompound[];
}

export interface ParsedLitematic {
  version: number;
  dataVersion: number;
  metadata: { name: string; author: string; description: string; regionCount: number };
  regions: ParsedRegion[];
}

function getInt(c: NbtCompound, key: string): number {
  const t = c.value.get(key);
  if (!t || t.type !== TagType.Int) throw coreError('LITEMATIC_MISSING_INT', { key });
  return t.value;
}

function getVec3(c: NbtCompound, key: string): { x: number; y: number; z: number } {
  const t = c.value.get(key);
  if (!t || t.type !== TagType.Compound) throw coreError('LITEMATIC_MISSING_COMPOUND', { key });
  return {
    x: getInt(t, 'x'),
    y: getInt(t, 'y'),
    z: getInt(t, 'z'),
  };
}

/** Decompress and parse a .litematic (in-house read-back for verification and simulation). */
export function parseLitematic(buf: Buffer): ParsedLitematic {
  const { tag } = readNbt(gunzipSync(buf));
  if (tag.type !== TagType.Compound) throw coreError('LITEMATIC_ROOT_NOT_COMPOUND');

  const version = getInt(tag, 'Version');
  const dataVersion = getInt(tag, 'MinecraftDataVersion');

  const metaTag = tag.value.get('Metadata');
  if (!metaTag || metaTag.type !== TagType.Compound) throw coreError('LITEMATIC_MISSING_METADATA');
  const metadata = {
    name: (metaTag.value.get('Name') as { value: string }).value,
    author: (metaTag.value.get('Author') as { value: string }).value,
    description: (metaTag.value.get('Description') as { value: string }).value,
    regionCount: getInt(metaTag, 'RegionCount'),
  };

  const regionsTag = tag.value.get('Regions');
  if (!regionsTag || regionsTag.type !== TagType.Compound) throw coreError('LITEMATIC_MISSING_REGIONS');

  const regions: ParsedRegion[] = [];
  for (const [name, regionTag] of regionsTag.value) {
    if (regionTag.type !== TagType.Compound) continue;
    const position = getVec3(regionTag, 'Position');
    const size = getVec3(regionTag, 'Size');

    const paletteTag = regionTag.value.get('BlockStatePalette');
    if (!paletteTag || paletteTag.type !== TagType.List) throw coreError('LITEMATIC_MISSING_PALETTE');
    const palette: BlockState[] = paletteTag.value.map((entry) => {
      if (entry.type !== TagType.Compound) throw coreError('LITEMATIC_BAD_PALETTE_ENTRY');
      const nameTag = entry.value.get('Name');
      const propsTag = entry.value.get('Properties');
      const state: BlockState = { name: nameTag ? (nameTag as { value: string }).value : 'minecraft:air' };
      if (propsTag && propsTag.type === TagType.Compound) {
        const props: Record<string, string> = {};
        for (const [k, v] of propsTag.value) props[k] = (v as { value: string }).value;
        state.properties = props;
      }
      return state;
    });

    const statesTag = regionTag.value.get('BlockStates');
    if (!statesTag || statesTag.type !== TagType.LongArray) throw coreError('LITEMATIC_MISSING_BLOCK_STATES');

    const volume = Math.abs(size.x) * Math.abs(size.y) * Math.abs(size.z);
    const bits = requiredBits(palette.length);
    const indices = unpackLongArray(statesTag.value, volume, bits);
    const entitiesTag = regionTag.value.get('TileEntities');
    const tileEntities =
      entitiesTag?.type === TagType.List
        ? entitiesTag.value.filter((entry): entry is NbtCompound => entry.type === TagType.Compound)
        : [];
    regions.push({ name, position, size, palette, indices, tileEntities });
  }

  return { version, dataVersion, metadata, regions };
}
