/**
 * Tests for `src/store/telemetry-validation.ts` — the guards and narrowing
 * helpers extracted from `telemetry-repository.ts` for the ADR-0072 byte
 * ceiling. These tests hit every `throw` branch in the validation module
 * directly, satisfying the per-file coverage gate without routing through
 * the repository's error-classification wrapper.
 *
 * Per-file coverage for `telemetry-repository.ts` itself is in
 * `tests/store-telemetry-repository.test.ts`.
 */
import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  GRANULARITY_MS,
  TELEMETRY_GRANULARITIES,
  TELEMETRY_METRICS,
  requireAligned,
  requireColumn,
  normalizeOptionalDimension,
  requireNonEmptyDimension,
  requireValidAtMs,
  requireValidBucketStartMs,
  requireValidGranularity,
  requireValidLimit,
  requireValidMeasure,
  requireValidMeasurementBase,
  requireValidMetric,
  requireValidQuery,
  requireValidRangeBound,
  toOptionalNumber,
  toRequiredNumber,
  toRequiredString,
  toTelemetryBucket,
  toTelemetryGranularity,
  toTelemetryMetric,
} from "../src/store/telemetry-validation.js";
import { telemetryBucketStartMs } from "../src/store/telemetry-repository.js";
import type {
  M3LTelemetryGranularity,
  M3LTelemetryMeasurement,
  M3LTelemetryMetric,
  M3LTelemetryQuery,
} from "../src/store/telemetry-repository-types.js";
import type { M3LStoreRow } from "../src/store/types.js";

// ---------------------------------------------------------------------------
// requireColumn — null/undefined throws ERR_CONSOLE_STORE_QUERY_FAILED
// ---------------------------------------------------------------------------

describe("requireColumn", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)(
    "throws ERR_CONSOLE_STORE_QUERY_FAILED for %s",
    (_label, value) => {
      const thrown = captureSync(() => requireColumn(value));
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_STORE_QUERY_FAILED",
      );
    },
  );

  test("returns the value when non-null and non-undefined", () => {
    expect(requireColumn("hello")).toBe("hello");
    expect(requireColumn(42)).toBe(42);
    expect(requireColumn(BigInt(99))).toBe(BigInt(99));
  });
});

// ---------------------------------------------------------------------------
// toRequiredNumber / toRequiredString / toOptionalNumber
// ---------------------------------------------------------------------------

describe("toRequiredNumber", () => {
  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for null", () => {
    const thrown = captureSync(() => toRequiredNumber(null));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("converts a number value", () => {
    expect(toRequiredNumber(7)).toBe(7);
  });

  test("converts a bigint via Number()", () => {
    expect(toRequiredNumber(BigInt(42))).toBe(42);
  });
});

describe("toRequiredString", () => {
  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for null", () => {
    const thrown = captureSync(() => toRequiredString(null));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("returns the string as-is", () => {
    expect(toRequiredString("hello")).toBe("hello");
  });
});

