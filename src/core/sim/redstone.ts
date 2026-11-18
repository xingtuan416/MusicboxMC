import type { BlockPlacement, Vec3 } from '../layout/types';

/**
 * A small block-level redstone simulator. Tests use it to answer questions the
 * geometric model in docs/redstone-model.md deliberately cannot: does every note
 * block actually fire, and at which game tick, when the circuit is really driven?
 *
 * The rules are transcribed from vanilla RedStoneWireBlock, DiodeBlock /
 * RepeaterBlock and NoteBlock (read from the local MCP 1.12.2 sources; 1.20.4 keeps
 * this model for these three blocks):
 *
 * - Dust has zero delay. Its power is a fixed point: a dust cell next to a powered
 *   repeater is 15, and every further dust cell is one lower.
 * - A repeater reads the block behind it (facing points at its input) and renews the
 *   signal, switching state 2 * delay game ticks after its input changes.
 * - A note block sounds on the rising edge of isBlockPowered and never emits power.
 * - Opaque blocks (stone, note blocks) are conductors. A block is strongly powered
 *   only by a repeater output pointing into it; that strong power feeds every
 *   adjacent dust cell and every adjacent block's isBlockPowered. It does not chain:
 *   a plain conductor never reports strong power of its own, which is what makes the
 *   layout's single-hop note rows work.
 *
 * Not modelled, so not verified: block update order and repeater priorities, quasi
 * connectivity, comparators, torches, dust climbing blocks, entities, server
 * performance. Chunk loading is modelled only as 'blocks in an unloaded chunk do not
 * tick'; the caller supplies the policy and an overdue repeater tick is replayed once
 * the chunk is loaded again.
 */

export type Horizontal = 'north' | 'east' | 'south' | 'west';

export interface AirBlock {
  kind: 'air';
}
export interface SolidBlock {
  kind: 'solid';
  /** Block id, so a test can name the offending block. */
  block: string;
}
export interface WireBlock {
  kind: 'wire';
  power: number;
}
export interface RepeaterBlock {
  kind: 'repeater';
  /** Points at the input side; the output is the opposite direction. */
  facing: Horizontal;
  delay: number;
  powered: boolean;
}
export interface NoteBlock {
  kind: 'note';
  instrument: string;
  note: number;
  powered: boolean;
}
/** Test-only stand-in for a redstone block: full strength to every neighbour. */
export interface SourceBlock {
  kind: 'source';
  power: number;
}

export type SimBlock = AirBlock | SolidBlock | WireBlock | RepeaterBlock | NoteBlock | SourceBlock;

export interface NoteTrigger {
  pos: Vec3;
  /** Game tick the note block sounded on, counted from the start of this simulation. */
  tick: number;
  instrument: string;
  note: number;
}

type OffsetName = Horizontal | 'up' | 'down';

interface Offset {
  name: OffsetName;
  dx: number;
  dy: number;
  dz: number;
}

const OFFSETS: readonly Offset[] = [
  { name: 'west', dx: -1, dy: 0, dz: 0 },
  { name: 'east', dx: 1, dy: 0, dz: 0 },
  { name: 'north', dx: 0, dy: 0, dz: -1 },
  { name: 'south', dx: 0, dy: 0, dz: 1 },
  { name: 'down', dx: 0, dy: -1, dz: 0 },
  { name: 'up', dx: 0, dy: 1, dz: 0 },
];

const OPPOSITE: Record<Horizontal, Horizontal> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
};

const MAX_POWER = 15;
const AIR: AirBlock = { kind: 'air' };

function keyOf(x: number, y: number, z: number): string {
  return x + ',' + y + ',' + z;
}

function chunkKeyOf(pos: Vec3): string {
  return Math.floor(pos.x / 16) + ',' + Math.floor(pos.z / 16);
}

function parseKey(key: string): Vec3 {
  const parts = key.split(',');
  return { x: Number(parts[0]), y: Number(parts[1]), z: Number(parts[2]) };
}

function directionBetween(from: Vec3, to: Vec3): OffsetName | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  for (const offset of OFFSETS) {
    if (offset.dx === dx && offset.dy === dy && offset.dz === dz) return offset.name;
  }
  return null;
}

function offsetPos(pos: Vec3, offset: Offset): Vec3 {
  return { x: pos.x + offset.dx, y: pos.y + offset.dy, z: pos.z + offset.dz };
}

function offsetByName(pos: Vec3, name: OffsetName): Vec3 | null {
  const offset = OFFSETS.find((entry) => entry.name === name);
  return offset ? offsetPos(pos, offset) : null;
}

