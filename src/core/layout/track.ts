import type { RegionTable } from '../palette/pitchMap';
import type { BlockResolver } from '../palette/blockTable';
import { noteBlock, plainBlock, redstoneWire, repeater } from '../palette/noteBlock';
import { place } from './placement';
import { applyWireConnections } from './wiring';
import { prepareGroups, type NoteToPlace } from './groups';
import type {
  BlockPlacement,
  LayoutConfig,
  LayoutWarning,
  PlacedNote,
  Tap,
  TrackSkeleton,
  Vec3,
} from './types';
import {
  ALIGN_TOLERANCE_CELLS,
  GAME_TICKS_PER_REDSTONE_TICK,
  MAX_PAD_RUN,
  MAX_REPEATER_DELAY,
  MAX_TRIGGER_SHIFT,
  chordCapacity,
  chordRowLayout,
  groupTailCells,
  type OverflowGroup,
  type TrackNote,
  type XPlan,
} from './model';

/**
 * Laying out one track along +X.
 *
 * The model in `model.ts` says what the circuit can do; this module decides where
 * every block goes, how far apart consecutive groups sit and how much to pad so
 * that this track stays aligned with the others.
 */

export * from './model';

export interface BuildTrackOptions {
  trackIndex: number;
  zBase: number;
  notes: TrackNote[];
  config: LayoutConfig;
  regions: RegionTable;
  resolve: BlockResolver;
  transpose?: number;
  outOfRange?: 'warn' | 'clamp' | 'octave' | 'drop';
  /**
   * Notes beyond the column's chord capacity are not dropped: they are recorded so
   * the caller can re-emit them on a new track.
   */
  collectOverflow?: boolean;
  /**
   * Song-wide lead-in in redstone ticks (0 or 1), computed once by layout().
   *
   * A repeater cannot have delay 0, so a group landing on redstone tick 0 cannot
   * sound earlier than one redstone tick in. To preserve **relative timing across
   * tracks** that offset has to be identical everywhere: if any track has a group
   * at rt 0, every track gets +1. Inferring it per track would give the tracks
   * different first-note offsets. When omitted, it is inferred from this track's
   * first group, which is what tests and scripts calling buildTrack directly want.
   */
  base?: number;
  /**
   * Shared "song time -> X" reference line, used for multi-track spatial alignment.
   * When given, this track pads with **redstone dust** to keep up with it; when
   * omitted the track is laid out naturally, which is the single-track case.
   */
  plan?: XPlan;
}

/**
 * Build one track: the main line plus every chord branch.
 *
 * Time model: the gap between groups, in redstone ticks, is the sum of the delays
 * of the repeaters ahead of the group (dust contributes none). The final repeater
 * takes min(4, gap) and the remainder is spread over earlier repeaters in series.
 * The group's first note sits inline on the main line and the rest fan out along
 * +/-Z; every row's repeater uses the same delay as the main row's final repeater,
 * so the whole group fires on one redstone tick.
 */
