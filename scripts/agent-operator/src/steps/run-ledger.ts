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
 * 2. **Omitted means *unobservable*, not zero.** This slice has no token or
 *    cost metering and no cross-run day counter, so those fields stay absent
 *    and a deployment that declares the matching budget escalates on that
 *    budget's `.unobservable` rule. Reporting a fabricated `0` would fail
 *    OPEN — it would tell the evaluator a ceiling is satisfied when nothing
 *    was ever measured.
 *
 * The ledger reads **no clock**: `now` is sampled once by the caller and
 * passed in, so two evaluations in one turn cannot disagree about the
 * per-day window.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";

/**
 * What accumulated on the ledger since the previous
 * {@link AgentRunLedger.takeGateDelta} call — the per-turn increments a gate
 * reports, as opposed to the cumulative counters a snapshot carries.
 *
 * @example
 * ```ts
 * import { AgentRunLedger } from "./run-ledger.js";
 *
 * const ledger = new AgentRunLedger();
 * ledger.recordInvocation();
 * const delta = ledger.takeGateDelta();
 * // delta.invocations === 1, delta.dryRunShapes === 0
 * ```
 */
export interface AgentRunLedgerGateDelta {
  /** Invocations recorded since the previous take. */
  readonly invocations: number;
  /** Newly-recorded dry-run shape keys since the previous take. */
  readonly dryRunShapes: number;
}

/**
 * The mutable run counters, and the frozen snapshots the policy evaluator
 * judges actions against.
 *
 * @remarks
 * Every snapshot is a fresh object, so an older snapshot never mutates under
 * a caller that kept it (an audit record must stay what it recorded). The
 * fields that are *always* present are the two this script genuinely
 * observes: `now` (handed in) and `invocationsThisRun` /
 * `dryRunCompletedShapes` (counted here). Everything else is omitted until
 * observed.
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
  /** Invocations since the last {@link AgentRunLedger.takeGateDelta}. */
  private invocationsSinceGate = 0;
  /** Newly-recorded shape keys since the last {@link AgentRunLedger.takeGateDelta}. */
  private dryRunShapesSinceGate = 0;
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
    });
  }

  /**
   * Counts one agent invocation onto both the cumulative run counter and the
   * pending gate delta.
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
    this.invocationsSinceGate += 1;
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
    this.dryRunShapesSinceGate += 1;
  }

  /**
   * Returns what accumulated since the previous call and resets the delta.
   *
   * @remarks
   * The reset is bookkeeping for the gate only — the cumulative snapshot
   * counters are untouched, so a take never rewinds the run.
   *
   * @returns The frozen {@link AgentRunLedgerGateDelta} for the elapsed
   *   window.
   *
   * @example
   * ```ts
   * import { AgentRunLedger } from "./run-ledger.js";
   *
   * const ledger = new AgentRunLedger();
   * ledger.recordInvocation();
   * ledger.takeGateDelta(); // { invocations: 1, dryRunShapes: 0 }
   * ledger.takeGateDelta(); // { invocations: 0, dryRunShapes: 0 }
   * ```
   */
  takeGateDelta(): AgentRunLedgerGateDelta {
    const delta: AgentRunLedgerGateDelta = Object.freeze({
      invocations: this.invocationsSinceGate,
      dryRunShapes: this.dryRunShapesSinceGate,
    });
    this.invocationsSinceGate = 0;
    this.dryRunShapesSinceGate = 0;
    return delta;
  }
}
