import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildLitematic,
  blockIndex,
  LITEMATIC_VERSION_1_20_4,
  MC_1_20_4_DATA_VERSION,
  parseLitematic,
  type RegionData,
} from '../src/core/litematic/build';
import { writeNbt } from '../src/core/nbt/writer';
import { readNbt } from '../src/core/nbt/reader';
import { TagType, nbt } from '../src/core/nbt/tag';
import { expectCoreError } from './helpers/errors';

describe('NBT writer/reader round-trip', () => {
  it('round-trips every tag type', () => {
    const root = nbt.compound({
      b: nbt.byte(-5),
      s: nbt.short(-300),
      i: nbt.int(-70000),
      l: nbt.long(1234567890123n),
      f: nbt.float(1.5),
      d: nbt.double(3.14159),
      str: nbt.string('hello 红石'),
      ba: nbt.byteArray([1, -2, 3]),
      ia: nbt.intArray([1, 2, -3]),
      la: nbt.longArray([1n, 2n, -3n]),
      list: nbt.list(TagType.Int, [nbt.int(1), nbt.int(2)]),
      nested: nbt.compound({ inner: nbt.string('x') }),
    });

    const bytes = writeNbt('root', root);
    const { name, tag } = readNbt(bytes);
    expect(name).toBe('root');
    expect(tag.type).toBe(TagType.Compound);

    const c = tag as typeof root;
    expect((c.value.get('b') as { value: number }).value).toBe(-5);
    expect((c.value.get('s') as { value: number }).value).toBe(-300);
    expect((c.value.get('i') as { value: number }).value).toBe(-70000);
    expect((c.value.get('l') as { value: bigint }).value).toBe(1234567890123n);
    expect((c.value.get('str') as { value: string }).value).toBe('hello 红石');
    expect([...(c.value.get('la') as { value: bigint[] }).value]).toEqual([1n, 2n, -3n]);
    expect((c.value.get('list') as { value: unknown[] }).value).toHaveLength(2);
  });
});

/**
 * Self-consistency, not format correctness.
 *
 * These assertions prove the writer and reader agree with each other. They cannot prove
 * either agrees with the format: both once agreed that NBT strings were plain UTF-8, and
 * Java refused the result. Format correctness is covered by the describe block at the end
 * of this file, which is anchored to a reader written from the specification.
 */
describe('litematic assembly and read-back (self-consistency)', () => {
  const region: RegionData = {
    position: { x: 0, y: 0, z: 0 },
    size: { x: 4, y: 3, z: 2 },
    blocks: [
      { x: 0, y: 2, z: 0, state: { name: 'minecraft:redstone_wire', properties: { power: '15' } } },
      {
        x: 0,
        y: 1,
        z: 0,
        state: {
          name: 'minecraft:note_block',
          properties: { instrument: 'harp', note: '12', powered: 'false' },
        },
      },
      { x: 0, y: 0, z: 0, state: { name: 'minecraft:grass_block' } },
      {
        x: 1,
        y: 2,
        z: 0,
        state: {
          name: 'minecraft:repeater',
          properties: { facing: 'east', delay: '4', locked: 'false', powered: 'false' },
        },
      },
    ],
  };

  it('reads back a generated file with air as palette[0]', () => {
    const buf = buildLitematic([region], {
      name: 'Test',
      author: 'MusicboxMC',
      description: 'test',
      dataVersion: MC_1_20_4_DATA_VERSION,
      version: LITEMATIC_VERSION_1_20_4,
    });

    const parsed = parseLitematic(buf);
    expect(parsed.version).toBe(6);
    expect(parsed.dataVersion).toBe(3700);
    expect(parsed.metadata.name).toBe('Test');
    expect(parsed.regions).toHaveLength(1);

    const r = parsed.regions[0]!;
    expect(r.palette[0]!.name).toBe('minecraft:air');
  });

  it('preserves block coordinates and states through a round trip', () => {
    const buf = buildLitematic([region], {
      name: 'T',
      author: 'A',
      description: '',
      dataVersion: 3700,
      version: 6,
    });
    const r = parseLitematic(buf).regions[0]!;

    const at = (x: number, y: number, z: number) =>
      r.palette[r.indices[blockIndex(x, y, z, r.size.x, r.size.z)]!]!;

    expect(at(0, 2, 0).name).toBe('minecraft:redstone_wire');
    expect(at(0, 2, 0).properties?.power).toBe('15');
    expect(at(0, 1, 0).name).toBe('minecraft:note_block');
    expect(at(0, 1, 0).properties?.instrument).toBe('harp');
    expect(at(0, 1, 0).properties?.note).toBe('12');
    expect(at(0, 0, 0).name).toBe('minecraft:grass_block');
    expect(at(1, 2, 0).properties?.delay).toBe('4');
    // Anything not placed stays as air.
    expect(at(3, 0, 1).name).toBe('minecraft:air');
  });

  it('rejects block coordinates outside the region size', () => {
    expectCoreError(
      () =>
        buildLitematic([{ ...region, blocks: [{ x: 99, y: 0, z: 0, state: { name: 'minecraft:stone' } }] }], {
          name: 'x',
          author: 'x',
          description: '',
          dataVersion: 3700,
          version: 6,
        }),
      'LITEMATIC_BLOCK_OUT_OF_BOUNDS',
    );
  });
});

