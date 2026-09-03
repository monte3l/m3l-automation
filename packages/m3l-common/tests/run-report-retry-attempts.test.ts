/**
 * `core/diagnostics/run-report` + `core/script/run-script` — U11 slice 6:
 * a new optional `retryAttempts?: number` on the run report, derived by
 * `run-script` from the breadcrumb trail it already receives (semver
 * minor, additive).
 *
 * RED phase: `retryAttempts` does not exist yet on `M3LRunReportInput` /
 * `M3LRunReportBase`, and `run-script` performs no derivation. This file
 * exercises two independent surfaces:
 *
 *  1. `M3LRunReporter.build()`'s pass-through of `retryAttempts`, tested
 *     directly against `build()` with no `run-script` involved — mirrors
 *     `tests/run-report-secrets.test.ts`'s style (a hand-built
 *     `M3LRunReportInput`, no `M3LScript`/`runScript` in the loop).
 *  2. `run-script`'s derivation of `retryAttempts` from `options.trail`,
 *     tested end-to-end through `runScript()` with
 *     `vi.spyOn(M3LRunReporter.prototype, "build")` left UNMOCKED (it
 *     still runs for real, called internally by the real `persist()`), so
 *     `.mock.results[0].value` is the genuine built report — mirrors
 *     `tests/run-script-secrets.test.ts`'s "differential" sections.
 *
 * Confirmed against the landed implementation (`run-script.ts`'s
 * `breadcrumbAttempt`/`maxAttempt`, ~line 176-194): the derivation scans
 * EVERY breadcrumb in the trail for a numeric `attempt` field, regardless
 * of event name — it is not limited to `poll:attempt`/`retry:attempt`
 * alone. `retry:scheduled` and `poll:wait` breadcrumbs (whose summarizers
 * also keep a plain `attempt`, per `breadcrumbs.ts`'s SUMMARIZERS table)
 * contribute to the maximum too. See the "any attempt-bearing event name
 * contributes" test below.
 *
 * `maxAttempt` is also a PER-CYCLE maximum, not a cumulative total across
 * cycles (`docs/reference/core/diagnostics.md`): `M3LPoller`/
 * `M3LRetryRunner` each restart their attempt counter at the start of
 * every `poll()`/`run()` call (a loop-local `for (let attempt = 0; ...)`),
 * so a trail spanning two separate cycles re-emits `attempt: 1, 2, 3...`
 * from the top each time. `retryAttempts` reports the deepest single
 * cycle observed, not the sum across cycles — see the "two separate
 * cycles" test below, which pins this down explicitly with a mutation
 * note explaining why the cumulative total is deliberately wrong.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
  type MockInstance,
} from "vitest";

import type {
  M3LBreadcrumb,
  M3LBreadcrumbScalar,
} from "../src/core/diagnostics/breadcrumbs.js";
import {
  M3LRunReporter,
  type M3LRunReport,
  type M3LRunReportBase,
  type M3LRunReportInput,
} from "../src/core/diagnostics/run-report.js";
import {
  M3LScript,
  runScript,
  type M3LScriptMetadata,
} from "../src/core/script/index.js";

const metadata: M3LScriptMetadata = {
  name: "test-script",
  version: "1.0.0",
};

const baseInput = {
  script: { name: "test-script", version: "1.0.0" },
  correlationId: "corr-1",
  startedAt: new Date("2026-07-23T10:20:30.123Z"),
};

/** A minimal `M3LBreadcrumb` fixture, defaulting `timestamp`/`source`. */
function crumb(
  event: string,
  payload: Record<string, M3LBreadcrumbScalar>,
): M3LBreadcrumb {
  return {
    timestamp: "2026-07-23T10:20:31.000Z",
    source: "test",
    event,
    payload,
  };
}

/** A `Pick<M3LBreadcrumbTrail, "entries">` stub returning a fixed array. */
function trailOf(entries: readonly M3LBreadcrumb[]) {
  return { entries: () => entries };
}

