/**
 * `agent-operator/steps/run-ledger` — the mutable per-run counters this
 * script keeps, and the frozen `Core.M3LAgentRunLedger` snapshots it hands to
 * `Core.evaluateAgentAction` (ADR-0060/ADR-0061).
 *
 * Two library rules shape every line below:
 *
 * 1. **Presence is read with `Object.hasOwn`, so an absent field must be
 *    omitted — never assigned `undefined`.** A present key holding
 *    `undefined` is malformed input the library throws on, so every optional
 *    field is emitted through a conditional spread.
 * 2. **Omitted means *unobservable*, not zero.** `tokensThisRun`,
 *    `costThisRun`, and `loopIterations` stay absent until
 *    {@link AgentRunLedger.observeSpend} has been called at least once, and
 *    `invocationsToday`/`todayCountedAt` stay absent until
 *    {@link AgentRunLedger.observeDailyBaseline} has been called with a
 *    baseline read off the cross-run counter (`steps/daily-counter.ts`). A
 *    deployment that declares the matching budget escalates on that budget's
 *    `.unobservable` rule. Reporting a fabricated `0` would fail OPEN — it
 *    would tell the evaluator a ceiling is satisfied when nothing was ever
 *    measured.
 *
 * The ledger reads **no clock**: `now` is sampled once by the caller and
 * passed in, so two evaluations in one turn cannot disagree about the
 * per-day window.
 *
 * `takeGateDelta`/`AgentRunLedgerGateDelta` were REMOVED (V8 final slice):
 * the method's only consumer was its own tests, since
 * `AgentDecisionRecordInput` carries no field for a per-gate delta — the
 * evaluator reads absolute counters, never deltas.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";

/**
 * One metering seam report: the ABSOLUTE run totals observed so far, never a
 * per-turn delta.
 *
 * @remarks
 * `costThisRun` is `undefined` exactly when cost is UNOBSERVABLE for the run
 * so far (no rates configured, or a served model lacked a rate) —
 * {@link AgentRunLedger.observeSpend} passes that through so `snapshot` can
 * omit `costThisRun`, which is what correctly yields
 * `budget.cost-per-run.unobservable` instead of silently passing on an
 * understated total. `tokensThisRun` and `loopIterations` have no such
 * escape hatch: the metering seam always knows the token/iteration count of
 * whatever it observed.
 *
 * @example
 * ```ts
 * import type { AgentRunSpend } from "./run-ledger.js";
 *
 * const spend: AgentRunSpend = {
 *   tokensThisRun: 1200,
 *   loopIterations: 4,
 *   costThisRun: 0.42,
 * };
 * ```
 */
export interface AgentRunSpend {
  /** Cumulative tokens across every completed turn. */
  readonly tokensThisRun: number;
  /** Completed model turns. */
  readonly loopIterations: number;
  /**
   * Cumulative cost, or `undefined` when cost is UNOBSERVABLE (no rates
   * configured, or a served modelId had no rate).
   */
  readonly costThisRun: number | undefined;
}

/**
 * Validates a raw, non-negative safe integer — the shape `tokensThisRun` and
 * `loopIterations` must both satisfy. Extracted because the same three
 * checks (finite, non-negative, safe-integer) apply to both fields and
 * `observeSpend` would otherwise repeat them verbatim.
 *
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_DECISION_LOG` when `value` is not a non-negative safe
 *   integer.
 */
function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new M3LAgentOperatorCliError(
      `the run ledger cannot observe spend: ${field} must be a non-negative safe integer`,
      "ERR_AGENT_OPERATOR_DECISION_LOG",
      { context: { field } },
    );
  }
}

/**
 * Validates the optional `costThisRun` — a finite, non-negative number, or
 * `undefined` (unobservable). Unlike the two integer fields, cost may be
 * fractional.
 *
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_DECISION_LOG` when `cost` is a defined value that is
 *   not finite or is negative.
 */