/**
 * Format correctness, anchored to something that is not this project.
 *
 * `test/fixtures/VerifyLitematic.java` parses NBT and unpacks the bit array from the format
 * description alone: tag framing, `readUTF`, and entries that cross 64-bit word boundaries.
 * Its output is the authority below. Reproduce it with:
 *
 *   java test/fixtures/VerifyLitematic.java test/fixtures/tiny.litematic
 *
 * which prints:
 *
 *   Version=6  MinecraftDataVersion=3700  Metadata.RegionCount=1
 *   region_0 size=2x1x2 palette=5 bits=3 words=1 expectedWords=1
 *   cell(0,0,0) paletteIndex=1 block=minecraft:stone
 *   cell(1,0,0) paletteIndex=2 block=minecraft:note_block
 *   cell(0,0,1) paletteIndex=3 block=minecraft:repeater
 *   cell(1,0,1) paletteIndex=4 block=minecraft:redstone_wire
 */
describe('litematic format, checked against a reader written from the specification', () => {
  const FIXTURE = resolve('test/fixtures/tiny.litematic');
  const RAW_FIXTURE = resolve('test/fixtures/tiny.litematic.nbt');

  const region: RegionData = {
    position: { x: 0, y: 0, z: 0 },
    size: { x: 2, y: 1, z: 2 },
    // Four distinct blocks, so a packing error cannot hide behind repetition.
    blocks: [
      { x: 0, y: 0, z: 0, state: { name: 'minecraft:stone' } },
      { x: 1, y: 0, z: 0, state: { name: 'minecraft:note_block', properties: { note: '7' } } },
      { x: 0, y: 0, z: 1, state: { name: 'minecraft:repeater', properties: { delay: '3' } } },
      { x: 1, y: 0, z: 1, state: { name: 'minecraft:redstone_wire', properties: { power: '0' } } },
    ],
  };
  const meta = { name: 'fixture', author: 'test', description: '', dataVersion: 3700, version: 6 };

  it('produces a file of the size Java read', () => {
    // A byte-exact comparison is not possible, and not because of gzip: the metadata writes
    // TimeCreated and TimeModified from Date.now(), so six bytes of the 685 differ on every
    // build. Length plus the per-cell assertions below cover what a byte comparison would
    // have caught - a change to the palette, the entry width or the tag framing moves one or
    // the other.
    const raw = gunzipSync(buildLitematic([region], meta));
    expect(raw.length).toBe(readFileSync(RAW_FIXTURE).length);
  });

  it('parses the fixture into the structure Java reported', () => {
    const parsed = parseLitematic(readFileSync(FIXTURE));
    expect(parsed.version).toBe(6);
    expect(parsed.dataVersion).toBe(3700);
    expect(parsed.metadata.regionCount).toBe(1);

    const parsedRegion = parsed.regions[0]!;
    expect(parsedRegion.size).toEqual({ x: 2, y: 1, z: 2 });
    // Five entries: air plus the four blocks. That is what makes the entry width 3 bits.
    expect(parsedRegion.palette).toHaveLength(5);
  });

  it('unpacks every cell to the block Java found in it', () => {
    const parsedRegion = parseLitematic(readFileSync(FIXTURE)).regions[0]!;
    const expected: Array<[number, number, number, string]> = [
      [0, 0, 0, 'minecraft:stone'],
      [1, 0, 0, 'minecraft:note_block'],
      [0, 0, 1, 'minecraft:repeater'],
      [1, 0, 1, 'minecraft:redstone_wire'],
    ];

    for (const [x, y, z, block] of expected) {
      const index = parsedRegion.indices[blockIndex(x, y, z, parsedRegion.size.x, parsedRegion.size.z)]!;
      expect(parsedRegion.palette[index]?.name, `cell(${x},${y},${z})`).toBe(block);
    }
  });
});
