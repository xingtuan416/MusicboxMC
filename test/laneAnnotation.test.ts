import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  annotationSlice,
  planLaneAnnotation,
  signEntity,
  SIGN_COLUMN_GAP,
  type LaneInfo,
} from '../src/core/layout/annotation';
import { parseLitematic } from '../src/core/litematic/build';
import { TagType, type NbtCompound } from '../src/core/nbt/tag';
import { generate } from '../src/main/generate';

const FIXTURE = resolve('test/fixtures/happy-birthday-16.mid');

/** A lane spanning zBase +/- span, which is all the planner looks at. */
function lane(sourceTracks: number[], zBase: number, span = 1): LaneInfo {
  return { sourceTracks, zBase, zMin: zBase - span, zMax: zBase + span };
}

const label = (tracks: readonly number[]): string => `轨 ${tracks.map((index) => index + 1).join('+')}`;
const strength = (): string => '力度 90%';

const planOptions = (lanes: LaneInfo[], leadLane: number | null, minX = 10, y = 2) => ({
  lanes,
  leadLane,
  minX,
  y,
  label,
  strength,
});

/** The four lines of a sign's block entity, decoded the way the game does. */
function signLines(entity: NbtCompound): string[] {
  const front = entity.value.get('front_text');
  if (!front || front.type !== TagType.Compound) return [];
  const messages = front.value.get('messages');
  if (!messages || messages.type !== TagType.List) return [];
  return messages.value.map((tag) => (JSON.parse((tag as { value: string }).value) as { text: string }).text);
}

describe('lane annotation planner', () => {
  it('puts one sign per lane before the circuit and sends the player to the lead row', () => {
    const plan = planLaneAnnotation(planOptions([lane([0], -4, 2), lane([1], 0, 3), lane([2, 3], 5, 2)], 1));
    expect(plan).not.toBeNull();
    expect(plan!.signs.map((sign) => sign.role)).toEqual(['secondary', 'lead', 'secondary']);
    expect(plan!.signs[1]!.lines).toEqual(['主音轨', '轨 2', '力度 90%', '沿线向东']);
    expect(plan!.signs[0]!.lines[3]).toBe('距主轨 4');
    expect(plan!.signs[2]!.lines[1]).toBe('轨 3+4');
    expect(plan!.singleLane).toBe(false);
    expect(plan!.player).toEqual({ x: 9, y: 2, z: 0 });
    expect(
      plan!.signs.every(
        (sign) => sign.pos.x === 10 - SIGN_COLUMN_GAP && sign.support.x === 11 - SIGN_COLUMN_GAP,
      ),
    ).toBe(true);
    // Support wall + post + sign for every lane.
    expect(plan!.blocks).toHaveLength(9);
    // The farthest lane edge (z = -6) is 7 blocks from the player's row.
    expect(plan!.spreadZ).toBe(7);
  });

  it('stops claiming a lead when the song fits on one spine', () => {
    const plan = planLaneAnnotation(planOptions([lane([0, 1, 2], 9, 9)], 0, 4, 2));
    expect(plan!.singleLane).toBe(true);
    expect(plan!.signs).toHaveLength(1);
    expect(plan!.signs[0]!.role).toBe('merged');
    expect(plan!.signs[0]!.lines).toEqual(['全曲主线', '轨 1+2+3', '沿主线走', '向东收听']);
    // Standing in the middle of a 19-block spine keeps every note inside the hearing radius.
    expect(plan!.player.z).toBe(9);
    expect(plan!.spreadZ).toBe(9);
  });

  it('numbers lanes without pretending one is the lead when routing is manual', () => {
    const plan = planLaneAnnotation(planOptions([lane([0], 0), lane([1], 3)], null, 0, 1));
    expect(plan!.signs.map((sign) => sign.role)).toEqual(['lane', 'lane']);
    expect(plan!.signs[0]!.lines).toEqual(['音轨', '轨 1', '力度 90%', '未指定主轨']);
    expect(plan!.player).toEqual({ x: -1, y: 1, z: 2 });
  });

  it('keeps the lead on its own lane when an empty lane sits in front', () => {
    const plan = planLaneAnnotation(planOptions([lane([], 5), lane([2], 0), lane([3], 4)], 2));
    expect(plan!.signs.map((sign) => sign.role)).toEqual(['secondary', 'lead']);
    expect(plan!.signs[1]!.sourceTracks).toEqual([3]);
  });

  it('returns nothing when no lane carries notes', () => {
    expect(planLaneAnnotation(planOptions([lane([], 0)], null))).toBeNull();
    expect(planLaneAnnotation(planOptions([], null))).toBeNull();
  });

  it('writes the sign text as JSON strings in a sign block entity', () => {
    const plan = planLaneAnnotation(planOptions([lane([0], 0), lane([1], 4)], 0, 10, 2))!;
    const entity = signEntity(plan.signs[0]!, { x: 7, y: 0, z: 0 });
    const front = entity.value.get('front_text');
    expect(front?.type).toBe(TagType.Compound);
    expect(signLines(entity)).toEqual(plan.signs[0]!.lines);
    expect((entity.value.get('x') as { value: number }).value).toBe(0);
    expect((entity.value.get('y') as { value: number }).value).toBe(2);
    expect((entity.value.get('z') as { value: number }).value).toBe(0);
    expect((entity.value.get('id') as { value: string }).value).toBe('minecraft:sign');
    expect((entity.value.get('is_waxed') as { value: number }).value).toBe(1);
  });

  it('packages the signs as a region of their own, in local coordinates', () => {
    const plan = planLaneAnnotation(planOptions([lane([0], 0), lane([1], 4)], 0, 10, 2))!;
    const slice = annotationSlice(plan)!;
    expect(slice.trackIndex).toBe(-2);
    expect(slice.tileEntities).toHaveLength(2);
    expect(slice.blocks.every((block) => block.pos.x >= 0 && block.pos.x < slice.size.x)).toBe(true);
    expect(slice.blocks.every((block) => block.pos.y >= 0 && block.pos.y < slice.size.y)).toBe(true);
    expect(slice.blocks.every((block) => block.pos.z >= 0 && block.pos.z < slice.size.z)).toBe(true);
  });
});

