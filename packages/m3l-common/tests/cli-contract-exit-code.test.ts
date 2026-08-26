/**
 * `core/cli-contract` — the outcome to exit-code mapper slice.
 *
 * ADR-0072 slice split: this file owns `mapCommandOutcomeToExitCode` and
 * nothing else, so `perFile` v8 coverage binds it to the mapper's own source
 * file rather than to the whole submodule. The descriptor/context/output type
 * surface lives in the sibling `cli-contract.test.ts`.
 *
 * Key behavioral contracts asserted here:
 *  - Every one of the five `M3LCommandOutcome` arms maps to a registry code:
 *    `success`/`dry-run` to `SUCCESS`, `interrupted` to `INTERRUPTED`,
 *    `partial` to `PARTIAL`, `failure` delegated to `mapErrorToExitCode`.
 *  - The `failure` arm delegates to the REAL `core/diagnostics` classifier —
 *    it is never mocked here, because "there is no second classification
 *    table" is precisely the claim under test.
 *  - No new codes are minted: the return type is `M3LExitCode`, not `number`.
 *  - It never throws, inheriting `mapErrorToExitCode`'s hostile-getter
 *    absorption.
 *  - It does not drift from `core/diagnostics/run-report.ts`'s own private
 *    outcome-to-exit-code table — the second copy of the same mapping in the
 *    codebase. A mirrored constant's drift guard has to enumerate every copy,
 *    so every `M3LRunOutcome` member is driven through the real
 *    `M3LRunReporter` and compared against the corresponding command outcome.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { mapCommandOutcomeToExitCode } from "../src/core/cli-contract/index.js";
import type { M3LCommandOutcome } from "../src/core/cli-contract/index.js";
import {
  M3L_EXIT_CODES,
  M3LRunReporter,
  mapErrorToExitCode,
} from "../src/core/diagnostics/index.js";
import type {
  M3LExitCode,
  M3LRunOutcome,
  M3LRunReportInput,
} from "../src/core/diagnostics/index.js";
import { M3LError } from "../src/core/errors/index.js";

// ---------------------------------------------------------------------------
// The five-arm outcome table
// ---------------------------------------------------------------------------

/**
 * Every non-`failure` arm, enumerated rather than sampled — the contract
 * names an exhaustive table, so the test has to name every member of it.
 * The `failure` arm has its own delegation table below because its code is
 * a function of the carried error, not of the label.
 */
const DIRECT_ARMS = [
  [{ status: "success" }, M3L_EXIT_CODES.SUCCESS],
  [{ status: "dry-run" }, M3L_EXIT_CODES.SUCCESS],
  [{ status: "interrupted" }, M3L_EXIT_CODES.INTERRUPTED],
  [{ status: "partial", recovered: 3 }, M3L_EXIT_CODES.PARTIAL],
] as const satisfies ReadonlyArray<readonly [M3LCommandOutcome, M3LExitCode]>;

describe("mapCommandOutcomeToExitCode — the five outcome arms", () => {
  test.each(DIRECT_ARMS)(
    "maps %j to exit code %i",
    (outcome: M3LCommandOutcome, expected: M3LExitCode) => {
      expect(mapCommandOutcomeToExitCode(outcome)).toBe(expected);
    },
  );

  test("the direct table covers every non-failure arm of the union", () => {
    const covered = new Set(DIRECT_ARMS.map(([outcome]) => outcome.status));
    expect([...covered].sort()).toEqual([
      "dry-run",
      "interrupted",
      "partial",
      "success",
    ]);
  });

  test("`partial` keys off the label alone, so `recovered: 0` still exits 6", () => {
    // The contract deliberately leaves `{ status: "partial", recovered: 0 }`
    // representable: such an outcome is mislabelled, never miscoded.
    expect(
      mapCommandOutcomeToExitCode({ status: "partial", recovered: 0 }),
    ).toBe(M3L_EXIT_CODES.PARTIAL);
  });
});

// ---------------------------------------------------------------------------
// The `failure` arm delegates to the real classifier
// ---------------------------------------------------------------------------

/**
 * `mapErrorToExitCode` is deliberately NOT mocked: delegation to the single
 * `core/diagnostics` classification table is the claim under test, and a stub
 * handing back the answer would assert the stub. Each row pins the literal
 * registry code as well, so the test does not degrade into `f(x) === f(x)`.
 */
