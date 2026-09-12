/**
 * Tests for `internal/storage/append-only-sweep-policy` — the sweep's
 * ORDERING and LEGACY-BOUNDARY policy, extracted from
 * `./append-only-sealer.js` (ADR-0102, X8b). Every export here is a PURE
 * function over already-parsed values, so this suite needs no filesystem and
 * no mocks at all.
 *
 * Before this extraction these three functions were reachable only by
 * driving the sealer end to end; this file exercises them directly so the
 * ordering and boundary rules are pinned independent of the sealer's own
 * triggers.
 *
 * A new sibling file on purpose: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched
 * by design.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "vitest";

import type { M3LAppendOnlySegment } from "../src/core/storage/append-only-read-types.js";
import type {
  ManifestBaselineRecord,
  ManifestContents,
} from "../src/internal/storage/append-only-manifest-records.js";
import {
  baselineBoundaryKey,
  isAtOrBeforeBaseline,
  segmentOrderKey,
} from "../src/internal/storage/append-only-sweep-policy.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal, well-formed `M3LAppendOnlySegment` at `datePrefix`/`sequence`. */
function segment(datePrefix: string, sequence: number): M3LAppendOnlySegment {
  return {
    name: `${datePrefix}-${String(sequence).padStart(4, "0")}.jsonl`,
    datePrefix,
    sequence,
    byteLength: 0,
    modifiedAtMs: 0,
  };
}

/** `ManifestContents` holding no seals, with an overridable baseline. */
function manifestContents(
  baseline: ManifestBaselineRecord | undefined,
): ManifestContents {
  return { baseline, seals: new Map() };
}

/** A `baseline` record naming `upTo`, at the current format version. */
function baselineRecord(upTo: string | null): ManifestBaselineRecord {
  return {
    kind: "baseline",
    formatVersion: 1,
    at: new Date().toISOString(),
    upTo,
  };
}

// ---------------------------------------------------------------------------
// segmentOrderKey
// ---------------------------------------------------------------------------

describe("segmentOrderKey", () => {
  test.each([
    {
      label: "a single-digit sequence must sort before a double-digit one",
      lower: 9,
      higher: 10,
    },
    {
      label: "a double-digit sequence must sort before a triple-digit one",
      lower: 99,
      higher: 100,
    },
  ])("$label, within the same date", ({ lower, higher }) => {
    const datePrefix = "2026-01-01";

    // A narrow zero-padding width would invert this exact pair (e.g.
    // padStart(4): "9999" > "10000" as plain strings) — the whole reason the
    // width constant exists.
    expect(
      segmentOrderKey(datePrefix, lower) < segmentOrderKey(datePrefix, higher),
    ).toBe(true);
  });

  test("orders by date prefix ahead of sequence magnitude", () => {
    const earlierDateHugeSequence = segmentOrderKey("2026-01-01", 9_999);
    const laterDateTinySequence = segmentOrderKey("2026-01-02", 1);

    expect(earlierDateHugeSequence < laterDateTinySequence).toBe(true);
  });

  test("is deterministic for the same input", () => {
    expect(segmentOrderKey("2026-03-04", 42)).toBe(
      segmentOrderKey("2026-03-04", 42),
    );
  });

  test("string-sorting a mixed batch of keys reproduces the real segment order", () => {
    const pairs: ReadonlyArray<readonly [string, number]> = [
      ["2026-01-01", 1],
      ["2026-01-01", 9],
      ["2026-01-01", 10],
      ["2026-01-01", 99],
      ["2026-01-01", 100],
      ["2026-01-02", 1],
    ];
    const keys = pairs.map(([datePrefix, sequence]) =>
      segmentOrderKey(datePrefix, sequence),
    );

    // The list above is already written in the order the real inventory
    // would sort it; a plain string `.sort()` over the produced keys must
    // reproduce that same order, or the padding width is wrong somewhere.
    expect([...keys].sort()).toEqual(keys);
  });
});

// ---------------------------------------------------------------------------
// baselineBoundaryKey
// ---------------------------------------------------------------------------

describe("baselineBoundaryKey", () => {
  test("returns undefined when the manifest has no baseline record at all", () => {
    expect(baselineBoundaryKey(manifestContents(undefined))).toBeUndefined();
  });

  test("returns undefined when the baseline states upTo: null", () => {
    expect(
      baselineBoundaryKey(manifestContents(baselineRecord(null))),
    ).toBeUndefined();
  });

  test("returns undefined when the baseline names something parseSegmentName declines", () => {
    expect(
      baselineBoundaryKey(
        manifestContents(baselineRecord("not-a-segment.txt")),
      ),
    ).toBeUndefined();
  });

  // The control case: without it, the three tests above would pass
  // identically against a function hard-coded to always return `undefined`.
  test("returns the named segment's order key when the baseline names a real segment", () => {
    const result = baselineBoundaryKey(
      manifestContents(baselineRecord("2026-01-01-0001.jsonl")),
    );

    expect(result).toBe(segmentOrderKey("2026-01-01", 1));
    expect(result).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isAtOrBeforeBaseline
// ---------------------------------------------------------------------------

describe("isAtOrBeforeBaseline", () => {
  test("is false when there is no boundary at all", () => {
    expect(isAtOrBeforeBaseline(segment("2026-01-01", 1), undefined)).toBe(
      false,
    );
  });

  test("is true exactly AT the boundary — the inclusive edge <= must satisfy and < must not", () => {
    const boundary = segmentOrderKey("2026-01-05", 3);

    expect(isAtOrBeforeBaseline(segment("2026-01-05", 3), boundary)).toBe(true);
  });

  test("is true one sequence BEFORE the boundary, same date", () => {
    const boundary = segmentOrderKey("2026-01-05", 3);

    expect(isAtOrBeforeBaseline(segment("2026-01-05", 2), boundary)).toBe(true);
  });

  test("is false one sequence AFTER the boundary, same date", () => {
    const boundary = segmentOrderKey("2026-01-05", 3);

    expect(isAtOrBeforeBaseline(segment("2026-01-05", 4), boundary)).toBe(
      false,
    );
  });

  test("is true for an earlier date with a lower sequence than the boundary", () => {
    const boundary = segmentOrderKey("2026-01-05", 5);

    expect(isAtOrBeforeBaseline(segment("2026-01-01", 1), boundary)).toBe(true);
  });

  test("is true for an earlier date even with a HIGHER sequence than the boundary — date dominates", () => {
    const boundary = segmentOrderKey("2026-01-05", 1);

    expect(isAtOrBeforeBaseline(segment("2026-01-01", 9_999), boundary)).toBe(
      true,
    );
  });
});