describe('standing spot column', () => {
  it('uses the column the layout measured, not the first column', () => {
    const plan = planLaneAnnotation({
      ...planOptions([lane([0], 0), lane([1], 4)], 0),
      playerX: 42,
    })!;
    expect(plan.player.x).toBe(42);
  });

  it('falls back to the column before the circuit when nothing measured one', () => {
    const plan = planLaneAnnotation(planOptions([lane([0], 0)], null))!;
    expect(plan.player.x).toBe(9);
  });
});

describe('lane annotation in a generated schematic', () => {
  it('adds a legend region without touching a single music block', () => {
    // A picked lead is what gives the lanes an order to be centred and annotated around.
    const bare = generate(FIXTURE, { dMax: 8, leadTrackIndex: 1, annotateLanes: false }).result;
    const { result, buffer } = generate(FIXTURE, { dMax: 8, leadTrackIndex: 1 });
    const info = result.laneAnnotation;
    expect(info).toBeDefined();
    expect(info!.singleLane).toBe(false);
    expect(info!.signs).toHaveLength(result.stats.outputTrackCount);
    expect(info!.signs.filter((sign) => sign.role === 'lead')).toHaveLength(1);
    expect(info!.signs.find((sign) => sign.role === 'lead')!.z).toBe(info!.player.z);

    // The circuit itself is untouched: same note blocks, plus exactly one decoration region.
    expect(result.stats.noteBlockCount).toBe(bare.stats.noteBlockCount);
    expect(result.stats.regionCount).toBe(bare.stats.regionCount + 1);
    const legendRegion = result.regions.find((region) => region.trackIndex === -2);
    expect(legendRegion).toBeDefined();
    // Three blocks per sign: the wall, its support and the sign itself.
    expect(legendRegion!.blockCount).toBeGreaterThanOrEqual(info!.signs.length * 3);
    const circuitLeft = Math.min(
      ...result.regions.filter((region) => region.trackIndex !== -2).map((region) => region.position.x),
    );
    // The sign column stays west of the circuit.
    expect(legendRegion!.position.x).toBeLessThan(circuitLeft);
    expect(legendRegion!.position.x + legendRegion!.size.x).toBeLessThanOrEqual(circuitLeft);
    // "Stand here" names the average note column: a redstone song is walked, not stood
    // still in, so naming the first column put the spot thousands of blocks away from
    // most of the music. It therefore sits inside the circuit, not before it.
    expect(info!.player.x).toBeGreaterThanOrEqual(circuitLeft);
    const circuitRight = Math.max(
      ...result.regions
        .filter((region) => region.trackIndex !== -2)
        .map((region) => region.position.x + region.size.x),
    );
    expect(info!.player.x).toBeLessThan(circuitRight);

    // The signs survive a real litematic round trip, text included.
    const parsed = parseLitematic(buffer!);
    const withEntities = parsed.regions.filter((region) => region.tileEntities.length > 0);
    expect(withEntities).toHaveLength(1);
    const texts = withEntities[0]!.tileEntities.map(signLines);
    for (const sign of info!.signs) expect(texts).toContainEqual([...sign.lines]);
  });

  it('exports the bare circuit when the switch is off', () => {
    const { result, buffer } = generate(FIXTURE, { dMax: 8, annotateLanes: false });
    expect(result.laneAnnotation).toBeUndefined();
    const written = parseLitematic(buffer!).regions.flatMap((region) =>
      region.palette.map((state) => state.name),
    );
    expect(written).not.toContain('minecraft:oak_wall_sign');
  });

  it('names the whole spine instead of a lead lane after a forced merge', () => {
    const { result } = generate(FIXTURE, { dMax: 8, forceMergeSameInstrument: true });
    const info = result.laneAnnotation;
    expect(info).toBeDefined();
    expect(info!.singleLane).toBe(true);
    expect(info!.signs).toHaveLength(1);
    expect(info!.signs[0]!.role).toBe('merged');
    expect(info!.signs[0]!.lines[0]).toBe('全曲主线');
    expect(info!.spreadZ).toBeGreaterThan(0);
  });
});
