/**
 * Contract: `packages/m3l-cli/src/flow/envelope.ts` — the `m3l flow run
 * <name> --json` result envelope (U10 slice 3, stage C).
 *
 * The load-bearing property, and the reason `buildRunEnvelope` is mocked
 * here rather than merely exercised: the flow envelope **composes**
 * `run/envelope.ts`'s existing per-run builder once per step execution. It
 * must never re-derive a reverse exit-code map and never re-implement the
 * ADR-0063 JSON read guards (the plan's first anti-duplication rule,
 * `docs/plans/2026-09-01-orchestration-engine.md` § Module layout). A
 * hand-rolled nested-envelope builder would satisfy every value assertion
 * below while never calling the mock — so the call-count/argument assertions
 * are the real gate, not decoration.
 *
 * The mock keeps the REAL implementation (`vi.fn(actual)`), so the same
 * suite can assert both composition (via `mock.calls`) and the actual
 * serialized values.
 *
 * Stage-B contract revision (stage-C review): there is NO parallel `stepRuns`
 * array on the input any more. `M3LCliFlowRunResult.stepExecutions` now carries
 * `M3LCliFlowStepOutcome`s — each with the window `flow/step.ts` observed for
 * THAT execution and the reason its report was unavailable — so this module
 * derives every nested envelope from the result alone. That is what stops each
 * nested `durationMs` from collapsing onto the whole run's window, which is the
 * defect the parallel-array design forced.
 *
 * RED phase: `src/flow/envelope.ts` does not exist yet and
 * `M3LCliFlowStepOutcome` is not yet exported from `src/flow/types.ts`, so the
 * imports below fail to resolve. That is the expected failure for this phase.
 */
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import * as runEnvelopeModule from "../src/run/envelope.js";

/**
 * The real `run/envelope` module's type, named once so neither the `vi.mock`
 * factory nor the `importActual` below needs an inline `typeof import(...)`
 * annotation (banned by `@typescript-eslint/consistent-type-imports`).
 */
type RunEnvelopeModule = typeof runEnvelopeModule;

vi.mock("../src/run/envelope.js", async (importOriginal) => {
  const actual = await importOriginal<RunEnvelopeModule>();
  return { ...actual, buildRunEnvelope: vi.fn(actual.buildRunEnvelope) };
});

import type {
  M3LCliExitCodeName,
  M3LCliRunEnvelope,
  M3LCliRunEnvelopeInput,
  M3LCliRunReportLookup,
  M3LCliRunReportUnavailableReason,
} from "../src/run/envelope.js";
import { buildFlowEnvelope, formatFlowEnvelope } from "../src/flow/envelope.js";
import type {
  M3LCliFlowEnvelope,
  M3LCliFlowEnvelopeInput,
  M3LCliFlowStepEnvelope,
} from "../src/flow/envelope.js";
import type { M3LCliFlowRunResult } from "../src/flow/run.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowRunStatus,
  M3LCliFlowStepOutcome,
} from "../src/flow/types.js";

const actualRunEnvelope = await vi.importActual<RunEnvelopeModule>(
  "../src/run/envelope.js",
);

const buildRunEnvelopeMock = vi.mocked(runEnvelopeModule.buildRunEnvelope);

beforeEach(() => {
  // `mockReset` clears both history and implementation; the real builder is
  // reinstated explicitly so every test starts from the same known state
  // (a bare `mockReset` would leave a mock returning `undefined`, and a bare
  // `mockClear` would let one test's `mockReturnValue` leak into the next).
  buildRunEnvelopeMock.mockReset();
  buildRunEnvelopeMock.mockImplementation(actualRunEnvelope.buildRunEnvelope);
});

const RUN_STARTED = new Date("2026-09-01T10:00:00.000Z");
const RUN_FINISHED = new Date("2026-09-01T10:00:12.500Z");

/** The default step's own window — deliberately NARROWER than the run's. */
const STEP_STARTED = new Date("2026-09-01T10:00:00.000Z");
const STEP_FINISHED = new Date("2026-09-01T10:00:04.000Z");