const FAILURE_DELEGATION = [
  [
    "a structural caller origin",
    { origin: "caller" },
    M3L_EXIT_CODES.CONFIG_USAGE,
  ],
  [
    "a structural external origin",
    { origin: "external" },
    M3L_EXIT_CODES.EXTERNAL,
  ],
  [
    "a structural library origin",
    { origin: "library" },
    M3L_EXIT_CODES.LIBRARY,
  ],
  [
    "a catalog code with no origin field",
    { code: "ERR_AWS_CLIENT" },
    M3L_EXIT_CODES.EXTERNAL,
  ],
  ["an unclassifiable value", "just a string", M3L_EXIT_CODES.UNCLASSIFIED],
] as const satisfies ReadonlyArray<readonly [string, unknown, M3LExitCode]>;

describe("mapCommandOutcomeToExitCode — the failure arm", () => {
  test.each(FAILURE_DELEGATION)(
    "delegates %s to mapErrorToExitCode, yielding %i for the second argument",
    (_label: string, error: unknown, expected: M3LExitCode) => {
      const outcome: M3LCommandOutcome = { status: "failure", error };

      expect(mapCommandOutcomeToExitCode(outcome)).toBe(expected);
      // Same value the real classifier produces, proving delegation rather
      // than a second table that happens to agree on these five inputs.
      expect(mapCommandOutcomeToExitCode(outcome)).toBe(
        mapErrorToExitCode(error),
      );
    },
  );

  test("delegates a real M3LError by its catalog origin", () => {
    const error = new M3LError("bad argument", {
      code: "ERR_INVALID_ARGUMENT",
    });

    expect(mapCommandOutcomeToExitCode({ status: "failure", error })).toBe(
      mapErrorToExitCode(error),
    );
  });

  // -------------------------------------------------------------------------
  // Hostile getters at the INNER depth: on the carried `error` object.
  //
  // These three exercise the *delegation* — `mapErrorToExitCode` absorbing a
  // hostile error value — and say nothing about the mapper's own boundary.
  // The hostile-`outcome` block further below is the OUTER depth: a hostile
  // getter on the outcome itself, which the mapper must absorb on its own
  // because the delegate is never reached. Do not collapse the two: an
  // escaped defect shipped green precisely because only this depth was
  // covered.
  // -------------------------------------------------------------------------

  test("never throws on a hostile `origin` getter, returning UNCLASSIFIED", () => {
    const hostile = {
      get origin(): string {
        throw new Error("boom");
      },
    };
    const outcome: M3LCommandOutcome = { status: "failure", error: hostile };

    expect(() => mapCommandOutcomeToExitCode(outcome)).not.toThrow();
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(
      M3L_EXIT_CODES.UNCLASSIFIED,
    );
  });

  test("never throws on a hostile `code` getter, returning UNCLASSIFIED", () => {
    const hostile = {
      origin: undefined,
      get code(): string {
        throw new Error("boom");
      },
    };

    expect(
      mapCommandOutcomeToExitCode({ status: "failure", error: hostile }),
    ).toBe(M3L_EXIT_CODES.UNCLASSIFIED);
  });

  test("never throws on a circular error object", () => {
    const circular: Record<string, unknown> = { code: "ERR_UNKNOWN_CODE" };
    circular["self"] = circular;

    expect(
      mapCommandOutcomeToExitCode({ status: "failure", error: circular }),
    ).toBe(M3L_EXIT_CODES.UNCLASSIFIED);
  });
});

// ---------------------------------------------------------------------------
// Hostile reads at the OUTER depth: on the `outcome` itself
// ---------------------------------------------------------------------------

/**
 * The documented guarantee is absolute — "**Never throws.**" — but the three
 * tests above only prove the *inner* half of it, where `mapErrorToExitCode`
 * (which has its own suite, and is sound) does the absorbing. Nothing above
 * puts a hostile getter on the `outcome` argument itself, and that is exactly
 * where the guarantee broke in practice: reading `outcome.status`, or reading
 * `outcome.error` after narrowing, re-enters caller-controlled code that the
 * delegate never sees.
 *
 * Every row is deliberately off-contract, hence the `as unknown as
 * M3LCommandOutcome` cast: the type system already forbids these values, so
 * the only way they reach the mapper is a host bug (a missing `await`, an
 * `any` boundary, a value crossing a JSON/IPC seam) — precisely the situation
 * a "never throws" guarantee exists to survive.
 */
