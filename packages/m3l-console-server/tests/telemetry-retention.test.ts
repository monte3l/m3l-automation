/**
 * Tests for src/telemetry-retention.ts — `telemetryPruneCutoffMs` and
 * `pruneTelemetry` (m3l-console-server X8 slice 5a telemetry retention
 * prune wiring, ADR-0070). No scheduler, timer, or call site exists here —
 * this module is only ever invoked on demand by an operator command
 * (slice 5c), which is exactly what the "schedules nothing" test below
 * pins.
 *
 * RED: `../src/telemetry-retention.ts` does not exist yet — every import
 * below is expected to fail to resolve until the implementer lands it.
 * `../src/store/telemetry-repository.js` and
 * `../src/store/telemetry-validation.js` are already shipped and real (X8
 * slice 1) — the fake repository below satisfies the REAL
 * `M3LConsoleTelemetryRepository` interface, and the tier drift pin below
 * compares against the REAL `TELEMETRY_GRANULARITIES`, never a hand-typed
 * list in this file.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  pruneTelemetry,
  telemetryPruneCutoffMs,
} from "../src/telemetry-retention.js";
import type { M3LTelemetryPruneOutcome } from "../src/telemetry-retention.js";
import { TELEMETRY_GRANULARITIES } from "../src/store/telemetry-validation.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryGranularity,
  M3LTelemetryPruneRequest,
} from "../src/store/telemetry-repository.js";

/** A representative, distinct-per-tier retention policy used across most tests. */
const RETENTION_MS = {
  minute: 1_000,
  hour: 2_000,
  day: 3_000,
} as const;

/**
 * A hand-written fake `M3LConsoleTelemetryRepository` that captures every
 * `prune` argument in `calls`, in call order. `record`/`recordAll` throw —
 * `pruneTelemetry` must never touch either. `pruneImpl` lets a test control
 * `prune`'s return value per call.
 */
function createFakePruneRepository(
  pruneImpl: (request: M3LTelemetryPruneRequest) => number = () => 0,
): {
  readonly repository: M3LConsoleTelemetryRepository;
  readonly calls: M3LTelemetryPruneRequest[];
} {
  const calls: M3LTelemetryPruneRequest[] = [];
  const repository: M3LConsoleTelemetryRepository = {
    record: () => {
      throw new Error("pruneTelemetry must not call record");
    },
    recordAll: () => {
      throw new Error("pruneTelemetry must not call recordAll");
    },
    list: () => [],
    count: () => 0,
    prune: (request) => {
      calls.push(request);
      return pruneImpl(request);
    },
  };
  return { repository, calls };
}

describe("M3LTelemetryPruneOutcome", () => {
  test("has the exact per-tier + total shape the contract declares", () => {
    expectTypeOf<M3LTelemetryPruneOutcome>().toEqualTypeOf<{
      readonly minute: number;
      readonly hour: number;
      readonly day: number;
      readonly total: number;
    }>();
  });
});

describe("telemetryPruneCutoffMs", () => {
  test.each<[M3LTelemetryGranularity]>([["minute"], ["hour"], ["day"]])(
    "returns nowMs - retentionMs[%s] for the %s tier",
    (granularity) => {
      const nowMs = 10_000;
      expect(telemetryPruneCutoffMs(RETENTION_MS, granularity, nowMs)).toBe(
        nowMs - RETENTION_MS[granularity],
      );
    },
  );

  test("returns a negative cutoff, unmodified, when retention exceeds nowMs", () => {
    expect(telemetryPruneCutoffMs(RETENTION_MS, "day", 500)).toBe(500 - 3_000);
  });
});

