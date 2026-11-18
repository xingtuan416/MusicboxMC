import type { TrackSkeleton } from './types';

/** Note blocks are the only blocks that make a sound, so only they count. */
const NOTE_BLOCK = 'minecraft:note_block';

export interface HearingSpot {
  /** Row the player stands on. */
  playerZ: number;
  /** Distance in blocks from `playerZ` to the farthest note block. */
  hearingRadius: number;
}

/**
 * Where the player stands, and how far the farthest note block is from that row.
 *
 * A note block is audible within 48 blocks of the player, measured block to player: a
 * radius, not the width of the arrangement. Measuring the whole Z span against 48
 * therefore rejected songs the player could hear completely, and accepted layouts whose
 * far end was silent. Signs, dust and repeaters make no sound and are ignored here.
 *
 * `preferredZ` is the lead lane's main line, a real row of dust the player can stand on
 * while the song plays. Without a lead the middle of the note rows is used, so the error
 * is shared between the two ends instead of landing entirely on one of them.
 */
export function hearingSpot(tracks: readonly TrackSkeleton[], preferredZ: number | null): HearingSpot {
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const track of tracks) {
    for (const placement of track.placements) {
      if (placement.block !== NOTE_BLOCK) continue;
      minZ = Math.min(minZ, placement.pos.z);
      maxZ = Math.max(maxZ, placement.pos.z);
    }
  }
  if (!Number.isFinite(minZ)) return { playerZ: preferredZ ?? 0, hearingRadius: 0 };
  const playerZ = preferredZ ?? Math.round((minZ + maxZ) / 2);
  let hearingRadius = 0;
  for (const track of tracks) {
    for (const placement of track.placements) {
      if (placement.block !== NOTE_BLOCK) continue;
      hearingRadius = Math.max(hearingRadius, Math.abs(placement.pos.z - playerZ));
    }
  }
  return { playerZ, hearingRadius };
}