// =============================================================================
// 1. Type surface — M3LRunReportInput / M3LRunReportBase gain retryAttempts
// =============================================================================
describe("retryAttempts — type surface", () => {
  test("M3LRunReportInput.retryAttempts is number | undefined, not unknown", () => {
    expectTypeOf<M3LRunReportInput["retryAttempts"]>().toEqualTypeOf<
      number | undefined
    >();
  });

  test("M3LRunReportBase.retryAttempts is number | undefined, not unknown", () => {
    expectTypeOf<M3LRunReportBase["retryAttempts"]>().toEqualTypeOf<
      number | undefined
    >();
  });

  test("retryAttempts is optional on M3LRunReportInput — omitting it still compiles", () => {
    const input: M3LRunReportInput = {
      ...baseInput,
      outcome: "success",
    };
    expect(input.retryAttempts).toBeUndefined();
  });
});

// =============================================================================
// 2. M3LRunReporter.build() — retryAttempts pass-through (no run-script)
// =============================================================================
describe("M3LRunReporter.build() — retryAttempts pass-through", () => {
  test("absent from input -> the key is absent from the built report (not just undefined-valued)", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({ ...baseInput, outcome: "success" });
    expect(Object.hasOwn(report, "retryAttempts")).toBe(false);
    expect(report.retryAttempts).toBeUndefined();
  });

  test("present on input -> copied verbatim onto the built report", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      retryAttempts: 3,
    });
    expect(report.retryAttempts).toBe(3);
  });

  test("0 is a valid retryAttempts value — present, not treated as absent", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      retryAttempts: 0,
    });
    expect(Object.hasOwn(report, "retryAttempts")).toBe(true);
    expect(report.retryAttempts).toBe(0);
  });

  test("present on a failure-outcome report — the field lives on the base, applies to every outcome", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "failure",
      error: new Error("boom"),
      retryAttempts: 5,
    });
    expect(report.outcome).toBe("failure");
    expect(report.retryAttempts).toBe(5);
  });

  test("present on a partial-outcome report — the field lives on the base, applies to every outcome", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "partial",
      recovery: [
        {
          item: "row-1",
          error: [{ name: "Error", message: "boom" }],
          recordedAt: "2026-07-23T10:20:31.000Z",
        },
      ],
      retryAttempts: 2,
    });
    expect(report.outcome).toBe("partial");
    expect(report.retryAttempts).toBe(2);
  });

  // `build()`'s TSDoc promises it never throws, even for hostile input —
  // the same guard already applied to `input.error` and the recovery
  // fields. A hostile `retryAttempts` getter must degrade the same way:
  // omitted from the built report, never an escaping throw. `build()` is
  // called directly by other suites in this repo (not only through
  // `runScript`), so this is a real contract, not a theoretical one.
  test("a hostile retryAttempts getter that throws on access does not make build() throw", () => {
    const reporter = new M3LRunReporter();
    const input: M3LRunReportInput = { ...baseInput, outcome: "success" };
    Object.defineProperty(input, "retryAttempts", {
      get(): number {
        throw new Error("hostile retryAttempts getter");
      },
      enumerable: true,
      configurable: true,
    });

    let report: M3LRunReport | undefined;
    expect(() => {
      report = reporter.build(input);
    }).not.toThrow();
    expect(report).toBeDefined();
    expect(Object.hasOwn(report ?? {}, "retryAttempts")).toBe(false);
  });
});

