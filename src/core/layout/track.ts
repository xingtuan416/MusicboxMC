import type {
  BlockPlacement,
  LayoutConfig,
  LayoutWarning,
  PlacedNote,
  Tap,
  TrackSkeleton,
  Vec3,
} from './types';
import { mapPitch, type NoteBlockInstrument, type PitchRegion, type RegionTable } from '../palette/pitchMap';
import type { BlockResolver } from '../palette/blockTable';
import { noteBlock, plainBlock, redstoneWire, repeater } from '../palette/noteBlock';
import { place } from './placement';
import { applyWireConnections } from './wiring';

/** One note's timing and pitch. `tick` is in game ticks (20 per second by default). */
export interface TrackNote {
  /** Quantised trigger time, in game ticks. */
  tick: number;
  midi: number;
}

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

/** One group that exceeded the column's capacity, for the caller to re-emit elsewhere. */
export interface OverflowGroup {
  tick: number;
  notes: TrackNote[];
}

/**
 * Topology: the main line carries its own repeaters, with note blocks inline.
 *
 *   main:  ... [N] [branch column W] [R(r)] [N] [branch column W] [R(r)] [N] ...  (+X)
 *   chord: the branch column extends a few rows along +/-Z, each row [W][R(r)][N],
 *          structurally identical to the main row.
 *
 * Time model: redstone dust adds no delay per cell; only repeaters delay (1-4
 * redstone ticks, where 1 redstone tick = 2 game ticks = 0.1s at 20 TPS). The gap
 * between two groups is the sum of the repeater delays ahead of the group, and a
 * group fires together because every branch row's repeater uses the same delay as
 * the main row's final repeater.
 *
 * Main-line continuity: a repeater powers a note block, and the powered note block
 * in turn powers the dust behind it, from which the next group's repeaters draw
 * power. A note block conducts only to its immediate neighbours, which is why a
 * chord of up to three notes can be lit by a single note block (see
 * chordRowLayout).
 */

/** 1 redstone tick = 2 game ticks = 0.1s at 20 TPS. */
export const GAME_TICKS_PER_REDSTONE_TICK = 2;

/** Highest delay a single repeater can be set to, in redstone ticks. */
export const MAX_REPEATER_DELAY = 4;

/** Full signal strength of redstone dust. */
export const WIRE_STRENGTH = 15;

/**
 * Maximum number of rows a branch column may extend to one side.
 *
 * Dust d rows away from the powered cell carries 15 - d, and a branch repeater
 * needs an input of at least 1, so d <= 14. This is the physical limit implied by
 * signal strength, not a configured capacity.
 */
export const MAX_SIDE_ROWS = WIRE_STRENGTH - 1;

/** Most notes one branch column can carry: 1 inline plus MAX_SIDE_ROWS rows on each side. */
export const MAX_CHORD_NOTES = 2 * MAX_SIDE_ROWS + 1;

/** Convert the user's setting into a column capacity, clamped by signal strength. */
export function chordCapacity(dMax: number): number {
  if (!Number.isFinite(dMax)) return MAX_CHORD_NOTES;
  const rows = Math.max(1, Math.min(MAX_SIDE_ROWS, Math.floor(dMax)));
  return 2 * rows + 1;
}

/**
 * Largest allowed difference between the actual and intended trigger time, in game ticks.
 * With this topology the only source of drift is redstone-tick quantisation:
 * |tick - 2*rt| <= 1.
 */
export const MAX_TRIGGER_SHIFT = 1;

/** Game ticks -> redstone ticks, rounded onto the 0.1s grid. */
export function gameTickToRedstone(tick: number): number {
  return Math.round(tick / GAME_TICKS_PER_REDSTONE_TICK);
}

/**
 * Spatial alignment tolerance between tracks, in cells.
 *
 * A track's X follows **song time** (see XPlan), and it is only padded once the
 * deficit exceeds this value, so tracks stay within a bounded distance of each
 * other instead of drifting apart over a long song. The 10-15 range is an order of
 * magnitude for the check interval, not a promised worst case for any song.
 */
export const ALIGN_TOLERANCE_CELLS = 12;