/**
 * Builds a prototype-less outcome. `Object.create(null)` is typed `any`, so the
 * property is assigned through an explicitly-typed local rather than through
 * `Object.assign`, keeping the fixture free of an `any` return.
 */
function nullPrototypeOutcome(status: unknown): unknown {
  const outcome = Object.create(null) as Record<string, unknown>;
  outcome["status"] = status;
  return outcome;
}

const HOSTILE_OUTCOMES: readonly {
  readonly label: string;
  readonly make: () => unknown;
}[] = [
  {
    label: "a failure outcome whose `error` getter throws",
    make: () => ({
      status: "failure",
      get error(): never {
        throw new Error("boom");
      },
    }),
  },
  {
    label: "an outcome whose `status` getter throws",
    make: () => ({
      get status(): never {
        throw new Error("boom");
      },
    }),
  },
  {
    label: "null (no property is readable at all)",
    make: () => null,
  },
  {
    label: "undefined (the realistic host bug: a missing `await`)",
    make: () => undefined,
  },
  {
    label: "a Proxy whose get trap throws for every key",
    make: () =>
      new Proxy(
        {},
        {
          get(): never {
            throw new Error("trap");
          },
        },
      ),
  },
  {
    label: "a null-prototype object carrying an unknown status",
    make: () => nullPrototypeOutcome("bogus"),
  },
];

