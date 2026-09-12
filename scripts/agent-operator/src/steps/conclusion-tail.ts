/**
 * `agent-operator/steps/conclusion-tail` — the "conclusion tail" shared by
 * `steps/run-health-check.ts`, `steps/run-etl-preset.ts`, and
 * `steps/run-log-triage.ts`: summarizing what a metered run cost, persisting
 * the cross-run daily invocation counter, and writing the concluding
 * decision-log entry. All three runners drove essentially identical copies
 * of this tail; this module is the one owner.
 *
 * @remarks
 * ## `recordConsumption` never throws — the one behavioral change
 *
 * Every caller awaits {@link recordConsumption} from a bare `finally`, so a
 * throw escaping it would REPLACE whatever the run's own loop was already
 * throwing, discarding the original failure's classification. The three
 * duplicated copies this module replaces already guarded the counter-write
 * failure itself; what they did not guard was the absorbed-failure reporting
 * path that runs when the write fails: `ports.reportRecovery(...)` and the
 * `new Date(now).toISOString()` that builds its `recordedAt` sit in their own
 * nested `try`, and a SYNCHRONOUS throw there is logged through
 * `ports.logger.error` instead of escaping. The guarantee is against that
 * synchronous throw only — a nested `try`/`catch` cannot observe a rejected
 * promise. `ConclusionTailPorts.reportRecovery` is typed `(entry) => void`,
 * which is also the real port's own contract: `M3LScript.reportRecovery` is
 * itself synchronous, so the guard covers every failure the real port can
 * produce.
 *
 * This closes a SHAPE, not a reachable failure — the commit is a `refactor`,
 * not a `fix`:
 *
 * - `Core.M3LLogger.error` cannot throw: the handler fan-out catches per
 *   handler and deliberately does not rethrow.
 * - `reportRecovery` throws only for a malformed
 *   `Core.M3LRunRecoveryEntry`; every call site here builds `item`/`error`/
 *   `recordedAt` as literals, so that path is not reachable.
 * - `new Date(now).toISOString()` raises `RangeError: Invalid time value`
 *   only for a non-finite `now` — an injected test input, not a production
 *   one (every caller samples `now` from `Date.now()`).
 *
 * A last-resort reporter positioned where its own throw would silently
 * replace a classified error is wrong regardless of whether today's inputs
 * can trigger it, so the guard is added and documented plainly rather than
 * implied as a live bug.
 *
 * ## Why cost is read from the ledger, never from `outcome.cost`
 *
 * {@link summarizeMeteredRun} reads `cost` off `setup.ledger.snapshot(...)`,
 * never off the loop outcome's own figure. `createMeteredInvoker`
 * (`steps/metering-invoker.ts`) pushes a locally recomputed cost onto the
 * ledger via `observeSpend` on every turn, so the ledger's `costThisRun` IS
 * that local figure — omitted (read back as `undefined`) exactly when a
 * served model had no declared rate. Reading the cost back from the loop's
 * own `outcome.cost` instead would compare the library's figure to itself:
 * the check could never fail, and `reconcileMeteredCost`'s whole reason for
 * existing — catching a drift between the local re-implementation of
 * `AWS.computeCost` and the library's own formula — would go unguarded.
 *
 * @packageDocumentation
 */

import { Core } from "@monte3l/m3l-common";
import type { AWS } from "@monte3l/m3l-common";

import type { AgentDailyInvocationCounter } from "./daily-counter.js";
import type { AgentDecisionRecorder } from "./decision-recorder.js";
import { reconcileMeteredCost } from "./metering-invoker.js";
import type { MeteredInvoker } from "./metering-invoker.js";
import type { AgentRunLedger } from "./run-ledger.js";

/**
 * The two ports the tail's absorbed-failure path needs.
 *
 * @remarks
 * Structurally satisfied by all three runners' own `*Deps` interfaces, so
 * each runner passes its whole `deps` object straight through — what bounds
 * the surface the tail can read is this narrow PARAMETER type, not any
 * trimming the caller does to its argument.
 */
export interface ConclusionTailPorts {
  /** The script's logger — where an absorbed reporting failure is logged. */
  readonly logger: Core.M3LLogger;
  /** Bound from `script.reportRecovery` — what demotes the run to `partial`. */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
}

/** What one metered run cost, as the concluding audit entry needs it. */
export interface MeteredRunSummary {
  /** The sum of `usage.totalTokens` across every observed iteration. */
  readonly tokens: number;
  /** `undefined` exactly when a served model had no declared rate. */
  readonly cost: number | undefined;
}

