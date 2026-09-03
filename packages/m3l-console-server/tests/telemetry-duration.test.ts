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
    // Ceiling clamp: values above Number.MAX_SAFE_INTEGER are clamped so the
    // telemetry store's non-negative-safe-integer constraint is always satisfied.
    // The security finding (X8 slice 3a): Number.isFinite(1e300) is true, so
    // without a ceiling clamp toValidDurationMs returned 1e300, which the store
    // rejected — the never-throws recorder silently swallowed the dropped row.
    [1e300, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER + 2, Number.MAX_SAFE_INTEGER],
    // Boundary: MAX_SAFE_INTEGER itself passes through unchanged.
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    // Just inside: MAX_SAFE_INTEGER - 1 also passes through unchanged.
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1],
  ])("toValidDurationMs(%s) === %i", (input, expected) => {
    expect(toValidDurationMs(input)).toBe(expected);
  });
});

describe("toValidDurationMs — safe-integer property", () => {
  /**
   * Pins the ACTUAL contract the ceiling clamp exists to enforce: every output
   * must be a non-negative safe integer. The fixed-value rows above verify
   * specific arithmetic; this test catches a future regression where the clamp
   * is removed or the ceiling is shifted to a value the store still rejects —
   * cases the fixed-value table alone would miss.
   */
  test("output is always a non-negative safe integer across the full hostile input set", () => {
    const inputs: number[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -0.4,
      0,
      0.5,
      1e300,
      Number.MAX_SAFE_INTEGER + 2,
    ];
    for (const input of inputs) {
      const result = toValidDurationMs(input);
      expect(
        Number.isSafeInteger(result) && result >= 0,
        `expected non-negative safe integer for input ${String(input)}, got ${String(result)}`,
      ).toBe(true);
    }
  });
});
