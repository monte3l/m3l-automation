/**
 * `core/cli-contract/outcome` — derives the {@link M3LCommandOutcome} a hosted
 * command reports from the observable end state of the run it just drove.
 *
 * Promoted out of three pilot scripts that each carried a byte-identical
 * private `toOutcome`. The precedence order it encodes — failure/interrupted
 * first, then partial, then dry-run, then success — mirrors
 * `core/script/run-script.ts` literally rather than being re-derived, because
 * the property that matters is PARITY: for every state a finished run can be
 * in, `mapCommandOutcomeToExitCode(deriveCommandOutcome(...))` must equal the
 * exit code `runScript` already assigned to `process.exitCode` on the spawn
 * path. A disagreement means a scheduler sees two different results for the
 * same run depending on how it was invoked — exactly what ADR-0054's parity
 * clause forbids.
 *
 * @packageDocumentation
 */

import type { M3LRunRecoveryEntry } from "../diagnostics/run-report.js";
import { hasProperty } from "../utils/guards.js";

import type { M3LCommandOutcome } from "./types.js";

/**
 * The two-property slice of a finished run {@link deriveCommandOutcome} reads.
 *
 * Structural rather than a `Pick<M3LScript, ...>`: an ADR-0009 layering zone
 * forbids any other `core/**` module from naming `core/script`, even via
 * `import type`. A real `M3LScript` satisfies this shape through its existing
 * `recovery`/`recoveryTotal` getters, and a test can drive every arm without
 * constructing a script or reaching AWS.
 *
 * @example
 * ```ts
 * import type { M3LCommandRunState } from "@m3l-automation/m3l-common/core";
 *
 * const clean: M3LCommandRunState = { recovery: [], recoveryTotal: 0 };
 * ```
 */
export interface M3LCommandRunState {
  /**
   * The run's absorbed per-item failures — a ring buffer truncated at
   * `M3L_RECOVERY_LIMIT`, so its length is a floor on how many there were,
   * not the count.
   */
  readonly recovery: readonly M3LRunRecoveryEntry[];
  /** The honest total of absorbed failures, truncation included. */
  readonly recoveryTotal: number;
}

/**
 * Whether `error` is a cooperative-cancellation abort — classified by CODE,
 * never by class (ADR-0049), so a structurally-equivalent abort raised across
 * a module boundary (a different copy of the library, an SDK's own error)
 * still classifies.
 *
 * Deliberately private: it has no call site outside this file now that
 * {@link deriveCommandOutcome} absorbs it, and ADR-0054's decision driver is
 * to promote only what has two or more demonstrated consumers.
 *
 * Mirroring `run-script.ts`'s own private `isAbortError` is the point.
 * `runScript` uses it to choose `INTERRUPTED` (5), while `mapErrorToExitCode`
 * is *typed* never to return that code — so reporting an abort as
 * `{ status: "failure" }` would map to 1-4 while the spawn path exited 5.
 *
 * **Never throws.** The one caller-controlled read — `code` — is snapshotted
 * once inside a `try`, exactly as `mapCommandOutcomeToExitCode` snapshots its
 * own reads in `exit-codes.ts`. `failures[0]` is whatever a pipeline threw, so
 * a throwing `code` getter or a revoked `Proxy` is reachable here; either
 * answers `false` (the non-abort branch), which classifies the value as an
 * ordinary failure rather than costing the caller the outcome it asked for.
 */
function isAbortFailure(error: unknown): boolean {
  let code: unknown;
  try {
    if (!(error instanceof Error) || !hasProperty(error, "code")) return false;
    code = error.code;
  } catch {
    // A throwing `code` getter, or a revoked `Proxy` (which throws from
    // `instanceof` and `in` alike). Not an abort as far as this module can
    // tell, so the caller gets `{ status: "failure" }` — the safe default.
    return false;
  }
  return code === "ERR_OPERATION_ABORTED";
}

/**
 * Maps a finished run's observable end state to the outcome a hosted command
 * reports back to its host.
 *
 * `failures.length > 0` rather than a `let captured: unknown`: a thrown
 * `undefined` is representable, and a single slot would leave it
 * indistinguishable from "nothing was captured". Only the FIRST captured
 * failure is reported — the run's proximate cause, matching what `runScript`
 * classifies on the spawn path.
 *
 * `recovered` reports `run.recoveryTotal`, not `run.recovery.length`, because
 * the recovery buffer is truncated; the *predicate* stays
 * `recovery.length > 0` to mirror `run-script.ts` literally rather than
 * second-guessing it.
 *
 * **Never throws**, matching every sibling in this module
 * ({@link mapCommandOutcomeToExitCode}, `isM3LCommandModule`,
 * `isM3LCommandOutcome`). `failures[0]` is an arbitrary thrown value, so its
 * abort classification reads `code` once inside a `try` and falls back to the
 * non-abort branch — a hostile getter yields `{ status: "failure" }` rather
 * than propagating out of a function whose whole job is to produce a verdict.
 *
 * @param run - The finished run's recovery state.
 * @param failures - Errors captured by a `captureRunFailures` `onError` hook,
 *   in the order the pipeline raised them.
 * @param dryRun - Whether this invocation performed no real work.
 * @returns The outcome whose mapped exit code equals `runScript`'s own.
 *
 * @example
 * ```ts
 * import { deriveCommandOutcome } from "@m3l-automation/m3l-common/core";
 *
 * const outcome = deriveCommandOutcome(script, capture.failures, context.dryRun);
 * ```
 */
export function deriveCommandOutcome(
  run: M3LCommandRunState,
  failures: readonly unknown[],
  dryRun: boolean,
): M3LCommandOutcome {
  if (failures.length > 0) {
    const failure = failures[0];
    return isAbortFailure(failure)
      ? { status: "interrupted" }
      : { status: "failure", error: failure };
  }
  if (run.recovery.length > 0) {
    return { status: "partial", recovered: run.recoveryTotal };
  }
  return dryRun ? { status: "dry-run" } : { status: "success" };
}