export function buildTrack(opts: BuildTrackOptions): {
  track: TrackSkeleton;
  warnings: LayoutWarning[];
  /** Only ever non-empty when collectOverflow = true. */
  overflow: OverflowGroup[];
  /** Intended and actual trigger tick for each placed group, in game ticks (actual = 2*rt). */
  placed: Array<{ tick: number; actual: number }>;
} {
  const maxChordNotes = chordCapacity(opts.config.dMax);

  // 1-2) Map pitches, group by redstone tick, and hand any surplus off as overflow
  const {
    groups: prepared,
    overflow,
    warnings,
  } = prepareGroups({
    notes: opts.notes,
    regions: opts.regions,
    outOfRange: opts.outOfRange ?? 'warn',
    transpose: opts.transpose ?? 0,
    maxChordNotes,
    collectOverflow: opts.collectOverflow === true,
  });

  // 3) Lay the main line along +X: [pre-group repeaters][branch column][repeaters][notes]
  const placements: BlockPlacement[] = [];
  const taps: Tap[] = [];
  const placed: Array<{ tick: number; actual: number }> = [];

  const putWire = (x: number, z: number): void => {
    // A schematic is pasted **unpowered**: dust is always written with power=0 and
    // the game propagates it once the player applies power at the start. Writing 15
    // would paste a pre-lit line, which is not what placing these blocks produces.
    placements.push(place({ x, y: opts.config.circuitY, z }, redstoneWire(0)));
    placements.push(
      place(
        { x, y: opts.config.floorY, z },
        plainBlock(opts.resolve({ slot: 'wireSupport', trackIndex: opts.trackIndex })),
      ),
    );
  };

  const putRelay = (x: number, z: number, delay: number): void => {
    // The output must point +X, towards the note blocks. Note the blockstate
    // semantics: facing points from the output side back towards the input side, the
    // opposite of the arrow - output east means facing=west.
    placements.push(place({ x, y: opts.config.circuitY, z }, repeater('west', delay)));
    placements.push(
      place(
        { x, y: opts.config.floorY, z },
        plainBlock(opts.resolve({ slot: 'wireSupport', trackIndex: opts.trackIndex })),
      ),
    );
  };

  const putNote = (x: number, z: number, n: NoteToPlace, path: Vec3[]): PlacedNote => {
    const notePos: Vec3 = { x, y: opts.config.circuitY, z };
    placements.push(place(notePos, noteBlock(n.note, n.instrument)));
    placements.push(
      place(
        { x, y: opts.config.floorY, z },
        plainBlock(opts.resolve({ slot: 'noteBase', trackIndex: opts.trackIndex, region: n.region })),
      ),
    );
    return {
      notePos,
      blockPos: { x, y: opts.config.floorY, z },
      note: n.note,
      block: n.block,
      path,
    };
  };

  let x = 0;
  let prevRt = 0;
  let first = true;

  // A group at rt 0 still needs one redstone tick to drive (the minimum repeater
  // delay), so the whole track shifts by one redstone tick: relative timing is
  // unchanged and everything simply fires 0.1s later. layout() computes this once
  // for the song and passes it in; when absent it is inferred from this track.
  const base = opts.base ?? (prepared.length > 0 && prepared[0]!.rt === 0 ? 1 : 0);
  if (base === 1) {
    warnings.push({
      code: 'TIMING_ADJUSTED',
      tick: prepared[0]!.tick,
      actual: GAME_TICKS_PER_REDSTONE_TICK,
    });
  }

  for (const g of prepared) {
    const gap = g.rt + base - prevRt; // >= 1: equal rts are merged and base keeps the first >= 1
    const r = Math.min(MAX_REPEATER_DELAY, gap);
    const rest = gap - r;
    const restCells = Math.ceil(rest / MAX_REPEATER_DELAY);

    // Spatial alignment: compare this group's natural note-column X against the
    // shared reference line. Pad only when the deficit exceeds the tolerance, and
    // **with dust only** (zero delay) - never by altering a repeater's delay, never
    // by cross-track wiring, never by padding past the end. At synchronised points
    // the tolerance is 0 so simultaneous notes share an X; if the available padding
    // still falls short, the residual is reported as SPATIAL_DRIFT.
    // Only chords of four or more notes get a branch column; otherwise the final
    // repeater draws directly from the block behind it.
    const tail = groupTailCells(g.notes.length);
    const noteXNatural = x + (first && rest > 0 ? 1 : 0) + restCells + (tail - 1);
    const atRt = g.rt + base;
    const targetX = opts.plan ? opts.plan.targetX(atRt) : noteXNatural;
    const deficit = Math.max(0, targetX - noteXNatural);
    const tolerance = opts.plan?.isSynchronized(atRt) === true ? 0 : ALIGN_TOLERANCE_CELLS;
    const padNeeded = Math.max(0, deficit - tolerance);
    const slots = restCells + 1; // slot 0 precedes the pre-group repeaters; one slot follows each of them
    const pad = Math.min(padNeeded, slots * MAX_PAD_RUN);
    if (padNeeded > pad) {
      warnings.push({ code: 'SPATIAL_DRIFT', tick: g.tick, drift: deficit - pad });
    }
    const padSlots = new Array<number>(slots).fill(0);
    if (pad > 0) {
      const each = Math.floor(pad / slots);
      for (let i = 0; i < slots; i++) padSlots[i] = each;
      for (let i = 0; i < pad % slots; i++) padSlots[i] = padSlots[i]! + 1;
    }

    // When the first group has repeaters ahead of it, lay one starting dust cell as
    // the power connection point. With rest = 0 the branch column is itself the first
    // cell, so power goes straight onto the column and keeps it at strength 15.
    if (first && rest > 0) {
      putWire(0, opts.zBase);
      x = 1;
    }

    // Padding runs: dust only, zero delay
    const putPad = (slot: number): void => {
      for (let i = 0; i < padSlots[slot]!; i++) {
        putWire(x, opts.zBase);
        x += 1;
      }
    };
    putPad(0);

    // Pre-group repeaters, chained end to end so their delays sum to rest
    let remaining = rest;
    let slot = 1;
    while (remaining > 0) {
      const d = Math.min(MAX_REPEATER_DELAY, remaining);
      putRelay(x, opts.zBase, d);
      x += 1;
      remaining -= d;
      putPad(slot);
      slot += 1;
    }

    // Branch column: main row plus branch rows. Dust in one column is a single
    // connected network, so every row in it is powered at the same instant.
    const xCol = x;
    const branches = chordRowLayout(g.notes.length);
    const needColumn = tail === 3;
    if (needColumn) putWire(xCol, opts.zBase);
    // Branch rows (4+ notes) get dust for vertical power transfer; conducted rows get
    // none, since the inline note block lights them.
    for (const b of branches) {
      if (!b.conducted) putWire(xCol, opts.zBase + b.side * b.row);
    }

    // Repeater column: all facing east, main and branch rows alike at delay r, so the
    // whole group fires on the same redstone tick.
    const xRelay = needColumn ? xCol + 1 : xCol;
    putRelay(xRelay, opts.zBase, r);
    for (const b of branches) {
      if (!b.conducted) putRelay(xCol + 1, opts.zBase + b.side * b.row, r);
    }

    // Note column: note 0 sits inline on the main line, powered by the repeater, and
    // the main line continues +X from it. Conducted rows have no redstone path at
    // all; the inline note block lights them one hop away, on the same tick.
    const xNote = xRelay + 1;
    const placedNotes: PlacedNote[] = [];
    placedNotes.push(
      // Without a branch column the input comes straight from the block behind, so the
      // recorded path is empty.
      putNote(
        xNote,
        opts.zBase,
        g.notes[0]!,
        needColumn ? [{ x: xCol, y: opts.config.circuitY, z: opts.zBase }] : [],
      ),
    );
    g.notes.slice(1).forEach((n, j) => {
      const b = branches[j]!;
      const z = opts.zBase + b.side * b.row;
      const path = b.conducted
        ? []
        : [
            { x: xCol, y: opts.config.circuitY, z },
            { x: xCol + 1, y: opts.config.circuitY, z },
          ];
      placedNotes.push(putNote(xNote, z, n, path));
    });

    taps.push({ x: xCol, t: g.rt, notes: placedNotes });

    const actual = (g.rt + base) * GAME_TICKS_PER_REDSTONE_TICK;
    placed.push({ tick: g.tick, actual });
    // The quantisation offset already includes the 2*base lead-in, so only a deviation
    // beyond the lead-in plus one game tick of grid error is worth reporting.
    if (Math.abs(actual - g.tick - 2 * base) > MAX_TRIGGER_SHIFT) {
      warnings.push({ code: 'TIMING_ADJUSTED', tick: g.tick, actual });
    }

    x = xCol + tail;
    prevRt = g.rt + base;
    first = false;
  }

  applyWireConnections(placements);

  return {
    track: {
      trackIndex: opts.trackIndex,
      zBase: opts.zBase,
      placements,
      taps,
    },
    warnings,
    overflow,
    placed,
  };
}
