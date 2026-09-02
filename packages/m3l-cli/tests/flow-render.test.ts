/**
 * Contract: `packages/m3l-cli/src/flow/render.ts` — the human (non-`--json`)
 * rendering for `m3l flow list` and `m3l flow run <name>` (U10 slice 3,
 * stage C).
 *
 * Pure by contract: both exports take data and RETURN lines. Nothing here
 * writes — `commands/flow.ts` owns every `context.output` call, exactly as
 * `commands/history.ts`/`commands/presets.ts` own theirs while
 * `cli/table.ts` stays a pure formatter. That is why this suite needs no
 * mocks and no `afterEach` teardown at all.
 *
 * Assertions deliberately pin the INFORMATION each rendering must carry
 * (the halting step, the guard value it hit, the dry-run marker) rather than
 * exact column widths, which `formatAlignedTable` owns and which a cosmetic
 * change may legitimately move.
 *
 * GREEN phase: `src/flow/render.ts` now exists; all tests should pass.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { formatFlowListLines, formatFlowRunLines } from "../src/flow/render.js";
import type { M3LCliFlowRenderInput } from "../src/flow/render.js";
import type { M3LCliFlowRunResult } from "../src/flow/run.js";
import type { M3LCliFlowStepOutcome } from "../src/flow/types.js";

const RUN_ID = "5c9f0b6a-1d2e-4f30-9a8b-7c6d5e4f3a2b";

/** One step execution fixture, overridable per test. */
function execution(
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
    startedAt: new Date("2026-09-01T09:00:00.000Z"),
    finishedAt: new Date("2026-09-01T09:00:04.000Z"),
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
    startedAt: new Date("2026-09-01T10:00:00.000Z"),
    finishedAt: new Date("2026-09-01T10:00:12.500Z"),
    stepExecutionCount: 2,
    haltingStepId: "republish",
    resumeStepId: null,
    stepExecutions: [
      execution(),
      execution({ stepId: "republish", branch: "stop" }),
    ],
    ...overrides,
  };
}

/** A render input fixture, overridable per test. */
function renderInput(
  overrides: Partial<M3LCliFlowRenderInput> = {},
): M3LCliFlowRenderInput {
  return {
    runId: RUN_ID,
    dryRun: false,
    maxStepExecutions: 50,
    result: runResult(),
    ...overrides,
  };
}

/** The rendered lines joined, for token-level assertions. */
function rendered(input: M3LCliFlowRenderInput): string {
  return formatFlowRunLines(input).join("\n");
}

