import { BASE_TPS } from './tick';

export interface SpeedRow {
  /** Multiplier, 1.0 is the original speed */
  factor: number;
  /** The corresponding /tick rate value */
  tickRate: number;
  /** Actual playback duration (seconds) */
  durationSec: number;
}

/**
 * Speed conversion table: `/tick rate` raises the game tick rate to baseTps × factor,
 * so the actual duration = track duration / factor.
 */
export function speedTable(durationSec: number, presets: number[], baseTps: number = BASE_TPS): SpeedRow[] {
  return presets.map((factor) => {
    const tickRate = baseTps * factor;
    return {
      factor,
      tickRate,
      durationSec: durationSec * (baseTps / tickRate),
    };
  });
}

/** Format as mm:ss.s */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