function assertValidCost(cost: number | undefined): void {
  if (cost === undefined) return;
  if (!Number.isFinite(cost) || cost < 0) {
    throw new M3LAgentOperatorCliError(
      "the run ledger cannot observe spend: costThisRun must be a finite, non-negative number, or undefined",
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
  }
}

/**
 * Rejects a regression against the last-observed cumulative value: the
 * metering seam reports absolute totals, so a decrease means a double-wired
 * or reset seam, which would under-report spend and widen a budget.
 *
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_DECISION_LOG` when `next` is lower than `previous`.
 */
function assertNoRegression(
  previous: number,
  next: number,
  field: string,
): void {
  if (next < previous) {
    throw new M3LAgentOperatorCliError(
      `the run ledger cannot observe spend: ${field} regressed from ${String(previous)} to ${String(next)}`,
      "ERR_AGENT_OPERATOR_DECISION_LOG",
      { context: { field, previous, next } },
    );
  }
}

/**
 * Validates one field of a daily baseline: a non-negative safe integer.
 *
 * Coded `ERR_AGENT_OPERATOR_BUDGET_STATE`, not
 * `ERR_AGENT_OPERATOR_DECISION_LOG`: the fault is in the cross-run counter
 * file under `data/agent-state/`, and an operator sent to `data/agent-log/`
 * would find nothing wrong there.
 *
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_BUDGET_STATE` when `value` is not a non-negative safe
 *   integer.
 */
function assertBaselineField(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new M3LAgentOperatorCliError(
      `the run ledger cannot observe a daily baseline: ${field} must be a non-negative safe integer`,
      "ERR_AGENT_OPERATOR_BUDGET_STATE",
      { context: { field } },
    );
  }
}

/**
 * The cross-run per-day starting point handed to
 * {@link AgentRunLedger.observeDailyBaseline}: how many invocations this
 * agent has already made *today*, and the instant that count is anchored to.
 *
 * @remarks
 * `countedAt` must be an instant inside the SAME UTC day as every `now` the
 * run will later evaluate under — the library rolls the window with
 * `Math.floor(t / 86_400_000)` and reads the count as `0` when
 * `todayCountedAt` and `now` fall in different UTC days. `steps/daily-counter`
 * therefore passes the run's own single `now` sample here, never the instant
 * stored in the counter file (which may belong to a previous day, and whose
 * count has already been rolled to `0` by then).
 *
 * `invocationsToday` is the count of invocations made *before this run
 * started*. The ledger adds `invocationsThisRun` on every snapshot rather
 * than storing a combined total, because both names describe the same event
 * and a stored total would go stale the moment the run makes a call.
 *
 * @example
 * ```ts
 * import type { AgentDailyBaseline } from "./run-ledger.js";
 *
 * const baseline: AgentDailyBaseline = {
 *   invocationsToday: 12,
 *   countedAt: Date.now(),
 * };
 * ```
 */
export interface AgentDailyBaseline {
  /** Invocations already made today, before this run started. */
  readonly invocationsToday: number;
  /** An instant inside today's UTC day the count is anchored to. */
  readonly countedAt: number;
}

/**
 * The mutable run counters, and the frozen snapshots the policy evaluator
 * judges actions against.
 *
 * @remarks
 * Every snapshot is a fresh object, so an older snapshot never mutates under
 * a caller that kept it (an audit record must stay what it recorded). The
 * fields that are *always* present are the two this script genuinely
 * observes unconditionally: `now` (handed in) and `invocationsThisRun` /
 * `dryRunCompletedShapes` (counted here). `tokensThisRun`, `loopIterations`,
 * and `decisionLogAvailable` are present only once observed; `costThisRun`
 * only once observed AND priceable; `invocationsToday`/`todayCountedAt` only
 * once a daily baseline has been observed, and then always as a *pair*.
 * Everything else is omitted until observed.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { AgentRunLedger } from "./run-ledger.js";
 *
 * declare const policy: Core.M3LAgentPolicy;
 *
 * const ledger = new AgentRunLedger();
 * const decision = Core.evaluateAgentAction({
 *   action: { script: "agent-operator", operation: "health-check", kind: "read-only" },
 *   policy,
 *   run: ledger.snapshot(Date.now()),
 * });
 * ```
 */
export class AgentRunLedger {
  /** Cumulative invocations this run — always observable, hence always emitted. */
  private invocationsThisRun = 0;
  /**
   * `undefined` until the log has actually been observed. The three states
   * are semantically distinct to the library: absent is an `.unobservable`
   * escalation, `false` is the hard `decision-log-unavailable` escalation,
   * and `true` clears the rule — so absent must never be collapsed onto
   * `false`.
   */
  private decisionLogAvailable: boolean | undefined = undefined;
  /**
   * A `Set` rather than an array: the library rejects a ledger whose
   * `dryRunCompletedShapes` contains duplicates, and insertion order is
   * preserved so the emitted list stays stable across snapshots.
   */
  private readonly dryRunShapes = new Set<string>();
  /**
   * `false` until {@link observeSpend} has been called at least once — the
   * fail-closed flag that makes `snapshot` omit `tokensThisRun`,
   * `costThisRun`, and `loopIterations` entirely rather than reading a
   * default `0` as an observed fact.
   */
  private spendObserved = false;
  /** Last-observed cumulative token count. Meaningless while `spendObserved` is `false`. */
  private tokensThisRun = 0;
  /** Last-observed cumulative loop-iteration count. Meaningless while `spendObserved` is `false`. */
  private loopIterations = 0;
  /** Last-observed cumulative cost, or `undefined` when cost is unobservable. */
  private costThisRun: number | undefined = undefined;
  /**
   * `undefined` until {@link observeDailyBaseline} has read the cross-run
   * counter. While absent, `snapshot` omits BOTH `invocationsToday` and
   * `todayCountedAt`, so a declared `invocationsPerDay` escalates on
   * `budget.invocations-per-day.unobservable` — the honest outcome, since
   * nothing has read yesterday's file yet.
   */
  private dailyBaseline: AgentDailyBaseline | undefined = undefined;