/**
 * The `"found"` lookup the envelope must RECONSTRUCT for a step execution that
 * located a report. The four timeline/recovery scalars are always `null`:
 * `M3LCliFlowStepOutcome` carries the report's `outcome` and path but not its
 * counts, and the envelope must degrade them rather than fabricate them.
 */
function reconstructedFoundLookup(
  reportPath: string,
  outcome: M3LCliRunEnvelope["outcome"] = "success",
): M3LCliRunReportLookup {
  return {
    status: "found",
    reportPath,
    summary: {
      outcome,
      timelineCount: null,
      timelineSourceCount: null,
      recoveryTotal: null,
      retryAttempts: null,
    },
  };
}

/** One per-execution outcome fixture, overridable per test. */
function stepOutcome(
  overrides: Partial<M3LCliFlowStepOutcome> = {},
): M3LCliFlowStepOutcome {
  return {
    stepId: "dump",
    script: "sqs-etl",
    attempt: 1,
    exitCode: 0,
    outcome: "success",
    reportPath: "/workspace/data/output/dump/run-report.json",
    branch: "continue",
    startedAt: STEP_STARTED,
    finishedAt: STEP_FINISHED,
    reportUnavailable: null,
    ...overrides,
  };
}

/** A run result fixture, overridable per test. */
function runResult(
  overrides: Partial<M3LCliFlowRunResult> = {},
): M3LCliFlowRunResult {
  return {
    flowName: "dlq-reconcile",
    status: "completed",
    exitCode: 0,
    startedAt: RUN_STARTED,
    finishedAt: RUN_FINISHED,
    stepExecutionCount: 2,
    haltingStepId: "republish",
    resumeStepId: null,
    stepExecutions: [stepOutcome()],
    ...overrides,
  };
}

/** A full envelope input fixture, overridable per test. */
function envelopeInput(
  overrides: Partial<M3LCliFlowEnvelopeInput> = {},
): M3LCliFlowEnvelopeInput {
  return {
    runId: "5c9f0b6a-1d2e-4f30-9a8b-7c6d5e4f3a2b",
    definitionHash: "a".repeat(64),
    dryRun: false,
    result: runResult(),
    ...overrides,
  };
}

/** The input every `buildRunEnvelope` call was made with, in call order. */
function runEnvelopeInputs(): readonly M3LCliRunEnvelopeInput[] {
  const inputs: M3LCliRunEnvelopeInput[] = [];
  for (const call of buildRunEnvelopeMock.mock.calls) {
    inputs.push(call[0]);
  }
  return inputs;
}

