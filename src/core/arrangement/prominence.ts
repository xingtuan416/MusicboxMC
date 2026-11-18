import type { NoteEvent } from '../midi/types';

/**
 * MIDI-only track prominence.
 *
 * Minecraft note blocks have a fixed output level, so velocity cannot be carried into the
 * schematic. These numbers describe the source performance: which track was written as the
 * loud, active, melodic line. The layout uses that result to put the lead track closest to
 * the listener.
 */

export interface ProminenceStats {
  noteCount: number;
  /** Seconds from the first attack to the last note's end. */
  activeSeconds: number;
  meanVelocity: number;
  maxVelocity: number;
  /** Fraction of attack times containing more than one note. */
  polyphonicOnsetRatio: number;
  /** 1 - polyphonicOnsetRatio; monophonic lines score higher. */
  melodicScore: number;
  /** activeSeconds / song duration, clamped to 0..1. */
  activityScore: number;
  /** Informational blend of loudness, activity and melodic shape; not used for ranking. */
  prominenceScore: number;
}

export interface ProminenceTrack extends ProminenceStats {
  index: number;
  percussion: boolean;
}

/** Why a track was chosen as the lead. Only loudness decides it, so there is one reason. */
export type LeadBasis = 'velocity';

export interface LeadChoice {
  index: number;
  basis: LeadBasis;
}

/** Compute the source-performance statistics for one track. */
export function trackProminence(
  notes: ReadonlyArray<Pick<NoteEvent, 'timeSec' | 'durationSec' | 'velocity'>>,
  songDurationSec: number,
): ProminenceStats {
  if (notes.length === 0) {
    return {
      noteCount: 0,
      activeSeconds: 0,
      meanVelocity: 0,
      maxVelocity: 0,
      polyphonicOnsetRatio: 0,
      melodicScore: 0,
      activityScore: 0,
      prominenceScore: 0,
    };
  }

  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let velocitySum = 0;
  let maxVelocity = 0;
  const onsets = new Map<number, number>();

  for (const note of notes) {
    first = Math.min(first, note.timeSec);
    last = Math.max(last, note.timeSec + note.durationSec);
    velocitySum += note.velocity;
    maxVelocity = Math.max(maxVelocity, note.velocity);
    const onset = Math.round(note.timeSec * 1000);
    onsets.set(onset, (onsets.get(onset) ?? 0) + 1);
  }

  const meanVelocity = velocitySum / notes.length;
  const polyphonicOnsets = [...onsets.values()].filter((count) => count > 1).length;
  const polyphonicOnsetRatio = polyphonicOnsets / onsets.size;
  const melodicScore = 1 - polyphonicOnsetRatio;
  const activeSeconds = Math.max(0, last - first);
  const activityScore = songDurationSec > 0 ? Math.max(0, Math.min(1, activeSeconds / songDurationSec)) : 0;

  return {
    noteCount: notes.length,
    activeSeconds,
    meanVelocity,
    maxVelocity,
    polyphonicOnsetRatio,
    melodicScore,
    activityScore,
    prominenceScore: 0.5 * meanVelocity + 0.3 * activityScore + 0.2 * melodicScore,
  };
}

/**
 * Loudness first, then size, then file order.
 *
 * The lead is simply the loudest track: the player stands on its line, so every other
 * lane's distance is measured from it. Instrument type plays no part - a drum track that
 * was written loudest leads, because loudness is the only thing the listener hears as
 * "in front". The two tie-breakers only exist to keep the choice deterministic.
 */
function compareProminence(a: ProminenceTrack, b: ProminenceTrack): number {
  const velocityDelta = b.meanVelocity - a.meanVelocity;
  if (velocityDelta !== 0) return velocityDelta;
  const countDelta = b.noteCount - a.noteCount;
  if (countDelta !== 0) return countDelta;
  return a.index - b.index;
}

/** Rank every track that has notes, loudest first. */
export function rankProminence(tracks: readonly ProminenceTrack[]): ProminenceTrack[] {
  return tracks.filter((track) => track.noteCount > 0).sort(compareProminence);
}

/** Choose the lead track: always exists as long as one track has notes. */
export function chooseLeadTrack(tracks: readonly ProminenceTrack[]): LeadChoice | null {
  const first = rankProminence(tracks)[0];
  return first ? { index: first.index, basis: 'velocity' } : null;
}
