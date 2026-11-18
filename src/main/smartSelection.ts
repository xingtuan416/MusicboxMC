import { chooseLeadTrack, rankProminence, type LeadBasis } from '../core/arrangement/prominence';
import { coveredRange, DEFAULT_REGIONS } from '../core/palette/pitchMap';
import { INSTRUMENTS } from '../core/palette/instruments';
import type { InstrumentMode, TrackAssignment } from '../core/palette/assignment';
import type { TrackSummary } from './types';

/** Thresholds for the initial smart-routing rules. */
export const SMART_RADIUS = { compact: 30, audible: 48 } as const;

export type SongCategory = 'pure-harp' | 'single-instrument' | 'multi-instrument';

/** Classify only tracks that will actually be generated. */
export function classifySong(
  assignments: readonly TrackAssignment[],
  activeTrackIndices: ReadonlySet<number>,
): SongCategory {
  const pitched = assignments.filter(
    (assignment) => activeTrackIndices.has(assignment.trackIndex) && assignment.native !== 'drums',
  );
  if (pitched.length === 0) return 'single-instrument';
  const instruments = new Set(pitched.map((assignment) => assignment.native));
  if (instruments.size === 1) return instruments.has('harp') ? 'pure-harp' : 'single-instrument';
  return 'multi-instrument';
}

export type MergeMode = 'off' | 'share' | 'same' | 'force';

export interface MergeChoice {
  mode: MergeMode;
  radiusZ: number;
}

/**
 * Choose the merge mode once the candidates' hearing radii are known.
 *
 * Every candidate is measured, never assumed: combining tracks can push a lane further
 * from the player, and the 48-block hearing radius around the player is what decides. Of
 * the candidates inside the radius the closest one wins, so a song is never left worse
 * than it had to be; ties go to lane sharing, then same-instrument merge, then forced
 * merge, which is also the order the candidates are tried in. When nothing fits the
 * closest measured candidate wins anyway, and when the uncombined layout already fits
 * nothing is touched. A song that would only get further away by merging therefore stays
 * unmerged instead of trading a fitting layout for one that does not fit.
 *
 * Same-instrument and forced merges only exist for multi-instrument songs: a pure harp song
 * has nothing to merge by instrument, and forcing it collapses to one instrument for no
 * audible gain. Lane sharing is allowed for every category, since it is what rescues a song
 * too wide to reach the player.
 */
export function decideMerge(
  category: SongCategory,
  widths: { off: number; share?: number; same?: number; force?: number },
): MergeChoice {
  const off: MergeChoice = { mode: 'off', radiusZ: widths.off };
  if (widths.off < SMART_RADIUS.compact) return off;

  const candidates: MergeChoice[] = [];
  const add = (mode: MergeMode, radiusZ: number | undefined): void => {
    if (radiusZ !== undefined) candidates.push({ mode, radiusZ });
  };
  add('share', widths.share);
  if (category === 'multi-instrument') {
    add('same', widths.same);
    add('force', widths.force);
  }

  const audible = candidates.filter((candidate) => candidate.radiusZ <= SMART_RADIUS.audible);
  // Stable sort: equal widths keep the preference order above.
  if (audible.length > 0) return [...audible].sort((a, b) => a.radiusZ - b.radiusZ)[0]!;
  if (widths.off <= SMART_RADIUS.audible) return off;
  return [off, ...candidates].sort((a, b) => a.radiusZ - b.radiusZ)[0]!;
}

export interface SmartMode {
  mode: InstrumentMode;
  resourcePackRecommended: boolean;
}

/**
 * Pick the smart instrument mode and whether the companion pack is useful.
 *
 * Extended harp range is effectively "install the companion pack": it puts the piano on
 * the five instrument slots (bass/guitar/harp/flute/bell), and without the pack those five
 * slots sound like five unrelated instruments. So it is only ever chosen for a pure-harp
 * song whose notes do not fit the single harp slot (F#3-F#5).
 *
 * Everything else keeps its own instruments. A multi-instrument song in extended mode would
 * have to give up its native bass/guitar/flute/bell tracks for substitutes, and a song that
 * needs no pack must not be steered into one.
 */
export function smartModeFor(category: SongCategory, midi: { min: number; max: number } | null): SmartMode {
  if (category !== 'pure-harp') return { mode: 'native', resourcePackRecommended: false };
  const harp = INSTRUMENTS.harp.range;
  const extended = coveredRange(DEFAULT_REGIONS);
  if (!harp || !extended || !midi) return { mode: 'native', resourcePackRecommended: false };
  const outsideHarp = midi.min < harp[0] || midi.max > harp[1];
  const insideExtended = midi.min >= extended[0] && midi.max <= extended[1];
  return {
    mode: outsideHarp ? 'extended' : 'native',
    // Beyond F#1-F#7 there is nothing the pack could unify; the out-of-range policy speaks.
    resourcePackRecommended: outsideHarp && insideExtended,
  };
}

export interface LanePlan {
  laneOrder: number[];
  leadTrackIndex: number | null;
  leadBasis: LeadBasis | 'manual' | null;
}

/**
 * Build the layout priority list: manual lead if valid, otherwise the prominence winner.
 * All selected tracks are retained; only their lane order changes.
 */
export function buildLaneOrder(
  tracks: readonly TrackSummary[],
  excluded: ReadonlySet<number>,
  manualLead: number | undefined,
): LanePlan {
  const active = tracks.filter((track) => !excluded.has(track.index) && track.noteCount > 0);
  if (active.length === 0) return { laneOrder: [], leadTrackIndex: null, leadBasis: null };

  const manual = manualLead === undefined ? undefined : active.find((track) => track.index === manualLead);
  const automatic = chooseLeadTrack(active);
  const leadIndex = manual?.index ?? automatic?.index ?? null;
  const leadBasis: LeadBasis | 'manual' | null = manual ? 'manual' : (automatic?.basis ?? null);
  const ranked = rankProminence(active);
  const orderedIndices = ranked.map((track) => track.index);
  const lead = active.find((track) => track.index === leadIndex);
  if (lead && !orderedIndices.includes(lead.index)) orderedIndices.unshift(lead.index);
  if (lead) {
    const rest = orderedIndices.filter((index) => index !== lead.index);
    return { laneOrder: [lead.index, ...rest], leadTrackIndex: lead.index, leadBasis };
  }
  return { laneOrder: orderedIndices, leadTrackIndex: null, leadBasis: null };
}

export function midiBounds(
  tracks: readonly TrackSummary[],
  active: ReadonlySet<number>,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const track of tracks) {
    if (!active.has(track.index) || track.noteCount === 0 || track.percussion) continue;
    min = Math.min(min, track.minMidi);
    max = Math.max(max, track.maxMidi);
  }
  return min === Number.POSITIVE_INFINITY ? null : { min, max };
}

/** True when the category needs a merge-width probe at all. */
export function canMerge(category: SongCategory): boolean {
  return category === 'multi-instrument';
}
