import { chordCapacity, gameTickToRedstone } from '../layout/model';

/**
 * Folding sparse tracks onto a lane that already exists.
 *
 * A track with a handful of notes still costs a full main line - its own strip of Z,
 * its own repeaters and its own row in the schematic - while contributing almost no
 * music. Sharing a lane removes that whole strip: the notes join the host's main line
 * and fire on its rungs. What it cannot do is make the host arbitrarily dense, because
 * the column can only hold so many simultaneous notes (see `chordCapacity`), so every
 * candidate host is checked against the guest's own simultaneity profile first.
 *
 * Nothing here measures Z: whether sharing actually helps is decided by laying the
 * result out, since adding notes to a host can deepen its chord rows.
 */

export interface ShareTrack {
  index: number;
  /** Trigger times in game ticks. */
  ticks: readonly number[];
}

export interface LaneShareOptions {
  /** Tracks below this many notes are candidates for sharing. */
  sparseBelow?: number;
  /**
   * A collector lane - several sparse tracks folded onto a brand-new line - must carry
   * at least this many notes. A line for two nearly empty tracks saves nothing.
   */
  minCollectorNotes?: number;
  /** Column capacity comes from the layout config's `dMax`. */
  dMax: number;
  /** Priority order, lead first; a nearer host is preferred. */
  order?: readonly number[];
  /** The lead keeps a lane of its own: it is the one the player stands on. */
  leadIndex?: number | null;
  /**
   * Whether leftover sparse tracks may share a brand-new lane.
   *
   * Folding onto an existing lane keeps the merge decision intact; packing leftovers onto
   * a new one re-mixes instruments that a merge was asked to keep apart, so lane-level
   * planning turns this off and only borrows from lanes that already carry notes.
   */
  allowCollector?: boolean;
}

export interface LaneSharePlan {
  /** One array per lane that folds two or more tracks together. */
  groups: number[][];
  borrowed: Array<{ guest: number; host: number }>;
  /** Sparse tracks folded onto a new lane of their own, in order. */
  collector: number[];
  /** Sparse tracks that could not be folded and keep their own lane. */
  kept: number[];
  /** Every track that was considered for sharing. */
  sparse: number[];
}

const DEFAULT_SPARSE_BELOW = 50;
const DEFAULT_MIN_COLLECTOR_NOTES = 50;

/** How many notes land on each redstone tick. */
function profile(ticks: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const tick of ticks) {
    const rt = gameTickToRedstone(tick);
    counts.set(rt, (counts.get(rt) ?? 0) + 1);
  }
  return counts;
}

/** True when every tick of `extra` still fits the column after `base`. */
function fitsIn(
  base: ReadonlyMap<number, number>,
  extra: ReadonlyMap<number, number>,
  capacity: number,
): boolean {
  for (const [rt, count] of extra) {
    if ((base.get(rt) ?? 0) + count > capacity) return false;
  }
  return true;
}

function addTo(base: Map<number, number>, extra: ReadonlyMap<number, number>): void {
  for (const [rt, count] of extra) base.set(rt, (base.get(rt) ?? 0) + count);
}

/**
 * Work out which sparse tracks can share a lane.
 *
 * The plan is pure geometry on note times: it never lays anything out, so the caller
 * still has to measure the result before believing the Z span improved.
 */
export function planLaneSharing(tracks: readonly ShareTrack[], options: LaneShareOptions): LaneSharePlan {
  const sparseBelow = options.sparseBelow ?? DEFAULT_SPARSE_BELOW;
  const minCollectorNotes = options.minCollectorNotes ?? DEFAULT_MIN_COLLECTOR_NOTES;
  const capacity = chordCapacity(options.dMax);
  const active = tracks.filter((track) => track.ticks.length > 0);
  const sparse = active.filter(
    (track) => track.index !== options.leadIndex && track.ticks.length < sparseBelow,
  );
  if (sparse.length === 0) {
    return { groups: [], borrowed: [], collector: [], kept: [], sparse: [] };
  }

  const sparseIndices = new Set(sparse.map((track) => track.index));
  const hosts = active.filter((track) => !sparseIndices.has(track.index));
  const order = options.order && options.order.length > 0 ? options.order : active.map((t) => t.index);
  const position = new Map(order.map((index, rank) => [index, rank]));
  const posOf = (index: number): number => position.get(index) ?? Number.MAX_SAFE_INTEGER;

  const hostProfiles = new Map<number, Map<number, number>>();
  for (const host of hosts) hostProfiles.set(host.index, profile(host.ticks));

  const borrowed: Array<{ guest: number; host: number }> = [];
  const leftovers: ShareTrack[] = [];
  // The densest guest is the hardest to place, so it gets first pick of the hosts.
  const queue = [...sparse].sort(
    (a, b) => b.ticks.length - a.ticks.length || posOf(a.index) - posOf(b.index),
  );
  for (const guest of queue) {
    const guestProfile = profile(guest.ticks);
    let best: { host: number; distance: number } | null = null;
    for (const host of hosts) {
      const hostProfile = hostProfiles.get(host.index);
      if (!hostProfile || !fitsIn(hostProfile, guestProfile, capacity)) continue;
      const distance = Math.abs(posOf(host.index) - posOf(guest.index));
      if (
        best === null ||
        distance < best.distance ||
        (distance === best.distance && posOf(host.index) < posOf(best.host))
      ) {
        best = { host: host.index, distance };
      }
    }
    if (best === null) {
      leftovers.push(guest);
      continue;
    }
    addTo(hostProfiles.get(best.host)!, guestProfile);
    borrowed.push({ guest: guest.index, host: best.host });
  }

  // Nothing could take the remainder: give two or more of them one shared new lane,
  // provided that lane is dense enough to be worth a main line at all.
  let collector: ShareTrack[] = [];
  if (leftovers.length >= 2 && options.allowCollector !== false) {
    const sorted = [...leftovers].sort(
      (a, b) => a.ticks.length - b.ticks.length || posOf(a.index) - posOf(b.index),
    );
    const combined = new Map<number, number>();
    let notes = 0;
    for (const track of sorted) {
      const trackProfile = profile(track.ticks);
      if (!fitsIn(combined, trackProfile, capacity)) continue;
      addTo(combined, trackProfile);
      notes += track.ticks.length;
      collector.push(track);
    }
    if (collector.length < 2 || notes < minCollectorNotes) collector = [];
  }

  const collected = new Set(collector.map((track) => track.index));
  const groups: number[][] = [];
  for (const host of hosts) {
    const guests = borrowed.filter((entry) => entry.host === host.index).map((entry) => entry.guest);
    if (guests.length > 0) groups.push([host.index, ...guests]);
  }
  if (collector.length >= 2) groups.push(collector.map((track) => track.index));

  return {
    groups,
    borrowed,
    collector: collector.map((track) => track.index),
    kept: leftovers.filter((track) => !collected.has(track.index)).map((track) => track.index),
    sparse: sparse.map((track) => track.index),
  };
}