/**
 * What the tail actually reads from a prepared run.
 *
 * @remarks
 * Narrower than `steps/prepare-gated-operation.ts`'s `GatedOperationSetup`,
 * which satisfies it structurally — so no caller changes and no test needs a
 * cast to build one. `metered` is `Pick`'d rather than restated so
 * `observedIterations`'s type keeps one owner in
 * `steps/metering-invoker.ts`'s {@link "./metering-invoker.js".MeteredInvoker}.
 */
export interface ConclusionTailSetup {
  /** The metered invoker's observed-iterations reader — nothing else of it. */
  readonly metered: Pick<MeteredInvoker, "observedIterations">;
  /** The run's budget ledger — the source of truth for `cost`. */
  readonly ledger: AgentRunLedger;
  /** The decision recorder the concluding entry is appended through. */
  readonly recorder: AgentDecisionRecorder;
  /** The preflight's already-auto-approved decision, re-recorded verbatim. */
  readonly decision: Core.M3LAgentDecision;
  /** The single `Date.now()` sample the whole run reads. */
  readonly now: number;
}

/**
 * Sums the run's observed tokens and reads its cost off the ledger's own
 * snapshot — see the module remarks for why the ledger, never `outcome.cost`,
 * is the source of `cost`.
 *
 * @param setup - See {@link ConclusionTailSetup}.
 * @returns See {@link MeteredRunSummary}.
 *
 * @example
 * ```ts
 * import type { ConclusionTailSetup } from "./conclusion-tail.js";
 * import { summarizeMeteredRun } from "./conclusion-tail.js";
 *
 * declare const setup: ConclusionTailSetup;
 * const { tokens, cost } = summarizeMeteredRun(setup);
 * ```
 */
export function summarizeMeteredRun(
  setup: ConclusionTailSetup,
): MeteredRunSummary {
  const iterations = setup.metered.observedIterations();
  const tokens = iterations.reduce(
    (total, iteration) => total + iteration.usage.totalTokens,
    0,
  );
  const cost = setup.ledger.snapshot(setup.now).costThisRun;
  return { tokens, cost };
}

/**
 * Persists the run's invocation count onto the cross-run daily counter.
 *
 * @remarks
 * Called from a `finally`, so it runs whether the loop completed, breached a
 * ceiling, or threw — a crash mid-loop must not forget invocations that were
 * already made and already billed. A failure to write is logged and reported
 * as an absorbed failure rather than rethrown: letting it escape from a
 * `finally` would REPLACE whatever the loop was already throwing, discarding
 * the original failure's classification. This is not swallowing — it still
 * reaches the logger and `reportRecovery`, so the run cannot report a silent
 * success.
 *
 * The reporting call itself — `ports.reportRecovery` and the `recordedAt` it
 * builds — sits in its own nested `try`, whose `catch` logs through
 * `ports.logger.error` rather than letting the reporting call's own failure
 * replace the counter-write failure that is actually the one that matters.
 * That nested `try`/`catch` only catches a SYNCHRONOUS throw — see the module
 * remarks for why that is the whole of the real port's contract, and for why
 * this guard closes a shape, not a reachable failure, in the current call
 * sites.
 *
 * @throws Never for a synchronous failure — every synchronous failure,
 *   including one from the absorbed-failure reporting path itself, is logged
 *   rather than propagated. A `reportRecovery` implementation that returns a
 *   rejected promise instead of throwing synchronously is outside this
 *   guarantee; the real port (`M3LScript.reportRecovery`) is synchronous.
 *
 * @example
 * ```ts
 * import type {
 *   ConclusionTailPorts,
 * } from "./conclusion-tail.js";
 * import { recordConsumption } from "./conclusion-tail.js";
 * import type { AgentDailyInvocationCounter } from "./daily-counter.js";
 * import type { AgentRunLedger } from "./run-ledger.js";
 *
 * declare const counter: AgentDailyInvocationCounter;
 * declare const ledger: AgentRunLedger;
 * declare const ports: ConclusionTailPorts;
 *
 * await recordConsumption(counter, ledger, ports, Date.now());
 * ```
 */
