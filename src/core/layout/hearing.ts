import type { TrackSkeleton } from './types';

/** Note blocks are the only blocks that make a sound, so only they count. */
const NOTE_BLOCK = 'minecraft:note_block';

export interface HearingSpot {
  /** Row the player stands on. */
  playerZ: number;
  /** Maximum Z offset of a note block from the player's row. */
  hearingRadius: number;
}

/**
 * Where the player stands, and how far the farthest note block is from that row.
 *
 * This is the lateral component of the game hearing distance while following the song
 * along X. Compare layouts by the farthest sound on either side of the row. Signs, dust
 * and repeaters make no sound and are ignored here.
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
