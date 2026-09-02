/**
 * Tests for src/flow/run.ts — the step loop: ordered execution from the first
 * step (or an injected resume-from step id), branch following via
 * `classifyStepBranch`, the cumulative step-execution loop guard, and the
 * failing step's own exit code propagated unchanged
 * (`docs/plans/2026-09-01-orchestration-engine.md` §_Branching algebra_,
 * §_Resume semantics_).
 *
 * `flow/step.js` is mocked at its module seam, so this file drives the loop by
 * scripting per-step exit codes and never spawns or imports anything real.
 * `flow/classify.js` is NOT mocked — the loop's branch decisions are asserted
 * through the real classification table, since a mocked classifier would let
 * the loop pass under an inverted algebra.
 *
 * Stage-B contract revision (stage-C review): the loop no longer DISCARDS the
 * `startedAt`/`finishedAt`/`reportUnavailable` that `flow/step.ts` observes per
 * execution. `M3LCliFlowRunResult.stepExecutions` is now a
 * `readonly M3LCliFlowStepOutcome[]` — the seven persisted fields PLUS those
 * three — while `M3LCliFlowStepExecution` keeps exactly its seven JSON-safe
 * fields as the shape `flow/record.ts` persists. Without the per-step window
 * here, `flow/envelope.ts` has nothing to hand `buildRunEnvelope` but the whole
 * run's window, so every nested step envelope would report the ENTIRE run's
 * `durationMs`.
 *
 * RED phase: `M3LCliFlowStepOutcome` does not exist in `src/flow/types.ts` yet
 * and the loop still drops the three observed fields, so the imports and the
 * per-step-window assertions below fail. That is the expected failure.
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

vi.mock("../src/flow/step.js", () => ({ executeFlowStep: vi.fn() }));

import { runFlow } from "../src/flow/run.js";
import type {
  M3LCliFlowRunOptions,
  M3LCliFlowRunResult,
} from "../src/flow/run.js";
import { executeFlowStep } from "../src/flow/step.js";
import type {
  M3LCliFlowStepContext,
  M3LCliFlowStepResult,
} from "../src/flow/step.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowDefinition,
  M3LCliFlowRunStatus,
  M3LCliFlowStep,
  M3LCliFlowStepExecution,
  M3LCliFlowStepOutcome,
} from "../src/flow/types.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliOutput } from "../src/cli/output.js";
import type {
  M3LCliRunOutcome,
  M3LCliRunReportUnavailableReason,
} from "../src/run/envelope.js";

const executeFlowStepMock = vi.mocked(executeFlowStep);

afterEach(() => {
  executeFlowStepMock.mockReset();
});

const OUTPUT_DIR = "/workspace/data/output";

function createOutput(): M3LCliOutput {
  return {
    colorEnabled: false,
    info: vi.fn(),
    error: vi.fn(),
    heading: vi.fn(),
  };
}

function buildContext(): M3LCliFlowStepContext {
  return {
    output: createOutput(),
    outputDirPath: OUTPUT_DIR,
    scriptDirectories: new Map([
      ["sqs-etl", "/workspace/scripts/sqs-etl"],
      ["json-etl", "/workspace/scripts/json-etl"],
    ]),
    env: { PATH: "/usr/bin" },
    envFile: { kind: "auto" },
    jsonOutput: false,
  };
}

function buildStep(
  id: string,
  overrides: Partial<M3LCliFlowStep> = {},
): M3LCliFlowStep {
  return {
    id,
    script: "sqs-etl",
    parameters: {},
    execution: "spawn",
    onSuccess: "continue",
    onFailure: "stop",
    onPartial: "stop",
    ...overrides,
  };
}

function buildDefinition(
  steps: readonly M3LCliFlowStep[],
  maxStepExecutions = 50,
): M3LCliFlowDefinition {
  return { name: "dlq-reconcile", maxStepExecutions, steps };
}

const T0 = new Date("2026-09-01T09:00:00.000Z");
const T1 = new Date("2026-09-01T09:10:00.000Z");

function scriptedNow(...dates: readonly Date[]): () => Date {
  const queue = [...dates];
  return (): Date => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("scriptedNow: called more times than dates provided");
    }
    return next;
  };
}

/**
 * What one scripted `executeFlowStep` invocation resolves. The window and the
 * unavailable reason are per-step on purpose: `flow/step.ts` reads the clock
 * INSIDE each execution, and the loop's job is to carry each step's own
 * observation forward rather than flatten them all onto the run's window.
 */