describe("buildFlowEnvelope — composition over re-derivation", () => {
  test("calls buildRunEnvelope exactly once per step execution", () => {
    buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({ stepId: "dump" }),
            stepOutcome({ stepId: "reshape", script: "json-etl" }),
            stepOutcome({ stepId: "dump", attempt: 2 }),
          ],
        }),
      }),
    );

    expect(buildRunEnvelopeMock).toHaveBeenCalledTimes(3);
  });

  test("calls buildRunEnvelope with that step's OWN observed values, not the flow's", () => {
    const stepStarted = new Date("2026-09-01T10:00:05.000Z");
    const stepFinished = new Date("2026-09-01T10:00:09.250Z");
    const reportPath = "/workspace/data/output/reshape/run-report.json";

    buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              stepId: "reshape",
              script: "json-etl",
              startedAt: stepStarted,
              finishedAt: stepFinished,
              exitCode: 4,
              outcome: "failure",
              reportPath,
            }),
          ],
        }),
      }),
    );

    expect(runEnvelopeInputs()).toEqual([
      {
        scriptName: "json-etl",
        startedAt: stepStarted,
        finishedAt: stepFinished,
        exitCode: 4,
        lookup: reconstructedFoundLookup(reportPath, "failure"),
      },
    ]);
  });

  test("two steps with DIFFERENT windows get TWO different nested windows and durations", () => {
    /*
     * The defect this pins shut. Before the stage-B split, `flow/run.ts`
     * discarded each step's observed window, so the command had nothing to
     * supply but the RUN's own window and every nested envelope reported the
     * whole run's `durationMs`. Two disjoint step windows — neither equal to
     * the run's 12.5s — make that failure mode visible; a single-step fixture
     * would not.
     */
    const firstStarted = new Date("2026-09-01T10:00:00.000Z");
    const firstFinished = new Date("2026-09-01T10:00:01.500Z");
    const secondStarted = new Date("2026-09-01T10:00:06.000Z");
    const secondFinished = new Date("2026-09-01T10:00:12.500Z");

    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              stepId: "dump",
              startedAt: firstStarted,
              finishedAt: firstFinished,
            }),
            stepOutcome({
              stepId: "republish",
              script: "json-etl",
              startedAt: secondStarted,
              finishedAt: secondFinished,
            }),
          ],
        }),
      }),
    );

    const windows: [string, string, number][] = [];
    for (const entry of envelope.steps) {
      windows.push([
        entry.run.startedAt,
        entry.run.finishedAt,
        entry.run.durationMs,
      ]);
    }
    expect(windows).toEqual([
      ["2026-09-01T10:00:00.000Z", "2026-09-01T10:00:01.500Z", 1500],
      ["2026-09-01T10:00:06.000Z", "2026-09-01T10:00:12.500Z", 6500],
    ]);
    // Neither nested duration may be the RUN's own 12.5s...
    expect(envelope.durationMs).toBe(12_500);
    expect(windows[0]?.[2]).not.toBe(envelope.durationMs);
    expect(windows[1]?.[2]).not.toBe(envelope.durationMs);
    // ...and the two must not collapse onto one another.
    expect(windows[0]).not.toEqual(windows[1]);
  });

  test("two attempts of the same step id keep their own distinct nested windows", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              attempt: 1,
              startedAt: new Date("2026-09-01T10:00:00.000Z"),
              finishedAt: new Date("2026-09-01T10:00:02.000Z"),
              branch: { goto: "dump" },
            }),
            stepOutcome({
              attempt: 2,
              startedAt: new Date("2026-09-01T10:00:08.000Z"),
              finishedAt: new Date("2026-09-01T10:00:11.000Z"),
              branch: "stop",
            }),
          ],
        }),
      }),
    );

    expect(envelope.steps[0]?.run.durationMs).toBe(2000);
    expect(envelope.steps[1]?.run.durationMs).toBe(3000);
    expect(envelope.steps[0]?.run.startedAt).not.toBe(
      envelope.steps[1]?.run.startedAt,
    );
  });

  test("nests exactly what buildRunEnvelope returned, unmodified", () => {
    const stub: M3LCliRunEnvelope = {
      kind: "m3l.run.result",
      schemaVersion: 1,
      script: "sentinel-script",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      exitCodeName: "SUCCESS",
      outcome: "partial",
      reportPath: "/sentinel/run-report.json",
      reportUnavailable: null,
      timelineCount: 7,
      timelineSourceCount: 3,
      recoveryTotal: 2,
      retryAttempts: 1,
    };
    buildRunEnvelopeMock.mockReturnValue(stub);

    const envelope = buildFlowEnvelope(envelopeInput());

    expect(envelope.steps).toHaveLength(1);
    expect(envelope.steps[0]?.run).toStrictEqual(stub);
  });

  test("copies the deciding step's exit-code NAME from the composed nested envelope", () => {
    // `EXTERNAL` is a registered ADR-0035 code; the deciding step is the LAST
    // step execution, matching `flow/run.ts`'s own "last executed step decides".
    const external = Core.M3L_EXIT_CODES.EXTERNAL;

    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          status: "failed",
          exitCode: external,
          stepExecutions: [
            stepOutcome({ stepId: "dump", exitCode: 0 }),
            stepOutcome({ stepId: "republish", exitCode: external }),
          ],
        }),
      }),
    );

    expect(envelope.exitCode).toBe(external);
    expect(envelope.exitCodeName).toBe("EXTERNAL");
    expect(envelope.steps[1]?.run.exitCodeName).toBe("EXTERNAL");
  });

  test("exitCodeName is null for an unregistered deciding exit code, never guessed", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          status: "failed",
          exitCode: 137,
          stepExecutions: [stepOutcome({ stepId: "republish", exitCode: 137 })],
        }),
      }),
    );

    expect(envelope.exitCode).toBe(137);
    expect(envelope.exitCodeName).toBeNull();
  });

  test("exitCodeName is null when there is no deciding step at all", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          status: "loop-guard-exceeded",
          exitCode: Core.M3L_EXIT_CODES.CONFIG_USAGE,
          haltingStepId: "retry",
          resumeStepId: "retry",
          stepExecutionCount: 50,
          stepExecutions: [],
        }),
      }),
    );

    expect(envelope.steps).toEqual([]);
    // No nested envelope exists to copy a name from, and the flow envelope
    // must not fall back to its own reverse lookup of `exitCode`.
    expect(envelope.exitCodeName).toBeNull();
    expect(buildRunEnvelopeMock).not.toHaveBeenCalled();
  });

  test("exitCodeName is null for a loop-guard-exceeded run even when a step already executed successfully", () => {
    // The defect this pins shut: before the fix, `exitCodeName` was copied
    // from the LAST nested envelope UNCONDITIONALLY, so a guard trip that had
    // already run a successful step reported `exitCodeName: "SUCCESS"`
    // alongside `status: "loop-guard-exceeded"` and the guard's own
    // `CONFIG_USAGE` exit code — misattributing the engine's verdict to a step
    // that exited 0. Unlike the zero-execution case above, THIS fixture gives
    // the losing branch (copy the last step's name) something to copy, so an
    // inverted implementation cannot pass by coincidence.
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          status: "loop-guard-exceeded",
          exitCode: Core.M3L_EXIT_CODES.CONFIG_USAGE,
          haltingStepId: "retry",
          resumeStepId: "retry",
          stepExecutionCount: 50,
          stepExecutions: [stepOutcome({ stepId: "retry", exitCode: 0 })],
        }),
      }),
    );

    // Asserted together so a fix that only satisfies one field cannot pass.
    expect({
      status: envelope.status,
      exitCode: envelope.exitCode,
      exitCodeName: envelope.exitCodeName,
    }).toEqual({
      status: "loop-guard-exceeded",
      exitCode: Core.M3L_EXIT_CODES.CONFIG_USAGE,
      exitCodeName: null,
    });
  });
});