  /**
   * Builds a frozen, omit-only ledger snapshot for the caller-sampled
   * instant `now`.
   *
   * @param now - The instant the caller sampled once for this evaluation
   *   turn. The ledger never reads a clock itself.
   * @returns A frozen `Core.M3LAgentRunLedger` with no own key holding
   *   `undefined`.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const snapshot = new AgentRunLedger().snapshot(Date.now());
   * // Object.hasOwn(snapshot, "tokensThisRun") === false — unobservable, not zero
   * ```
   */
  snapshot(now: number): Core.M3LAgentRunLedger {
    return Object.freeze({
      now,
      invocationsThisRun: this.invocationsThisRun,
      dryRunCompletedShapes: Object.freeze([...this.dryRunShapes]),
      // Conditional spread, never `decisionLogAvailable: this.…`: an own key
      // holding `undefined` is malformed input, not an absent observation.
      ...(this.decisionLogAvailable === undefined
        ? {}
        : { decisionLogAvailable: this.decisionLogAvailable }),
      // `tokensThisRun`/`loopIterations` are present the moment spend has
      // ever been observed, even at a seeded zero. `costThisRun` needs the
      // extra "and it was priceable" condition — cost can go unobservable
      // independently of tokens/iterations.
      ...(this.spendObserved
        ? {
            tokensThisRun: this.tokensThisRun,
            loopIterations: this.loopIterations,
          }
        : {}),
      ...(this.spendObserved && this.costThisRun !== undefined
        ? { costThisRun: this.costThisRun }
        : {}),
      // ONE spread emitting BOTH fields, never two independent spreads. The
      // evaluator checks presence of all three of `invocationsToday` /
      // `todayCountedAt` / `now` BEFORE it applies the UTC-day window, so a
      // half-present pair is unobservable anyway — and it would *look*
      // observed to anyone reading the snapshot, which is strictly worse than
      // being plainly absent. Today's count is COMPOSED here rather than
      // stored: the baseline is what happened before this run, and
      // `invocationsThisRun` is what has happened since, and they are counts
      // of the same event.
      ...(this.dailyBaseline === undefined
        ? {}
        : {
            invocationsToday:
              this.dailyBaseline.invocationsToday + this.invocationsThisRun,
            todayCountedAt: this.dailyBaseline.countedAt,
          }),
    });
  }

  /**
   * Counts one agent invocation onto the cumulative run counter.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.recordInvocation();
   * ```
   */
  recordInvocation(): void {
    this.invocationsThisRun += 1;
  }

  /**
   * The invocations counted onto this run so far — the same number
   * {@link snapshot} emits as `invocationsThisRun`.
   *
   * @remarks
   * It exists because `Core.M3LAgentRunLedger` types **every** field optional
   * (the library's presence contract is `Object.hasOwn`), so
   * `snapshot(now).invocationsThisRun` is `number | undefined` at the type
   * level even though this ledger always emits it. A caller that needs the
   * count — `steps/daily-counter`'s `record` — would otherwise reach for
   * `?? 0`, and a defaulted observation is exactly the mistake the whole
   * omit-vs-zero discipline exists to prevent.
   *
   * @returns The cumulative invocation count for this run.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.recordInvocation();
   * ledger.invocationCount; // 1
   * ```
   */
  get invocationCount(): number {
    return this.invocationsThisRun;
  }

