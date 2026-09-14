/**
 * Tests for `internal/storage/append-only-archival` — the read path's
 * archival accounting (ADR-0102, X8b slice 4c): given a manifest's
 * already-parsed contents and the set of segment names actually present on
 * disk, which sealed segments are gone, how each one is reported, and the
 * parsed names the reader's sequence-gap walk then treats as accounted for.
 *
 * Two clauses reach past that module on purpose. The five-field projection
 * and the mirror it must match (C6, C10) live in
 * `internal/storage/append-only-sealed-payload`, beside the record they
 * project, because archival is only one of their two consumers — so those
 * clauses import `toSealedSegmentPayload` and
 * `AppendOnlySealedSegmentPayload` from there directly.
 *
 * A sibling of `storage-append-only-verify.test.ts` and grouped the same way
 * — one `describe` per contract clause — but with the opposite fixture
 * idiom, and deliberately so. That suite owns the classification built on
 * real bytes in a real `mkdtemp` sandbox; this module is synchronous and
 * does no I/O at all (the manifest read stays in the reader), so every
 * fixture here is a hand-built `ManifestContents` literal and a hand-built
 * `Set` of names. That is the point of the module's shape: every branch is
 * reachable from memory, including one the real manifest parser already
 * rules out before a record could ever reach this function (see C8).
 *
 * `check:test-counts` pins a count for `storage.test.ts` alone and treats
 * the append-only siblings — this one included — as unmatched by design.
 *
 * Every payload assertion here uses `toEqual`, never `toMatchObject`:
 * `toMatchObject` ignores extra properties, which is exactly how the
 * previous slice shipped an internal `ManifestSealRecord` straight onto a
 * public field and let `kind` and `formatVersion` ride along into
 * `JSON.stringify` output. C6 is the standing guard against that recurring.
 *
 * @packageDocumentation
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import type { M3LAppendOnlySealedSegment } from "../src/core/storage/append-only-verify-types.js";
import type { AppendOnlyArchivalPolicy } from "../src/internal/storage/append-only-archival.js";
import { resolveArchivedSegments } from "../src/internal/storage/append-only-archival.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import { MANIFEST_FORMAT_VERSION } from "../src/internal/storage/append-only-manifest.js";
import type {
  ManifestBaselineRecord,
  ManifestContents,
  ManifestSealRecord,
} from "../src/internal/storage/append-only-manifest-records.js";
import type { AppendOnlySealedSegmentPayload } from "../src/internal/storage/append-only-sealed-payload.js";
import { toSealedSegmentPayload } from "../src/internal/storage/append-only-sealed-payload.js";
import type { ParsedSegmentName } from "../src/internal/storage/append-only-segments.js";

// ---------------------------------------------------------------------------
// Fixtures — hand-built records, never produced by the library under test
// ---------------------------------------------------------------------------

/** Two segments on one date, plus a third on an earlier one. */
const DAY_ONE = "2026-09-10";
const DAY_TWO = "2026-09-11";

const SEG_EARLY = `${DAY_ONE}-0001.jsonl`;
/**
 * `9999` and `10000` sit either side of the sequence-width change:
 * `segmentFileName` zero-pads to width four, so `padStart` is a no-op above
 * four digits and `2026-09-11-10000.jsonl` is a name this writer really does
 * produce. Lexicographically `"10000" < "9999"`, so a string sort orders
 * these two the wrong way round and a numeric one orders them correctly —
 * which is what makes the C3 ordering test discriminate at all.
 */
const SEG_WIDE_LOW = `${DAY_TWO}-9999.jsonl`;
const SEG_WIDE_HIGH = `${DAY_TWO}-10000.jsonl`;

const AT_EARLY = "2026-09-10T23:59:59.000Z";
const AT_LOW = "2026-09-11T09:00:00.000Z";
const AT_HIGH = "2026-09-11T17:30:00.000Z";

const MEASUREMENT_EARLY = {
  entryCount: 3,
  byteLength: 48,
  sha256: "a".repeat(64),
} as const;
const MEASUREMENT_LOW = {
  entryCount: 7,
  byteLength: 112,
  sha256: "b".repeat(64),
} as const;
const MEASUREMENT_HIGH = {
  entryCount: 11,
  byteLength: 256,
  sha256: "c".repeat(64),
} as const;

/**
 * One `seal` record, with every measured number distinct per segment so a
 * projection that mixed two records up could not pass by coincidence.
 */