describe("buildFlowEnvelope — reconstructing each step's report lookup", () => {
  test("a located report becomes a 'found' lookup with null timeline scalars", () => {
    // The outcome carries the report's path and outcome but none of its
    // counts, so the envelope must degrade those to `null` rather than invent
    // them — the same discipline `run/envelope.ts` applies to a malformed
    // report.
    buildFlowEnvelope(envelopeInput());

    expect(runEnvelopeInputs()[0]?.lookup).toEqual(
      reconstructedFoundLookup(
        "/workspace/data/output/dump/run-report.json",
        "success",
      ),
    );
  });

  test.each<[M3LCliRunReportUnavailableReason]>([
    ["output-directory-missing"],
    ["output-directory-unreadable"],
    ["no-matching-report"],
    ["report-unreadable"],
    ["report-malformed"],
  ])(
    "an unavailable report carries its OWN observed %s reason into the nested envelope",
    (reason) => {
      // Before the stage-B split this was hardcoded to `"no-matching-report"`,
      // because the loop discarded the reason `flow/step.ts` observed — so a
      // malformed or unreadable report was mislabelled in the JSON surface.
      const envelope = buildFlowEnvelope(
        envelopeInput({
          result: runResult({
            stepExecutions: [
              stepOutcome({
                reportPath: null,
                outcome: null,
                reportUnavailable: reason,
              }),
            ],
          }),
        }),
      );

      expect(runEnvelopeInputs()[0]?.lookup).toEqual({
        status: "unavailable",
        reason,
      });
      expect(envelope.steps[0]?.run.reportUnavailable).toBe(reason);
      expect(envelope.steps[0]?.run.reportPath).toBeNull();
      expect(envelope.steps[0]?.run.outcome).toBeNull();
    },
  );

  test("two steps unavailable for DIFFERENT reasons keep their own reasons", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              stepId: "dump",
              reportPath: null,
              outcome: null,
              reportUnavailable: "report-malformed",
            }),
            stepOutcome({
              stepId: "republish",
              script: "json-etl",
              reportPath: null,
              outcome: null,
              reportUnavailable: "output-directory-missing",
            }),
          ],
        }),
      }),
    );

    const reasons: (M3LCliRunReportUnavailableReason | null)[] = [];
    for (const entry of envelope.steps) {
      reasons.push(entry.run.reportUnavailable);
    }
    expect(reasons).toEqual(["report-malformed", "output-directory-missing"]);
  });

  test("a null reportPath with no observed reason degrades to 'no-matching-report'", () => {
    // The honest default, and the only one the envelope may synthesize: a step
    // with no located report and no recorded reason cannot be described more
    // precisely than "nothing matched".
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              reportPath: null,
              outcome: null,
              reportUnavailable: null,
            }),
          ],
        }),
      }),
    );

    expect(runEnvelopeInputs()[0]?.lookup).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
    expect(envelope.steps[0]?.run.reportUnavailable).toBe("no-matching-report");
  });

  test("a located report never becomes an 'unavailable' lookup, even with a stray reason", () => {
    // `reportPath` is the discriminator: a step that DID locate a report is
    // `"found"` regardless of a leftover reason, so the nested envelope keeps
    // the path instead of throwing it away.
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              reportPath: "/workspace/data/output/dump/run-report.json",
              outcome: "partial",
              reportUnavailable: "report-malformed",
            }),
          ],
        }),
      }),
    );

    expect(envelope.steps[0]?.run.reportPath).toBe(
      "/workspace/data/output/dump/run-report.json",
    );
    expect(envelope.steps[0]?.run.outcome).toBe("partial");
    expect(envelope.steps[0]?.run.reportUnavailable).toBeNull();
  });
});

