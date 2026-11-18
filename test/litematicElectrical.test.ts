import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockIndex, parseLitematic } from '../src/core/litematic/build';
import type { BlockPlacement } from '../src/core/layout/types';
import { RedstoneSim } from '../src/core/sim/redstone';
import { generate, measureLayout } from '../src/main/service';
import type { GenerateResult, GenerateOptions, RegionSummary } from '../src/main/types';
import { writeSong } from './helpers/smf';
import type { WrittenTrack } from './helpers/smf';

/**
 * The unit tests drive the in-memory layout; these ones drive the file that ships.
 *
 * Everything between `LayoutResult` and the `.litematic` on disk can still lose blocks: a region
 * box that clips the last row, a writer that skips a block type, a dust whose connection
 * properties are wrong so the line loads as a disconnected dot, or a power corridor that never
 * reaches the lane it is supposed to feed. A test that only simulates `result.regions` cannot see
 * any of that. So this suite writes the file, reads it back with `parseLitematic`, and simulates
 * the blocks it actually finds.
 *
 * The song is written by hand: the checked-in fixture merges down to three lanes that all start at
 * x = 0, so no lane ever has to borrow power and the corridor code would never run.
 */

/** A lane that plays almost all the time, so its main line starts at x = 0. */
function denseTrack(program: number, offset: number): WrittenTrack {
  const notes: Array<{ midi: number; tick: number }> = [];
  for (let tick = 0; tick < 3000; tick += 24)
    notes.push({ midi: 60 + ((tick / 24) % 5), tick: tick + offset });
  return { program, notes };
}

/** A lane whose first note lands late, so its main line has to borrow power from a neighbour. */
function sparseTrack(program: number, start: number): WrittenTrack {
  const notes: Array<{ midi: number; tick: number }> = [];
  for (let tick = start; tick < 3000; tick += 480) notes.push({ midi: 72, tick });
  return { program, notes };
}

const VECTORS: Record<string, { dx: number; dz: number }> = {
  north: { dx: 0, dz: -1 },
  east: { dx: 1, dz: 0 },
  south: { dx: 0, dz: 1 },
  west: { dx: -1, dz: 0 },
};

const OPPOSITE: Record<string, string> = { north: 'south', east: 'west', south: 'north', west: 'east' };

const AIR = 'minecraft:air';
const NOTE_BLOCK = 'minecraft:note_block';
const DUST = 'minecraft:redstone_wire';
const REPEATER = 'minecraft:repeater';
const CIRCUIT = new Set([DUST, REPEATER, NOTE_BLOCK]);

