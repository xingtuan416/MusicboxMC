import type { NoteBlockInstrument } from './instruments';
import type { PitchRegion } from './pitchMap';

/**
 * The unified resolution layer for "which block goes at a given position".
 *
 * Deliberately no special cases for any one position: adding a position type only
 * means adding a name to `BlockSlot`, and the override rules and resolution
 * priority take effect automatically. Below redstone wire is just its first user.
 *
 * Every position can resolve to `minecraft:air` (that is, "place no block here");
 * whether that is allowed is up to the caller.
 */
export type BlockSlot =
  /** Below redstone wire / repeaters, so they do not pop off unsupported */
  | 'wireSupport'
  /** Below note blocks, determines the timbre */
  | 'noteBase'
  /** Generic floor */
  | 'floor';

export type BlockTable = Record<BlockSlot, string>;

export const AIR = 'minecraft:air';

/** Global defaults. */
export const DEFAULT_BLOCK_TABLE: BlockTable = {
  wireSupport: 'minecraft:dirt',
  noteBase: 'minecraft:grass_block',
  floor: 'minecraft:dirt',
};

/**
 * Defaults come in two levels: global + pitch region.
 *
 * Region-level defaults are necessary — note block base blocks already differ per
 * pitch region (the five regions A/B/C/D/E have different timbres), so the
 * "default" itself must be expressible per A/B/C/D/E region.
 */
export interface BlockDefaults {
  global: BlockTable;
  regions?: Partial<Record<PitchRegion, Partial<BlockTable>>>;
  /** Defaults for a fixed instrument; used when a track follows its MIDI instrument. */
  instruments?: Partial<Record<NoteBlockInstrument, Partial<BlockTable>>>;
}

/** Track-level / region-level overrides; a value may be any block id (incl. `minecraft:air`). */
export interface BlockOverrides {
  tracks?: Record<number, Partial<BlockTable>>;
  regions?: Partial<Record<PitchRegion, Partial<BlockTable>>>;
}

export interface BlockQuery {
  slot: BlockSlot;
  trackIndex?: number;
  region?: PitchRegion;
  /** Set instead of `region` when the note belongs to a fixed instrument. */
  instrument?: NoteBlockInstrument;
}

export type BlockResolver = (query: BlockQuery) => string;

/**
 * Resolution priority (from specific to broad):
 *   override·region > override·track > default·region > default·instrument > default·global
 *
 * Overrides take priority over defaults; region takes priority over track, because the
 * region directly determines the timbre (swap the base block and the instrument changes).
 * `default·instrument` is only reached when the caller names a fixed instrument, which
 * is the multi-instrument path.
 */
export function createBlockResolver(
  defaults: BlockDefaults = { global: DEFAULT_BLOCK_TABLE },
  overrides: BlockOverrides = {},
): BlockResolver {
  return ({ slot, trackIndex, region, instrument }) => {
    if (region !== undefined) {
      const o = overrides.regions?.[region]?.[slot];
      if (o !== undefined) return o;
    }

    if (trackIndex !== undefined) {
      const o = overrides.tracks?.[trackIndex]?.[slot];
      if (o !== undefined) return o;
    }

    if (region !== undefined) {
      const d = defaults.regions?.[region]?.[slot];
      if (d !== undefined) return d;
    }

    if (instrument !== undefined) {
      const d = defaults.instruments?.[instrument]?.[slot];
      if (d !== undefined) return d;
    }

    return defaults.global[slot];
  };
}

export function isAir(block: string): boolean {
  return block === AIR;
}
