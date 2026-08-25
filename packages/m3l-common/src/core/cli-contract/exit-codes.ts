/**
 * `core/cli-contract/exit-codes` — maps an in-process {@link M3LCommandOutcome}
 * to the exit code the spawned child would have produced, so the two
 * execution paths are indistinguishable to a scheduler.
 *
 * No new codes are minted here and there is no second classification table:
 * the registry and the error classifier both stay singly owned by
 * `core/diagnostics`.
 *
 * @packageDocumentation
 */

import type { M3LExitCode } from "../diagnostics/exit-codes.js";
import {
  M3L_EXIT_CODES,
  mapErrorToExitCode,
} from "../diagnostics/exit-codes.js";
import type { M3LRunOutcome } from "../diagnostics/run-report.js";

import type { M3LCommandOutcome } from "./types.js";

/**
 * Compile-time pin binding this module's outcome vocabulary to
 * `core/diagnostics`' {@link M3LRunOutcome} in **both** directions: the
 * conditional resolves to `never` (TS2322 on the `= true`) if either union
 * gains a member the other lacks.
 *
 * A one-way `extends` would be fail-open in the direction it does not test,
 * and the two vocabularies must stay identical so an in-process run and a run
 * report describe the same event with the same word. The `_` prefix satisfies
 * `varsIgnorePattern: "^_"` in `no-unused-vars` without a suppression comment.
 */
const _m3lCommandOutcomeStatusPin: M3LCommandOutcome["status"] extends M3LRunOutcome
  ? M3LRunOutcome extends M3LCommandOutcome["status"]
    ? true
    : never
  : never = true;

/**
 * Maps a command outcome to a process exit code.
 *
 * | Outcome | Exit code |
 * | ------- | --------- |
 * | `"success"` / `"dry-run"` | `SUCCESS` (0) |
 * | `"interrupted"` | `INTERRUPTED` (5) |
 * | `"partial"` | `PARTIAL` (6) |
 * | `"failure"` | delegated to `mapErrorToExitCode` (1–4) |
 *
 * The return type is {@link M3LExitCode} rather than `number` so ADR-0054's
 * "mints no new codes" clause is enforced by the compiler instead of by
 * review, and the `default` arm's `never` binding turns a sixth outcome
 * without a mapping into a compile error rather than a runtime fall-through.
 *
 * **Never throws.** Every read off the caller-supplied `outcome` — `status`,
 * plus `error` on the `"failure"` arm — happens exactly once inside a single
 * `try`, before any dispatch. A hostile getter, a revoked `Proxy`, or a
 * non-object forced past the type system therefore yields `UNCLASSIFIED` (1)
 * instead of propagating: argument evaluation would otherwise happen in this
 * frame, outside any callee's guard. The `"failure"` arm then delegates the
 * already-read value to `mapErrorToExitCode`, whose own never-throws guarantee
 * covers whatever the outcome carries.
 *
 * @param outcome - The outcome a hosted command resolved to.
 * @returns The registry code the equivalent spawned run would have exited with.
 *
 * @example
 * ```ts
 * import { mapCommandOutcomeToExitCode } from "@m3l-automation/m3l-common/core";
 *
 * const outcome = await commandModule.execute(parameters, context);
 * process.exitCode = mapCommandOutcomeToExitCode(outcome);
 * ```
 */
export function mapCommandOutcomeToExitCode(
  outcome: M3LCommandOutcome,
): M3LExitCode {
  let snapshot: {
    readonly status: M3LCommandOutcome["status"];
    readonly error: unknown;
  };
  try {
    // Both caller-controlled reads happen here, once each: an argument
    // expression such as `mapErrorToExitCode(outcome.error)` is evaluated in
    // *this* frame, so a throwing getter would escape the callee's own guard.
    const { status } = outcome;
    snapshot = {
      status,
      error: status === "failure" ? outcome.error : undefined,
    };
  } catch {
    return M3L_EXIT_CODES.UNCLASSIFIED;
  }

  const { status, error } = snapshot;
  switch (status) {
    case "success":
    case "dry-run":
      return M3L_EXIT_CODES.SUCCESS;
    case "interrupted":
      return M3L_EXIT_CODES.INTERRUPTED;
    case "partial":
      return M3L_EXIT_CODES.PARTIAL;
    case "failure":
      return mapErrorToExitCode(error);
    default: {
      // The `never` binding makes a sixth outcome without a mapping a compile
      // error. At runtime this arm still receives any status forced past the
      // type system, and answers `UNCLASSIFIED` rather than throwing: a mapper
      // that throws costs the caller the one value it asked for.
      const _exhaustive: never = status;
      return M3L_EXIT_CODES.UNCLASSIFIED;
    }
  }
}
