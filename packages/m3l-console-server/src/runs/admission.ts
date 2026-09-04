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
import type { M3LTelemetryRecorder } from "../telemetry/port.js";

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
  /** The telemetry recorder; every gate decision is counted here. */
  readonly telemetry: M3LTelemetryRecorder;
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
 * Runs the confirmation gate to completion: evaluates the policy, counts the
 * verdict, and — on a denial — audits and throws.
 *
 * It exists as a unit because a denial is not a value {@link admitRun} can
 * hand back: the gate either lets the launch continue or ends it here, so
 * "evaluate" and "act on the verdict" cannot be separated without inventing
 * an intermediate verdict type for a caller that has no other use for one.
 * Extracting it also keeps {@link admitRun} readable as the three-step
 * sequence its module doc promises (resolve, confirm, admit) instead of two
 * inlined gate bodies — and, like the module split itself, the extraction is
 * forced by eslint's `max-lines-per-function: 60` as well as by the seam, so
 * re-inlining this gate (or {@link applyAdmissionGate}) back into `admitRun`
 * would trip lint on top of blurring the design boundary.
 *
 * The audit write precedes the telemetry emit on the deny arm: the audit
 * entry is the operator-visible record of WHY a launch was refused, while
 * the sample is a counter derived from it, so the reason is recorded first
 * and never displaced by its own derived count. (`runs/audit.ts` is
 * deliberately the escalate-by-default seam rather than a durable audit
 * trail — it logs each record through `Core.M3LLogger` at `info` — so
 * "operator-visible", not "durable", is what this ordering buys.) The emit
 * still happens before the throw — a refused launch must still be counted.
 *
 * @param options - See {@link M3LRunAdmissionOptions}.
 * @param scriptName - The resolved script's name (never the raw request
 *   value), so the audited and counted decision names what was actually
 *   resolved.
 * @param body - The validated launch request body.
 * @param operator - The operator requesting the launch.
 * @param attemptAtMs - The launch attempt's shared clock reading.
 * @throws {@link M3LConsoleError} with `"ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"`
 *   when the policy denies the launch.
 */
function applyConfirmationGate(
  options: M3LRunAdmissionOptions,
  scriptName: string,
  body: M3LRunRequestBody,
  operator: string,
  attemptAtMs: number,
): void {
  const verdict = options.policy.evaluate({
    scriptName,
    dryRun: body.dryRun,
    confirmed: body.confirmed,
    operator,
  });
  if (verdict.kind === "deny") {
    options.audit.record({
      action: "run.launch-denied",
      runId: undefined,
      scriptName,
      operator,
      atMs: attemptAtMs,
      detail: { reason: verdict.reason },
    });
    options.telemetry.policyDecision({
      posture: "confirmation",
      outcome: "deny",
    });
    throw new M3LConsoleError(
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
      `run of '${scriptName}' was denied: ${verdict.reason}`,
    );
  }
  options.telemetry.policyDecision({
    posture: "confirmation",
    outcome: "allow",
  });
}

/**
 * Runs the admission-control gate to completion: asks the governor to
 * decide, commits that decision against it (`accept`/`enqueue`), counts it,
 * and — on a rejection — audits and throws.
 *
 * Deciding and committing belong in one unit because the governor's counters
 * are only correct if every `decide` is followed by exactly one of `accept`,
 * `enqueue`, or nothing (reject); splitting the two apart would let a future
 * caller read a decision and forget to honour it, silently leaking or
 * double-booking capacity.
 *
 * The emit is placed after the commit, but the counter it feeds does NOT
 * track committed state: `policy.decision` counts DECISIONS, not launches
 * that survived to run. The divergence is real and intended — the
 * `insertQueued` catch arm in `runs/orchestrator.ts`'s `persistQueuedRow`
 * (`:378-389`) undoes this very commitment (`governor.release` for an
 * accepted run, `governor.dequeue` for a queued one), yet by then the sample
 * is already written to all three granularity tiers and the rollup row is
 * durable. So the count of `"admission"` decisions can exceed the number of
 * runs actually started, and a reader must not conclude the counter tracks
 * committed state: the governor genuinely reached this verdict, and a later
 * persistence failure does not un-make the decision it made.
 *
 * The defensive `default:` arm counts NOTHING. An unreachable governor
 * decision is a bug report, not a policy decision, and `posture`/`outcome`
 * are a permanent primary key in the rollup store — writing an unknown value
 * there would pollute it for good.
 *
 * @param options - See {@link M3LRunAdmissionOptions}.
 * @param scriptName - The resolved script's name.
 * @param operator - The operator requesting the launch.
 * @param attemptAtMs - The launch attempt's shared clock reading.
 * @returns The committed decision's kind.
 * @throws {@link M3LConsoleError} with `"ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"`
 *   when the governor rejects the launch, or `"ERR_CONSOLE_INTERNAL"` for an
 *   unreachable decision kind.
 */
function applyAdmissionGate(
  options: M3LRunAdmissionOptions,
  scriptName: string,
  operator: string,
  attemptAtMs: number,
): "accept" | "queue" {
  const decision = options.governor.decide(scriptName);
  switch (decision.kind) {
    case "reject":
      options.audit.record({
        action: "run.launch-rejected",
        runId: undefined,
        scriptName,
        operator,
        atMs: attemptAtMs,
        detail: {},
      });
      options.telemetry.policyDecision({
        posture: "admission",
        outcome: "reject",
      });
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
        `run of '${scriptName}' was rejected: the run queue is full`,
      );
    case "accept":
      options.governor.accept(scriptName);
      options.telemetry.policyDecision({
        posture: "admission",
        outcome: "accept",
      });
      return "accept";
    case "queue":
      options.governor.enqueue();
      options.telemetry.policyDecision({
        posture: "admission",
        outcome: "queue",
      });
      return "queue";
    default: {
      const exhaustive: never = decision.kind;
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `unhandled governor decision: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Resolves `body.scriptName`, applies the confirmation policy, then the
 * admission-control governor — in that order, matching
 * `runs/orchestrator.ts`'s `launch` contract exactly. A denial or a
 * rejection is audited BEFORE it throws: a launch that never gets to
 * persist a row still leaves a trace of why it was refused. Each gate also
 * reports exactly one `policy.decision` telemetry sample (posture
 * `"confirmation"` / `"admission"`). On every arm that performs a write of
 * its own, the emit comes after it — the audit entry on the confirmation
 * deny and admission reject arms, the governor commitment on the accept and
 * queue arms — so a derived counter never displaces the record it is derived
 * from; the confirmation ALLOW arm has no preceding write at all and so
 * emits first. Either way the refusing arms do emit, so a denied or rejected
 * launch is counted rather than lost. Those emits are deliberately NOT
 * wrapped in a try/catch — the port never throws by contract
 * (`telemetry/port.ts`), and swallowing here would hide a genuine recorder
 * bug (the identical stance `runs/orchestrator.ts`'s `recordFinish` takes).
 *
 * Committing the governor's own decision (`accept`/`enqueue`) happens here
 * too; undoing that commitment on a later `insertQueued` failure is the
 * caller's job, not this function's — this function only ever moves forward.
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
 *   denial) / `"ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"` (governor rejection) /
 *   `"ERR_CONSOLE_INTERNAL"` (an unreachable governor decision kind, from
 *   {@link applyAdmissionGate}'s defensive `default:` arm).
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
  applyConfirmationGate(options, resolved.name, body, operator, attemptAtMs);
  const kind = applyAdmissionGate(
    options,
    resolved.name,
    operator,
    attemptAtMs,
  );
  return { kind, resolved };
}
