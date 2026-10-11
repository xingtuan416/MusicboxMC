# Litematic output format

How `core/litematic/` writes a `.litematic` that Litematica can load, and the
details that are easy to get wrong.

Target: **Minecraft 1.20.4** — `MinecraftDataVersion` 3700, litematic `Version` 6.

## Root structure

```
(root, unnamed)
├── Version                Int    6
├── MinecraftDataVersion   Int    3700
├── Metadata               Compound
│   ├── Name, Author, Description   String
│   ├── RegionCount                 Int
│   ├── TotalVolume, TotalBlocks    Int
│   ├── TimeCreated, TimeModified   Long
│   └── EnclosingSize               Compound{x,y,z} Int
└── Regions                Compound
    ├── region_0           Compound
    └── region_1           ...
```

Each region:

```
├── Position           Compound{x,y,z} Int    origin in schematic space
├── Size               Compound{x,y,z} Int    always positive
├── BlockStatePalette  List<Compound>         index 0 must be minecraft:air
├── BlockStates        LongArray              packed palette indices
├── TileEntities       List<Compound>         command blocks, signs
├── Entities           List<Compound>         always empty here
├── PendingBlockTicks  List<Compound>         always empty here
└── PendingFluidTicks  List<Compound>         always empty here
```

The whole NBT tree is serialised big-endian and then gzipped.

## Bit packing

Litematica's `BlockStates` array is **not** the same as vanilla Minecraft's
`BitArray`. Entries are packed contiguously and **cross 64-bit word boundaries**;
vanilla pads each word instead. Copying vanilla's implementation produces a file
that loads with scrambled blocks.

```
bits   = max(2, ceil(log2(paletteSize)))
length = ceil(volume * bits / 64)
entry i starts at bit  start = i * bits
word index      startWord = start >>> 6
bit offset      startOffset = start & 63
last word       endWord = (start + bits - 1) >>> 6
```

Bits are written least-significant-first within each word. When an entry spans
two words, the low part goes into `startWord` and the remainder is shifted into
`endWord`.

**Reading requires normalising the sign bit.** NBT stores longs as signed, so a
value with bit 63 set arrives negative. `unpackLongArray` applies
`BigInt.asUintN(64, ...)` before shifting; without it the sign bit fills the
following palette entry with ones and every block after that point is wrong.

`requiredBits` returns at least 2, because a palette of one entry still needs a
representable width.

## Index order

```
index = y * (sizeX * sizeZ) + z * sizeX + x
```

Note that `y` is the outermost axis and `z` sits between `y` and `x`. Getting
this wrong produces a schematic that looks plausible but is transposed.

## Regions

Litematica stores one dense array per region, so a single region covering a whole
song costs `volume * bits / 8` bytes regardless of how empty it is. `sliceRegions`
therefore emits **one region per track**; because tracks are separated by at least
one `trackPitch` along Z, the regions never overlap.

Two details matter:

- Region-local block coordinates must be **≥ 0**. Layout coordinates can be
  negative (chord branches extend along −Z), so each region takes its own minimum
  as origin and translates its blocks by `-(minX, minY, minZ)`.
- `TileEntities` coordinates are **region-local**, matching the blocks, not
  schematic-global.

`buildRegion` validates this: a tile entity that is out of bounds, duplicated, or
that has no block at its position fails the build instead of producing a file
Litematica would reject.

## Palette

Index 0 is always `minecraft:air` — Litematica relies on it for empty cells.
Entries are deduplicated by a stable key that sorts the property names, so
`{delay, facing}` and `{facing, delay}` are the same state.

Block states are built by `core/palette/noteBlock.ts` rather than assembled
inline, so a repeater always carries `delay`, `facing`, `locked` and `powered`,
and a note block always carries `instrument`, `note` and `powered`.

### Redstone dust connections

A dust block's `north`/`east`/`south`/`west` properties are part of its block
state. Placing dust by hand in game makes Minecraft update them automatically;
writing a schematic does not. If they are omitted, the dust loads as an
unconnected dot — which visibly breaks branch columns in chords of four or more
notes.

`core/layout/wiring.ts` computes them from the neighbouring blocks, following
`RedStoneWireBlock`:

- Dust connects to other dust, and to a repeater **only along that repeater's own
  axis**. A note block, stone or any other full block is a redstone conductor and
  gets `none`.
- Dust never renders as a bare dot. If a whole axis has no connection on either
  side, both of its sides are filled in, so an isolated dust block becomes a cross
  and a dust block with one neighbour becomes a full straight line.

The `RedstoneSide.UP` branch of the vanilla rule is omitted: it needs dust climbing
onto a block above its neighbour, and the generator keeps every dust block on one
circuit layer.

`test/wireConnections.test.ts` encodes the vanilla cases directly rather than the
generator's own output, so it fails if the rule drifts from the game.

### Power

Dust is always written with `power=0`. A schematic is pasted unpowered; writing
15 would paste a circuit that is already lit, which is not the state the player
gets when they place the same blocks by hand.

## Round-tripping

`parseLitematic` reads the format back with the project's own NBT reader, and the
test suite uses it to verify that a build survives the round trip: palette,
indices, positions, sizes and tile entities. It is also what the acceptance tests
use to count note blocks in the exported file rather than trusting the layout's
own bookkeeping.

## See also

- [architecture.md](architecture.md) — where this code lives
- [redstone-model.md](redstone-model.md) — what the blocks mean
