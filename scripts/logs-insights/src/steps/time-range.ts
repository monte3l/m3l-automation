/**
 * `steps/time-range` — pure time-window planning for `logs-insights`.
 *
 * Business logic lives here — never in `main.ts`. This step takes no
 * dependencies at all (not even a logger): it is a pure function over
 * epoch-second bounds, so it is unit-testable with no mocks.
 */

/** Seconds in one minute, used to convert `windowMinutes` to seconds. */
const SECONDS_PER_MINUTE = 60;

/** A single query time window, in epoch seconds, half-open `[startTime, endTime)`. */
export interface LogsInsightsTimeWindow {
  /** Inclusive window start, epoch seconds. */
  readonly startTime: number;
  /** Exclusive window end, epoch seconds (equal to the next window's `startTime`). */
  readonly endTime: number;
}

/**
 * Splits `[startEpochSeconds, endEpochSeconds)` into an ordered array of
 * fixed-size `windowMinutes * 60`-second windows. The final window is
 * shorter than the fixed size when the range doesn't divide evenly; an empty
 * range (`startEpochSeconds === endEpochSeconds`) produces no windows.
 *
 * @param startEpochSeconds - Inclusive start of the overall range, epoch seconds.
 * @param endEpochSeconds - Exclusive end of the overall range, epoch seconds.
 * @param windowMinutes - Size of each window, in minutes.
 * @returns An ordered, contiguous, non-overlapping array of time windows
 *   exactly covering `[startEpochSeconds, endEpochSeconds)`.
 *
 * @example
 * ```ts
 * import { planTimeWindows } from "./time-range.js";
 *
 * const windows = planTimeWindows(1_700_000_000, 1_700_007_200, 60);
 * // [{ startTime: 1_700_000_000, endTime: 1_700_003_600 },
 * //  { startTime: 1_700_003_600, endTime: 1_700_007_200 }]
 * ```
 */
export function planTimeWindows(
  startEpochSeconds: number,
  endEpochSeconds: number,
  windowMinutes: number,
): readonly LogsInsightsTimeWindow[] {
  const windowSeconds = windowMinutes * SECONDS_PER_MINUTE;
  const windows: LogsInsightsTimeWindow[] = [];

  let cursor = startEpochSeconds;
  while (cursor < endEpochSeconds) {
    const windowEnd = Math.min(cursor + windowSeconds, endEpochSeconds);
    windows.push({ startTime: cursor, endTime: windowEnd });
    cursor = windowEnd;
  }

  return windows;
}