// =============================================================================
// 3. run-script — retryAttempts derivation from options.trail
// =============================================================================
describe("run-script — retryAttempts derivation from options.trail", () => {
  let outDir: string;

  beforeEach(async () => {
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "once").mockImplementation(() => process);
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-retry-attempts-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    await rm(outDir, { recursive: true, force: true });
  });

  /**
   * `M3LPaths` snapshots `M3L_OUTPUT_DIR` at construction time, so the env
   * var must be stubbed BEFORE `new M3LScript(...)` runs — mirrors
   * `tests/run-script-secrets.test.ts`'s own `makeScript` helper.
   */
  function makeScript(): M3LScript {
    vi.stubEnv("M3L_OUTPUT_DIR", outDir);
    return new M3LScript({ metadata });
  }

  function builtReport(
    buildSpy: MockInstance<(input: M3LRunReportInput) => M3LRunReport>,
  ): M3LRunReport | undefined {
    return buildSpy.mock.results[0]?.value as M3LRunReport | undefined;
  }

  test("no trail supplied -> retryAttempts is absent from the built report", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();

    await runScript(script, () => {});

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(builtReport(buildSpy) ?? {}, "retryAttempts")).toBe(
      false,
    );
  });

  test("trail supplied but with no attempt-bearing breadcrumbs -> absent", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();

    await runScript(script, () => {}, { trail: trailOf([]) });

    expect(Object.hasOwn(builtReport(buildSpy) ?? {}, "retryAttempts")).toBe(
      false,
    );
  });

  test("trail with attempts 1, 2, 3 -> retryAttempts is the maximum (3)", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("poll:attempt", { attempt: 1, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 2, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 3, maxAttempts: 5 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(3);
  });

  test("breadcrumbs out of chronological order -> still the maximum, not the last", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: 3 }),
      crumb("retry:attempt", { attempt: 1 }),
      crumb("retry:attempt", { attempt: 2 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(3);
  });

  test("a non-numeric attempt is ignored, not coerced, and does not poison the maximum", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: 1 }),
      crumb("retry:attempt", { attempt: "three" }),
      crumb("retry:attempt", { attempt: 2 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(2);
  });

  test("a breadcrumb missing the attempt field entirely is ignored", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: 4 }),
      crumb("custom:event", { note: "no attempt here" }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(4);
  });

  test("both poll:attempt and retry:attempt events present -> the max across both", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("poll:attempt", { attempt: 2 }),
      crumb("retry:attempt", { attempt: 5 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(5);
  });

  // Confirmed behavior (see header comment): the derivation is not
  // limited to `poll:attempt`/`retry:attempt` — ANY breadcrumb carrying a
  // numeric `attempt`, regardless of event name, contributes to the
  // maximum. `retry:scheduled` and `poll:wait` breadcrumbs prove this.
  test("any attempt-bearing event name contributes to the maximum, not just poll:attempt/retry:attempt", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("poll:attempt", { attempt: 1 }),
      crumb("retry:scheduled", { attempt: 6, delayMs: 500 }),
      crumb("poll:wait", { attempt: 2, delayMs: 100 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(6);
  });

  // `maxAttempt` is a PER-CYCLE maximum, not a cumulative total across
  // cycles (`docs/reference/core/diagnostics.md`). `M3LPoller`/
  // `M3LRetryRunner` each restart their attempt counter at the start of
  // every `poll()`/`run()` call, so a trail spanning two separate cycles
  // — e.g. a first cycle reaching attempt 3, then a second, independent
  // cycle reaching attempt 5 — re-emits `attempt: 1, 2, 3...` from the top
  // each time. The deepest SINGLE cycle (5) is the answer; 8 (3 + 5, the
  // cumulative total across both cycles) is deliberately NOT the answer —
  // summing across cycles would conflate two independent retry attempts
  // into a number that describes neither cycle's actual depth. This test
  // exists specifically so a future change toward a cumulative sum fails
  // here instead of shipping unnoticed (mutation-tested: flipping the
  // expectation to 8, matching a cumulative-sum implementation, was
  // confirmed to fail against the current maximum-based code — see the
  // spoke report for this slice).
  test("two separate cycles -> the per-cycle maximum (5), NOT the cumulative total (8)", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      // First cycle: three attempts.
      crumb("poll:attempt", { attempt: 1, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 2, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 3, maxAttempts: 5 }),
      // Second, independent cycle: its own counter restarts at 1.
      crumb("poll:attempt", { attempt: 1, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 2, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 3, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 4, maxAttempts: 5 }),
      crumb("poll:attempt", { attempt: 5, maxAttempts: 5 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(5);
  });

  test("the failure path (buildFailureInput) also derives retryAttempts from the trail", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: 1 }),
      crumb("retry:attempt", { attempt: 3 }),
    ];

    await runScript(
      script,
      () => {
        throw new Error("boom");
      },
      { trail: trailOf(entries) },
    );

    const report = builtReport(buildSpy);
    expect(report?.outcome).toBe("failure");
    expect(report?.retryAttempts).toBe(3);
  });

  test("a partial outcome also carries retryAttempts", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: 1 }),
      crumb("retry:attempt", { attempt: 2 }),
    ];

    await runScript(
      script,
      () => {
        script.reportRecovery({
          item: "row-1",
          error: [{ name: "Error", message: "boom" }],
          recordedAt: "2026-07-23T10:20:31.000Z",
        });
      },
      { trail: trailOf(entries) },
    );

    const report = builtReport(buildSpy);
    expect(report?.outcome).toBe("partial");
    expect(report?.retryAttempts).toBe(2);
  });

  // `typeof NaN === "number"`, so a naive numeric guard accepts it. The
  // asymmetry is the whole point: `max === undefined` accepts ANY number
  // unconditionally on the first entry (including NaN), and every later
  // `attempt > NaN` comparison is `false` — so once NaN becomes the
  // running max, no real value can ever replace it. NaN NOT first is fine
  // (a later NaN never beats a real running max). Both orderings are
  // covered explicitly below since only one of them poisons.
  test("NaN as the FIRST attempt poisons the maximum — the real value (10) must still win after the fix", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: NaN }),
      crumb("retry:attempt", { attempt: 10 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(10);
  });

  // Contrast case: NaN NOT first does not poison even on today's code —
  // proving the defect is specifically about ORDER, not about NaN's mere
  // presence anywhere in the trail.
  test("NaN NOT first does not poison the maximum (contrast case for the asymmetry above)", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: 5 }),
      crumb("retry:attempt", { attempt: NaN }),
      crumb("retry:attempt", { attempt: 10 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(10);
  });

  // Infinity is equally meaningless as an attempt count, and — unlike
  // NaN — poisons regardless of position: once accepted as `max`, nothing
  // is ever `> Infinity`, so no later real value can win either.
  test("Infinity as an attempt poisons the maximum the same way NaN does", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: Infinity }),
      crumb("retry:attempt", { attempt: 10 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    expect(builtReport(buildSpy)?.retryAttempts).toBe(10);
  });

  // The dangerous consequence of the NaN-first defect: `JSON.stringify(NaN)`
  // produces `null`, indistinguishable from "no attempt data present" —
  // exactly where this corruption would hide in a persisted report.
  // Asserting on the stringified report (not only the in-memory object)
  // pins the actual failure mode, not just an intermediate value.
  test("the fixed retryAttempts value serializes as a real number, never as null (the NaN-first corruption's hiding place)", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const entries = [
      crumb("retry:attempt", { attempt: NaN }),
      crumb("retry:attempt", { attempt: 10 }),
    ];

    await runScript(script, () => {}, { trail: trailOf(entries) });

    const serialized = JSON.stringify(builtReport(buildSpy));
    expect(serialized).toContain('"retryAttempts":10');
    expect(serialized).not.toContain('"retryAttempts":null');
  });
});