describe("buildFlowEnvelope — flow-level fields", () => {
  test("carries the flow identity, window, duration and cumulative count", () => {
    const envelope = buildFlowEnvelope(envelopeInput());

    expect(envelope).toMatchObject({
      kind: "m3l.flow.result",
      schemaVersion: 1,
      flow: "dlq-reconcile",
      runId: "5c9f0b6a-1d2e-4f30-9a8b-7c6d5e4f3a2b",
      definitionHash: "a".repeat(64),
      startedAt: "2026-09-01T10:00:00.000Z",
      finishedAt: "2026-09-01T10:00:12.500Z",
      durationMs: 12_500,
      status: "completed",
      exitCode: 0,
      dryRun: false,
      stepExecutionCount: 2,
      haltingStepId: "republish",
      resumeStepId: null,
    });
  });

  test("carries the resume and halting step ids of an unfinished run", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          status: "failed",
          exitCode: 1,
          haltingStepId: "republish",
          resumeStepId: "republish",
        }),
      }),
    );

    expect(envelope.status).toBe("failed");
    expect(envelope.haltingStepId).toBe("republish");
    expect(envelope.resumeStepId).toBe("republish");
  });

  test("marks a dry run so a consumer can never mistake it for a real one", () => {
    const envelope = buildFlowEnvelope(envelopeInput({ dryRun: true }));

    expect(envelope.dryRun).toBe(true);
  });

  test.each<[M3LCliFlowRunStatus]>([
    ["completed"],
    ["stopped"],
    ["failed"],
    ["loop-guard-exceeded"],
  ])("carries the %s status verbatim", (status) => {
    const envelope = buildFlowEnvelope(
      envelopeInput({ result: runResult({ status }) }),
    );

    expect(envelope.status).toBe(status);
  });

  test("nests one entry per step execution, each with its own stepId/attempt/branch", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({ stepId: "dump", attempt: 1, branch: "continue" }),
            stepOutcome({
              stepId: "reshape",
              script: "json-etl",
              attempt: 1,
              branch: { goto: "dump" },
            }),
            stepOutcome({ stepId: "dump", attempt: 2, branch: "stop" }),
          ],
        }),
      }),
    );

    const nested: [string, string, number, M3LCliFlowStepEnvelope["branch"]][] =
      [];
    for (const entry of envelope.steps) {
      nested.push([entry.stepId, entry.script, entry.attempt, entry.branch]);
    }
    expect(nested).toEqual([
      ["dump", "sqs-etl", 1, "continue"],
      ["reshape", "json-etl", 1, { goto: "dump" }],
      ["dump", "sqs-etl", 2, "stop"],
    ]);
  });

  test("a branch with a hostile extra key is rebuilt to exactly {goto}, not copied by reference", () => {
    // Fix #3's regression: `branch` was previously `outcome.branch` copied by
    // reference, so any extra key riding along on the resolved branch value
    // reached the JSON surface verbatim. `toEqual` (never `toMatchObject`,
    // which would pass with `extra` still attached) is what makes this test
    // discriminate the fix.
    const hostileBranch = { goto: "dump", extra: 1 } as M3LCliFlowBranch;

    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [stepOutcome({ branch: hostileBranch })],
        }),
      }),
    );

    expect(envelope.steps[0]?.branch).toEqual({ goto: "dump" });
  });

  test.each(["continue", "stop"] as const)(
    "a %s branch passes through unchanged",
    (branch) => {
      const envelope = buildFlowEnvelope(
        envelopeInput({
          result: runResult({
            stepExecutions: [stepOutcome({ branch })],
          }),
        }),
      );

      expect(envelope.steps[0]?.branch).toBe(branch);
    },
  );
});

