import type { BlockPlacement } from './types';

/**
 * Redstone dust connection blockstates, following vanilla `RedStoneWireBlock`.
 *
 * A dust block's `north`/`east`/`south`/`west` properties are part of its block
 * state. Placing dust by hand makes Minecraft compute them; writing a schematic
 * does not, so the generator has to compute them itself or the dust loads as an
 * unconnected dot.
 *
 * The rule below is transcribed from `RedStoneWireBlock.getConnectingSide` and
 * `getConnectionState`. Two things about it are easy to get wrong and were wrong
 * in this project before:
 *
 *   1. Dust does **not** connect to just anything nearby. It connects to other
 *      dust, and to a repeater only along that repeater's own axis. A note block,
 *      stone or any other full block is a redstone conductor, and conductors get
 *      `none`.
 *   2. A dust block never renders as a bare dot. If a whole axis ends up
 *      unconnected, both of its sides are forced to `side`, so an isolated dust
 *      block becomes a cross and a dust block with one neighbour becomes a full
 *      straight line. This is why the states written here can never be all `none`.
 */

type Horizontal = 'north' | 'east' | 'south' | 'west';
type Side = 'side' | 'none';

const DIRECTIONS: ReadonlyArray<{ name: Horizontal; dx: number; dz: number }> = [
  { name: 'north', dx: 0, dz: -1 },
  { name: 'east', dx: 1, dz: 0 },
  { name: 'south', dx: 0, dz: 1 },
  { name: 'west', dx: -1, dz: 0 },
];

const OPPOSITE: Record<Horizontal, Horizontal> = {
  north: 'south',
  east: 'west',
  south: 'north',
  west: 'east',
};

const AIR = 'minecraft:air';

function isRedstoneComponent(block: string): boolean {
  return block === 'minecraft:redstone_wire' || block === 'minecraft:repeater';
}

/**
 * Vanilla asks the block whether it conducts redstone; a conductor blocks the
 * connection and yields `none`. The generator only ever emits dust, repeaters and
 * full solid blocks (wire supports, note-block bases and the forced layout's feed
 * block), so "not air and not a redstone component" is exact for its output.
 */
function isRedstoneConductor(block: string): boolean {
  return block !== AIR && !isRedstoneComponent(block);
}

/**
 * Vanilla `RedStoneWireBlock.shouldConnectTo`.
 *
 * `direction` is the direction from the dust towards the neighbour; `null` means
 * "unspecified", which vanilla uses for the block below and which only dust
 * answers `true` to.
 */
function shouldConnectTo(neighbour: BlockPlacement | undefined, direction: Horizontal | null): boolean {
  if (!neighbour) return false;
  if (neighbour.block === 'minecraft:redstone_wire') return true;
  if (neighbour.block === 'minecraft:repeater') {
    // `facing` points from the output side back towards the input side, so the two
    // ends of a repeater are `facing` and its opposite. Dust connects to those two
    // sides and to neither of the other two.
    const facing = neighbour.props?.facing;
    return direction !== null && (facing === direction || facing === OPPOSITE[direction]);
  }
  return false;
}

/**
 * Vanilla `RedStoneWireBlock.getConnectingSide`, minus its `RedstoneSide.UP`
 * branch. `UP` fires when dust climbs onto a block above the neighbour; this
 * generator keeps every dust block on one circuit layer, so it cannot occur.
 */
function sideFor(
  neighbour: BlockPlacement | undefined,
  belowNeighbour: BlockPlacement | undefined,
  direction: Horizontal,
): Side {
  if (shouldConnectTo(neighbour, direction)) return 'side';
  // The step-down case: dust also reaches a non-conducting neighbour whose own
  // block below would connect. With every dust block on one layer and only solid
  // supports underneath, this never fires here, but it is part of the rule and is
  // cheap to keep faithful.
  if (neighbour && !isRedstoneConductor(neighbour.block) && shouldConnectTo(belowNeighbour, null)) {
    return 'side';
  }
  return 'none';
}

/**
 * Vanilla `RedStoneWireBlock.getConnectionState`: complete an empty axis.
 *
 * Both flags are read before either axis is forced, exactly as vanilla does, so
 * an isolated dust block ends up connected on all four sides.
 */
function completeEmptyAxes(sides: Record<Horizontal, Side>): void {
  const noNorthSouth = sides.north === 'none' && sides.south === 'none';
  const noEastWest = sides.east === 'none' && sides.west === 'none';
  if (noNorthSouth) {
    sides.west = 'side';
    sides.east = 'side';
  }
  if (noEastWest) {
    sides.north = 'side';
    sides.south = 'side';
  }
}

/**
 * Write the four connection properties onto every redstone dust placement.
 *
 * Mutates the placements in place; other blocks and the `power` property are left
 * alone.
 */
export function applyWireConnections(placements: BlockPlacement[]): void {
  const byPos = new Map<string, BlockPlacement>();
  for (const placement of placements) {
    byPos.set(`${placement.pos.x},${placement.pos.y},${placement.pos.z}`, placement);
  }

  for (const wire of placements) {
    if (wire.block !== 'minecraft:redstone_wire') continue;

    const sides = {} as Record<Horizontal, Side>;
    for (const direction of DIRECTIONS) {
      const x = wire.pos.x + direction.dx;
      const z = wire.pos.z + direction.dz;
      const neighbour = byPos.get(`${x},${wire.pos.y},${z}`);
      const belowNeighbour = byPos.get(`${x},${wire.pos.y - 1},${z}`);
      sides[direction.name] = sideFor(neighbour, belowNeighbour, direction.name);
    }
    completeEmptyAxes(sides);

    wire.props = { ...(wire.props ?? {}), power: wire.props?.power ?? '0', ...sides };
  }
}