describe("mapCommandOutcomeToExitCode — hostile reads on the outcome itself", () => {
  test.each(HOSTILE_OUTCOMES)(
    "absorbs $label and returns UNCLASSIFIED",
    ({ make }: { readonly make: () => unknown }) => {
      const outcome = make() as M3LCommandOutcome;

      expect(() => mapCommandOutcomeToExitCode(outcome)).not.toThrow();
      expect(mapCommandOutcomeToExitCode(outcome)).toBe(
        M3L_EXIT_CODES.UNCLASSIFIED,
      );
    },
  );

  test("the hostile-outcome table names every documented vector", () => {
    // A "never throws" guarantee is an invariant over a set, so the set has to
    // be enumerated rather than sampled; this row guards the table against
    // quietly losing a vector.
    expect(HOSTILE_OUTCOMES).toHaveLength(6);
    expect(new Set(HOSTILE_OUTCOMES.map((row) => row.label)).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// The `default` arm is reachable — it is not dead code
// ---------------------------------------------------------------------------

/**
 * The `default` arm's `never` binding makes it *statically* unreachable, which
 * is not the same claim as *dynamically* unreachable: any value that crosses
 * an untyped seam with an unrecognised `status` lands there. These rows are
 * what a coverage pragma on that arm would have hidden, and what keeps the
 * `perFile` threshold honest without one.
 *
 * Unlike the hostile-getter rows above, these pass against the pre-fix
 * implementation too — they are a regression lock on the fall-through
 * returning a code instead of throwing, not a proof of the new guard.
 */
const UNKNOWN_STATUS_OUTCOMES: readonly {
  readonly label: string;
  readonly make: () => unknown;
}[] = [
  {
    label: "a plain object with an unknown string status",
    make: () => ({ status: "bogus" }),
  },
  { label: "an object whose status is a number", make: () => ({ status: 5 }) },
  {
    label: "a null-prototype object with an unknown status",
    make: () => nullPrototypeOutcome("bogus"),
  },
];

describe("mapCommandOutcomeToExitCode — the default arm", () => {
  test.each(UNKNOWN_STATUS_OUTCOMES)(
    "routes $label through the default arm to UNCLASSIFIED",
    ({ make }: { readonly make: () => unknown }) => {
      expect(mapCommandOutcomeToExitCode(make() as M3LCommandOutcome)).toBe(
        M3L_EXIT_CODES.UNCLASSIFIED,
      );
    },
  );

  test("an unknown status is coded, never thrown", () => {
    expect(() =>
      mapCommandOutcomeToExitCode({
        status: "bogus",
      } as unknown as M3LCommandOutcome),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Each caller-controlled property is read exactly once
// ---------------------------------------------------------------------------

/**
 * The repo's validate-then-re-read hazard: a value read twice can be made to
 * disagree with itself between the reads, so a guard proves nothing about the
 * value that is actually used (the `core/checkpoint` A4 fingerprint incident).
 * A non-idempotent getter is the only way to observe the difference — an
 * inert getter passes under either implementation.
 *
 * Each test asserts BOTH halves: the read count is 1, *and* the routing
 * matches the FIRST read. Counting alone would not catch a guard that reads
 * once and then routes on a stale copy; routing alone would not catch a
 * second read that happens to agree.
 *
 * These three pass against the pre-guard implementation as well (a bare
 * `switch (outcome.status)` also reads once): they are a regression lock on
 * the guard NOT introducing a validate-then-re-read, not a proof of it.
 */
describe("mapCommandOutcomeToExitCode — one read per caller-controlled property", () => {
  test("reads `status` exactly once, and routes on that first read", () => {
    let reads = 0;
    const outcome = {
      get status(): string {
        reads += 1;
        // A second read disagrees with the first: an implementation that
        // validates `status` and then re-reads it would route on "failure"
        // (and then read a `error`-less outcome, yielding UNCLASSIFIED).
        return reads === 1 ? "success" : "failure";
      },
    } as unknown as M3LCommandOutcome;

    expect(mapCommandOutcomeToExitCode(outcome)).toBe(M3L_EXIT_CODES.SUCCESS);
    expect(reads).toBe(1);
  });

  test("reads `error` exactly once, and classifies that first read", () => {
    let reads = 0;
    const outcome = {
      status: "failure",
      get error(): unknown {
        reads += 1;
        // First read classifies to CONFIG_USAGE (2), second to EXTERNAL (3):
        // the two reads route to different exit codes on purpose.
        return reads === 1 ? { origin: "caller" } : { origin: "external" };
      },
    } as unknown as M3LCommandOutcome;

    expect(mapCommandOutcomeToExitCode(outcome)).toBe(
      M3L_EXIT_CODES.CONFIG_USAGE,
    );
    expect(reads).toBe(1);
  });

  test("does not read `error` at all on a non-failure outcome", () => {
    let reads = 0;
    const outcome = {
      status: "interrupted",
      get error(): unknown {
        reads += 1;
        throw new Error("the interrupted arm must not touch caller data");
      },
    } as unknown as M3LCommandOutcome;

    expect(mapCommandOutcomeToExitCode(outcome)).toBe(
      M3L_EXIT_CODES.INTERRUPTED,
    );
    expect(reads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drift lock against run-report.ts's private duplicate table
// ---------------------------------------------------------------------------

/**
 * `core/diagnostics/run-report.ts` carries its own private
 * outcome-to-exit-code switch. That makes this mapping a mirrored constant
 * with two copies, and a drift guard for a mirrored constant has to enumerate
 * every copy — otherwise the two tables can diverge silently and an
 * in-process run stops being indistinguishable from a spawned one.
 *
 * The real `M3LRunReporter` is used, not a stub: a stub would assert the
 * fixture rather than the second table.
 */
const REPORT_BASE = {
  script: { name: "drift-lock", version: "1.0.0" },
  correlationId: "corr-drift",
  startedAt: new Date("2026-08-26T09:00:00.000Z"),
  finishedAt: new Date("2026-08-26T09:00:01.000Z"),
} as const satisfies Omit<M3LRunReportInput, "outcome">;

const DRIFT_FAILURE_ERROR = new M3LError("external blew up", {
  code: "ERR_AWS_CLIENT",
});

interface DriftRow {
  /** The `core/diagnostics` outcome label. */
  readonly runOutcome: M3LRunOutcome;
  /** The `core/cli-contract` outcome carrying the same meaning. */
  readonly commandOutcome: M3LCommandOutcome;
  /** Extra report input the run-report arm needs to reach its own branch. */
  readonly reportExtras: Partial<M3LRunReportInput>;
}

/**
 * The `"partial"` row MUST carry a non-empty `recovery` array: `build()`
 * branches the partial arm on data, not on the label, and degrades an empty
 * partial report to `"success"` with exit code 0. Without a recovery entry
 * this row would compare `PARTIAL` against `SUCCESS` and fail for a reason
 * that has nothing to do with drift.
 */
const DRIFT_ROWS: readonly DriftRow[] = [
  {
    runOutcome: "success",
    commandOutcome: { status: "success" },
    reportExtras: {},
  },
  {
    runOutcome: "dry-run",
    commandOutcome: { status: "dry-run" },
    reportExtras: {},
  },
  {
    runOutcome: "interrupted",
    commandOutcome: { status: "interrupted" },
    reportExtras: {},
  },
  {
    runOutcome: "partial",
    commandOutcome: { status: "partial", recovered: 1 },
    reportExtras: {
      recovery: [
        {
          item: "row-1",
          error: [{ name: "Error", message: "absorbed" }],
          recordedAt: "2026-08-26T09:00:00.500Z",
        },
      ],
    },
  },
  {
    runOutcome: "failure",
    commandOutcome: { status: "failure", error: DRIFT_FAILURE_ERROR },
    reportExtras: { error: DRIFT_FAILURE_ERROR },
  },
];

describe("drift lock: the mapper agrees with run-report.ts's own table", () => {
  test("the drift table enumerates every M3LRunOutcome member", () => {
    const covered = [...DRIFT_ROWS.map((row) => row.runOutcome)].sort();
    expect(covered).toEqual([
      "dry-run",
      "failure",
      "interrupted",
      "partial",
      "success",
    ]);
    expectTypeOf<M3LRunOutcome>().toEqualTypeOf<
      "success" | "failure" | "dry-run" | "interrupted" | "partial"
    >();
  });

  test.each(DRIFT_ROWS)(
    "M3LRunReporter's exitCode for $runOutcome matches mapCommandOutcomeToExitCode",
    ({ runOutcome, commandOutcome, reportExtras }: DriftRow) => {
      const reporter = new M3LRunReporter();
      const report = reporter.build({
        ...REPORT_BASE,
        ...reportExtras,
        outcome: runOutcome,
      });

      // Guards the fixture itself: if the partial arm silently degraded, the
      // built report's outcome would no longer be the one under test and the
      // comparison below would be meaningless.
      expect(report.outcome).toBe(runOutcome);
      expect(report.exitCode).toBe(mapCommandOutcomeToExitCode(commandOutcome));
    },
  );
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("mapCommandOutcomeToExitCode — type-level contract", () => {
  test("returns M3LExitCode, not number — the compiler enforces 'mints no new codes'", () => {
    expectTypeOf(
      mapCommandOutcomeToExitCode,
    ).returns.toEqualTypeOf<M3LExitCode>();
    // The whole point of the narrow return type: a widened `number` would let
    // an implementation mint a code outside the registry.
    expectTypeOf(
      mapCommandOutcomeToExitCode,
    ).returns.not.toEqualTypeOf<number>();
    expectTypeOf(mapCommandOutcomeToExitCode)
      .parameter(0)
      .toEqualTypeOf<M3LCommandOutcome>();
  });

  test("`error` is reachable only after narrowing to the failure arm", () => {
    const outcome: M3LCommandOutcome = { status: "success" };

    if (outcome.status === "success") {
      // @ts-expect-error -- `error` belongs to the "failure" arm only; a
      // `{ status: "success", error }` must not compile.
      expect(outcome.error).toBeUndefined();
    }
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(M3L_EXIT_CODES.SUCCESS);
  });

  test("`recovered` is reachable only after narrowing to the partial arm", () => {
    const outcome: M3LCommandOutcome = {
      status: "failure",
      error: new Error("nope"),
    };

    if (outcome.status === "failure") {
      // @ts-expect-error -- `recovered` belongs to the "partial" arm only.
      expect(outcome.recovered).toBeUndefined();
    }
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(
      M3L_EXIT_CODES.UNCLASSIFIED,
    );
  });

  test("the outcome union is exactly the five documented arms", () => {
    expectTypeOf<M3LCommandOutcome["status"]>().toEqualTypeOf<
      "success" | "dry-run" | "interrupted" | "partial" | "failure"
    >();
    expectTypeOf<
      Extract<M3LCommandOutcome, { status: "partial" }>["recovered"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      Extract<M3LCommandOutcome, { status: "failure" }>["error"]
    >().toEqualTypeOf<unknown>();
  });
});
