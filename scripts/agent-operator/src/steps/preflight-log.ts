/**
 * `agent-operator/steps/preflight-log` — the two-phase decision-log
 * bootstrap (ADR-0061).
 *
 * The problem: under `requireDecisionLog: true` the **first** evaluation of a
 * run necessarily has `decisionLogAvailable` absent, so it escalates on
 * `decision-log-unavailable.unobservable` and the agent can never act. The
 * resolution is *not* to seed the observation — that would make the audit
 * record claim something nothing had verified. Instead:
 *
 * 1. Evaluate the bootstrap action honestly against the virgin ledger. It
 *    escalates, truthfully.
 * 2. **Write that decision. The write *is* the observation** — a log that
 *    accepted an entry is, by demonstration, available.
 * 3. Record the observation and re-evaluate.
 * 4. Write the re-evaluated verdict too, so the audit trail carries the
 *    verdict the run *ended* on and not only the one it started from. It
 *    cannot be written any earlier, because it does not exist until step 3.
 *
 * A failed write aborts before anything else happens: a run whose audit trail
 * cannot be written must never reach the model.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { AgentDecisionRecorder } from "./decision-recorder.js";
import type { AgentRunLedger } from "./run-ledger.js";

/**
 * Inputs for {@link runDecisionLogPreflight}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AgentDecisionRecorder } from "./decision-recorder.js";
 * import type { AgentPreflightOptions } from "./preflight-log.js";
 * import { AgentRunLedger } from "./run-ledger.js";
 *
 * declare const policy: Core.M3LAgentPolicy;
 * declare const recorder: AgentDecisionRecorder;
 *
 * const options: AgentPreflightOptions = {
 *   policy,
 *   ledger: new AgentRunLedger(),
 *   recorder,
 *   action: { script: "agent-operator", operation: "health-check", kind: "read-only" },
 *   now: Date.now(),
 * };
 * ```
 */
export interface AgentPreflightOptions {
  /** The validated deployment policy both evaluations are judged against. */
  readonly policy: Core.M3LAgentPolicy;
  /** The run ledger, virgin on entry and observing the log on success. */
  readonly ledger: AgentRunLedger;
  /** The recorder that appends the bootstrap decision. */
  readonly recorder: AgentDecisionRecorder;
  /** The read-only bootstrap action to judge. */
  readonly action: Core.M3LAgentAction;
  /** The instant the caller sampled once for this preflight. */
  readonly now: number;
}

/**
 * What the two-phase bootstrap produced.
 *
 * @remarks
 * `bootstrapDecision` is kept alongside `decision` deliberately: both are
 * *recorded*, in that order, and an operator reading the log must be able to
 * reconcile the bootstrap escalation they see first with the concluding
 * verdict the run went on to act upon.
 *
 * @example
 * ```ts
 * import type { AgentPreflightResult } from "./preflight-log.js";
 *
 * function summarize(result: AgentPreflightResult): string {
 *   return `${result.bootstrapDecision.rule} -> ${result.decision.rule}`;
 * }
 * ```
 */
export interface AgentPreflightResult {
  /** Phase 1: the honest first verdict, before anything was observed. */
  readonly bootstrapDecision: Core.M3LAgentDecision;
  /**
   * Phase 3: the verdict re-evaluated against the observed ledger. Recorded
   * in its own log entry by phase 4, so the audit trail and this field agree
   * on the verdict the run concluded upon.
   */
  readonly decision: Core.M3LAgentDecision;
  /** Phase 2: the entry whose successful write was the observation. */
  readonly entry: Core.M3LAgentDecisionLogEntry;
}

/**
 * Runs the decision-log bootstrap: evaluate honestly, write, observe,
 * re-evaluate, then write the conclusion. A successful preflight therefore
 * leaves **two** entries in the log.
 *
 * @remarks
 * Resolving does **not** mean the run is broadly authorized — it means the
 * decision-log rule is resolved. Any budget the deployment declared that this
 * slice cannot observe still escalates on its own `.unobservable` rule, and
 * that is the correct outcome: nothing here may default an unmeasured
 * observation to `0` to make a ceiling look satisfied.
 *
 * @param options - See {@link AgentPreflightOptions}.
 * @returns See {@link AgentPreflightResult}.
 * @throws {@link Core.M3LError} — specifically the
 *   `ERR_AGENT_OPERATOR_DECISION_LOG`-coded `M3LAgentOperatorCliError` the
 *   recorder raises — when either entry cannot be written. Re-thrown
 *   unchanged so the caller still reaches the library's own write error as
 *   `cause`. When the *bootstrap* write fails the ledger is deliberately left
 *   *unobserved*, so a caller may honestly mark the log unavailable; a
 *   failing *concluding* write fails the whole preflight rather than
 *   returning a result whose `decision` never reached the audit trail.
 *
 * @example
 * ```ts
 * import { runDecisionLogPreflight } from "./preflight-log.js";
 * import type { AgentPreflightOptions } from "./preflight-log.js";
 *
 * declare const options: AgentPreflightOptions;
 *
 * const result = await runDecisionLogPreflight(options);
 * // result.bootstrapDecision.rule === "decision-log-unavailable.unobservable"
 * ```
 */
export async function runDecisionLogPreflight(
  options: AgentPreflightOptions,
): Promise<AgentPreflightResult> {
  const bootstrapDecision = Core.evaluateAgentAction({
    action: options.action,
    policy: options.policy,
    run: options.ledger.snapshot(options.now),
  });

  // Phase 2 before phase 3, always: the entry must be accepted before the
  // ledger may claim the log is available.
  const entry = await options.recorder.record({
    decision: bootstrapDecision,
    now: options.now,
  });
  options.ledger.observeDecisionLog(true);

  const decision = Core.evaluateAgentAction({
    action: options.action,
    policy: options.policy,
    run: options.ledger.snapshot(options.now),
  });

  // Phase 4: the concluding verdict is recorded too. Writing only the
  // bootstrap escalation would leave the durable audit trail carrying the
  // verdict the run STARTED from and never the one it ended on — and the
  // concluding verdict does not exist until the re-evaluation above, so this
  // is the earliest point at which it can be written.
  await options.recorder.record({ decision, now: options.now });

  return Object.freeze({ bootstrapDecision, decision, entry });
}
