/** Inclusive bounds of a numeric sequence, or null when it is empty. */
export interface NumericRange {
  min: number;
  max: number;
}

/**
 * Scan numeric bounds without spreading the values into a function call.
 *
 * `Math.min(...values)` overflows the call stack for a sufficiently long track. A MIDI
 * track can carry hundreds of thousands of notes, so every whole-track scan uses this
 * loop instead.
 */
export function numericRange(values: Iterable<number>): NumericRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Number.POSITIVE_INFINITY ? null : { min, max };
}