// =============================================================================
// 4. run-script — retryAttempts derivation never breaks report building
// =============================================================================
describe("run-script — retryAttempts derivation never breaks report building", () => {
  let outDir: string;

  beforeEach(async () => {
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "once").mockImplementation(() => process);
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-retry-hostile-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    await rm(outDir, { recursive: true, force: true });
  });

  function makeScript(): M3LScript {
    vi.stubEnv("M3L_OUTPUT_DIR", outDir);
    return new M3LScript({ metadata });
  }

  test("a trail whose entries() returns a non-array does not throw — the report is still produced, with retryAttempts absent", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const hostileTrail = {
      entries: () => null as unknown as readonly M3LBreadcrumb[],
    };

    await expect(
      runScript(script, () => {}, { trail: hostileTrail }),
    ).resolves.toBeUndefined();

    expect(buildSpy).toHaveBeenCalledTimes(1);
    const report = buildSpy.mock.results[0]?.value as M3LRunReport | undefined;
    expect(report).toBeDefined();
    expect(Object.hasOwn(report ?? {}, "retryAttempts")).toBe(false);
  });

  // Regression lock, not new behavior: a trail whose entries() THROWS
  // already fails buildInput() entirely today (see
  // tests/run-script-secrets.test.ts section 4, "run-report-build-failed"
  // diagnostic) — persistBestEffort's try/catch around buildInput() means
  // NO report is built at all in this case. This is the EXISTING fail-soft
  // posture the brief asks to "verify how it currently degrades and match
  // it" — not a new guarantee this slice introduces. This test already
  // passes on unmodified code; it exists only so a retryAttempts-specific
  // change cannot silently regress the composition-root's never-throw
  // contract.
  test("a trail whose entries() throws still resolves runScript() without throwing (existing fail-soft posture, unaffected by retryAttempts)", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript();
    const throwingTrail = {
      entries: () => {
        throw new Error("trail read failed");
      },
    };

    await expect(
      runScript(script, () => {}, { trail: throwingTrail }),
    ).resolves.toBeUndefined();

    expect(buildSpy).not.toHaveBeenCalled();
  });

  // `breadcrumbAttempt` does `entry.payload["attempt"]` unguarded, and
  // `maxAttempt`'s loop has no per-entry try/catch — so a trail whose
  // entries() returns a VALID ARRAY containing one hostile element throws
  // a TypeError that escapes `buildSuccessInput`, meaning `build()` is
  // never called and the ENTIRE report (timeline, environment, all of it)
  // is lost, not just `retryAttempts`. This is a regression: before
  // `retryAttempts` existed, a trail like this still produced a report.
  //
  // Each case below pairs a valid entry (attempt: 7) with one hostile
  // sibling — the strongest form of the assertion, since it pins "skip the
  // bad entry and keep going" rather than merely "don't throw".
  const validAttemptEntry = crumb("retry:attempt", { attempt: 7 });

  const HOSTILE_ELEMENT_CASES: ReadonlyArray<{
    readonly name: string;
    readonly entries: readonly M3LBreadcrumb[];
  }> = [
    {
      name: "[validEntry, null]",
      entries: [validAttemptEntry, null] as unknown as readonly M3LBreadcrumb[],
    },
    {
      name: '[validEntry, "not-an-entry"]',
      entries: [
        validAttemptEntry,
        "not-an-entry",
      ] as unknown as readonly M3LBreadcrumb[],
    },
    {
      name: "an entry with payload: null",
      entries: [
        validAttemptEntry,
        {
          timestamp: "2026-07-23T10:20:31.000Z",
          source: "test",
          event: "retry:attempt",
          payload: null,
        } as unknown as M3LBreadcrumb,
      ],
    },
    {
      name: "an entry with no payload property at all",
      entries: [
        validAttemptEntry,
        {
          timestamp: "2026-07-23T10:20:31.000Z",
          source: "test",
          event: "retry:attempt",
        } as unknown as M3LBreadcrumb,
      ],
    },
    {
      name: "an entry whose payload has a throwing getter for attempt",
      entries: [
        validAttemptEntry,
        {
          timestamp: "2026-07-23T10:20:31.000Z",
          source: "test",
          event: "retry:attempt",
          payload: Object.defineProperty({}, "attempt", {
            get(): number {
              throw new Error("hostile attempt getter");
            },
            enumerable: true,
          }),
        },
      ],
    },
  ];

  test.each(HOSTILE_ELEMENT_CASES)(
    "a hostile element ($name) alongside a valid entry does not destroy the report; the valid entry's attempt (7) still comes through",
    async ({ entries }) => {
      const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
      const script = makeScript();

      await expect(
        runScript(script, () => {}, { trail: trailOf(entries) }),
      ).resolves.toBeUndefined();

      expect(buildSpy).toHaveBeenCalledTimes(1);
      const report = buildSpy.mock.results[0]?.value as
        M3LRunReport | undefined;
      expect(report).toBeDefined();
      expect(report?.retryAttempts).toBe(7);
    },
  );
});