describe("toOptionalNumber", () => {
  test("returns undefined for null", () => {
    expect(toOptionalNumber(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(toOptionalNumber(undefined)).toBeUndefined();
  });

  test("converts a number value", () => {
    expect(toOptionalNumber(5)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary tables — drift guards
// ---------------------------------------------------------------------------

describe("TELEMETRY_METRICS vocabulary", () => {
  test("contains exactly the documented five members", () => {
    const keys = Object.keys(TELEMETRY_METRICS).sort();
    expect(keys).toEqual(
      [
        "http.request",
        "policy.decision",
        "run.finished",
        "sse.stream",
        "store.health",
      ].sort(),
    );
  });
});

describe("TELEMETRY_GRANULARITIES vocabulary", () => {
  test("contains exactly 'minute', 'hour', 'day'", () => {
    const keys = Object.keys(TELEMETRY_GRANULARITIES).sort();
    expect(keys).toEqual(["day", "hour", "minute"]);
  });
});

describe("GRANULARITY_MS widths", () => {
  test("minute is 60_000 ms", () => {
    expect(GRANULARITY_MS["minute"]).toBe(60_000);
  });
  test("hour is 3_600_000 ms", () => {
    expect(GRANULARITY_MS["hour"]).toBe(3_600_000);
  });
  test("day is 86_400_000 ms", () => {
    expect(GRANULARITY_MS["day"]).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// toTelemetryMetric / toTelemetryGranularity — row narrowing
// ---------------------------------------------------------------------------

describe("toTelemetryMetric", () => {
  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for an unrecognized metric string", () => {
    const thrown = captureSync(() => toTelemetryMetric("http.garbage"));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for a null column", () => {
    const thrown = captureSync(() => toTelemetryMetric(null));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("returns the metric when it is a recognized member", () => {
    expect(toTelemetryMetric("http.request")).toBe("http.request");
    expect(toTelemetryMetric("store.health")).toBe("store.health");
  });
});

describe("toTelemetryGranularity", () => {
  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for an unrecognized granularity string", () => {
    const thrown = captureSync(() => toTelemetryGranularity("second"));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for a null column", () => {
    const thrown = captureSync(() => toTelemetryGranularity(null));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("returns the granularity when it is a recognized member", () => {
    expect(toTelemetryGranularity("minute")).toBe("minute");
    expect(toTelemetryGranularity("day")).toBe("day");
  });
});

// ---------------------------------------------------------------------------
// toTelemetryBucket — projects a raw row into a typed bucket
// ---------------------------------------------------------------------------

describe("toTelemetryBucket", () => {
  test("projects a fully populated raw row into M3LTelemetryBucket", () => {
    const row = {
      granularity: "minute",
      bucket_start_ms: 60_000,
      metric: "http.request",
      route: "/api/v1/runs",
      script: "",
      operation: "",
      outcome: "2xx",
      posture: "",
      sample_count: 5,
      sum_value: 750,
      min_value: 100,
      max_value: 200,
    } satisfies M3LStoreRow;

    const bucket = toTelemetryBucket(row);

    expect(bucket.granularity).toBe("minute");
    expect(bucket.bucketStartMs).toBe(60_000);
    expect(bucket.metric).toBe("http.request");
    expect(bucket.route).toBe("/api/v1/runs");
    expect(bucket.sampleCount).toBe(5);
    expect(bucket.sumValue).toBe(750);
    expect(bucket.minValue).toBe(100);
    expect(bucket.maxValue).toBe(200);
  });

  test("maps null sum_value / min_value / max_value to undefined", () => {
    const row = {
      granularity: "minute",
      bucket_start_ms: 60_000,
      metric: "sse.stream",
      route: "",
      script: "",
      operation: "",
      outcome: "",
      posture: "",
      sample_count: 3,
      sum_value: null,
      min_value: null,
      max_value: null,
    } satisfies M3LStoreRow;

    const bucket = toTelemetryBucket(row);

    expect(bucket.sumValue).toBeUndefined();
    expect(bucket.minValue).toBeUndefined();
    expect(bucket.maxValue).toBeUndefined();
  });

  test("throws ERR_CONSOLE_STORE_QUERY_FAILED for a row with a null NOT NULL column", () => {
    const row = {
      granularity: "minute",
      bucket_start_ms: null,
      metric: "http.request",
      route: "/api",
      script: "",
      operation: "",
      outcome: "2xx",
      posture: "",
      sample_count: 1,
      sum_value: null,
      min_value: null,
      max_value: null,
    } satisfies M3LStoreRow;

    const thrown = captureSync(() => toTelemetryBucket(row));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });
});

// ---------------------------------------------------------------------------
// requireValidGranularity
// ---------------------------------------------------------------------------

describe("requireValidGranularity", () => {
  test.each([
    ["an empty string", ""],
    ["'second'", "second"],
    ["'weekly'", "weekly"],
  ] as const)("throws ERR_CONSOLE_BAD_REQUEST for %s", (_label, value) => {
    const thrown = captureSync(() =>
      requireValidGranularity(value as M3LTelemetryGranularity),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("returns the granularity unchanged for a valid member", () => {
    expect(requireValidGranularity("minute")).toBe("minute");
    expect(requireValidGranularity("hour")).toBe("hour");
    expect(requireValidGranularity("day")).toBe("day");
  });
});

// ---------------------------------------------------------------------------
// requireValidMetric
// ---------------------------------------------------------------------------

describe("requireValidMetric", () => {
  test.each([
    ["'http.garbage'", "http.garbage"],
    ["an empty string", ""],
  ] as const)("throws ERR_CONSOLE_BAD_REQUEST for %s", (_label, value) => {
    const thrown = captureSync(() =>
      requireValidMetric(value as M3LTelemetryMetric),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("returns the metric unchanged for a valid member", () => {
    expect(requireValidMetric("http.request")).toBe("http.request");
    expect(requireValidMetric("store.health")).toBe("store.health");
  });
});

// ---------------------------------------------------------------------------
// requireValidBucketStartMs
// ---------------------------------------------------------------------------

describe("requireValidBucketStartMs", () => {
  const invalidValues: readonly [string, number][] = [
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["non-integer", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ];

  test.each(invalidValues)(
    "throws ERR_CONSOLE_BAD_REQUEST for %s",
    (_label, value) => {
      const thrown = captureSync(() => requireValidBucketStartMs(value));
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );

  test("returns the value unchanged for 0", () => {
    expect(requireValidBucketStartMs(0)).toBe(0);
  });

  test("returns the value unchanged for a positive safe integer", () => {
    expect(requireValidBucketStartMs(60_000)).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// requireValidAtMs
// ---------------------------------------------------------------------------

describe("requireValidAtMs", () => {
  const invalidValues: readonly [string, number][] = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ];

  test.each(invalidValues)(
    "throws ERR_CONSOLE_BAD_REQUEST for %s",
    (_label, value) => {
      const thrown = captureSync(() => requireValidAtMs(value));
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );

  test("returns 0 (non-negative boundary)", () => {
    expect(requireValidAtMs(0)).toBe(0);
  });

  test("returns a positive safe integer", () => {
    expect(requireValidAtMs(75_000)).toBe(75_000);
  });

  test("returns MAX_SAFE_INTEGER (upper boundary)", () => {
    expect(requireValidAtMs(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test("returns a fractional millisecond timestamp unchanged", () => {
    // A fractional atMs is legal input — only the bucket must be an integer.
    expect(requireValidAtMs(75_000.5)).toBe(75_000.5);
  });

  test("error message mentions 'atMs'", () => {
    const thrown = captureSync(() => requireValidAtMs(-1));
    expect((thrown as M3LConsoleError).message).toContain("atMs");
  });
});

// ---------------------------------------------------------------------------
// requireAligned
// ---------------------------------------------------------------------------

describe("requireAligned", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST when not aligned to minute", () => {
    const thrown = captureSync(() => requireAligned(61_000, "minute"));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST when not aligned to hour", () => {
    // 3_601_000 ms is not an hour boundary
    const thrown = captureSync(() => requireAligned(3_601_000, "hour"));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST when granularity itself is invalid", () => {
    const thrown = captureSync(() =>
      requireAligned(60_000, "second" as M3LTelemetryGranularity),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("does not throw for a correctly aligned minute bucket", () => {
    expect(() => requireAligned(60_000, "minute")).not.toThrow();
    expect(() => requireAligned(0, "minute")).not.toThrow();
  });

  test("does not throw for a correctly aligned hour bucket", () => {
    expect(() => requireAligned(3_600_000, "hour")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// requireValidMeasure
// ---------------------------------------------------------------------------

describe("requireValidMeasure", () => {
  const invalidValues: readonly [string, number][] = [
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["non-integer", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ];

  test.each(invalidValues)(
    "throws ERR_CONSOLE_BAD_REQUEST for %s",
    (_label, value) => {
      const thrown = captureSync(() =>
        requireValidMeasure(value, "testMeasure"),
      );
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );

  test("returns zero (non-negative safe integer boundary)", () => {
    expect(requireValidMeasure(0, "ms")).toBe(0);
  });

  test("includes the label in the error message", () => {
    const thrown = captureSync(() => requireValidMeasure(-1, "valueBytes"));
    expect((thrown as M3LConsoleError).message).toContain("valueBytes");
  });
});

// ---------------------------------------------------------------------------
// requireNonEmptyDimension
// ---------------------------------------------------------------------------

describe("requireNonEmptyDimension", () => {
  test.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a tab", "\t"],
    ["a newline", "\n"],
  ] as const)("throws ERR_CONSOLE_BAD_REQUEST for %s", (_label, value) => {
    const thrown = captureSync(() => requireNonEmptyDimension(value, "route"));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("returns an already-trimmed value unchanged", () => {
    expect(requireNonEmptyDimension("/api/v1/runs", "route")).toBe(
      "/api/v1/runs",
    );
  });

  test.each([
    ["leading whitespace", " /api/v1/runs"],
    ["trailing whitespace", "/api/v1/runs "],
    ["both leading and trailing whitespace", "  /api/v1/runs  "],
    ["tab and newline mix", "\t/api/v1/runs\n"],
  ] as const)(
    "returns the trimmed value for a string with %s",
    (_label, value) => {
      expect(requireNonEmptyDimension(value, "route")).toBe("/api/v1/runs");
    },
  );

  test.each([
    // Outer whitespace stripped, but the two-space run inside is preserved
    // byte-for-byte. A single internal space is invariant under .replace(/\s+/g,
    // " ") — the run of spaces must contain ≥2 chars to detect that mutation.
    [
      "two-space run with outer whitespace",
      "  /api/v1/  runs  ",
      "/api/v1/  runs",
    ],
    // An internal tab must also survive; \s+ collapses it to a space, so this
    // fixture would fail under that mutation.
    ["internal tab", "a\tb", "a\tb"],
  ] as const)(
    "preserves internal whitespace (%s) — only outer whitespace is stripped",
    (_label, value, expected) => {
      expect(requireNonEmptyDimension(value, "route")).toBe(expected);
    },
  );

  test("includes the label in the error message", () => {
    const thrown = captureSync(() => requireNonEmptyDimension("", "outcome"));
    expect((thrown as M3LConsoleError).message).toContain("outcome");
  });
});

// ---------------------------------------------------------------------------
// normalizeOptionalDimension
// ---------------------------------------------------------------------------

describe("normalizeOptionalDimension", () => {
  // Collapse cases: undefined, empty string, and whitespace-only all map to
  // the DDL sentinel "". An explicit "" is legal — undefined already produces
  // the same row, so making "" throw while undefined succeeds would be
  // incoherent on the optional arm.
  test.each([
    ["undefined", undefined, ""],
    ["empty string", "", ""],
    ["whitespace-only spaces", "   ", ""],
  ] as const)(
    "%s collapses to empty string sentinel",
    (_label, value, expected) => {
      expect(normalizeOptionalDimension(value)).toBe(expected);
    },
  );

  test.each([
    ["leading space", " export", "export"],
    ["trailing space", "export ", "export"],
    ["both leading and trailing", "  export  ", "export"],
    ["tab-and-newline mix", "\texport\n", "export"],
  ] as const)("strips outer whitespace — %s", (_label, value, expected) => {
    expect(normalizeOptionalDimension(value)).toBe(expected);
  });

  test.each([
    // A run of ≥2 spaces is invariant under .trim() but not under
    // .replace(/\s+/g, " ") — the ≥2-space fixture detects that collapse
    // mutation. This exact mistake was already made once on this branch and
    // caught only by mutation testing; the fixture prevents a recurrence.
    ["two-space internal run", "a  b", "a  b"],
    // An internal tab would be collapsed to a space by \s+ replace —
    // this fixture proves that mutation is also caught.
    ["internal tab", "a\tb", "a\tb"],
  ] as const)(
    "preserves internal whitespace (%s)",
    (_label, value, expected) => {
      expect(normalizeOptionalDimension(value)).toBe(expected);
    },
  );

  test("never throws for any input — including undefined, empty, and control characters", () => {
    const values: ReadonlyArray<string | undefined> = [
      undefined,
      "",
      "   ",
      "valid",
      "\t\n",
      "a  b",
      "\x00",
    ];
    for (const v of values) {
      expect(() => normalizeOptionalDimension(v)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// requireValidLimit
// ---------------------------------------------------------------------------

describe("requireValidLimit", () => {
  test.each([
    ["negative", -1],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const)("throws ERR_CONSOLE_BAD_REQUEST for %s", (_label, value) => {
    const thrown = captureSync(() => requireValidLimit(value));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("returns 0 (boundary)", () => {
    expect(requireValidLimit(0)).toBe(0);
  });

  test("returns a positive integer", () => {
    expect(requireValidLimit(100)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// requireValidRangeBound
// ---------------------------------------------------------------------------

describe("requireValidRangeBound", () => {
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["non-integer", 1.5],
  ] as const)("throws ERR_CONSOLE_BAD_REQUEST for %s", (_label, value) => {
    const thrown = captureSync(() => requireValidRangeBound(value, "fromMs"));
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("accepts 0 and negative safe integers (no lower bound required)", () => {
    expect(requireValidRangeBound(0, "fromMs")).toBe(0);
    expect(requireValidRangeBound(-1_000, "fromMs")).toBe(-1_000);
  });

  test("includes the label in the error message", () => {
    const thrown = captureSync(() =>
      requireValidRangeBound(Number.NaN, "toMs"),
    );
    expect((thrown as M3LConsoleError).message).toContain("toMs");
  });
});

// ---------------------------------------------------------------------------
// requireValidQuery
// ---------------------------------------------------------------------------

describe("requireValidQuery", () => {
  function baseQuery(
    overrides: Partial<M3LTelemetryQuery> = {},
  ): M3LTelemetryQuery {
    return { granularity: "minute", limit: 100, ...overrides };
  }

  test("throws ERR_CONSOLE_BAD_REQUEST for an invalid granularity", () => {
    const thrown = captureSync(() =>
      requireValidQuery(
        baseQuery({ granularity: "second" as M3LTelemetryGranularity }),
      ),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for an invalid metric", () => {
    const thrown = captureSync(() =>
      requireValidQuery(
        baseQuery({ metric: "http.garbage" as M3LTelemetryMetric }),
      ),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for a negative limit", () => {
    const thrown = captureSync(() =>
      requireValidQuery(baseQuery({ limit: -1 })),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for a non-safe-integer fromMs", () => {
    const thrown = captureSync(() =>
      requireValidQuery(baseQuery({ fromMs: Number.POSITIVE_INFINITY })),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for a non-safe-integer toMs", () => {
    const thrown = captureSync(() =>
      requireValidQuery(baseQuery({ toMs: 1.5 })),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST when fromMs > toMs", () => {
    const thrown = captureSync(() =>
      requireValidQuery(baseQuery({ fromMs: 120_000, toMs: 60_000 })),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("returns the query unchanged when all fields are valid", () => {
    const query = baseQuery({
      metric: "http.request",
      fromMs: 0,
      toMs: 60_000,
    });
    expect(requireValidQuery(query)).toBe(query);
  });
});

// ---------------------------------------------------------------------------
// requireValidMeasurementBase
// ---------------------------------------------------------------------------

describe("requireValidMeasurementBase", () => {
  function baseMeasurement(
    overrides: Partial<M3LTelemetryMeasurement> = {},
  ): M3LTelemetryMeasurement {
    return {
      metric: "http.request",
      granularity: "minute",
      bucketStartMs: 60_000,
      route: "/api/v1/test",
      outcome: "2xx",
      valueMs: 150,
      ...overrides,
    } as M3LTelemetryMeasurement;
  }

  test("throws ERR_CONSOLE_BAD_REQUEST for a negative bucketStartMs", () => {
    const thrown = captureSync(() =>
      requireValidMeasurementBase(baseMeasurement({ bucketStartMs: -1 })),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for an invalid granularity", () => {
    const thrown = captureSync(() =>
      requireValidMeasurementBase(
        baseMeasurement({
          granularity: "second" as M3LTelemetryGranularity,
          bucketStartMs: 0,
        }),
      ),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("throws ERR_CONSOLE_BAD_REQUEST when bucketStartMs is not aligned to granularity", () => {
    const thrown = captureSync(() =>
      requireValidMeasurementBase(
        baseMeasurement({ granularity: "minute", bucketStartMs: 61_000 }),
      ),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("returns an object with the validated bucketStartMs for a valid measurement", () => {
    const result = requireValidMeasurementBase(baseMeasurement());
    expect(result.bucketStartMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// telemetryBucketStartMs — atMs guard wiring
//
// `store-telemetry-repository.test.ts` has only 807 chars of headroom under
// the 60,000-char check:file-budget ceiling, so the requireValidAtMs wiring
// tests for telemetryBucketStartMs live here, beside the guard itself.
// ---------------------------------------------------------------------------

describe("telemetryBucketStartMs — requireValidAtMs guard wiring", () => {
  // Mirror the cast pattern from store-telemetry-repository.test.ts:1258.
  const BAD_GRAN = "second" as unknown as M3LTelemetryGranularity;

  test.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const)(
    "throws ERR_CONSOLE_BAD_REQUEST for atMs=%s with a valid granularity",
    (_label, atMs) => {
      const thrown = captureSync(() => telemetryBucketStartMs(atMs, "minute"));
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );

  test("granularity is validated first — bad granularity wins over bad atMs", () => {
    // When BOTH atMs and granularity are invalid, the granularity guard fires
    // first. The thrown message must mention "granularity", not "atMs", so a
    // future reordering of the two guards breaks this test visibly.
    const thrown = captureSync(() =>
      telemetryBucketStartMs(Number.NaN, BAD_GRAN),
    );
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("granularity");
    expect((thrown as M3LConsoleError).message).not.toContain("atMs");
  });

  test("75_000 ms with 'minute' granularity returns the 60_000 bucket (behavior preserved)", () => {
    expect(telemetryBucketStartMs(75_000, "minute")).toBe(60_000);
  });

  test("fractional atMs 75_000.5 with 'minute' granularity still floors to 60_000", () => {
    // A fractional atMs is legal; Math.floor rounds down to the correct bucket.
    expect(telemetryBucketStartMs(75_000.5, "minute")).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function captureSync(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}
