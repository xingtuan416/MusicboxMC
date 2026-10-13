/** Default TPS: 1 game tick = 50ms. */
export const BASE_TPS = 20;

/** Milliseconds per tick. */
export const MS_PER_TICK = 1000 / BASE_TPS;

/**
 * Worst-case error of one rounding onto the game-tick grid: ±½ tick.
 *
 * This is what the command backend is subject to, since it quantises once.
 */
export const MAX_QUANTIZE_ERROR_MS = MS_PER_TICK / 2;

/**
 * Worst-case error of the redstone backend, which rounds **twice**.
 *
 * A note's seconds are first rounded onto the game-tick grid (±½ tick, ±25ms) and the
 * result is then rounded onto the redstone-tick grid, which is two game ticks wide
 * (±1 game tick, ±50ms). The two roundings add up, so the bound is ±75ms and not the
 * ±25ms the interface used to claim. It is also asymmetric: 1.026s lands on 1.1s, an
 * error of +74ms, because 20.52 rounds to 21 and 10.5 rounds to 11.
 */
export const MAX_LAYOUT_ERROR_MS = MS_PER_TICK * 1.5;

/** Seconds → tick, rounded to the tick grid. */
export function secondsToTick(seconds: number, tps: number = BASE_TPS): number {
  return Math.round(seconds * tps);
}

/** tick → seconds. */
export function tickToSeconds(tick: number, tps: number = BASE_TPS): number {
  return tick / tps;
}