function cell(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** Read the written file back and index every non-air block by its schematic coordinate. */
function readBack(buffer: Buffer): Map<string, BlockPlacement> {
  const at = new Map<string, BlockPlacement>();
  for (const region of parseLitematic(buffer).regions) {
    const { x: sizeX, y: sizeY, z: sizeZ } = region.size;
    for (let y = 0; y < sizeY; y += 1) {
      for (let z = 0; z < sizeZ; z += 1) {
        for (let x = 0; x < sizeX; x += 1) {
          const state = region.palette[region.indices[blockIndex(x, y, z, sizeX, sizeZ)] ?? 0];
          if (!state || state.name === AIR) continue;
          const pos = { x: region.position.x + x, y: region.position.y + y, z: region.position.z + z };
          at.set(cell(pos.x, pos.y, pos.z), { pos, block: state.name, props: state.properties ?? {} });
        }
      }
    }
  }
  return at;
}

interface Lane {
  name: string;
  /** Z of the lane's main line: the row the player stands on and the row that feeds the chords. */
  z: number;
  minX: number;
  /** False when a repeater corridor from another lane feeds the first cell of this lane. */
  fedByCorridor: boolean;
}

/**
 * Split the file back into lanes from the geometry alone.
 *
 * A lane's main line is the row inside its region that carries the most circuit blocks: every
 * chord row branches off it, so it always wins. A lane that borrows power has no repeater of its
 * own at `minX`, only the last repeater of a corridor whose output points at the head cell.
 */
function lanesOf(at: Map<string, BlockPlacement>, regions: RegionSummary[]): Lane[] {
  const circuit = [...at.values()].filter(
    (placement) => placement.pos.y === 1 && CIRCUIT.has(placement.block),
  );
  const lanes: Lane[] = [];
  for (const region of regions) {
    if (region.size.x < 3) continue;
    // The decoration region (sign wall) carries no notes, so it is not a lane.
    let carriesNote = false;
    for (const placement of at.values()) {
      if (placement.block !== NOTE_BLOCK) continue;
      if (placement.pos.x < region.position.x || placement.pos.x >= region.position.x + region.size.x)
        continue;
      if (placement.pos.z < region.position.z || placement.pos.z >= region.position.z + region.size.z)
        continue;
      carriesNote = true;
      break;
    }
    if (!carriesNote) continue;
    const rowCounts = new Map<number, number>();
    for (const placement of circuit) {
      if (placement.pos.x < region.position.x || placement.pos.x >= region.position.x + region.size.x)
        continue;
      if (placement.pos.z < region.position.z || placement.pos.z >= region.position.z + region.size.z)
        continue;
      rowCounts.set(placement.pos.z, (rowCounts.get(placement.pos.z) ?? 0) + 1);
    }
    let mainZ = Number.NaN;
    let best = -1;
    for (const [z, count] of rowCounts) {
      if (count > best) {
        best = count;
        mainZ = z;
      }
    }
    let minX = Number.POSITIVE_INFINITY;
    for (const placement of circuit) {
      if (placement.pos.z !== mainZ) continue;
      if (placement.pos.x < region.position.x || placement.pos.x >= region.position.x + region.size.x)
        continue;
      minX = Math.min(minX, placement.pos.x);
    }
    let fedByCorridor = false;
    for (const dz of [-1, 1]) {
      const neighbour = at.get(cell(minX, 1, mainZ + dz));
      if (!neighbour || neighbour.block !== REPEATER) continue;
      const vector = VECTORS[String(neighbour.props?.facing ?? '')];
      // A repeater outputs opposite its facing; it feeds this lane when that output is the head.
      if (vector && neighbour.pos.z - vector.dz === mainZ) fedByCorridor = true;
    }
    lanes.push({ name: region.name, z: mainZ, minX, fedByCorridor });
  }
  return lanes;
}

/** Vanilla `RedStoneWireBlock.shouldConnectTo`, transcribed from the game, not from `wiring.ts`. */
function connectsTo(neighbour: BlockPlacement | undefined, direction: string): boolean {
  if (!neighbour) return false;
  if (neighbour.block === DUST) return true;
  if (neighbour.block !== REPEATER) return false;
  const facing = String(neighbour.props?.facing ?? '');
  return facing === direction || facing === OPPOSITE[direction];
}

/** What the four connection properties of a dust block ought to be. */
function expectedSides(at: Map<string, BlockPlacement>, placement: BlockPlacement): Record<string, string> {
  const sides: Record<string, string> = {};
  for (const [direction, vector] of Object.entries(VECTORS)) {
    const neighbour = at.get(cell(placement.pos.x + vector.dx, 1, placement.pos.z + vector.dz));
    sides[direction] = connectsTo(neighbour, direction) ? 'side' : 'none';
  }
  // Vanilla completes an axis whose two directions both came out empty, so dust never loads as a dot.
  if (sides.north === 'none' && sides.south === 'none') {
    sides.west = 'side';
    sides.east = 'side';
  }
  if (sides.east === 'none' && sides.west === 'none') {
    sides.north = 'side';
    sides.south = 'side';
  }
  return sides;
}

const OPTIONS: GenerateOptions = { dMax: 8, laneSharing: false, laneRide: true };

describe('the .litematic on disk is the circuit these tests simulate', () => {
  let directory = '';
  let songPath = '';
  let result: GenerateResult;
  let at: Map<string, BlockPlacement>;
  let lanes: Lane[];

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'musicbox-electrical-'));
    songPath = join(directory, 'song.mid');
    writeSong(songPath, [denseTrack(0, 0), denseTrack(0, 12), sparseTrack(73, 1200), sparseTrack(40, 1500)]);
    const generated = generate(songPath, OPTIONS);
    if (!generated.buffer) throw new Error('the generator produced no schematic');
    result = generated.result;
    at = readBack(Buffer.from(generated.buffer));
    lanes = lanesOf(at, result.regions);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('finds one gap-free main line per generated lane', () => {
    expect(lanes).toHaveLength(result.stats.outputTrackCount);
    expect(lanes.length).toBeGreaterThan(1);
    for (const lane of lanes) {
      const missing: number[] = [];
      for (let x = lane.minX; x <= lane.minX + 40; x += 1) if (!at.has(cell(x, 1, lane.z))) missing.push(x);
      expect({ lane: lane.name, missing: missing.slice(0, 5) }).toEqual({ lane: lane.name, missing: [] });
    }
  });

  it('keeps every block the generator counted', () => {
    const claimed = result.regions.reduce((sum, region) => sum + region.blockCount, 0);
    expect(at.size).toBe(claimed);
    expect([...at.values()].filter((placement) => placement.block === NOTE_BLOCK)).toHaveLength(
      result.stats.noteBlockCount,
    );
  });

  it('gives every repeater an input, because every lane head is a repeater', () => {
    const starved: Array<{ pos: string; facing: string }> = [];
    for (const placement of at.values()) {
      if (placement.block !== REPEATER) continue;
      const facing = String(placement.props?.facing ?? '');
      const vector = VECTORS[facing];
      expect(vector, `repeater facing ${facing}`).toBeDefined();
      if (!vector) continue;
      if (at.has(cell(placement.pos.x + vector.dx, placement.pos.y, placement.pos.z + vector.dz))) continue;
      starved.push({ pos: `${placement.pos.x},${placement.pos.z}`, facing });
    }
    // A head waits for the player to power it: that is the only empty input in the file.
    expect(starved.length).toBeGreaterThan(0);
    expect(starved.length).toBeLessThanOrEqual(lanes.length);
    for (const entry of starved) expect(entry.facing).toBe('west');
    // A borrowed lane has no head of its own: the corridor already feeds its first cell.
    for (const lane of lanes.filter((entry) => !entry.fedByCorridor)) {
      expect(at.get(cell(lane.minX - 1, 1, lane.z))).toBeUndefined();
    }
  });

  it('writes the dust connections vanilla would compute', () => {
    const wrong: Array<{ pos: string; direction: string; wrote: string; want: string }> = [];
    for (const placement of at.values()) {
      if (placement.block !== DUST) continue;
      for (const [direction, side] of Object.entries(expectedSides(at, placement))) {
        const wrote = String(placement.props?.[direction] ?? '');
        if (wrote !== side)
          wrong.push({ pos: `${placement.pos.x},${placement.pos.z}`, direction, wrote, want: side });
      }
      expect(placement.props?.power, `dust at ${placement.pos.x},${placement.pos.z} carries power`).toBe('0');
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('fires every note from the file when the lane heads are powered', () => {
    const measure = measureLayout(songPath, OPTIONS);
    expect(measure.riddenLanes).toBeGreaterThan(0);
    const borrowing = lanes.filter((lane) => lane.fedByCorridor);
    expect(borrowing.length).toBeGreaterThan(0);

    const sim = RedstoneSim.fromPlacements([...at.values()]);
    for (const lane of lanes.filter((entry) => !entry.fedByCorridor)) {
      // The player powers each lane head from the west; a borrowed lane is fed by its corridor.
      sim.set({ x: lane.minX - 1, y: 1, z: lane.z }, { kind: 'source', power: 15 });
    }
    sim.settle();
    sim.run(20000);

    const fired = new Map<string, number>();
    const doubled: string[] = [];
    for (const trigger of sim.noteTriggers) {
      const key = cell(trigger.pos.x, trigger.pos.y, trigger.pos.z);
      if (fired.has(key)) doubled.push(key);
      fired.set(key, trigger.tick);
    }
    const notes = [...at.values()].filter((placement) => placement.block === NOTE_BLOCK);
    const silent = notes.filter(
      (placement) => !fired.has(cell(placement.pos.x, placement.pos.y, placement.pos.z)),
    );
    expect(doubled.slice(0, 5)).toEqual([]);
    expect(silent.map((placement) => `${placement.pos.x},${placement.pos.z}`).slice(0, 5)).toEqual([]);
    expect(fired.size).toBe(notes.length);
  });
});
