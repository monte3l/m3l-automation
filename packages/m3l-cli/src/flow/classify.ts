/**
 * `flow/classify` — the branching algebra: the single pure function mapping
 * one step's observed result (its exit code plus whatever its located
 * `run-report.json` claimed) onto the branch the flow takes next.
 *
 * Its own module, with no I/O and no imports beyond types, so the branch
 * table can be exercised exhaustively without a filesystem, a child process
 * or a clock — and so `flow/run`'s loop tests can drive the REAL table rather
 * than a mock that would let an inverted algebra pass.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LCliRunOutcome } from "../run/envelope.js";
import type { M3LCliFlowBranch, M3LCliFlowStep } from "./types.js";

/**
 * What a completed step execution is observed to have produced: the exit code
 * the mechanism resolved, and the outcome its run report declared (`null`
 * when no report could be located — the common case for a script that writes
 * none).
 *
 * Two fields and no more: the branch decision must be reproducible from
 * exactly what a caller can always observe. Anything richer (a duration, a
 * report path) belongs in the run record, not in the decision input.
 *
 * @example
 * ```ts
 * const observation: M3LCliFlowStepObservation = {
 *   exitCode: 6,
 *   outcome: "partial",
 * };
 * ```
 */
export interface M3LCliFlowStepObservation {
  /** The exit code the step's mechanism resolved, verbatim. */
  readonly exitCode: number;
  /** The outcome the located run report declared, or `null` when unavailable. */
  readonly outcome: M3LCliRunOutcome | null;
}

/**
 * Resolves which of `step`'s three arms `observation` selects.
 *
 * The table, in evaluation order:
 *
 * 1. **partial** — the `PARTIAL` exit code (6) OR an `outcome` of
 *    `"partial"`. Either signal alone is sufficient, and this row is checked
 *    FIRST so it wins over row 2 when a step exits 0 while its report says
 *    `"partial"`. That combination means the script's own exit mapping and
 *    its report disagree; the report is the script's authoritative
 *    self-assessment of absorbed per-item failures, so the safe reading lets
 *    the author's `onPartial` arm fire rather than silently treating absorbed
 *    failures as a clean success.
 * 2. **success** — exit code 0. Only `"partial"` is admitted as an
 *    outcome-driven override, so an `outcome` of `"failure"` alongside a 0
 *    exit code still lands here.
 * 3. **failure** — everything else, including a signal-derived code
 *    (`128 + n`) and an unregistered one.
 *
 * The returned value is `step`'s OWN branch value by identity, never a
 * reconstructed copy: a `{ goto }` object is recorded verbatim in the run
 * record, and rebuilding it would break identity-based reasoning downstream
 * while still satisfying a structural comparison.
 *
 * `step.onPartial ?? step.onFailure` is a real fallback, not dead code:
 * `flow/validate` always materializes `onPartial`, but the TYPE declares it
 * optional and a hand-built definition literal may legitimately omit it.
 * Falling back to `onFailure` is the format's documented default (a partial
 * outcome is a failure the author did not separately account for) — do not
 * "simplify" this to a non-null assertion.
 *
 * @param step - The step whose arms are being selected from; never mutated.
 * @param observation - The step's observed exit code and report outcome;
 *   never mutated.
 * @returns The selected branch, by identity.
 *
 * @example
 * ```ts
 * const branch = classifyStepBranch(step, { exitCode: 0, outcome: "success" });
 * // step.onSuccess, by identity
 * ```
 */
export function classifyStepBranch(
  step: M3LCliFlowStep,
  observation: M3LCliFlowStepObservation,
): M3LCliFlowBranch {
  if (
    observation.exitCode === Core.M3L_EXIT_CODES.PARTIAL ||
    observation.outcome === "partial"
  ) {
    return step.onPartial ?? step.onFailure;
  }
  if (observation.exitCode === Core.M3L_EXIT_CODES.SUCCESS) {
    return step.onSuccess;
  }
  return step.onFailure;
}
