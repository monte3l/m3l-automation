/**
 * `runs/admission` — `admitRun`, the launch-admission decision: resolves the
 * requested script, applies the confirmation policy, then the
 * admission-control governor, in that order.
 *
 * Extracted out of `runs/orchestrator.ts` (X4 slice 6 round 2) as its own
 * module rather than left inline: "is this caller allowed to run this script
 * right now, and is there capacity" is a real concept distinct from "run
 * lifecycle" (persisting a row, starting an executor, recording a finish),
 * and splitting it out reads as a design decision, not mere byte-shaving to
 * clear `orchestrator.ts`'s per-file size budget (which it also happens to
 * do).
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";

import type { M3LRunAuditSink } from "./audit.js";
import type { M3LRunGovernor } from "./governor.js";
import type { M3LRunRequestBody } from "./parameters.js";
import type { M3LRunPolicy } from "./policy.js";
import { resolveScript } from "./resolver.js";
import type { M3LResolvedScript } from "./resolver.js";

/**
 * The collaborators {@link admitRun} decides against. Carries only
 * `scriptsDir` (a plain string) rather than the orchestrator's full
 * multi-field run-governor configuration — `admitRun` never reads any other
 * config setting, and importing or duplicating that broader shape here
 * would give this module a dependency it does not actually need.
 *
 * @example
 * ```ts
 * function scriptsDirOf(options: M3LRunAdmissionOptions): string {
 *   return options.scriptsDir;
 * }
 * ```
 */
export interface M3LRunAdmissionOptions {
  /** The launch-confirmation policy port. */
  readonly policy: M3LRunPolicy;
  /** The admission-control port. */
  readonly governor: M3LRunGovernor;
  /** The run-lifecycle audit port; a denial or rejection is recorded here before {@link admitRun} throws. */
  readonly audit: M3LRunAuditSink;
  /** The resolved, absolute path to the scripts directory. */
  readonly scriptsDir: string;
}

/**
 * An admitted launch's verdict: the resolved script, and whether the
 * governor accepted it (start immediately) or queued it (wait for a free
 * slot). A `"reject"` verdict never reaches this type — {@link admitRun}
 * throws for that arm instead of returning it.
 *
 * @example
 * ```ts
 * function shouldStartNow(result: M3LRunAdmissionResult): boolean {
 *   return result.kind === "accept";
 * }
 * ```
 */
export interface M3LRunAdmissionResult {
  /** Whether the run may start immediately (`"accept"`) or must wait in the queue (`"queue"`). */
  readonly kind: "accept" | "queue";
  /** The requested script, resolved against `options.scriptsDir`. */
  readonly resolved: M3LResolvedScript;
}

/**
 * Resolves `body.scriptName`, applies the confirmation policy, then the
 * admission-control governor — in that order, matching
 * `runs/orchestrator.ts`'s `launch` contract exactly. A denial or a
 * rejection is audited BEFORE it throws: a launch that never gets to
 * persist a row still leaves a trace of why it was refused. Committing the
 * governor's own decision (`accept`/`enqueue`) happens here too; undoing
 * that commitment on a later `insertQueued` failure is the caller's job,
 * not this function's — this function only ever moves forward.
 *
 * @param options - See {@link M3LRunAdmissionOptions}.
 * @param body - The validated launch request body.
 * @param operator - The operator requesting the launch.
 * @param attemptAtMs - The clock reading at the start of this launch
 *   attempt; shared by every audit entry this call may write, so a denied
 *   or rejected launch records one consistent timestamp rather than a
 *   fresh clock read per entry.
 * @returns The admitted {@link M3LRunAdmissionResult}.
 * @throws {@link M3LConsoleError} propagated unchanged from `resolveScript`
 *   (`"ERR_CONSOLE_BAD_REQUEST"` / `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"`), or
 *   raised here with `"ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"` (policy
 *   denial) / `"ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"` (governor rejection).
 *
 * @example
 * ```ts
 * import { admitRun } from "@m3l-automation/m3l-console-server/runs/admission.js";
 *
 * declare const options: Parameters<typeof admitRun>[0];
 * const result = admitRun(
 *   options,
 *   { scriptName: "sqs-etl", confirmed: true, dryRun: false, parameters: {} },
 *   "ada",
 *   Date.now(),
 * );
 * ```
 */
export function admitRun(
  options: M3LRunAdmissionOptions,
  body: M3LRunRequestBody,
  operator: string,
  attemptAtMs: number,
): M3LRunAdmissionResult {
  const resolved = resolveScript(body.scriptName, options.scriptsDir);

  const verdict = options.policy.evaluate({
    scriptName: resolved.name,
    dryRun: body.dryRun,
    confirmed: body.confirmed,
    operator,
  });
  if (verdict.kind === "deny") {
    options.audit.record({
      action: "run.launch-denied",
      runId: undefined,
      scriptName: resolved.name,
      operator,
      atMs: attemptAtMs,
      detail: { reason: verdict.reason },
    });
    throw new M3LConsoleError(
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
      `run of '${resolved.name}' was denied: ${verdict.reason}`,
    );
  }

  const decision = options.governor.decide(resolved.name);
  switch (decision.kind) {
    case "reject":
      options.audit.record({
        action: "run.launch-rejected",
        runId: undefined,
        scriptName: resolved.name,
        operator,
        atMs: attemptAtMs,
        detail: {},
      });
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
        `run of '${resolved.name}' was rejected: the run queue is full`,
      );
    case "accept":
      options.governor.accept(resolved.name);
      return { kind: "accept", resolved };
    case "queue":
      options.governor.enqueue();
      return { kind: "queue", resolved };
    default: {
      const exhaustive: never = decision.kind;
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `unhandled governor decision: ${String(exhaustive)}`,
      );
    }
  }
}
