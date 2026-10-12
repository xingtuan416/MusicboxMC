/**
 * The redstone circuit model behind the layout.
 *
 * This is the part that is dictated by Minecraft rather than by this project: how
 * long a redstone tick is, how far dust can carry power, how many notes a single
 * chord column can hold and which rows they occupy. `track.ts` uses it to lay a
 * track out, `index.ts` uses it to align tracks against each other, and
 * `forced.ts` relies on the same limits.
 */

/** One note's timing and pitch. `tick` is in game ticks (20 per second by default). */
export interface TrackNote {
  /** Quantised trigger time, in game ticks. */
  tick: number;
  midi: number;
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