interface ScriptedStep {
  readonly exitCode: number;
  readonly outcome?: "partial";
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly reportPath?: string | null;
  readonly reportUnavailable?: M3LCliRunReportUnavailableReason | null;
}

/**
 * Scripts `executeFlowStep` to resolve one result per invocation, taking the
 * exit code (and optional outcome, window, report path and unavailable
 * reason) from `plan` keyed by step id. A step id absent from `plan` resolves
 * exit code 0 over the shared `T0`–`T1` window.
 */
function scriptSteps(plan: Readonly<Record<string, ScriptedStep>>): void {
  executeFlowStepMock.mockImplementation(
    (
      _context: M3LCliFlowStepContext,
      step: M3LCliFlowStep,
      flowDryRun: boolean,
    ): Promise<M3LCliFlowStepResult> => {
      const scripted: ScriptedStep = plan[step.id] ?? { exitCode: 0 };
      const result: M3LCliFlowStepResult = {
        stepId: step.id,
        script: step.script,
        execution: step.execution === "in-process" ? "in-process" : "spawn",
        dryRun: flowDryRun || step.dryRun === true,
        startedAt: scripted.startedAt ?? T0,
        finishedAt: scripted.finishedAt ?? T1,
        exitCode: scripted.exitCode,
        outcome: scripted.outcome ?? null,
        reportPath:
          scripted.reportPath === undefined
            ? `/workspace/data/output/${step.id}/run-report.json`
            : scripted.reportPath,
        reportUnavailable: scripted.reportUnavailable ?? null,
      };
      return Promise.resolve(result);
    },
  );
}

/**
 * The step ids `executeFlowStep` was invoked with, in invocation order.
 *
 * Deliberately a `for..of` rather than `.map`: in the RED phase
 * `executeFlowStep` has no type, so a callback parameter here would be an
 * implicit `any`.
 */
function executedStepIds(): readonly string[] {
  const ids: string[] = [];
  for (const call of executeFlowStepMock.mock.calls) {
    const step: M3LCliFlowStep = call[1];
    ids.push(step.id);
  }
  return ids;
}

function defaultOptions(
  overrides: Partial<M3LCliFlowRunOptions> = {},
): M3LCliFlowRunOptions {
  return { now: scriptedNow(T0, T1), ...overrides };
}

describe("runFlow — ordered execution", () => {
  test("runs every step in declaration order and completes", async () => {
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump"),
      buildStep("reshape", { script: "json-etl" }),
      buildStep("republish"),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump", "reshape", "republish"]);
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(Core.M3L_EXIT_CODES.SUCCESS);
    expect(result.flowName).toBe("dlq-reconcile");
    expect(result.stepExecutionCount).toBe(3);
  });

  test("'continue' on the LAST step ends the flow normally", async () => {
    // Falling off the end of the declared list is a normal completion, not a
    // guard trip and not an error.
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump", { onSuccess: "continue" }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump"]);
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.haltingStepId).toBe("dump");
    expect(result.resumeStepId).toBeNull();
  });

  test("'stop' after a successful step halts with status 'stopped' and exit 0", async () => {
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump", { onSuccess: "stop" }),
      buildStep("never"),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump"]);
    expect(result.status).toBe("stopped");
    expect(result.exitCode).toBe(0);
    expect(result.resumeStepId).toBeNull();
  });

  test("records the run's own observed window from the now seam", async () => {
    scriptSteps({});

    const result = await runFlow(
      buildContext(),
      buildDefinition([buildStep("dump")]),
      { now: scriptedNow(T0, T1) },
    );

    expect(result.startedAt).toBe(T0);
    expect(result.finishedAt).toBe(T1);
  });
});