describe("buildFlowEnvelope — allowlisted scalars only (ADR-0063)", () => {
  test("the envelope's own keys are exactly the declared closed set", () => {
    const envelope = buildFlowEnvelope(envelopeInput());

    expect(Object.keys(envelope).toSorted()).toEqual(
      [
        "definitionHash",
        "dryRun",
        "durationMs",
        "exitCode",
        "exitCodeName",
        "finishedAt",
        "flow",
        "haltingStepId",
        "kind",
        "resumeStepId",
        "runId",
        "schemaVersion",
        "startedAt",
        "status",
        "steps",
        "stepExecutionCount",
      ].toSorted(),
    );
  });

  test("a nested step entry's own keys are exactly stepId/script/attempt/branch/run", () => {
    // Specifically NOT the raw `startedAt`/`finishedAt`/`reportUnavailable` of
    // the outcome it was derived from: those reach the consumer through the
    // nested `run` envelope, which is the one place ADR-0063 allowlists them.
    const envelope = buildFlowEnvelope(envelopeInput());

    expect(Object.keys(envelope.steps[0] ?? {}).toSorted()).toEqual(
      ["attempt", "branch", "run", "script", "stepId"].toSorted(),
    );
  });

  test("no raw run-report document rides along, even when the input smuggles one", () => {
    // A hostile extra key on a step outcome must not reach the envelope — which
    // it would if the builder spread the outcome instead of projecting it.
    const smuggled = {
      ...stepOutcome(),
      report: { secret: "token-abc", timeline: [{ source: "x" }] },
    } as M3LCliFlowStepOutcome;

    const serialized = formatFlowEnvelope(
      buildFlowEnvelope(
        envelopeInput({ result: runResult({ stepExecutions: [smuggled] }) }),
      ),
    );

    expect(serialized).not.toContain("token-abc");
    expect(serialized).not.toContain('timeline":[');
    expect(serialized).not.toContain('"report":');
  });
});