describe("pruneTelemetry — walks every granularity exactly once", () => {
  test("calls repository.prune exactly once per TELEMETRY_GRANULARITIES tier, with the derived cutoff, and sums the tiers' own return values", () => {
    const tierCounts: Record<M3LTelemetryGranularity, number> = {
      minute: 5,
      hour: 3,
      day: 7,
    };
    const { repository, calls } = createFakePruneRepository(
      (request) => tierCounts[request.granularity],
    );
    const nowMs = 10_000;

    const outcome = pruneTelemetry({
      repository,
      retentionMs: RETENTION_MS,
      nowMs: () => nowMs,
    });

    // Non-vacuous tier drift pin: the walked set comes from the store's OWN
    // vocabulary, not a hand-typed ["minute", "hour", "day"] literal here —
    // a fourth granularity added to the store fails this assertion instead
    // of silently going unpruned forever.
    const expectedGranularities = Object.keys(TELEMETRY_GRANULARITIES).sort();
    expect(calls).toHaveLength(expectedGranularities.length);
    expect(calls.map((call) => call.granularity).sort()).toEqual(
      expectedGranularities,
    );

    for (const call of calls) {
      expect(call.beforeMs).toBe(nowMs - RETENTION_MS[call.granularity]);
    }

    // The three counts are the fake's own distinct return values, not
    // recomputed by the driver — a transposition (e.g. hour/day swapped)
    // fails this because all three are different numbers.
    expect(outcome).toEqual({
      minute: 5,
      hour: 3,
      day: 7,
      total: 15,
    });
  });
});