describe("formatFlowRunLines — a completed flow", () => {
  test("names the flow, the run id, the status and the exit code", () => {
    const text = rendered(renderInput());

    expect(text).toContain("dlq-reconcile");
    expect(text).toContain(RUN_ID);
    expect(text).toContain("completed");
    expect(text).toContain("exit 0");
  });

  test("reports the observed window and the duration", () => {
    const text = rendered(renderInput());

    expect(text).toContain("2026-09-01T10:00:00.000Z");
    expect(text).toContain("2026-09-01T10:00:12.500Z");
    expect(text).toContain("12500");
  });

  test("reports the cumulative step-execution count against the guard", () => {
    const text = rendered(
      renderInput({ result: runResult({ stepExecutionCount: 7 }) }),
    );

    expect(text).toContain("7");
    expect(text).toContain("50");
  });

  test("renders one aligned table row per step execution, in order", () => {
    const lines = formatFlowRunLines(renderInput());
    const headerIndex = lines.findIndex((line) => line.startsWith("STEP"));

    expect(headerIndex).toBeGreaterThanOrEqual(0);
    const header = lines[headerIndex] ?? "";
    for (const column of [
      "STEP",
      "SCRIPT",
      "ATTEMPT",
      "EXIT",
      "OUTCOME",
      "BRANCH",
    ]) {
      expect(header).toContain(column);
    }

    const rows = lines.slice(headerIndex + 1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("dump");
    expect(rows[0]).toContain("sqs-etl");
    expect(rows[1]).toContain("republish");
  });

  test("every returned line is a single newline-free line", () => {
    for (const line of formatFlowRunLines(renderInput())) {
      expect(line).not.toContain("\n");
    }
  });

  test("says so rather than rendering an empty table when no step ran", () => {
    const lines = formatFlowRunLines(
      renderInput({
        result: runResult({
          stepExecutionCount: 0,
          haltingStepId: null,
          stepExecutions: [],
        }),
      }),
    );

    expect(lines.join("\n")).toContain("no step ran");
    expect(lines.some((line) => line.startsWith("STEP"))).toBe(false);
  });
});

describe("formatFlowRunLines — a failed flow", () => {
  test("names the halting step and marks the run as halted", () => {
    const text = rendered(
      renderInput({
        result: runResult({
          status: "failed",
          exitCode: 3,
          haltingStepId: "republish",
          resumeStepId: "republish",
          stepExecutions: [
            execution(),
            execution({
              stepId: "republish",
              exitCode: 3,
              outcome: "failure",
              branch: "stop",
            }),
          ],
        }),
      }),
    );

    expect(text).toContain("failed");
    expect(text).toContain("exit 3");
    expect(text).toContain("halted");
    expect(text).toContain("republish");
  });

  test("names the step a follow-up run would resume from", () => {
    const text = rendered(
      renderInput({
        result: runResult({
          status: "failed",
          exitCode: 1,
          haltingStepId: "reshape",
          resumeStepId: "reshape",
        }),
      }),
    );

    expect(text).toContain("resume");
    expect(text).toContain("reshape");
  });

  test("propagates an unregistered exit code verbatim, never clamped", () => {
    const text = rendered(
      renderInput({
        result: runResult({ status: "failed", exitCode: 137 }),
      }),
    );

    expect(text).toContain("exit 137");
  });
});

describe("formatFlowRunLines — a stopped flow", () => {
  test("distinguishes a deliberate stop from a completion, at exit 0", () => {
    const text = rendered(
      renderInput({
        result: runResult({
          status: "stopped",
          exitCode: 0,
          haltingStepId: "dump",
          stepExecutions: [execution({ branch: "stop" })],
        }),
      }),
    );

    expect(text).toContain("stopped");
    expect(text).toContain("exit 0");
    expect(text).toContain("dump");
    expect(text).not.toContain("completed");
  });
});

describe("formatFlowRunLines — a loop-guard-exceeded flow", () => {
  test("states the guard value it hit, not just that a guard tripped", () => {
    const text = rendered(
      renderInput({
        maxStepExecutions: 12,
        result: runResult({
          status: "loop-guard-exceeded",
          exitCode: 2,
          stepExecutionCount: 12,
          haltingStepId: "retry",
          resumeStepId: "retry",
        }),
      }),
    );

    expect(text).toContain("loop-guard-exceeded");
    expect(text).toContain("12");
    // An operator must be able to raise the right knob from this line alone.
    expect(text).toContain("maxStepExecutions");
    expect(text).toContain("retry");
  });
});

describe("formatFlowRunLines — the dry-run marker", () => {
  test("visibly marks a dry run in upper case, so it cannot be skimmed past", () => {
    const text = rendered(renderInput({ dryRun: true }));

    expect(text).toContain("DRY RUN");
  });

  test("carries no dry-run marker for a real run (the guard that makes the marker meaningful)", () => {
    const text = rendered(renderInput({ dryRun: false }));

    expect(text.toUpperCase()).not.toContain("DRY RUN");
    expect(text.toUpperCase()).not.toContain("DRY-RUN");
  });
});

describe("formatFlowRunLines — per-step cell rendering", () => {
  test("renders a { goto } branch as its target step id", () => {
    const text = rendered(
      renderInput({
        result: runResult({
          stepExecutions: [execution({ branch: { goto: "dump" } })],
        }),
      }),
    );

    expect(text).toContain("goto dump");
  });

  test.each<[string, "continue" | "stop"]>([
    ["continue", "continue"],
    ["stop", "stop"],
  ])("renders the %s branch literally", (_label, branch) => {
    const text = rendered(
      renderInput({
        result: runResult({ stepExecutions: [execution({ branch })] }),
      }),
    );

    expect(text).toContain(branch);
  });

  test("renders a null outcome as a placeholder, never the string 'null'", () => {
    const lines = formatFlowRunLines(
      renderInput({
        result: runResult({
          stepExecutions: [execution({ outcome: null, reportPath: null })],
        }),
      }),
    );
    const headerIndex = lines.findIndex((line) => line.startsWith("STEP"));
    const row = lines[headerIndex + 1] ?? "";

    expect(row).not.toContain("null");
    expect(row).toContain("-");
  });

  test("renders a revisited step's attempt number", () => {
    const lines = formatFlowRunLines(
      renderInput({
        result: runResult({
          stepExecutionCount: 3,
          stepExecutions: [
            execution({ stepId: "retry", attempt: 1 }),
            execution({ stepId: "retry", attempt: 2 }),
            execution({ stepId: "retry", attempt: 3, branch: "stop" }),
          ],
        }),
      }),
    );
    const headerIndex = lines.findIndex((line) => line.startsWith("STEP"));
    const rows = lines.slice(headerIndex + 1);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("retry");
    expect(rows[2]).toContain("3");
  });

  test("never renders a step's reportPath — the table is a summary, not a path dump", () => {
    // A `run-report.json` path is already in the `--json` envelope and in the
    // run record; repeating it here would push every row past a terminal
    // width for no operator benefit.
    const text = rendered(renderInput());

    expect(text).not.toContain("/workspace/data/output");
  });
});

describe("formatFlowListLines", () => {
  test("renders one line per flow name, in the given order", () => {
    const lines = formatFlowListLines(["dlq-reconcile", "nightly-export"]);

    expect(lines.join("\n")).toContain("dlq-reconcile");
    expect(lines.join("\n")).toContain("nightly-export");
    expect(
      lines.findIndex((line) => line.includes("dlq-reconcile")),
    ).toBeLessThan(lines.findIndex((line) => line.includes("nightly-export")));
  });

  test("says so explicitly rather than returning nothing for an empty flows directory", () => {
    const lines = formatFlowListLines([]);

    expect(lines).not.toEqual([]);
    expect(lines.join("\n")).toContain("no flows found");
  });

  test("every returned line is a single newline-free line", () => {
    for (const line of formatFlowListLines(["a-flow", "b-flow"])) {
      expect(line).not.toContain("\n");
    }
  });
});

describe("flow render — type contract", () => {
  test("both exports return readonly string arrays", () => {
    expectTypeOf(formatFlowRunLines).returns.toEqualTypeOf<readonly string[]>();
    expectTypeOf(formatFlowListLines).returns.toEqualTypeOf<
      readonly string[]
    >();
  });

  test("the render input carries the run result rather than re-declaring its fields", () => {
    expectTypeOf<
      M3LCliFlowRenderInput["result"]
    >().toEqualTypeOf<M3LCliFlowRunResult>();
  });

  test("the render input takes the guard value as a number, not the whole definition", () => {
    expectTypeOf<
      M3LCliFlowRenderInput["maxStepExecutions"]
    >().toEqualTypeOf<number>();
  });

  test("formatFlowListLines takes the flow names, not a workspace root", () => {
    expectTypeOf(formatFlowListLines)
      .parameter(0)
      .toEqualTypeOf<readonly string[]>();
  });
});