function sealRecord(
  segment: string,
  at: string,
  measurement: {
    readonly entryCount: number;
    readonly byteLength: number;
    readonly sha256: string;
  },
): ManifestSealRecord {
  return {
    kind: "seal",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at,
    segment,
    ...measurement,
  };
}

const SEAL_EARLY = sealRecord(SEG_EARLY, AT_EARLY, MEASUREMENT_EARLY);
const SEAL_WIDE_LOW = sealRecord(SEG_WIDE_LOW, AT_LOW, MEASUREMENT_LOW);
const SEAL_WIDE_HIGH = sealRecord(SEG_WIDE_HIGH, AT_HIGH, MEASUREMENT_HIGH);

/** The five-field projection each of the three seals above must yield. */
const PROJECTED_EARLY: AppendOnlySealedSegmentPayload = {
  segment: SEG_EARLY,
  at: AT_EARLY,
  ...MEASUREMENT_EARLY,
};
const PROJECTED_WIDE_LOW: AppendOnlySealedSegmentPayload = {
  segment: SEG_WIDE_LOW,
  at: AT_LOW,
  ...MEASUREMENT_LOW,
};
const PROJECTED_WIDE_HIGH: AppendOnlySealedSegmentPayload = {
  segment: SEG_WIDE_HIGH,
  at: AT_HIGH,
  ...MEASUREMENT_HIGH,
};

/** The exact five keys a projection may carry, sorted for comparison. */
const PROJECTION_KEYS = [
  "at",
  "byteLength",
  "entryCount",
  "segment",
  "sha256",
] as const;

/**
 * A `ManifestContents` keyed exactly as the manifest fold keys it — by each
 * record's own `segment` — so no test depends on a key and a record
 * disagreeing.
 */
function contents(
  seals: readonly ManifestSealRecord[],
  baseline?: ManifestBaselineRecord,
): ManifestContents {
  return {
    baseline,
    seals: new Map(seals.map((seal) => [seal.segment, seal])),
  };
}

/** A `baseline` record stating `upTo`, stamped by the writer's own clock. */
function baselineRecord(upTo: string | null): ManifestBaselineRecord {
  return {
    kind: "baseline",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at: "2026-09-11T18:00:00.000Z",
    upTo,
  };
}

interface RecordedFailure {
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly error: M3LError;
}

interface RecordingFailurePort {
  readonly build: AppendOnlyReadFailure;
  readonly calls: RecordedFailure[];
}

/**
 * A real failure port, not a mock of the behaviour under test: it builds a
 * genuine `M3LError` under a recognisable `code`, and keeps the instance it
 * returned so a test can assert the module threw THAT object rather than
 * merely some error of the right class.
 */
function createFailurePort(): RecordingFailurePort {
  const calls: RecordedFailure[] = [];
  const build: AppendOnlyReadFailure = (message, options) => {
    const context: Record<string, unknown> = { ...options?.context };
    const error = new M3LError(message, {
      code: "ERR_TEST_APPEND_ONLY_ARCHIVAL",
      cause: options?.cause,
      context,
    });
    calls.push({ message, context, error });
    return error;
  };
  return { build, calls };
}

interface ArchivalHarness {
  readonly policy: AppendOnlyArchivalPolicy;
  readonly port: RecordingFailurePort;
  /** Every projection the handler saw, in the order it saw them. */
  readonly seen: AppendOnlySealedSegmentPayload[];
}

/**
 * Builds one call's policy. `"none"` omits `onArchivedSegment` entirely —
 * the C4 shape — rather than passing a no-op, which would be a different
 * policy the module is free to treat differently.
 */
function harness(
  handler:
    | "record"
    | "none"
    | ((segment: AppendOnlySealedSegmentPayload) => void) = "record",
): ArchivalHarness {
  const port = createFailurePort();
  const seen: AppendOnlySealedSegmentPayload[] = [];
  if (handler === "none") {
    return { policy: { buildManifestError: port.build }, port, seen };
  }
  const onArchivedSegment =
    handler === "record"
      ? (segment: AppendOnlySealedSegmentPayload): void => {
          seen.push(segment);
        }
      : handler;
  return {
    policy: { onArchivedSegment, buildManifestError: port.build },
    port,
    seen,
  };
}