describe("pruneTelemetry — clock injection", () => {
  test("two different pinned nowMs values produce different cutoffs for the same tier", () => {
    const { repository: repositoryA, calls: callsA } =
      createFakePruneRepository();
    pruneTelemetry({
      repository: repositoryA,
      retentionMs: RETENTION_MS,
      nowMs: () => 10_000,
    });

    const { repository: repositoryB, calls: callsB } =
      createFakePruneRepository();
    pruneTelemetry({
      repository: repositoryB,
      retentionMs: RETENTION_MS,
      nowMs: () => 20_000,
    });

    const minuteCutoffA = callsA.find(
      (call) => call.granularity === "minute",
    )?.beforeMs;
    const minuteCutoffB = callsB.find(
      (call) => call.granularity === "minute",
    )?.beforeMs;

    expect(minuteCutoffA).toBe(10_000 - RETENTION_MS.minute);
    expect(minuteCutoffB).toBe(20_000 - RETENTION_MS.minute);
    expect(minuteCutoffA).not.toBe(minuteCutoffB);
  });

  test("defaults the clock to Date.now when nowMs is not supplied — asserted by behavior, not identity", () => {
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const { repository, calls } = createFakePruneRepository();

      pruneTelemetry({ repository, retentionMs: RETENTION_MS });

      const minuteCall = calls.find((call) => call.granularity === "minute");
      expect(minuteCall?.beforeMs).toBe(fixedNow - RETENTION_MS.minute);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});

describe("pruneTelemetry — schedules nothing (ADR-0070 'never silent deletion')", () => {
  test("installs no pending timer of any kind when called", () => {
    vi.useFakeTimers();
    try {
      const { repository } = createFakePruneRepository();

      pruneTelemetry({
        repository,
        retentionMs: RETENTION_MS,
        nowMs: () => 10_000,
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pruneTelemetry — guards the cutoff arithmetic", () => {
  test("throws an M3LConsoleError before calling repository.prune when the derived cutoff is non-finite", () => {
    const { repository, calls } = createFakePruneRepository();

    expect(() =>
      pruneTelemetry({
        repository,
        retentionMs: RETENTION_MS,
        nowMs: () => Number.NaN,
      }),
    ).toThrow(M3LConsoleError);
    expect(calls).toHaveLength(0);
  });

  test("passes a negative-but-finite cutoff through unchanged — the repository's own bucket_start_ms >= 0 invariant makes it a safe no-op, not something this driver special-cases", () => {
    const { repository, calls } = createFakePruneRepository(() => 0);

    const outcome = pruneTelemetry({
      repository,
      retentionMs: RETENTION_MS,
      nowMs: () => 100,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.beforeMs < 0)).toBe(true);
    expect(outcome).toEqual({ minute: 0, hour: 0, day: 0, total: 0 });
  });
});

describe("pruneTelemetry — partial-tier failure diagnostics (silent-failure fix)", () => {
  /**
   * The walk order `pruneTelemetry` visits tiers in is
   * `Object.keys(TELEMETRY_GRANULARITIES)` (src's own `GRANULARITIES`
   * derivation) — currently `["minute", "hour", "day"]`, per that object's
   * declared property order (`store/telemetry-validation.ts`), which
   * `Object.keys` preserves for string keys per the ECMAScript spec. Rather
   * than hand-typing that literal order here, both tests below read
   * `TELEMETRY_GRANULARITIES` themselves and pick "the second tier in
   * declared order" as the one that throws — so the test keeps working
   * unchanged if the store's tier list is ever reordered, and only the
   * *count* of tiers (at least two) is an assumption, not their names or
   * position.
   */
  test("wraps a mid-walk repository.prune throw in M3LConsoleError, chains the original cause, and reports only the completed tier's count", () => {
    const order = Object.keys(
      TELEMETRY_GRANULARITIES,
    ) as readonly M3LTelemetryGranularity[];
    const failingGranularity = order[1];
    if (failingGranularity === undefined) {
      throw new Error(
        "test fixture assumes at least two granularity tiers exist",
      );
    }
    const completedGranularity = order[0];
    if (completedGranularity === undefined) {
      throw new Error(
        "test fixture assumes at least two granularity tiers exist",
      );
    }
    const remainingGranularities = order.slice(2);

    // Distinctive, non-zero: a coincidental 0 would be indistinguishable
    // from "nothing old enough to delete", which is exactly the ambiguity
    // this fix removes.
    const completedTierCount = 4_217;
    const causeError = new Error("repository.prune failed mid-walk");

    const { repository, calls } = createFakePruneRepository((request) => {
      if (request.granularity === completedGranularity) {
        return completedTierCount;
      }
      if (request.granularity === failingGranularity) {
        throw causeError;
      }
      throw new Error(
        `unexpected call for granularity '${request.granularity}' — the walk should have stopped at '${failingGranularity}'`,
      );
    });

    let thrown: unknown;
    try {
      pruneTelemetry({
        repository,
        retentionMs: RETENTION_MS,
        nowMs: () => 10_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.code).toBe("ERR_CONSOLE_INTERNAL");

    // Identity, not just equality — a re-wrap that constructs a fresh Error
    // with the same message would defeat this.
    expect(consoleError.cause).toBe(causeError);

    expect(Object.hasOwn(consoleError.context, "partialCounts")).toBe(true);
    const partialCounts = consoleError.context["partialCounts"] as Record<
      string,
      number
    >;

    expect(Object.hasOwn(partialCounts, completedGranularity)).toBe(true);
    expect(partialCounts[completedGranularity]).toBe(completedTierCount);

    // The failed tier and every tier never reached must be ABSENT, not
    // present with 0 — `toHaveProperty`/`in` would walk the prototype
    // chain and could pass even when the key is genuinely missing, so
    // absence is asserted with `Object.hasOwn` only.
    expect(Object.hasOwn(partialCounts, failingGranularity)).toBe(false);
    for (const granularity of remainingGranularities) {
      expect(Object.hasOwn(partialCounts, granularity)).toBe(false);
    }

    // The walk must actually have stopped at the failing tier — confirms
    // the fixture's own "never called after failure" assumption held.
    expect(calls.map((call) => call.granularity)).toEqual([
      completedGranularity,
      failingGranularity,
    ]);
  });

  test("reports an empty partial-counts object (not zero-filled) when the very first visited tier throws", () => {
    const order = Object.keys(
      TELEMETRY_GRANULARITIES,
    ) as readonly M3LTelemetryGranularity[];
    const failingGranularity = order[0];
    if (failingGranularity === undefined) {
      throw new Error(
        "test fixture assumes at least one granularity tier exists",
      );
    }

    const causeError = new Error("repository.prune failed on the first tier");
    const { repository, calls } = createFakePruneRepository((request) => {
      if (request.granularity === failingGranularity) {
        throw causeError;
      }
      throw new Error(
        `unexpected call for granularity '${request.granularity}' — the walk should have stopped at '${failingGranularity}'`,
      );
    });

    let thrown: unknown;
    try {
      pruneTelemetry({
        repository,
        retentionMs: RETENTION_MS,
        nowMs: () => 10_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.code).toBe("ERR_CONSOLE_INTERNAL");
    expect(consoleError.cause).toBe(causeError);

    expect(Object.hasOwn(consoleError.context, "partialCounts")).toBe(true);
    const partialCounts = consoleError.context["partialCounts"] as Record<
      string,
      number
    >;
    expect(Object.keys(partialCounts)).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});
