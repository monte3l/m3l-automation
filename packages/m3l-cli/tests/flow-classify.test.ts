/**
 * Tests for src/flow/classify.ts — the single pure function that maps one
 * step's observed result (exit code + run-report outcome) onto the branch the
 * flow takes next (`docs/plans/2026-09-01-orchestration-engine.md`
 * §_Branching algebra_).
 *
 * RED phase: `src/flow/classify.ts` does not exist yet, so every import below
 * fails to resolve. That is the expected failure for this phase.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { classifyStepBranch } from "../src/flow/classify.js";
import type { M3LCliFlowStepObservation } from "../src/flow/classify.js";
import type { M3LCliFlowBranch, M3LCliFlowStep } from "../src/flow/types.js";
import type { M3LCliRunOutcome } from "../src/run/envelope.js";

/** Three visibly distinct branches, so a test can tell which arm fired. */
const ON_SUCCESS: M3LCliFlowBranch = "continue";
const ON_FAILURE: M3LCliFlowBranch = "stop";
const ON_PARTIAL: M3LCliFlowBranch = { goto: "reconcile" };

/**
 * A step whose three arms are pairwise distinct. Stage A's validator always
 * materializes `onPartial`, so the default fixture carries a concrete one.
 */
function buildStep(overrides: Partial<M3LCliFlowStep> = {}): M3LCliFlowStep {
  return {
    id: "dump",
    script: "sqs-etl",
    parameters: {},
    execution: "spawn",
    onSuccess: ON_SUCCESS,
    onFailure: ON_FAILURE,
    onPartial: ON_PARTIAL,
    ...overrides,
  };
}

function observe(
  exitCode: number,
  outcome: M3LCliRunOutcome | null = null,
): M3LCliFlowStepObservation {
  return { exitCode, outcome };
}

describe("classifyStepBranch — success arm", () => {
  test("exit code 0 with no located report takes onSuccess", () => {
    expect(classifyStepBranch(buildStep(), observe(0, null))).toBe(ON_SUCCESS);
  });

  test.each([["success"], ["dry-run"]] as const)(
    "exit code 0 with outcome %s takes onSuccess",
    (outcome: M3LCliRunOutcome) => {
      expect(classifyStepBranch(buildStep(), observe(0, outcome))).toBe(
        ON_SUCCESS,
      );
    },
  );
});

describe("classifyStepBranch — partial arm", () => {
  test("the PARTIAL exit code (6) takes onPartial", () => {
    expect(
      classifyStepBranch(
        buildStep(),
        observe(Core.M3L_EXIT_CODES.PARTIAL, null),
      ),
    ).toBe(ON_PARTIAL);
  });

  test("outcome 'partial' takes onPartial even on a non-6 non-zero exit code", () => {
    expect(classifyStepBranch(buildStep(), observe(3, "partial"))).toBe(
      ON_PARTIAL,
    );
  });

  test("the PARTIAL exit code wins even when the report says 'failure'", () => {
    // The table's second row admits EITHER signal, so exit code 6 alone is
    // sufficient regardless of what the located report claims.
    expect(
      classifyStepBranch(
        buildStep(),
        observe(Core.M3L_EXIT_CODES.PARTIAL, "failure"),
      ),
    ).toBe(ON_PARTIAL);
  });

  /*
   * The ratified table's two overlapping rows: row 1 matches `exitCode === 0`,
   * row 2 admits `outcome === "partial"` on its own. An observation that is
   * BOTH is the one case the table does not disambiguate, so it is pinned
   * here: the partial arm wins.
   *
   * Why: row 1's parenthetical enumerates exactly the outcomes for which a 0
   * exit code means success — `success`, `dry-run`, or unavailable — and
   * deliberately does not list `partial`. A report saying `partial` alongside
   * a 0 exit code means the script's own exit mapping
   * (`Core.mapCommandOutcomeToExitCode`, which sends a partial outcome to 6)
   * and its report disagree; the report is the script's authoritative
   * self-assessment of absorbed per-item failures, and the safe reading is the
   * one that lets the author's `onPartial` arm fire rather than silently
   * treating absorbed failures as a clean success.
   */
  test("exit code 0 with outcome 'partial' takes onPartial, not onSuccess", () => {
    expect(classifyStepBranch(buildStep(), observe(0, "partial"))).toBe(
      ON_PARTIAL,
    );
  });

  test("falls back to onFailure for a hand-built step that omits onPartial", () => {
    // The TYPE makes `onPartial` optional (a hand-written literal need not
    // spell it out) even though stage A's validator always materializes it,
    // so the function must still resolve a branch without a non-null
    // assertion. `onPartial ?? onFailure` is what the design table specifies.
    const step = buildStep();
    const withoutPartial: M3LCliFlowStep = {
      id: step.id,
      script: step.script,
      parameters: step.parameters,
      execution: step.execution,
      onSuccess: step.onSuccess,
      onFailure: step.onFailure,
    };

    expect(
      classifyStepBranch(
        withoutPartial,
        observe(Core.M3L_EXIT_CODES.PARTIAL, "partial"),
      ),
    ).toBe(ON_FAILURE);
  });
});