describe("formatFlowEnvelope", () => {
  test("emits a single line of JSON with no embedded or trailing newline", () => {
    const text = formatFlowEnvelope(
      buildFlowEnvelope(
        envelopeInput({
          result: runResult({
            stepExecutions: [
              stepOutcome({ stepId: "dump" }),
              stepOutcome({ stepId: "land" }),
            ],
          }),
        }),
      ),
    );

    expect(text).not.toContain("\n");
    expect(text.split("\n")).toHaveLength(1);
  });

  test("round-trips through JSON.parse unchanged", () => {
    const envelope = buildFlowEnvelope(envelopeInput());

    expect(JSON.parse(formatFlowEnvelope(envelope))).toEqual(envelope);
  });

  test("outcome: null survives serialization rather than being dropped", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          stepExecutions: [
            stepOutcome({
              reportPath: "/workspace/data/output/dump/run-report.json",
              outcome: null,
            }),
          ],
        }),
      }),
    );
    const text = formatFlowEnvelope(envelope);

    expect(envelope.steps[0]?.run.outcome).toBeNull();
    expect(text).toContain('"outcome":null');
  });

  test("a null haltingStepId/resumeStepId survives serialization", () => {
    const envelope = buildFlowEnvelope(
      envelopeInput({
        result: runResult({
          haltingStepId: null,
          resumeStepId: null,
          stepExecutions: [],
        }),
      }),
    );
    const text = formatFlowEnvelope(envelope);

    expect(text).toContain('"haltingStepId":null');
    expect(text).toContain('"resumeStepId":null');
  });

  test("a null exitCodeName survives serialization", () => {
    const text = formatFlowEnvelope(
      buildFlowEnvelope(
        envelopeInput({
          result: runResult({
            status: "failed",
            exitCode: 137,
            stepExecutions: [stepOutcome({ exitCode: 137 })],
          }),
        }),
      ),
    );

    expect(text).toContain('"exitCodeName":null');
  });
});

describe("flow envelope — type contract", () => {
  test("kind and schemaVersion mirror M3LCliRunEnvelope's own literal conventions", () => {
    expectTypeOf<
      M3LCliFlowEnvelope["kind"]
    >().toEqualTypeOf<"m3l.flow.result">();
    expectTypeOf<M3LCliFlowEnvelope["schemaVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<M3LCliRunEnvelope["schemaVersion"]>().toEqualTypeOf<1>();
  });

  test("exitCodeName reuses run/envelope.ts's M3LCliExitCodeName, nullable", () => {
    expectTypeOf<
      M3LCliFlowEnvelope["exitCodeName"]
    >().toEqualTypeOf<M3LCliExitCodeName | null>();
  });

  test("a nested step entry carries a full M3LCliRunEnvelope, not a re-declared shape", () => {
    expectTypeOf<
      M3LCliFlowStepEnvelope["run"]
    >().toEqualTypeOf<M3LCliRunEnvelope>();
  });

  test("the envelope's steps are the nested step entries", () => {
    expectTypeOf<M3LCliFlowEnvelope["steps"]>().toEqualTypeOf<
      readonly M3LCliFlowStepEnvelope[]
    >();
  });

  test("the input is exactly the run id, definition hash, dry-run flag and result", () => {
    // No parallel `stepRuns` array, and therefore no `M3LCliFlowStepRunInput`:
    // every nested envelope is derivable from `result.stepExecutions` alone,
    // and a second array of the same executions could only ever drift from it.
    expectTypeOf<M3LCliFlowEnvelopeInput>().toEqualTypeOf<{
      readonly runId: string;
      readonly definitionHash: string;
      readonly dryRun: boolean;
      readonly result: M3LCliFlowRunResult;
    }>();
  });

  test("the envelope input carries the run result rather than re-declaring its fields", () => {
    expectTypeOf<
      M3LCliFlowEnvelopeInput["result"]
    >().toEqualTypeOf<M3LCliFlowRunResult>();
  });

  test("the per-step observations the builder reads are the run result's own", () => {
    expectTypeOf<
      M3LCliFlowEnvelopeInput["result"]["stepExecutions"]
    >().toEqualTypeOf<readonly M3LCliFlowStepOutcome[]>();
  });

  test("formatFlowEnvelope returns a string", () => {
    expectTypeOf(formatFlowEnvelope).returns.toBeString();
  });
});
