/**
 * Tests for `toValidDurationMs` in `src/telemetry/duration.ts` (X8 slice 3a).
 *
 * The clamp exists because `M3LTelemetryRecorder` never throws by contract —
 * it fans out to a store whose `valueMs` column carries a non-negative-integer
 * CHECK constraint. Without the clamp, a backward-stepping clock (NTP
 * correction, VM snapshot restore) would produce a negative raw elapsed value,
 * the store would reject the row with `ERR_CONSOLE_BAD_REQUEST`, and the
 * recorder's `fanOut` would swallow the rejection as a logged warning — the
 * sample vanishes while the observed operation continues to report success.
 * `toValidDurationMs` clamps every non-finite and every negative reading to 0
 * before it ever reaches the recorder, so the sample always survives.
 */
import { describe, expect, test } from "vitest";

import { toValidDurationMs } from "../src/telemetry/duration.js";

describe("toValidDurationMs — clamp table", () => {
  test.each<[number, number]>([
    [0, 0],
    [1, 1],
    [1.4, 1],
    [1.6, 2],
    [-1, 0],
    [-0.4, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])("toValidDurationMs(%s) === %i", (input, expected) => {
    expect(toValidDurationMs(input)).toBe(expected);
  });
});