describe("classifyStepBranch — failure arm", () => {
  test.each([
    [Core.M3L_EXIT_CODES.UNCLASSIFIED],
    [Core.M3L_EXIT_CODES.CONFIG_USAGE],
    [Core.M3L_EXIT_CODES.EXTERNAL],
    [Core.M3L_EXIT_CODES.LIBRARY],
    [Core.M3L_EXIT_CODES.INTERRUPTED],
  ])("exit code %i takes onFailure", (exitCode: number) => {
    expect(classifyStepBranch(buildStep(), observe(exitCode, null))).toBe(
      ON_FAILURE,
    );
  });

  test.each([
    [128 + 9, "SIGKILL"],
    [128 + 15, "SIGTERM"],
  ])(
    "the signal-derived exit code %i (%s) takes onFailure",
    (exitCode: number, _signalName: string) => {
      expect(classifyStepBranch(buildStep(), observe(exitCode, null))).toBe(
        ON_FAILURE,
      );
    },
  );

  test("an unregistered high exit code takes onFailure", () => {
    expect(classifyStepBranch(buildStep(), observe(255, null))).toBe(
      ON_FAILURE,
    );
  });

  test("outcome 'interrupted' with a non-zero exit code takes onFailure", () => {
    expect(
      classifyStepBranch(
        buildStep(),
        observe(Core.M3L_EXIT_CODES.INTERRUPTED, "interrupted"),
      ),
    ).toBe(ON_FAILURE);
  });

  test("outcome 'failure' with a zero exit code still takes onSuccess", () => {
    // Only `partial` is admitted as an outcome-driven override; a `failure`
    // outcome alongside a 0 exit code is NOT in the table's second row, so
    // row 1 applies. Pinned so the implementer does not generalize the
    // outcome override to every non-success literal.
    expect(classifyStepBranch(buildStep(), observe(0, "failure"))).toBe(
      ON_SUCCESS,
    );
  });
});

describe("classifyStepBranch — purity and types", () => {
  test("returns the step's own branch value by identity, never a copy", () => {
    // The branch is recorded verbatim in the run record, so a `{ goto }`
    // object must not be reconstructed (a structural copy would still pass a
    // toEqual assertion while breaking identity-based reasoning downstream).
    const gotoBranch: M3LCliFlowBranch = { goto: "republish" };
    const step = buildStep({ onSuccess: gotoBranch });

    expect(classifyStepBranch(step, observe(0, "success"))).toBe(gotoBranch);
  });

  test("does not mutate the step or the observation", () => {
    const step = buildStep();
    const observation = observe(Core.M3L_EXIT_CODES.PARTIAL, "partial");
    const stepSnapshot = structuredClone(step);
    const observationSnapshot = structuredClone(observation);

    classifyStepBranch(step, observation);

    expect(step).toEqual(stepSnapshot);
    expect(observation).toEqual(observationSnapshot);
  });

  test("the observation type is the two-field contract, with a nullable outcome", () => {
    expectTypeOf<M3LCliFlowStepObservation>().toEqualTypeOf<{
      readonly exitCode: number;
      readonly outcome: M3LCliRunOutcome | null;
    }>();
  });

  test("classifyStepBranch is a pure (step, observation) -> branch function", () => {
    expectTypeOf(classifyStepBranch).toEqualTypeOf<
      (
        step: M3LCliFlowStep,
        observation: M3LCliFlowStepObservation,
      ) => M3LCliFlowBranch
    >();
  });
});
