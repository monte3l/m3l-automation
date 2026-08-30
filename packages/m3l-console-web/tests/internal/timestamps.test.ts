import { describe, expect, test } from "vitest";

import {
  formatNullableTimestampMs,
  formatTimestampMs,
} from "../../src/internal/timestamps.js";

// The documented fallback string for a not-yet-happened nullable timestamp
// (a queued run's startedAtMs, for example) — spelled out once here rather
// than re-typed at every call site below.
const FALLBACK = "—";

describe("formatTimestampMs", () => {
  test("formats a fixed epoch-ms value as an ISO-8601 string", () => {
    expect(formatTimestampMs(1_700_000_000_000)).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });

  test("formats the epoch (0) as an ISO-8601 string", () => {
    expect(formatTimestampMs(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("formats a negative (pre-1970) value as an ISO-8601 string", () => {
    expect(formatTimestampMs(-86_400_000)).toBe("1969-12-31T00:00:00.000Z");
  });

  // `new Date(ms).toISOString()` throws a RangeError for |ms| > 8.64e15 or a
  // non-finite ms. These fixtures are not yet handled — the implementer is
  // expected to fall back to the same "—" the nullable helper uses rather
  // than let the RangeError propagate to a rendering component.
  test.each([
    ["a value just past the maximum representable range", 8.64e15 + 1],
    ["an absurdly large magnitude", 1e300],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])(
    "returns the fallback string rather than throwing for %s",
    (_label, ms) => {
      expect(formatTimestampMs(ms)).toBe(FALLBACK);
    },
  );
});

describe("formatNullableTimestampMs", () => {
  test("renders null as the fallback string", () => {
    expect(formatNullableTimestampMs(null)).toBe(FALLBACK);
  });

  test("delegates a number to formatTimestampMs, producing the same result", () => {
    const ms = 1_700_000_000_000;
    expect(formatNullableTimestampMs(ms)).toBe(formatTimestampMs(ms));
  });

  test("returns the fallback string for an out-of-range number rather than throwing", () => {
    expect(formatNullableTimestampMs(1e300)).toBe(FALLBACK);
  });
});
