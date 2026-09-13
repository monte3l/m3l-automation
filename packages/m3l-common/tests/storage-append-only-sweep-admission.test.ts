/**
 * Tests for `internal/storage/append-only-sweep-policy`'s
 * {@link selectSweepCandidates} — the sweep's CANDIDATE-ADMISSION rule: which
 * segments in an on-disk inventory the cold-start sweep may seal.
 *
 * `selectSweepCandidates` is a pure function over already-parsed values (no
 * filesystem, no clock, no `this`), so every admission term is pinned here as
 * a direct call rather than through the sealer's filesystem fixtures — the
 * sibling `storage-append-only-sweep-policy.test.ts` does the same for
 * `segmentOrderKey`/`baselineBoundaryKey`/`isAtOrBeforeBaseline`, and
 * `storage-append-only-sealer.test.ts` separately proves the `active`
 * exclusion survives the real sealer end to end.
 *
 * One test per term, so a single-clause mutation (deleting or inverting one
 * `&&` operand in the filter) moves exactly one test from green to red.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "vitest";

import type { M3LAppendOnlySegment } from "../src/core/storage/append-only-read-types.js";
import type { ManifestBaselineRecord } from "../src/internal/storage/append-only-manifest-records.js";
import {
  baselineBoundaryKey,
  selectSweepCandidates,
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

/** A permissive baseline of "no legacy boundary" for admission fixtures. */
const NO_SEALED: ReadonlySet<string> = new Set();

/** A segment name no fixture here otherwise produces — inert as `active`. */
const NO_ACTIVE_SEGMENT = "2999-12-31-9999.jsonl";

const TODAY = "2026-06-15";
const YESTERDAY = "2026-06-14";
const LAST_WEEK = "2026-06-08";

/** A generous per-call cap, so no test here is accidentally about `limit`. */
const AMPLE_LIMIT = 64;

// ---------------------------------------------------------------------------
// 1. Strictly-older admission
// ---------------------------------------------------------------------------

describe("selectSweepCandidates — the date term", () => {
  test("admits a segment whose datePrefix is strictly older than today and which passes every other term", () => {
    const older = segment(YESTERDAY, 1);

    const result = selectSweepCandidates([older], {
      today: TODAY,
      active: NO_ACTIVE_SEGMENT,
      sealed: NO_SEALED,
      boundaryKey: undefined,
      limit: AMPLE_LIMIT,
    });

    expect(result).toEqual([older]);
  });

  test("does not admit a segment carrying today's own date prefix", () => {
    const today = segment(TODAY, 1);

    const result = selectSweepCandidates([today], {
      today: TODAY,
      active: NO_ACTIVE_SEGMENT,
      sealed: NO_SEALED,
      boundaryKey: undefined,
      limit: AMPLE_LIMIT,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The `active` term
// ---------------------------------------------------------------------------

describe("selectSweepCandidates — the active term", () => {
  test("does not admit a segment that satisfies every other term when its name equals admission.active", () => {
    // Older date prefix, not in `sealed`, after the baseline — every other
    // term is satisfied, so `active` is the ONLY reason this is refused.
    // The mutation this test exists to catch: deleting
    // `segment.name !== admission.active` from the filter.
    const activeSegment = segment(YESTERDAY, 1);

    const result = selectSweepCandidates([activeSegment], {
      today: TODAY,
      active: activeSegment.name,
      sealed: NO_SEALED,
      boundaryKey: undefined,
      limit: AMPLE_LIMIT,
    });

    expect(result).toEqual([]);
  });

  test("the active exclusion is by NAME, not by date prefix — a different segment with the same older date is admitted in the same call", () => {
    const activeSegment = segment(YESTERDAY, 1);
    const sameDateOther = segment(YESTERDAY, 2);

    const result = selectSweepCandidates([activeSegment, sameDateOther], {
      today: TODAY,
      active: activeSegment.name,
      sealed: NO_SEALED,
      boundaryKey: undefined,
      limit: AMPLE_LIMIT,
    });

    expect(result).toEqual([sameDateOther]);
  });
});

// ---------------------------------------------------------------------------
// 3. The `sealed` term
// ---------------------------------------------------------------------------

describe("selectSweepCandidates — the sealed term", () => {
  test("does not admit a segment already named in sealed", () => {
    const alreadySealed = segment(YESTERDAY, 1);

    const result = selectSweepCandidates([alreadySealed], {
      today: TODAY,
      active: NO_ACTIVE_SEGMENT,
      sealed: new Set([alreadySealed.name]),
      boundaryKey: undefined,
      limit: AMPLE_LIMIT,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The baseline term
// ---------------------------------------------------------------------------

describe("selectSweepCandidates — the baseline term", () => {
  test("does not admit a segment at or before the baseline", () => {
    const baselineRecord: ManifestBaselineRecord = {
      kind: "baseline",
      formatVersion: 1,
      at: new Date(0).toISOString(),
      upTo: segment(YESTERDAY, 5).name,
    };
    const boundaryKey = baselineBoundaryKey({
      baseline: baselineRecord,
      seals: new Map(),
    });
    const atBoundary = segment(YESTERDAY, 5);
    const beforeBoundary = segment(LAST_WEEK, 1);

    const result = selectSweepCandidates([atBoundary, beforeBoundary], {
      today: TODAY,
      active: NO_ACTIVE_SEGMENT,
      sealed: NO_SEALED,
      boundaryKey,
      limit: AMPLE_LIMIT,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. `limit` bounds CANDIDATES, oldest-first
// ---------------------------------------------------------------------------

describe("selectSweepCandidates — the limit term", () => {
  test("returns exactly limit admissible segments, the OLDEST ones by inventory order", () => {
    // The inventory's own order IS the "oldest first" order here — the
    // function must not merely count down to `limit`, it must keep the
    // FRONT of the list, so this is asserted on identity, not just length.
    const oldest = segment(LAST_WEEK, 1);
    const middle = segment(LAST_WEEK, 2);
    const newest = segment(YESTERDAY, 1);

    const result = selectSweepCandidates([oldest, middle, newest], {
      today: TODAY,
      active: NO_ACTIVE_SEGMENT,
      sealed: NO_SEALED,
      boundaryKey: undefined,
      limit: 2,
    });

    expect(result).toEqual([oldest, middle]);
  });

  test("limit: 0 returns an empty array", () => {
    const admissible = segment(YESTERDAY, 1);

    const result = selectSweepCandidates([admissible], {
      today: TODAY,
      active: NO_ACTIVE_SEGMENT,
      sealed: NO_SEALED,
      boundaryKey: undefined,
      limit: 0,
    });

    expect(result).toEqual([]);
  });
});