/**
 * Longest single padding run, in cells, made of redstone dust only.
 *
 * Signal strength is 15 and powering a repeater or note block at the far end needs
 * at least 1, so 13 leaves one cell of margin. Padding uses **dust only** because
 * dust adds no delay, which is what lets padding change geometry without changing
 * when anything fires.
 */
export const MAX_PAD_RUN = 13;

/**
 * Shared "song time -> X" reference line for the whole song.
 *
 * It is the upper envelope of every track's **natural** X (no padding). Because an
 * envelope is never behind any track, each track only ever pads forward - it never
 * has to move back or be compressed, so no repeater delay is altered and no
 * cross-track wiring is needed.
 */
export interface XPlan {
  /** Reference X (note column position) at a song time, including the song-wide lead-in. */
  targetX(atRt: number): number;
  /** Whether two or more independent tracks land a note at this time, so X should be shared. */
  isSynchronized(atRt: number): boolean;
}

/**
 * X samples of each group when a track is laid out naturally (no padding), used by
 * index.ts to build the upper envelope.
 *
 * Mirrors buildTrack's routing exactly: ceil(rest/4) cells of pre-group repeaters,
 * one branch-column cell, one final-repeater cell and one note cell; plus a single
 * starting dust cell for the first group when rest > 0.
 */
export function naturalSamples(
  notes: TrackNote[],
  base: number,
  maxNotes: number = MAX_CHORD_NOTES,
): Array<{ atRt: number; x: number }> {
  const counts = new Map<number, number>();
  for (const n of notes) {
    const rt = gameTickToRedstone(n.tick);
    counts.set(rt, (counts.get(rt) ?? 0) + 1);
  }
  const rts = [...counts.keys()].sort((a, b) => a - b);
  const out: Array<{ atRt: number; x: number }> = [];
  let x = 0;
  let prevRt = 0;
  let first = true;
  for (const rt of rts) {
    const gap = rt + base - prevRt;
    const r = Math.min(MAX_REPEATER_DELAY, gap);
    const rest = gap - r;
    const restCells = Math.ceil(rest / MAX_REPEATER_DELAY);
    const n = Math.min(counts.get(rt)!, maxNotes);
    if (first && rest > 0) x = 1;
    x += restCells + groupTailCells(n);
    out.push({ atRt: rt + base, x: x - 1 }); // note column
    prevRt = rt + base;
    first = false;
  }
  return out;
}