export async function recordConsumption(
  counter: Pick<AgentDailyInvocationCounter, "record">,
  ledger: AgentRunLedger,
  ports: ConclusionTailPorts,
  now: number,
): Promise<void> {
  try {
    await counter.record(ledger.invocationCount);
  } catch (cause) {
    ports.logger.error(
      "the cross-run daily invocation counter could not be updated; today's recorded spend is now behind by this run's invocations",
      { invocations: ledger.invocationCount },
    );
    try {
      ports.reportRecovery({
        item: "daily-invocation-counter",
        error: Core.serializeErrorChain(cause, { redact: true }),
        recordedAt: new Date(now).toISOString(),
      });
    } catch (reportingCause) {
      // Neither branch is reachable today (see the module remarks), but a
      // last-resort reporter must never be the thing that replaces the
      // counter-write failure above from inside a caller's bare `finally`.
      ports.logger.error(
        "reporting the daily-invocation-counter recovery entry also failed; the counter write failure above is the one that matters",
        { cause: Core.serializeErrorChain(reportingCause, { redact: true }) },
      );
    }
  }
}

/**
 * Writes the run's concluding decision-log entry: what the authorized run
 * actually cost.
 *
 * @remarks
 * JSONL is append-only, so this is a further entry rather than an amendment
 * of the preflight's own bootstrap entry, which never carries `tokens`/
 * `cost`. `cost` is spread conditionally: an unpriceable run must leave the
 * key absent, not present holding `undefined` — `AgentDecisionRecorder`'s own
 * `record` treats a present-but-`undefined` key as malformed input.
 *
 * @param recorder - The shared decision recorder.
 * @param decision - The preflight's already-auto-approved decision.
 * @param now - The single instant the whole run reads.
 * @param summary - The run's summarized tokens/cost — see
 *   {@link summarizeMeteredRun}. Passed as one value rather than two adjacent
 *   `number` parameters, so transposing `now` and the token count cannot
 *   typecheck silently.
 *
 * @example
 * ```ts
 * import { Core } from "@monte3l/m3l-common";
 * import { recordConclusion } from "./conclusion-tail.js";
 * import type { AgentDecisionRecorder } from "./decision-recorder.js";
 *
 * declare const recorder: AgentDecisionRecorder;
 * declare const decision: Core.M3LAgentDecision;
 *
 * await recordConclusion(recorder, decision, Date.now(), {
 *   tokens: 128,
 *   cost: 0.02,
 * });
 * ```
 */
export async function recordConclusion(
  recorder: AgentDecisionRecorder,
  decision: Core.M3LAgentDecision,
  now: number,
  summary: MeteredRunSummary,
): Promise<void> {
  await recorder.record({
    decision,
    now,
    outcome: { dryRun: false, exitCode: 0 },
    tokens: summary.tokens,
    ...(summary.cost === undefined ? {} : { cost: summary.cost }),
  });
}

/**
 * Everything after a gated operation's loop: reconcile the metered cost
 * against the loop's own reported cost, then record the concluding audit
 * entry.
 *
 * @remarks
 * `reconcileMeteredCost` runs unconditionally here. `steps/run-etl-preset.ts`
 * and `steps/run-log-triage.ts` both call this because their loops never
 * absorb a failure into a missing outcome, so reaching this function at all
 * already means the loop produced a genuine `outcome`. `steps/run-health-check.ts`
 * does NOT call this for a loop that absorbed a ceiling breach — see its own
 * `concludeHealthCheck`, which guards the call on `loop.outcome !== undefined`
 * before ever reaching {@link recordConclusion} directly.
 *
 * @param setup - See {@link ConclusionTailSetup}.
 * @param outcome - The loop's own resolved outcome.
 * @throws {@link "./metering-invoker.js".reconcileMeteredCost}'s own
 *   `M3LAgentOperatorCliError` coded `ERR_AGENT_OPERATOR_CONFIG` on
 *   divergence — {@link recordConclusion} is never reached in that case.
 *
 * @example
 * ```ts
 * import type { AWS } from "@monte3l/m3l-common";
 * import type { ConclusionTailSetup } from "./conclusion-tail.js";
 * import { concludeGatedOperation } from "./conclusion-tail.js";
 *
 * declare const setup: ConclusionTailSetup;
 * declare const outcome: AWS.M3LBedrockToolLoopOutcome;
 *
 * await concludeGatedOperation(setup, outcome);
 * ```
 */
export async function concludeGatedOperation(
  setup: ConclusionTailSetup,
  outcome: AWS.M3LBedrockToolLoopOutcome,
): Promise<void> {
  const summary = summarizeMeteredRun(setup);
  reconcileMeteredCost({ metered: summary.cost, reported: outcome.cost });

  await recordConclusion(setup.recorder, setup.decision, setup.now, summary);
}