export interface RedstoneSimOptions {
  /**
   * Chunk loading policy. null (the default) means every chunk is loaded, which is
   * what a paste with forceloaded chunks looks like.
   */
  isChunkLoaded?: ((chunkX: number, chunkZ: number) => boolean) | null;
}

/**
 * Block-level simulation of the circuit layer, in game ticks (50 ms each).
 *
 * Dust and note blocks settle inside one game tick: dust is instantaneous, so a note
 * downstream of a changed dust cell hears the final power in the same tick.
 * Repeaters are the only stateful, delayed component.
 */
export class RedstoneSim {
  private readonly blocks = new Map<string, SimBlock>();
  /** Due tick -> repeater keys. */
  private readonly due = new Map<number, Set<string>>();
  private readonly dueKeys = new Set<string>();
  private readonly wireDirty = new Set<string>();
  private readonly checkDirty = new Set<string>();
  private readonly triggers = new Map<string, number[]>();
  /** Chunk key -> block keys, so a chunk that loads again can be re-evaluated. */
  private readonly byChunk = new Map<string, Set<string>>();
  /** Chunk keys known to be loaded as of the last step. */
  private readonly loadedChunks = new Set<string>();
  /** Blocks whose chunk was unloaded when they needed another look. */
  private readonly waiting = new Set<string>();
  private isChunkLoaded: ((chunkX: number, chunkZ: number) => boolean) | null;
  /** Game ticks already simulated. */
  tick = 0;

  constructor(options: RedstoneSimOptions = {}) {
    this.isChunkLoaded = options.isChunkLoaded ?? null;
  }

  setChunkPolicy(policy: ((chunkX: number, chunkZ: number) => boolean) | null): void {
    this.isChunkLoaded = policy;
  }

  get(pos: Vec3): SimBlock {
    return this.blocks.get(keyOf(pos.x, pos.y, pos.z)) ?? AIR;
  }

  set(pos: Vec3, block: SimBlock): void {
    const key = keyOf(pos.x, pos.y, pos.z);
    this.blocks.set(key, block);
    const chunk = chunkKeyOf(pos);
    const bucket = this.byChunk.get(chunk);
    if (bucket) bucket.add(key);
    else this.byChunk.set(chunk, new Set([key]));
  }

  get size(): number {
    return this.blocks.size;
  }

  powerAt(pos: Vec3): number {
    const block = this.get(pos);
    return block.kind === 'wire' ? block.power : 0;
  }

  get noteTriggers(): NoteTrigger[] {
    const out: NoteTrigger[] = [];
    for (const [key, ticks] of this.triggers) {
      const pos = parseKey(key);
      const block = this.blocks.get(key);
      for (const tick of ticks) {
        out.push({
          pos,
          tick,
          instrument: block?.kind === 'note' ? block.instrument : '',
          note: block?.kind === 'note' ? block.note : -1,
        });
      }
    }
    return out.sort((a, b) => a.tick - b.tick || a.pos.x - b.pos.x || a.pos.z - b.pos.z);
  }