  /**
   * Records the cross-run per-day starting point read off
   * `steps/daily-counter`, making `invocationsPerDay` OBSERVABLE for the rest
   * of the run.
   *
   * @remarks
   * Call this **before** the first `Core.evaluateAgentAction` of the run —
   * including both phases of the decision-log preflight. Budgets are step 3
   * of the evaluator and the decision-log rule is step 3b, so an unseeded
   * ledger escalates on `budget.invocations-per-day.unobservable` at *both*
   * preflight phases and the two-phase bootstrap can never resolve.
   *
   * Nothing is seeded speculatively: a baseline is only ever passed here
   * after the counter file has actually been read (an absent file reads as a
   * genuine, observed zero for today, which is a different claim from "not
   * measured").
   *
   * @param baseline - See {@link AgentDailyBaseline}.
   * @throws {@link M3LAgentOperatorCliError} coded
   *   `ERR_AGENT_OPERATOR_BUDGET_STATE` when either field is not a
   *   non-negative safe integer.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.observeDailyBaseline({ invocationsToday: 12, countedAt: Date.now() });
   * ```
   */
  observeDailyBaseline(baseline: AgentDailyBaseline): void {
    assertBaselineField(baseline.invocationsToday, "invocationsToday");
    assertBaselineField(baseline.countedAt, "countedAt");
    this.dailyBaseline = baseline;
  }

  /**
   * Records whether the decision log has been observed as writable.
   *
   * @param available - `true` once an entry has actually been appended
   *   (the write **is** the observation), `false` once a write has failed.
   *   Never call this speculatively: a seeded `true` turns the bootstrap
   *   probe into a lie.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.observeDecisionLog(true);
   * ```
   */
  observeDecisionLog(available: boolean): void {
    this.decisionLogAvailable = available;
  }

  /**
   * Records that a dry-run probe completed for `shapeKey`, satisfying the
   * policy's `dryRunFirst` requirement for that action shape.
   *
   * @remarks
   * Deduplication runs **before** the bound, so re-recording an
   * already-known shape adds nothing and cannot push the list past the
   * ceiling. At the ceiling a genuinely new shape is **rejected**, never
   * dropped: silently truncating the list would reintroduce the
   * dry-run-first requirement for a shape the caller already cleared.
   *
   * @param shapeKey - A key minted by `Core.agentActionShapeKey`.
   * @throws {@link M3LAgentOperatorCliError} coded
   *   `ERR_AGENT_OPERATOR_DECISION_LOG` when a new shape would exceed
   *   `Core.M3L_AGENT_MAX_DRY_RUN_SHAPES`.
   *
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common";
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.recordDryRunShape(
   *   Core.agentActionShapeKey({ script: "json-etl", kind: "mutating" }),
   * );
   * ```
   */
  recordDryRunShape(shapeKey: string): void {
    if (this.dryRunShapes.has(shapeKey)) return;
    if (this.dryRunShapes.size >= Core.M3L_AGENT_MAX_DRY_RUN_SHAPES) {
      throw new M3LAgentOperatorCliError(
        "the run ledger cannot record another completed dry-run shape: the library's per-run shape ceiling is already reached",
        "ERR_AGENT_OPERATOR_DECISION_LOG",
        // The key itself is derived from an action under judgement, so it is
        // never echoed — only the ceiling that was hit.
        { context: { ceiling: Core.M3L_AGENT_MAX_DRY_RUN_SHAPES } },
      );
    }
    this.dryRunShapes.add(shapeKey);
  }

  /**
   * Records the metering seam's latest ABSOLUTE run totals — never a delta.
   *
   * @remarks
   * The first call is what makes `tokensThisRun`, `loopIterations`, and
   * (when priceable) `costThisRun` observable at all: before it,
   * {@link snapshot} omits all three entirely (see the module doc). Every
   * field is validated at this boundary — a non-finite/negative/fractional
   * `tokensThisRun` or `loopIterations`, or a negative/non-finite
   * `costThisRun` — so a metering bug surfaces as OUR error here rather than
   * as a confusing policy-evaluation failure downstream. A regression (a
   * lower cumulative `tokensThisRun`/`loopIterations` than the last observed
   * value) is rejected for the same reason: it would silently under-report
   * spend and widen a budget ceiling.
   *
   * @param spend - The metering seam's latest absolute totals.
   * @throws {@link M3LAgentOperatorCliError} coded
   *   `ERR_AGENT_OPERATOR_DECISION_LOG` on an invalid or regressed value.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.observeSpend({ tokensThisRun: 0, loopIterations: 0, costThisRun: 0 });
   * ```
   */
  observeSpend(spend: AgentRunSpend): void {
    assertNonNegativeSafeInteger(spend.tokensThisRun, "tokensThisRun");
    assertNonNegativeSafeInteger(spend.loopIterations, "loopIterations");
    assertValidCost(spend.costThisRun);
    if (this.spendObserved) {
      assertNoRegression(
        this.tokensThisRun,
        spend.tokensThisRun,
        "tokensThisRun",
      );
      assertNoRegression(
        this.loopIterations,
        spend.loopIterations,
        "loopIterations",
      );
    }
    this.tokensThisRun = spend.tokensThisRun;
    this.loopIterations = spend.loopIterations;
    this.costThisRun = spend.costThisRun;
    this.spendObserved = true;
  }
}