/** Group notes by game tick. Only used for the totalTicks statistic; layout groups by redstone tick. */
export function groupByTick(notes: TrackNote[]): Array<{ tick: number; midi: number[] }> {
  const map = new Map<number, number[]>();
  for (const n of notes) {
    const arr = map.get(n.tick);
    if (arr) arr.push(n.midi);
    else map.set(n.tick, [n.midi]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([tick, midi]) => ({ tick, midi }));
}

/** Row of the j-th extra chord note: +1, -1, +2, -2, ... alternating sides. */
export function branchRow(j: number): { side: 1 | -1; row: number } {
  return { side: j % 2 === 0 ? 1 : -1, row: Math.floor(j / 2) + 1 };
}

/** Rows an n-note chord extends to one side. */
export function chordRows(n: number): number {
  return n <= 1 ? 0 : Math.ceil((n - 1) / 2);
}

/** Row of one extra chord note, excluding the inline main-line row. */
export interface ChordRow {
  side: 1 | -1;
  row: number;
  /** true = lit by the inline note block's **single hop**, so this row gets no dust and no repeater */
  conducted: boolean;
}

/**
 * Row layout for the extra notes of a chord.
 *
 * **Up to 3 notes -> single-hop cluster.** One repeater powers the inline (middle)
 * note block, which lights the note blocks on the adjacent rows, so the whole chord
 * fires on the same tick with no dust and no repeaters of its own. The limit is 3
 * because a note block conducts only one hop: in a row [a][b][c][d], powering b
 * lights a and c but not d. The main line still continues +X from the powered
 * (inline) note block.
 *
 * **4 or more notes -> branch mode.** The branch column has to be laid with dust to
 * reach the outer rows, and a cluster would occupy the +/-1 rows and block the
 * column, so from four notes up each extra note gets its own row and its own
 * repeater.
 */
/**
 * How many cells a group occupies after its pre-group repeaters: one branch-column
 * cell, one repeater cell and one note cell = 3, or - when no branch column is
 * needed - one repeater cell and one note cell = 2.
 *
 * **Only chords of four or more notes get a branch column.** The outer rows must be
 * powered at the same instant, and vertical power transfer needs dust, because any
 * repeater orientation would add delay. Otherwise the final repeater draws its
 * input straight from the block behind it (the previous note block or repeater),
 * and the dust cell in between would be redundant.
 */
export function groupTailCells(n: number): number {
  return chordRowLayout(n).some((r) => !r.conducted) ? 3 : 2;
}

export function chordRowLayout(n: number): ChordRow[] {
  if (n <= 1) return [];
  if (n === 2) return [{ side: 1, row: 1, conducted: true }];
  if (n === 3) {
    return [
      { side: -1, row: 1, conducted: true },
      { side: 1, row: 1, conducted: true },
    ];
  }
  return Array.from({ length: n - 1 }, (_, j) => ({ ...branchRow(j), conducted: false }));
}

/** Pre-scan a track's widest chord (used to inset zBase and to plan track spacing). */
export function maxChordRows(notes: TrackNote[], maxSideRows: number = MAX_SIDE_ROWS): number {
  const counts = new Map<number, number>();
  for (const n of notes) {
    const rt = gameTickToRedstone(n.tick);
    counts.set(rt, (counts.get(rt) ?? 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) {
    max = Math.max(max, Math.min(chordRows(c), maxSideRows));
  }
  return max;
}

/** A note ready to be placed: already mapped to a note value, region and base block. */
interface NoteToPlace {
  /** Original note, kept so overflow can be re-emitted elsewhere. */
  source: TrackNote;
  midi: number;
  note: number;
  region: PitchRegion;
  block: string;
  instrument: NoteBlockInstrument;
  degraded: boolean;
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
  const warnings: LayoutWarning[] = [];
  const overflow: OverflowGroup[] = [];
  const maxChordNotes = chordCapacity(opts.config.dMax);

  // 1) Map pitches, then group by redstone tick
  interface Group {
    rt: number;
    /** Earliest original game tick in the group, used for warnings and placed reporting. */
    tick: number;
    notes: NoteToPlace[];
  }
  const groupMap = new Map<number, Group>();
  for (const n of opts.notes) {
    const m = mapPitch(n.midi, opts.regions, opts.outOfRange ?? 'warn', opts.transpose ?? 0);
    if (m.dropped) {
      warnings.push({ code: 'OUT_OF_RANGE', midi: n.midi, action: 'drop' });
      continue;
    }
    // Automatic octave shifting is an explicit user choice and stays silent; every
    // other degraded outcome is reported.
    if (m.degraded && (opts.outOfRange ?? 'warn') !== 'octave') {
      warnings.push({ code: 'OUT_OF_RANGE', midi: n.midi, action: opts.outOfRange ?? 'warn' });
    }
    const rt = gameTickToRedstone(n.tick);
    let g = groupMap.get(rt);
    if (!g) {
      g = { rt, tick: n.tick, notes: [] };
      groupMap.set(rt, g);
    }
    g.tick = Math.min(g.tick, n.tick);
    g.notes.push({
      source: n,
      midi: n.midi,
      note: m.note,
      region: m.region,
      block: m.block,
      instrument: m.instrument,
      degraded: m.degraded,
    });
  }
  const groups = [...groupMap.values()].sort((a, b) => a.rt - b.rt);

  // 2) Chord capacity: anything past the column's physical limit goes to overflow
  const prepared: Group[] = [];
  for (const g of groups) {
    if (g.notes.length <= maxChordNotes) {
      prepared.push(g);
      continue;
    }
    warnings.push({
      code: 'POLYPHONY_EXCEEDED',
      tick: g.tick,
      n: g.notes.length,
      limit: maxChordNotes,
    });
    const sorted = [...g.notes].sort((a, b) => b.midi - a.midi);
    prepared.push({ rt: g.rt, tick: g.tick, notes: sorted.slice(0, maxChordNotes) });
    const rest = sorted.slice(maxChordNotes);
    if (opts.collectOverflow && rest.length > 0) {
      overflow.push({ tick: g.tick, notes: rest.map((n) => n.source) });
    }
  }

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