describe("runFlow — goto branching", () => {
  test("a forward goto skips the intervening steps", async () => {
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump", { onSuccess: { goto: "republish" } }),
      buildStep("skipped"),
      buildStep("republish", { onSuccess: "stop" }),
    ]);

    await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump", "republish"]);
  });

  test("a backward goto re-executes an earlier step", async () => {
    scriptSteps({});
    let reshapeRuns = 0;
    executeFlowStepMock.mockImplementation(
      (
        _context: M3LCliFlowStepContext,
        step: M3LCliFlowStep,
      ): Promise<M3LCliFlowStepResult> => {
        if (step.id === "reshape") reshapeRuns += 1;
        const result: M3LCliFlowStepResult = {
          stepId: step.id,
          script: step.script,
          execution: "spawn",
          dryRun: false,
          startedAt: T0,
          finishedAt: T1,
          // The second `reshape` run succeeds, breaking the retry loop.
          exitCode: step.id === "reshape" && reshapeRuns === 1 ? 3 : 0,
          outcome: null,
          reportPath: null,
          reportUnavailable: "no-matching-report",
        };
        return Promise.resolve(result);
      },
    );
    const definition = buildDefinition([
      buildStep("dump"),
      buildStep("reshape", { onFailure: { goto: "dump" } }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump", "reshape", "dump", "reshape"]);
    expect(result.status).toBe("completed");
    expect(result.stepExecutionCount).toBe(4);
  });

  test("a self-referential goto re-executes the same step", async () => {
    let runs = 0;
    executeFlowStepMock.mockImplementation(
      (
        _context: M3LCliFlowStepContext,
        step: M3LCliFlowStep,
      ): Promise<M3LCliFlowStepResult> => {
        runs += 1;
        const result: M3LCliFlowStepResult = {
          stepId: step.id,
          script: step.script,
          execution: "spawn",
          dryRun: false,
          startedAt: T0,
          finishedAt: T1,
          exitCode: runs < 3 ? 3 : 0,
          outcome: null,
          reportPath: null,
          reportUnavailable: "no-matching-report",
        };
        return Promise.resolve(result);
      },
    );
    const definition = buildDefinition([
      buildStep("retry", { onFailure: { goto: "retry" }, onSuccess: "stop" }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["retry", "retry", "retry"]);
    expect(result.status).toBe("stopped");
    expect(result.stepExecutionCount).toBe(3);
  });

  test("rejects with ERR_CLI_FLOW_INVALID when a goto names an undeclared step", async () => {
    // Stage A's validator guarantees every `goto` resolves, but the DEFINITION
    // TYPE admits a hand-built literal with a dangling target; halting silently
    // would misreport that as a normal completion.
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump", { onSuccess: { goto: "nowhere" } }),
    ]);

    let thrown: unknown;
    try {
      await runFlow(buildContext(), definition, defaultOptions());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_FLOW_INVALID");
  });
});

describe("runFlow — branch selection follows the real classification table", () => {
  test("a partial step (exit 6) takes its onPartial arm", async () => {
    scriptSteps({ dump: { exitCode: Core.M3L_EXIT_CODES.PARTIAL } });
    const definition = buildDefinition([
      buildStep("dump", {
        onSuccess: { goto: "wrong" },
        onFailure: { goto: "wrong" },
        onPartial: { goto: "reconcile" },
      }),
      buildStep("wrong"),
      buildStep("reconcile", { onSuccess: "stop" }),
    ]);

    await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump", "reconcile"]);
  });

  test("a failing step takes its onFailure arm", async () => {
    scriptSteps({ dump: { exitCode: Core.M3L_EXIT_CODES.EXTERNAL } });
    const definition = buildDefinition([
      buildStep("dump", {
        onSuccess: { goto: "wrong" },
        onFailure: { goto: "handle" },
      }),
      buildStep("wrong"),
      buildStep("handle", { onSuccess: "stop" }),
    ]);

    await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump", "handle"]);
  });
});

describe("runFlow — exit code propagation", () => {
  test("a step exiting 4 yields flow exit 4, unclamped and unremapped", async () => {
    scriptSteps({ dump: { exitCode: Core.M3L_EXIT_CODES.LIBRARY } });
    const definition = buildDefinition([buildStep("dump")]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.exitCode).toBe(4);
    expect(result.status).toBe("failed");
    expect(result.haltingStepId).toBe("dump");
    expect(result.resumeStepId).toBe("dump");
  });

  test("a signal-derived 137 propagates unchanged", async () => {
    scriptSteps({ dump: { exitCode: 137 } });
    const definition = buildDefinition([buildStep("dump")]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.exitCode).toBe(137);
    expect(result.status).toBe("failed");
  });

  test("a partial halting step propagates exit 6", async () => {
    scriptSteps({ dump: { exitCode: Core.M3L_EXIT_CODES.PARTIAL } });
    const definition = buildDefinition([
      buildStep("dump", { onPartial: "stop" }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.exitCode).toBe(6);
    expect(result.status).toBe("failed");
  });

  test("the DECIDING (last executed) step owns the exit code, not the first failure", async () => {
    // With `onFailure: continue`, an earlier failure is deliberately absorbed
    // by the definition's author; the flow's exit code is the halting step's.
    scriptSteps({ dump: { exitCode: 3 } });
    const definition = buildDefinition([
      buildStep("dump", { onFailure: "continue" }),
      buildStep("reshape"),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump", "reshape"]);
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
  });
});

describe("runFlow — the loop guard", () => {
  test("admits exactly maxStepExecutions executions then halts with CONFIG_USAGE", async () => {
    scriptSteps({ retry: { exitCode: 3 } });
    const definition = buildDefinition(
      [buildStep("retry", { onFailure: { goto: "retry" } })],
      3,
    );

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["retry", "retry", "retry"]);
    expect(result.status).toBe("loop-guard-exceeded");
    expect(result.exitCode).toBe(Core.M3L_EXIT_CODES.CONFIG_USAGE);
    expect(result.stepExecutionCount).toBe(3);
    expect(result.haltingStepId).toBe("retry");
    expect(result.resumeStepId).toBe("retry");
  });

  test("the guard trips on a two-step goto cycle, counting cumulatively across revisits", async () => {
    scriptSteps({});
    const definition = buildDefinition(
      [
        buildStep("a", { onSuccess: { goto: "b" } }),
        buildStep("b", { onSuccess: { goto: "a" } }),
      ],
      5,
    );

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["a", "b", "a", "b", "a"]);
    expect(result.status).toBe("loop-guard-exceeded");
    expect(result.stepExecutionCount).toBe(5);
  });

  test("the count is cumulative across revisits of the same step", async () => {
    scriptSteps({ a: { exitCode: 0 } });
    const definition = buildDefinition(
      [buildStep("a", { onSuccess: { goto: "a" } })],
      4,
    );

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.stepExecutionCount).toBe(4);
    expect(executeFlowStepMock).toHaveBeenCalledTimes(4);
  });

  test("an honest linear flow shorter than the guard never trips it", async () => {
    scriptSteps({});
    const definition = buildDefinition([buildStep("a"), buildStep("b")], 2);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.status).toBe("completed");
    expect(result.stepExecutionCount).toBe(2);
  });
});

describe("runFlow — resume", () => {
  test("resumeFromStepId starts execution at that step, skipping its predecessors", async () => {
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump"),
      buildStep("reshape"),
      buildStep("land", { onSuccess: "stop" }),
    ]);

    const result = await runFlow(
      buildContext(),
      definition,
      defaultOptions({ resumeFromStepId: "reshape" }),
    );

    expect(executedStepIds()).toEqual(["reshape", "land"]);
    expect(result.stepExecutionCount).toBe(2);
  });

  test("a resume seeds the step-execution count so the guard is NOT silently reset", async () => {
    // The whole point of persisting a cumulative count: re-entering the engine
    // with 2 executions already spent and a guard of 3 must admit exactly one
    // more execution, not three.
    scriptSteps({ retry: { exitCode: 3 } });
    const definition = buildDefinition(
      [buildStep("retry", { onFailure: { goto: "retry" } })],
      3,
    );

    const result = await runFlow(
      buildContext(),
      definition,
      defaultOptions({
        resumeFromStepId: "retry",
        stepExecutionCount: 2,
      }),
    );

    expect(executeFlowStepMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("loop-guard-exceeded");
    expect(result.exitCode).toBe(Core.M3L_EXIT_CODES.CONFIG_USAGE);
    // Cumulative, not per-run: the seeded 2 plus this run's 1.
    expect(result.stepExecutionCount).toBe(3);
    // ...while `stepExecutions` holds only THIS run's executions.
    expect(result.stepExecutions).toHaveLength(1);
  });

  test("a seeded count already at the guard admits no execution at all", async () => {
    scriptSteps({});
    const definition = buildDefinition([buildStep("retry")], 3);

    const result = await runFlow(
      buildContext(),
      definition,
      defaultOptions({ resumeFromStepId: "retry", stepExecutionCount: 3 }),
    );

    expect(executeFlowStepMock).not.toHaveBeenCalled();
    expect(result.status).toBe("loop-guard-exceeded");
    expect(result.stepExecutions).toEqual([]);
    expect(result.stepExecutionCount).toBe(3);
  });

  test("rejects an unknown resume-from step id with ERR_CLI_UNKNOWN_FLOW_STEP and suggestions", async () => {
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump"),
      buildStep("reshape"),
    ]);

    let thrown: unknown;
    try {
      await runFlow(
        buildContext(),
        definition,
        defaultOptions({ resumeFromStepId: "reshpe" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_FLOW_STEP");
    expect((thrown as M3LCliError).suggestions).toContain("reshape");
    expect(executeFlowStepMock).not.toHaveBeenCalled();
  });

  test("omitting resumeFromStepId starts at the first declared step", async () => {
    scriptSteps({});
    const definition = buildDefinition([
      buildStep("dump", { onSuccess: "stop" }),
      buildStep("reshape"),
    ]);

    await runFlow(buildContext(), definition, defaultOptions());

    expect(executedStepIds()).toEqual(["dump"]);
  });
});

describe("runFlow — per-step-execution records", () => {
  test("records one entry per execution with a 1-based per-step attempt and the branch taken", async () => {
    let runs = 0;
    executeFlowStepMock.mockImplementation(
      (
        _context: M3LCliFlowStepContext,
        step: M3LCliFlowStep,
      ): Promise<M3LCliFlowStepResult> => {
        runs += 1;
        const result: M3LCliFlowStepResult = {
          stepId: step.id,
          script: step.script,
          execution: "spawn",
          dryRun: false,
          startedAt: T0,
          finishedAt: T1,
          exitCode: runs === 1 ? 3 : 0,
          outcome: runs === 1 ? null : "success",
          reportPath: `/workspace/data/output/${String(runs)}/run-report.json`,
          reportUnavailable: null,
        };
        return Promise.resolve(result);
      },
    );
    const retryBranch: M3LCliFlowBranch = { goto: "dump" };
    const definition = buildDefinition([
      buildStep("dump", {
        script: "sqs-etl",
        onFailure: retryBranch,
        onSuccess: "stop",
      }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.stepExecutions).toEqual([
      {
        stepId: "dump",
        script: "sqs-etl",
        attempt: 1,
        exitCode: 3,
        outcome: null,
        reportPath: "/workspace/data/output/1/run-report.json",
        branch: retryBranch,
        startedAt: T0,
        finishedAt: T1,
        reportUnavailable: null,
      },
      {
        stepId: "dump",
        script: "sqs-etl",
        attempt: 2,
        exitCode: 0,
        outcome: "success",
        reportPath: "/workspace/data/output/2/run-report.json",
        branch: "stop",
        startedAt: T0,
        finishedAt: T1,
        reportUnavailable: null,
      },
    ]);
  });

  test("two steps with DIFFERENT observed windows produce two DIFFERENT recorded windows", async () => {
    /*
     * The defect this pins shut. `flow/step.ts` reads the clock inside each
     * execution, so every step owns a disjoint window; a loop that discarded
     * them would leave `flow/envelope.ts` nothing to hand `buildRunEnvelope`
     * but the RUN's window, and every nested step envelope would then report
     * the whole run's `durationMs`.
     *
     * Two distinct windows are the discriminating fixture: an implementation
     * that substitutes the run's own window (or `stepResult.startedAt` of the
     * first execution) yields two IDENTICAL pairs and fails here, while the
     * happy path above — where both steps share `T0`–`T1` — passes either way.
     */
    const dumpStarted = new Date("2026-09-01T09:00:01.000Z");
    const dumpFinished = new Date("2026-09-01T09:00:03.500Z");
    const reshapeStarted = new Date("2026-09-01T09:07:00.000Z");
    const reshapeFinished = new Date("2026-09-01T09:07:42.250Z");
    scriptSteps({
      dump: {
        exitCode: 0,
        startedAt: dumpStarted,
        finishedAt: dumpFinished,
      },
      reshape: {
        exitCode: 0,
        startedAt: reshapeStarted,
        finishedAt: reshapeFinished,
      },
    });
    const definition = buildDefinition([
      buildStep("dump"),
      buildStep("reshape", { script: "json-etl", onSuccess: "stop" }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    const windows: [Date, Date][] = [];
    for (const entry of result.stepExecutions) {
      windows.push([entry.startedAt, entry.finishedAt]);
    }
    expect(windows).toEqual([
      [dumpStarted, dumpFinished],
      [reshapeStarted, reshapeFinished],
    ]);
    // Spelled out separately: the two recorded windows must not collapse onto
    // one another, and neither may be the RUN's own window.
    expect(windows[0]).not.toEqual(windows[1]);
    expect(windows[0]).not.toEqual([T0, T1]);
    expect(windows[1]).not.toEqual([T0, T1]);
  });

  test("two attempts of the SAME step id keep their two distinct windows", async () => {
    // A flow that revisits one step is exactly the case a correlation id would
    // otherwise be needed for: the two executions are told apart purely by
    // their disjoint observed intervals, so the loop must not coalesce them.
    const firstStarted = new Date("2026-09-01T09:01:00.000Z");
    const firstFinished = new Date("2026-09-01T09:01:05.000Z");
    const secondStarted = new Date("2026-09-01T09:02:00.000Z");
    const secondFinished = new Date("2026-09-01T09:02:11.000Z");
    let runs = 0;
    executeFlowStepMock.mockImplementation(
      (
        _context: M3LCliFlowStepContext,
        step: M3LCliFlowStep,
      ): Promise<M3LCliFlowStepResult> => {
        runs += 1;
        const first = runs === 1;
        const result: M3LCliFlowStepResult = {
          stepId: step.id,
          script: step.script,
          execution: "spawn",
          dryRun: false,
          startedAt: first ? firstStarted : secondStarted,
          finishedAt: first ? firstFinished : secondFinished,
          exitCode: first ? 3 : 0,
          outcome: null,
          reportPath: null,
          reportUnavailable: "no-matching-report",
        };
        return Promise.resolve(result);
      },
    );
    const definition = buildDefinition([
      buildStep("retry", { onFailure: { goto: "retry" }, onSuccess: "stop" }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    expect(result.stepExecutions).toHaveLength(2);
    expect(result.stepExecutions[0]?.startedAt).toBe(firstStarted);
    expect(result.stepExecutions[0]?.finishedAt).toBe(firstFinished);
    expect(result.stepExecutions[1]?.startedAt).toBe(secondStarted);
    expect(result.stepExecutions[1]?.finishedAt).toBe(secondFinished);
  });

  test("carries each step's OWN reportUnavailable reason, never a hardcoded one", async () => {
    // `flow/envelope.ts` reconstructs each nested envelope's `lookup` from this
    // field. A loop that dropped it would force the envelope to guess
    // `"no-matching-report"` for every unavailable report, mislabelling a
    // malformed or unreadable one.
    scriptSteps({
      dump: {
        exitCode: 0,
        reportPath: null,
        reportUnavailable: "report-malformed",
      },
      reshape: {
        exitCode: 0,
        reportPath: null,
        reportUnavailable: "output-directory-unreadable",
      },
      land: { exitCode: 0 },
    });
    const definition = buildDefinition([
      buildStep("dump"),
      buildStep("reshape", { script: "json-etl" }),
      buildStep("land", { onSuccess: "stop" }),
    ]);

    const result = await runFlow(buildContext(), definition, defaultOptions());

    const reasons: (M3LCliRunReportUnavailableReason | null)[] = [];
    for (const entry of result.stepExecutions) {
      reasons.push(entry.reportUnavailable);
    }
    expect(reasons).toEqual([
      "report-malformed",
      "output-directory-unreadable",
      // A step whose report WAS located carries `null`, not a reason.
      null,
    ]);
  });

  test("a located report keeps reportUnavailable null alongside its path", async () => {
    scriptSteps({ dump: { exitCode: 0 } });

    const result = await runFlow(
      buildContext(),
      buildDefinition([buildStep("dump", { onSuccess: "stop" })]),
      defaultOptions(),
    );

    expect(result.stepExecutions[0]?.reportPath).toBe(
      "/workspace/data/output/dump/run-report.json",
    );
    expect(result.stepExecutions[0]?.reportUnavailable).toBeNull();
  });

  test("does not leak the step mechanism or the effective dry-run flag into the entry", async () => {
    // `M3LCliFlowStepResult` also carries `execution` and `dryRun`; the loop's
    // per-execution entry deliberately does NOT, because neither is part of
    // the persisted record nor of the nested run envelope.
    scriptSteps({ dump: { exitCode: 0 } });

    const result = await runFlow(
      buildContext(),
      buildDefinition([buildStep("dump", { onSuccess: "stop" })]),
      defaultOptions({ dryRun: true }),
    );

    const entry = result.stepExecutions[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).toSorted()).toEqual(
      [
        "attempt",
        "branch",
        "exitCode",
        "finishedAt",
        "outcome",
        "reportPath",
        "reportUnavailable",
        "script",
        "startedAt",
        "stepId",
      ].toSorted(),
    );
  });

  test("attempt counts per step id, not per run", async () => {
    scriptSteps({});
    const definition = buildDefinition(
      [
        buildStep("a", { onSuccess: { goto: "b" } }),
        buildStep("b", { onSuccess: { goto: "a" } }),
      ],
      4,
    );

    const result = await runFlow(buildContext(), definition, defaultOptions());

    const attempts: [string, number][] = [];
    for (const entry of result.stepExecutions) {
      attempts.push([entry.stepId, entry.attempt]);
    }
    expect(attempts).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
      ["b", 2],
    ]);
  });
});

describe("runFlow — seam forwarding and failure propagation", () => {
  test("forwards the flow-level dry-run flag to every step as flowDryRun", async () => {
    scriptSteps({});
    const definition = buildDefinition([buildStep("a"), buildStep("b")]);

    await runFlow(buildContext(), definition, defaultOptions({ dryRun: true }));

    for (const call of executeFlowStepMock.mock.calls) {
      expect(call[2]).toBe(true);
    }
  });

  test("defaults the flow-level dry-run flag to false when omitted", async () => {
    scriptSteps({});

    await runFlow(buildContext(), buildDefinition([buildStep("a")]), {
      now: scriptedNow(T0, T1),
    });

    expect(executeFlowStepMock.mock.calls[0]?.[2]).toBe(false);
  });

  test("forwards the injectable step seams to every step invocation", async () => {
    scriptSteps({});
    const spawnImpl = vi.fn();
    const importModule = vi.fn(() => Promise.resolve({}));
    const now = scriptedNow(T0, T1);

    await runFlow(buildContext(), buildDefinition([buildStep("a")]), {
      now,
      spawnImpl: spawnImpl as unknown as M3LCliFlowRunOptions["spawnImpl"],
      importModule,
    });

    expect(executeFlowStepMock.mock.calls[0]?.[3]).toMatchObject({
      spawnImpl,
      importModule,
      now,
    });
  });

  test("passes the caller's context through to every step unchanged", async () => {
    scriptSteps({});
    const context = buildContext();

    await runFlow(
      context,
      buildDefinition([buildStep("a"), buildStep("b")]),
      defaultOptions(),
    );

    for (const call of executeFlowStepMock.mock.calls) {
      expect(call[0]).toBe(context);
    }
  });

  test("a step rejection propagates unchanged and aborts the loop", async () => {
    const cause = new M3LCliError("ERR_CLI_SPAWN_FAILED", "spawn blew up");
    executeFlowStepMock.mockRejectedValue(cause);

    await expect(
      runFlow(
        buildContext(),
        buildDefinition([buildStep("a"), buildStep("b")]),
        defaultOptions(),
      ),
    ).rejects.toBe(cause);
    expect(executeFlowStepMock).toHaveBeenCalledTimes(1);
  });
});

describe("runFlow — types", () => {
  test("the run status is the four designed literals", () => {
    expectTypeOf<M3LCliFlowRunStatus>().toEqualTypeOf<
      "completed" | "stopped" | "failed" | "loop-guard-exceeded"
    >();
  });

  test("the PERSISTED per-step-execution record still carries exactly the seven designed fields", () => {
    // Deliberately NOT widened with the observed window: this shape IS the
    // on-disk JSON inside `M3LCliFlowRunRecord`, and a `Date` written there
    // reads back as a string, which would make the round-trip a type lie.
    expectTypeOf<M3LCliFlowStepExecution>().toEqualTypeOf<{
      readonly stepId: string;
      readonly script: string;
      readonly attempt: number;
      readonly exitCode: number;
      readonly outcome: M3LCliRunOutcome | null;
      readonly reportPath: string | null;
      readonly branch: M3LCliFlowBranch;
    }>();
  });

  test("the IN-MEMORY per-execution outcome is those seven fields plus the three observed ones", () => {
    expectTypeOf<M3LCliFlowStepOutcome>().toEqualTypeOf<{
      readonly stepId: string;
      readonly script: string;
      readonly attempt: number;
      readonly exitCode: number;
      readonly outcome: M3LCliRunOutcome | null;
      readonly reportPath: string | null;
      readonly branch: M3LCliFlowBranch;
      readonly startedAt: Date;
      readonly finishedAt: Date;
      readonly reportUnavailable: M3LCliRunReportUnavailableReason | null;
    }>();
  });

  test("the observed window is a Date pair, matching M3LCliRunEnvelopeInput's own", () => {
    // `flow/envelope.ts` forwards these straight into `buildRunEnvelope`,
    // which does the ISO-8601 conversion itself — so they must stay `Date`s
    // here rather than being pre-stringified.
    expectTypeOf<M3LCliFlowStepOutcome["startedAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<M3LCliFlowStepOutcome["finishedAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<
      M3LCliFlowStepOutcome["reportUnavailable"]
    >().toEqualTypeOf<M3LCliRunReportUnavailableReason | null>();
  });

  test("the run result exposes the cumulative count, halting id, and resume id", () => {
    expectTypeOf<
      M3LCliFlowRunResult["stepExecutionCount"]
    >().toEqualTypeOf<number>();
    expectTypeOf<M3LCliFlowRunResult["haltingStepId"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<M3LCliFlowRunResult["resumeStepId"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<M3LCliFlowRunResult["stepExecutions"]>().toEqualTypeOf<
      readonly M3LCliFlowStepOutcome[]
    >();
    expectTypeOf<
      M3LCliFlowRunResult["status"]
    >().toEqualTypeOf<M3LCliFlowRunStatus>();
  });

  test("runFlow takes (context, definition, options?) and resolves a run result", () => {
    expectTypeOf(runFlow).toEqualTypeOf<
      (
        context: M3LCliFlowStepContext,
        definition: M3LCliFlowDefinition,
        options?: M3LCliFlowRunOptions,
      ) => Promise<M3LCliFlowRunResult>
    >();
  });

  test("the resume-from step id is optional — U10 ships no --resume flag", () => {
    expectTypeOf<M3LCliFlowRunOptions["resumeFromStepId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<M3LCliFlowRunOptions["stepExecutionCount"]>().toEqualTypeOf<
      number | undefined
    >();
  });
});
