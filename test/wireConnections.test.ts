import { describe, expect, it } from 'vitest';
import { applyWireConnections } from '../src/core/layout/wiring';
import type { BlockPlacement } from '../src/core/layout/types';

/**
 * These cases are transcribed from vanilla `RedStoneWireBlock`, not from the
 * generator's own output, so they fail if the implementation drifts from the game.
 *
 * The two rules that are easy to get wrong:
 *
 *   - dust connects to other dust, and to a repeater only along that repeater's
 *     own axis; note blocks, stone and every other full block are conductors and
 *     get `none`;
 *   - a dust block never renders as a bare dot: an axis with no connection on
 *     either side is filled in, so an isolated dust block becomes a cross and a
 *     dust block with a single neighbour becomes a full straight line.
 */

function wire(x: number, z: number): BlockPlacement {
  return { pos: { x, y: 1, z }, block: 'minecraft:redstone_wire', props: { power: '0' } };
}

function repeater(x: number, z: number, facing: string): BlockPlacement {
  return {
    pos: { x, y: 1, z },
    block: 'minecraft:repeater',
    props: { facing, delay: '1', locked: 'false', powered: 'false' },
  };
}

function solid(x: number, z: number, block: string): BlockPlacement {
  return { pos: { x, y: 1, z }, block };
}

function sides(placement: BlockPlacement): Record<string, string | undefined> {
  return {
    north: placement.props?.north,
    east: placement.props?.east,
    south: placement.props?.south,
    west: placement.props?.west,
  };
}

/** Run the rule over one dust block plus its neighbours and return its four sides. */
function sidesOf(neighbours: BlockPlacement[]): Record<string, string | undefined> {
  const subject = wire(0, 0);
  const placements = [subject, ...neighbours];
  applyWireConnections(placements);
  return sides(subject);
}

describe('redstone dust connections follow vanilla RedStoneWireBlock', () => {
  it('draws a cross when nothing connects, instead of leaving a bare dot', () => {
    expect(sidesOf([])).toEqual({ north: 'side', east: 'side', south: 'side', west: 'side' });
  });

  it('completes the axis when a single dust neighbour sits to the east', () => {
    // East connects for real; west is filled in so the pair renders as a line.
    expect(sidesOf([wire(1, 0)])).toEqual({
      north: 'none',
      east: 'side',
      south: 'none',
      west: 'side',
    });
  });

  it('leaves a corner alone when both axes already have a connection', () => {
    expect(sidesOf([wire(1, 0), wire(0, -1)])).toEqual({
      north: 'side',
      east: 'side',
      south: 'none',
      west: 'none',
    });
  });

  it('connects to a repeater along its axis', () => {
    // facing=west means the input side is west, so the dust at +1 east is on the axis.
    expect(sidesOf([repeater(1, 0, 'west')])).toEqual({
      north: 'none',
      east: 'side',
      south: 'none',
      west: 'side',
    });
    expect(sidesOf([repeater(0, -1, 'north')])).toEqual({
      north: 'side',
      east: 'none',
      south: 'side',
      west: 'none',
    });
  });

  it('does not connect to a repeater across its axis', () => {
    // A repeater facing north/south presents no end to the east, so nothing here
    // connects for real and the dust falls back to a cross.
    expect(sidesOf([repeater(1, 0, 'north')])).toEqual({
      north: 'side',
      east: 'side',
      south: 'side',
      west: 'side',
    });
  });

  it('does not connect to a note block, which is a conductor', () => {
    expect(sidesOf([solid(0, -1, 'minecraft:note_block')])).toEqual({
      north: 'side',
      east: 'side',
      south: 'side',
      west: 'side',
    });
  });

  it('does not connect to stone or other solid blocks', () => {
    for (const block of ['minecraft:stone', 'minecraft:dirt', 'minecraft:gold_block']) {
      expect(sidesOf([solid(0, -1, block)])).toEqual({
        north: 'side',
        east: 'side',
        south: 'side',
        west: 'side',
      });
    }
  });

  it('renders a straight line through a column of dust', () => {
    const placements = [wire(0, -1), wire(0, 0), wire(0, 1)];
    applyWireConnections(placements);
    expect(sides(placements[1]!)).toEqual({ north: 'side', east: 'none', south: 'side', west: 'none' });
  });

  it('keeps the power property and leaves other blocks untouched', () => {
    const dust = wire(0, 0);
    dust.props = { power: '7' };
    const relay = repeater(1, 0, 'west');
    applyWireConnections([dust, relay]);
    expect(dust.props?.power).toBe('7');
    expect(relay.props).toEqual({ facing: 'west', delay: '1', locked: 'false', powered: 'false' });
  });
});