/** Runs `call` and returns whatever it threw, or `undefined` if it did not. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// C1 — a present segment is not archived
// ---------------------------------------------------------------------------

describe("C1 a seal whose segment is present", () => {
  test("is neither reported nor returned", () => {
    const { policy, seen, port } = harness();

    const result = resolveArchivedSegments(
      contents([SEAL_EARLY]),
      new Set([SEG_EARLY]),
      policy,
    );

    expect(result).toEqual([]);
    expect(seen).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  test("is not archived even when a sibling seal is", () => {
    const { policy, seen } = harness();

    const result = resolveArchivedSegments(
      contents([SEAL_EARLY, SEAL_WIDE_LOW]),
      new Set([SEG_WIDE_LOW]),
      policy,
    );

    expect(result).toEqual([{ datePrefix: DAY_ONE, sequence: 1 }]);
    expect(seen).toEqual([PROJECTED_EARLY]);
  });
});

// ---------------------------------------------------------------------------
// C2 — an absent segment is archived
// ---------------------------------------------------------------------------

describe("C2 a seal whose segment is absent", () => {
  test("is reported exactly once, with the projection, and returned parsed", () => {
    const { policy, seen } = harness();

    const result = resolveArchivedSegments(
      contents([SEAL_WIDE_HIGH]),
      new Set<string>(),
      policy,
    );

    expect(seen).toEqual([PROJECTED_WIDE_HIGH]);
    expect(result).toEqual([{ datePrefix: DAY_TWO, sequence: 10000 }]);
  });

  test("is archived when the present set holds other, unrelated names", () => {
    const { policy, seen } = harness();

    const result = resolveArchivedSegments(
      contents([SEAL_EARLY]),
      new Set([SEG_WIDE_LOW, SEG_WIDE_HIGH]),
      policy,
    );

    expect(seen).toEqual([PROJECTED_EARLY]);
    expect(result).toEqual([{ datePrefix: DAY_ONE, sequence: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// C3 — read order, numeric on (datePrefix, sequence)
// ---------------------------------------------------------------------------

describe("C3 read order", () => {
  /**
   * Inserted into the map newest-first and across two dates, so neither
   * insertion order nor a per-date grouping can produce the expected result
   * by accident. `9999` before `10000` is the discriminating pair: a
   * lexicographic sort of the file names puts `-10000.jsonl` first.
   */
  const SCRAMBLED = contents([SEAL_WIDE_HIGH, SEAL_EARLY, SEAL_WIDE_LOW]);

  test("results ascend by (datePrefix, sequence), not by file name", () => {
    const { policy } = harness();

    const result = resolveArchivedSegments(
      SCRAMBLED,
      new Set<string>(),
      policy,
    );

    expect(result).toEqual([
      { datePrefix: DAY_ONE, sequence: 1 },
      { datePrefix: DAY_TWO, sequence: 9999 },
      { datePrefix: DAY_TWO, sequence: 10000 },
    ]);
  });

  test("handler calls arrive in that same order", () => {
    const { policy, seen } = harness();

    resolveArchivedSegments(SCRAMBLED, new Set<string>(), policy);

    expect(seen).toEqual([
      PROJECTED_EARLY,
      PROJECTED_WIDE_LOW,
      PROJECTED_WIDE_HIGH,
    ]);
  });
});

// ---------------------------------------------------------------------------
// C4 — no handler means throw
// ---------------------------------------------------------------------------

