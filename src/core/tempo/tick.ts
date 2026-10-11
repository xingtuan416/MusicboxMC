/** Default TPS: 1 game tick = 50ms. */
export const BASE_TPS = 20;

/** Milliseconds per tick. */
export const MS_PER_TICK = 1000 / BASE_TPS;

/** Quantization error upper bound (milliseconds): ±(MS_PER_TICK / 2). */
export const MAX_QUANTIZE_ERROR_MS = MS_PER_TICK / 2;

/** Seconds → tick, rounded to the tick grid. */
export function secondsToTick(seconds: number, tps: number = BASE_TPS): number {
  return Math.round(seconds * tps);
}

/** tick → seconds. */
export function tickToSeconds(tick: number, tps: number = BASE_TPS): number {
  return tick / tps;
}

/** Quantization error (milliseconds), used for GUI hints, always ≤ 25ms. */
export function quantizeErrorMs(seconds: number, tps: number = BASE_TPS): number {
  const tick = secondsToTick(seconds, tps);
  return Math.abs(tickToSeconds(tick, tps) - seconds) * 1000;
}
