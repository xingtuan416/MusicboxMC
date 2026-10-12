import { nbt, TagType, type NbtCompound } from '../nbt/tag';
import type { RegionData } from '../litematic/build';
import type { Vec3 } from '../layout/types';
import { coreError } from '../errors';

/**
 * Geometry and block assembly for the command player.
 *
 * The command chain is folded into a compact 3D serpentine so that a long song
 * does not run off into the distance, and the two controls are placed alongside it
 * with a button and a sign. Nothing here knows what the commands do.
 */

/** Side length of one serpentine layer, in blocks. */
export const COMMAND_CHAIN_EDGE = 32;

/** Number of cells in one layer. */
const CELLS_PER_LAYER = COMMAND_CHAIN_EDGE * COMMAND_CHAIN_EDGE;

/**
 * Position of the n-th command block: a serpentine that snakes along X, steps one
 * row in Z, and drops onto the next layer at the end of each one.
 */
export function commandChainPosition(index: number): Vec3 {
  const layer = Math.floor(index / CELLS_PER_LAYER);
  let local = index % CELLS_PER_LAYER;
  if (layer % 2) local = CELLS_PER_LAYER - 1 - local;
  const row = Math.floor(local / COMMAND_CHAIN_EDGE);
  return {
    x: row % 2 ? COMMAND_CHAIN_EDGE - 1 - (local % COMMAND_CHAIN_EDGE) : local % COMMAND_CHAIN_EDGE,
    y: layer + 1,
    z: row + 3,
  };
}

/** The facing a command block needs so its chain points at the next one. */
export function chainDirection(from: Vec3, to: Vec3): string {
  const delta = [to.x - from.x, to.y - from.y, to.z - from.z];
  if (delta.reduce((sum, value) => sum + Math.abs(value), 0) !== 1) {
    throw coreError('COMMAND_CHAIN_DISCONTINUOUS');
  }
  const [dx, dy, dz] = delta as [number, number, number];
  return dx ? (dx > 0 ? 'east' : 'west') : dy ? (dy > 0 ? 'up' : 'down') : dz > 0 ? 'south' : 'north';
}

/** A `~`-relative coordinate triple, the form `setblock` and `data` accept. */
export function relativePosition(from: Vec3, to: Vec3): string {
  return (['x', 'y', 'z'] as const).map((axis) => `~${to[axis] - from[axis] || ''}`).join(' ');
}

/** Block entity NBT for one command block. */
function commandEntity(pos: Vec3, command: string, automatic: boolean, name: string): NbtCompound {
  return nbt.compound({
    id: nbt.string('minecraft:command_block'),
    x: nbt.int(pos.x),
    y: nbt.int(pos.y),
    z: nbt.int(pos.z),
    Command: nbt.string(command),
    CustomName: nbt.string(JSON.stringify({ text: name })),
    auto: nbt.byte(automatic ? 1 : 0),
    powered: nbt.byte(0),
    conditionMet: nbt.byte(0),
    TrackOutput: nbt.byte(0),
    SuccessCount: nbt.int(0),
    UpdateLastExecution: nbt.byte(1),
  });
}

/** A labelled run of command blocks, laid out along +X. */
export interface Control {
  pos: Vec3;
  label: string;
  commands: string[];
}

export interface PlayerLayout {
  blocks: RegionData['blocks'];
  entities: NbtCompound[];
  /** Origin of the region, in chain coordinates. */
  min: Vec3;
  size: Vec3;
  /** Final position of the stop control, pushed clear of the bootstrap chain. */
  stop: Vec3;
}

/**
 * Lay out the playback chain plus the Start and Stop controls.
 *
 * `controls[0]` is the Start control and its command list is the bootstrap chain,
 * whose length decides where the Stop control has to sit.
 */
export function buildPlayer(options: { commands: string[]; controls: Control[]; power: Vec3 }): PlayerLayout {
  const { commands, controls, power } = options;
  const [start, stop] = controls as [Control, Control];

  const blocks: RegionData['blocks'] = [];
  const entities: NbtCompound[] = [];
  const put = (pos: Vec3, name: string, properties: Record<string, string>): void => {
    blocks.push({ ...pos, state: { name, properties } });
  };
  const addCommand = (
    pos: Vec3,
    command: string,
    name: string,
    facing: string,
    label: string,
    conditional = false,
  ): void => {
    put(pos, name, { facing, conditional: String(conditional) });
    entities.push(commandEntity(pos, command, name === 'minecraft:chain_command_block', label));
  };

  commands.forEach((command, i) => {
    const pos = commandChainPosition(i);
    const facing = i + 1 < commands.length ? chainDirection(pos, commandChainPosition(i + 1)) : 'up';
    addCommand(
      pos,
      command,
      i === 0 ? 'minecraft:repeating_command_block' : 'minecraft:chain_command_block',
      facing,
      'MusicboxMC',
    );
  });

  // The Stop control has to sit clear of the bootstrap chain, whose length is only
  // known now.
  stop.pos.x = start.commands.length + 3;

  for (const control of controls) {
    const isStart = control === start;
    if (isStart) {
      control.commands[2] = `setblock ${relativePosition({ ...control.pos, x: control.pos.x + 2 }, power)} air`;
    }
    const powerIndex = isStart ? control.commands.length - 1 : 1;
    const powerPos = { ...control.pos, x: control.pos.x + powerIndex };
    control.commands[powerIndex] =
      `setblock ${relativePosition(powerPos, power)} ${isStart ? 'redstone_block' : 'air'}`;

    control.commands.forEach((command, i) =>
      addCommand(
        { ...control.pos, x: control.pos.x + i },
        command,
        i === 0 ? 'minecraft:command_block' : 'minecraft:chain_command_block',
        'east',
        control.label,
      ),
    );

    put({ ...control.pos, z: control.pos.z - 1 }, 'minecraft:stone_button', {
      face: 'wall',
      facing: 'north',
      powered: 'false',
    });

    const signPos = { ...control.pos, y: 2 };
    put(signPos, 'minecraft:oak_sign', { rotation: '8', waterlogged: 'false' });
    const signText = nbt.compound({
      messages: nbt.list(
        TagType.String,
        [control.label, 'MusicboxMC', '', ''].map((text) => nbt.string(JSON.stringify({ text }))),
      ),
      color: nbt.string('black'),
      has_glowing_text: nbt.byte(0),
    });
    entities.push(
      nbt.compound({
        id: nbt.string('minecraft:sign'),
        x: nbt.int(signPos.x),
        y: nbt.int(signPos.y),
        z: nbt.int(signPos.z),
        front_text: signText,
        back_text: signText,
        is_waxed: nbt.byte(1),
      }),
    );
  }

  // Reserve the empty clock power position, so both relative setblock controls
  // stay inside the schematic bounds.
  put(power, 'minecraft:air', {});

  const min: Vec3 = { x: -1, y: 0, z: -1 };
  const size: Vec3 = {
    x: Math.max(COMMAND_CHAIN_EDGE + 1, stop.pos.x + stop.commands.length + 1),
    y: Math.max(3, commandChainPosition(commands.length - 1).y + 1),
    z: COMMAND_CHAIN_EDGE + 4,
  };

  for (const block of blocks) {
    block.x -= min.x;
    block.y -= min.y;
    block.z -= min.z;
  }
  for (const entity of entities) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const tag = entity.value.get(axis)!;
      if (tag.type === TagType.Int) tag.value -= min[axis];
    }
  }

  return { blocks, entities, min, size, stop: stop.pos };
}