describe("C4 no handler and something archived", () => {
  test("throws the error the port built, for the first archived segment in read order", () => {
    const { policy, port } = harness("none");

    const thrown = thrownBy(() =>
      resolveArchivedSegments(
        contents([SEAL_WIDE_HIGH, SEAL_EARLY, SEAL_WIDE_LOW]),
        new Set<string>(),
        policy,
      ),
    );

    expect(port.calls).toHaveLength(1);
    const [call] = port.calls;
    if (call === undefined) {
      throw new Error("the port recorded no call");
    }
    expect(thrown).toBe(call.error);
    // The count belongs beside the name because the name alone is not
    // actionable: one archived segment and a whole deleted date produce the
    // identical error, and an operator handed `2026-09-10-0001.jsonl` cannot
    // tell which they are looking at. It is library-computed — the length of
    // this call's own archived list — so it carries no caller data and joins
    // the segment name under the same rule.
    expect(call.context).toEqual({ segment: SEG_EARLY, archivedCount: 3 });
  });

  test("reports archivedCount 1 for a single archival, counting archived segments and not every seal", () => {
    // The field is unconditional, never "only when there are several": a
    // lone archival still reports a count. Two of the three seals are
    // PRESENT here, so an implementation counting `contents.seals` — or the
    // present set — reports 3 and fails, while one counting what it actually
    // archived reports 1.
    const { policy, port } = harness("none");

    thrownBy(() =>
      resolveArchivedSegments(
        contents([SEAL_EARLY, SEAL_WIDE_LOW, SEAL_WIDE_HIGH]),
        new Set([SEG_WIDE_LOW, SEG_WIDE_HIGH]),
        policy,
      ),
    );

    const [call] = port.calls;
    if (call === undefined) {
      throw new Error("the port recorded no call");
    }
    expect(call.context).toEqual({ segment: SEG_EARLY, archivedCount: 1 });
  });

  test("carries a constant message with no caller data, and only library-computed facts as context", () => {
    const first = harness("none");
    const second = harness("none");

    thrownBy(() =>
      resolveArchivedSegments(
        contents([SEAL_EARLY]),
        new Set<string>(),
        first.policy,
      ),
    );
    thrownBy(() =>
      resolveArchivedSegments(
        contents([SEAL_WIDE_LOW]),
        new Set<string>(),
        second.policy,
      ),
    );

    const firstCall = first.port.calls[0];
    const secondCall = second.port.calls[0];
    if (firstCall === undefined || secondCall === undefined) {
      throw new Error("a port recorded no call");
    }
    // Constant across two runs whose only difference is the segment name,
    // and the name reaches `context` rather than the message text. The key
    // set is pinned exactly, so a later field cannot be added to `context`
    // without this suite being made to say so.
    expect(secondCall.message).toBe(firstCall.message);
    expect(firstCall.message).not.toContain(SEG_EARLY);
    expect(Object.keys(firstCall.context).sort()).toEqual([
      "archivedCount",
      "segment",
    ]);
    expect(secondCall.context).toEqual({
      segment: SEG_WIDE_LOW,
      archivedCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// C5 — nothing archived never reaches the port
// ---------------------------------------------------------------------------

describe("C5 nothing archived", () => {
  test.each([
    ["with a handler", "record"],
    ["without a handler", "none"],
  ] as const)(
    "returns an empty array and never invokes buildManifestError (%s)",
    (_label, handler) => {
      const { policy, port, seen } = harness(handler);

      const result = resolveArchivedSegments(
        contents([SEAL_EARLY, SEAL_WIDE_LOW]),
        new Set([SEG_EARLY, SEG_WIDE_LOW]),
        policy,
      );

      expect(result).toEqual([]);
      expect(port.calls).toEqual([]);
      expect(seen).toEqual([]);
    },
  );

  test("an empty manifest returns an empty array", () => {
    const { policy, port, seen } = harness();

    const result = resolveArchivedSegments(
      contents([]),
      new Set([SEG_EARLY]),
      policy,
    );

    expect(result).toEqual([]);
    expect(port.calls).toEqual([]);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C6 — the projection is exactly five fields
// ---------------------------------------------------------------------------

describe("C6 the projection", () => {
  test("toSealedSegmentPayload yields exactly the five public fields", () => {
    const payload = toSealedSegmentPayload(SEAL_WIDE_LOW);

    expect(Object.keys(payload).sort()).toEqual([...PROJECTION_KEYS]);
    expect(payload).toEqual(PROJECTED_WIDE_LOW);
  });

  test("toSealedSegmentPayload serializes without the record's internal fields", () => {
    const serialized = JSON.stringify(toSealedSegmentPayload(SEAL_WIDE_LOW));

    expect(serialized).not.toContain("formatVersion");
    expect(serialized).not.toContain('"kind":"seal"');
  });

  test("the handler receives that same five-field projection, not the record", () => {
    const { policy, seen } = harness();

    resolveArchivedSegments(
      contents([SEAL_WIDE_LOW]),
      new Set<string>(),
      policy,
    );

    const [payload] = seen;
    if (payload === undefined) {
      throw new Error("the handler saw no projection");
    }
    expect(Object.keys(payload).sort()).toEqual([...PROJECTION_KEYS]);
    expect(JSON.stringify(payload)).not.toContain("formatVersion");
  });
});

// ---------------------------------------------------------------------------
// C7 — a seal outranks the baseline
// ---------------------------------------------------------------------------

describe("C7 a seal outranks the baseline", () => {
  test("a baseline naming a LATER segment does not suppress the archival finding", () => {
    const { policy, seen } = harness();

    const result = resolveArchivedSegments(
      contents([SEAL_EARLY], baselineRecord(SEG_WIDE_HIGH)),
      new Set([SEG_WIDE_HIGH]),
      policy,
    );

    expect(seen).toEqual([PROJECTED_EARLY]);
    expect(result).toEqual([{ datePrefix: DAY_ONE, sequence: 1 }]);
  });

  test.each([
    ["a boundary at the sealed segment itself", SEG_EARLY],
    ["a boundary asserting sealing since the first segment", null],
  ] as const)("still finds the archival with %s", (_label, upTo) => {
    const { policy, seen } = harness();

    const result = resolveArchivedSegments(
      contents([SEAL_EARLY], baselineRecord(upTo)),
      new Set<string>(),
      policy,
    );

    expect(seen).toEqual([PROJECTED_EARLY]);
    expect(result).toEqual([{ datePrefix: DAY_ONE, sequence: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// C8 — a seal naming something that is not a segment name
// ---------------------------------------------------------------------------

describe("C8 a seal naming something that is not a segment name", () => {
  /**
   * The real manifest parser (`ownSealSegment`) refuses such a record
   * outright, so no production read can reach this branch. It is reachable
   * HERE precisely because this function takes already-parsed contents and
   * does no I/O of its own — the same property that makes every other
   * branch testable from memory. The assertion stays on observable
   * behaviour: it throws through the owner's `buildManifestError`, and the
   * thrown object is the one that port built.
   *
   * `2026-09-11-00010.jsonl` is the subtle row: it matches the name
   * pattern's `\d{4,}` digits but fails `parseSegmentName`'s round-trip,
   * because `segmentFileName` re-pads sequence 10 to `-0010.jsonl`.
   */
  test.each([
    [
      "a five-digit sequence that does not round-trip",
      "2026-09-11-00010.jsonl",
    ],
    ["the manifest sidecar itself", "manifest.jsonl"],
    ["a calendar-invalid date prefix", "2026-02-30-0001.jsonl"],
    ["a foreign extension", "2026-09-11-0001.txt"],
  ])("throws through buildManifestError for %s", (_label, name) => {
    const { policy, port, seen } = harness();

    const thrown = thrownBy(() =>
      resolveArchivedSegments(
        contents([sealRecord(name, AT_LOW, MEASUREMENT_LOW)]),
        new Set<string>(),
        policy,
      ),
    );

    expect(port.calls).toHaveLength(1);
    const [call] = port.calls;
    if (call === undefined) {
      throw new Error("the port recorded no call");
    }
    expect(thrown).toBe(call.error);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C9 — a throwing handler propagates
// ---------------------------------------------------------------------------

describe("C9 a throwing handler", () => {
  test("propagates unchanged — neither swallowed nor wrapped", () => {
    const boom = new Error("handler exploded");
    const { policy, port } = harness(() => {
      throw boom;
    });

    const thrown = thrownBy(() =>
      resolveArchivedSegments(
        contents([SEAL_EARLY, SEAL_WIDE_LOW]),
        new Set<string>(),
        policy,
      ),
    );

    expect(thrown).toBe(boom);
    // Not re-routed through the owner's error vocabulary either: the reader
    // has no never-throws contract on this path, unlike the sealer's
    // `onSealFailed`, which swallows by design.
    expect(port.calls).toEqual([]);
  });

  test("aborts the walk at the throwing segment, leaving later ones unreported", () => {
    const seen: AppendOnlySealedSegmentPayload[] = [];
    const boom = new Error("handler exploded");
    const { policy } = harness((segment) => {
      seen.push(segment);
      throw boom;
    });

    thrownBy(() =>
      resolveArchivedSegments(
        contents([SEAL_EARLY, SEAL_WIDE_LOW, SEAL_WIDE_HIGH]),
        new Set<string>(),
        policy,
      ),
    );

    expect(seen).toEqual([PROJECTED_EARLY]);
  });
});

// ---------------------------------------------------------------------------
// C10 — the internal mirror cannot drift from the public type
// ---------------------------------------------------------------------------

describe("C10 type-level contract", () => {
  test("AppendOnlySealedSegmentPayload mirrors M3LAppendOnlySealedSegment exactly", () => {
    expectTypeOf<AppendOnlySealedSegmentPayload>().toEqualTypeOf<M3LAppendOnlySealedSegment>();
  });

  test("resolveArchivedSegments returns parsed segment names", () => {
    expectTypeOf(resolveArchivedSegments).returns.toEqualTypeOf<
      readonly ParsedSegmentName[]
    >();
  });
});