  /** Re-evaluate every block once. Needed after manual edits, not after a run. */
  settle(): void {
    this.syncChunks();
    for (const [key, block] of this.blocks) {
      if (block.kind === 'wire') this.wireDirty.add(key);
      else if (block.kind === 'repeater' || block.kind === 'note') this.checkDirty.add(key);
    }
    this.drain();
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  step(): void {
    this.tick++;
    this.syncChunks();
    if (this.waiting.size > 0) {
      for (const key of this.waiting) this.checkDirty.add(key);
      this.waiting.clear();
    }
    this.fireDueRepeaters();
    this.drain();
  }

  chunkLoaded(pos: Vec3): boolean {
    if (!this.isChunkLoaded) return true;
    return this.isChunkLoaded(Math.floor(pos.x / 16), Math.floor(pos.z / 16));
  }

  /**
   * Re-evaluate whatever came back into loaded chunks. Vanilla keeps block states
   * across an unload, so a chunk that returns keeps stale power until something
   * touches it; refreshing is the conservative choice for a test harness, because it
   * can only make the circuit play, never silently mute a note.
   */
  private syncChunks(): void {
    if (!this.isChunkLoaded) return;
    for (const [chunk, keys] of this.byChunk) {
      const comma = chunk.indexOf(',');
      const cx = Number(chunk.slice(0, comma));
      const cz = Number(chunk.slice(comma + 1));
      const loaded = this.isChunkLoaded(cx, cz);
      if (loaded === this.loadedChunks.has(chunk)) continue;
      if (!loaded) {
        this.loadedChunks.delete(chunk);
        continue;
      }
      this.loadedChunks.add(chunk);
      for (const key of keys) {
        const block = this.blocks.get(key);
        if (!block) continue;
        if (block.kind === 'wire') this.wireDirty.add(key);
        else if (block.kind === 'repeater' || block.kind === 'note') this.checkDirty.add(key);
      }
    }
  }

  private fireDueRepeaters(): void {
    const bucket = this.due.get(this.tick);
    if (!bucket) return;
    this.due.delete(this.tick);
    for (const key of [...bucket]) {
      this.dueKeys.delete(key);
      const pos = parseKey(key);
      const block = this.blocks.get(key);
      if (block?.kind !== 'repeater') continue;
      if (!this.chunkLoaded(pos)) {
        // An unloaded chunk does not tick; replay the overdue tick once it is back.
        this.schedule(key, this.tick + 1);
        continue;
      }
      if (this.isLocked(pos, block)) continue;
      const wanted = this.repeaterInput(pos, block) > 0;
      if (wanted === block.powered) continue;
      block.powered = wanted;
      this.notifyRepeater(pos, block);
    }
  }

  private drain(): void {
    for (;;) {
      const wire = this.wireDirty.values().next();
      if (wire.done !== true) {
        const key = String(wire.value);
        this.wireDirty.delete(key);
        this.refreshWire(key);
        continue;
      }
      const check = this.checkDirty.values().next();
      if (check.done === true) return;
      const key = String(check.value);
      this.checkDirty.delete(key);
      this.evaluate(key);
    }
  }

  private evaluate(key: string): void {
    const block = this.blocks.get(key);
    if (!block) return;
    const pos = parseKey(key);
    if (!this.chunkLoaded(pos)) {
      // An unloaded chunk freezes its blocks; keep the request for a later tick
      // instead of dropping it, otherwise a block at the loading frontier never
      // learns that its input turned on.
      this.waiting.add(key);
      return;
    }
    if (block.kind === 'repeater') this.checkRepeater(key, pos, block);
    else if (block.kind === 'note') this.checkNote(key, block);
  }

  /**
   * Vanilla DiodeBlock.notifyNeighbors: a repeater that flips tells the block in front of
   * it and that block holds, skipping itself. Without the second hop a signal would stop
   * at the first note block, because the dust on its far side is not adjacent to the
   * repeater that energised it.
   */
  private notifyRepeater(pos: Vec3, block: RepeaterBlock): void {
    const out = offsetByName(pos, OPPOSITE[block.facing]);
    if (!out) return;
    this.touch(out);
    for (const offset of OFFSETS) {
      const next = offsetPos(out, offset);
      if (next.x === pos.x && next.y === pos.y && next.z === pos.z) continue;
      this.touch(next);
    }
  }

  private touch(pos: Vec3): void {
    const key = keyOf(pos.x, pos.y, pos.z);
    const block = this.blocks.get(key);
    if (!block) return;
    if (block.kind === 'wire') this.wireDirty.add(key);
    else if (block.kind === 'repeater' || block.kind === 'note') this.checkDirty.add(key);
  }

  /** Power the block at from pushes into its neighbour at to. */
  private powerFrom(from: Vec3, to: Vec3): number {
    const block = this.get(from);
    const target = this.get(to);
    switch (block.kind) {
      case 'source':
        return Math.min(MAX_POWER, block.power);
      case 'repeater': {
        if (!block.powered) return 0;
        // facing points at the input, so the signal leaves on the opposite side.
        return directionBetween(to, from) === block.facing ? MAX_POWER : 0;
      }
      case 'wire': {
        // Vanilla dust feeds a repeater only along that repeater's axis; otherwise a
        // branch column touching a repeater's side would power it early.
        if (target.kind === 'repeater') {
          return directionBetween(to, from) === target.facing ? block.power : 0;
        }
        return block.power;
      }
      case 'solid':
      case 'note':
        return this.strongPower(from);
      default:
        return 0;
    }
  }

  /** Vanilla World.getStrongPower: what the emitters around pos push into it. */
  private strongPower(pos: Vec3): number {
    let best = 0;
    for (const offset of OFFSETS) {
      const neighbour = offsetPos(pos, offset);
      const block = this.get(neighbour);
      if (block.kind === 'repeater') {
        if (block.powered && block.facing === offset.name) best = MAX_POWER;
      } else if (block.kind === 'source') {
        best = Math.max(best, Math.min(MAX_POWER, block.power));
      }
    }
    return best;
  }

  isBlockPowered(pos: Vec3): boolean {
    for (const offset of OFFSETS) {
      if (this.powerFrom(offsetPos(pos, offset), pos) > 0) return true;
    }
    return false;
  }

  private repeaterInput(pos: Vec3, block: RepeaterBlock): number {
    const input = offsetByName(pos, block.facing);
    return input ? this.powerFrom(input, pos) : 0;
  }

  private isLocked(pos: Vec3, block: RepeaterBlock): boolean {
    // Vanilla locks a repeater when the block in front of it is a diode that does not
    // point straight back at it (DiodeBlock.isFacingTowardsRepeater).
    const front = offsetByName(pos, OPPOSITE[block.facing]);
    if (!front) return false;
    const other = this.get(front);
    if (other.kind !== 'repeater' || !other.powered) return false;
    return other.facing !== OPPOSITE[block.facing];
  }

  private checkRepeater(key: string, pos: Vec3, block: RepeaterBlock): void {
    if (this.isLocked(pos, block)) return;
    const wanted = this.repeaterInput(pos, block) > 0;
    if (wanted === block.powered) return;
    this.schedule(key, this.tick + block.delay * 2);
  }

  private schedule(key: string, dueTick: number): void {
    if (this.dueKeys.has(key)) return;
    this.dueKeys.add(key);
    const bucket = this.due.get(dueTick);
    if (bucket) bucket.add(key);
    else this.due.set(dueTick, new Set([key]));
  }

  private checkNote(key: string, block: NoteBlock): void {
    const pos = parseKey(key);
    const powered = this.isBlockPowered(pos);
    if (powered === block.powered) return;
    block.powered = powered;
    if (!powered) return;
    const list = this.triggers.get(key);
    if (list) list.push(this.tick);
    else this.triggers.set(key, [this.tick]);
  }

  /** Recompute one dust network to its fixed point; dust is instantaneous. */
  private refreshWire(startKey: string): void {
    const start = parseKey(startKey);
    if (this.get(start).kind !== 'wire') return;
    const network: Vec3[] = [];
    const seen = new Set<string>([startKey]);
    const queue: Vec3[] = [start];
    while (queue.length > 0) {
      const cell = queue.pop();
      if (!cell) break;
      network.push(cell);
      for (const offset of OFFSETS) {
        const next = offsetPos(cell, offset);
        const key = keyOf(next.x, next.y, next.z);
        if (seen.has(key)) continue;
        if (this.get(next).kind !== 'wire') continue;
        seen.add(key);
        queue.push(next);
      }
    }
    for (;;) {
      let changed = false;
      for (const cell of network) {
        const block = this.get(cell);
        if (block.kind !== 'wire') continue;
        // Dust in an unloaded chunk does not tick, so it holds its last power and the
        // signal stops at the frontier exactly like it does in the game.
        if (!this.chunkLoaded(cell)) continue;
        let best = 0;
        for (const offset of OFFSETS) {
          const neighbour = offsetPos(cell, offset);
          const other = this.get(neighbour);
          const raw = this.powerFrom(neighbour, cell);
          const contribution = other.kind === 'wire' ? raw - 1 : raw;
          if (contribution > best) best = contribution;
        }
        const clamped = Math.max(0, Math.min(MAX_POWER, best));
        if (clamped !== block.power) {
          block.power = clamped;
          changed = true;
        }
      }
      if (!changed) break;
    }
    // Only blocks outside the network react to the new dust power; re-dirtying the
    // network itself would make the settle loop spin forever.
    for (const cell of network) {
      for (const offset of OFFSETS) {
        const next = offsetPos(cell, offset);
        const key = keyOf(next.x, next.y, next.z);
        const block = this.blocks.get(key);
        if (!block) continue;
        if (block.kind === 'repeater' || block.kind === 'note') this.checkDirty.add(key);
      }
    }
  }

  static fromPlacements(
    placements: readonly BlockPlacement[],
    options: RedstoneSimOptions = {},
  ): RedstoneSim {
    const sim = new RedstoneSim(options);
    for (const placement of placements) {
      const block = toSimBlock(placement);
      if (block) sim.set(placement.pos, block);
    }
    return sim;
  }
}

export function toSimBlock(placement: BlockPlacement): SimBlock | null {
  const { block, props } = placement;
  if (block === 'minecraft:air') return null;
  if (block === 'minecraft:redstone_wire') return { kind: 'wire', power: Number(props?.power ?? 0) };
  if (block === 'minecraft:repeater') {
    const facing = props?.facing;
    if (facing !== 'north' && facing !== 'east' && facing !== 'south' && facing !== 'west') return null;
    return { kind: 'repeater', facing, delay: Number(props?.delay ?? 1), powered: props?.powered === 'true' };
  }
  if (block === 'minecraft:note_block') {
    return {
      kind: 'note',
      instrument: props?.instrument ?? 'harp',
      note: Number(props?.note ?? 0),
      powered: false,
    };
  }
  return { kind: 'solid', block };
}
