/**
 * Tests for `steps/run-ledger` — the mutable run counters `agent-operator`
 * keeps, and the frozen `Core.M3LAgentRunLedger` snapshots it hands to
 * `Core.evaluateAgentAction`.
 *
 * Written RED, before `steps/run-ledger.ts` existed; the module now exists and
 * these tests pass, so they stand as the regression pin on its contract —
 * every assertion below is the behaviour the module was built to satisfy, not
 * a description of work still outstanding.
 *
 * The contract these tests pin:
 *
 * ```ts
 * export interface AgentRunLedgerGateDelta {
 *   readonly invocations: number;
 *   readonly dryRunShapes: number;
 * }
 * export class AgentRunLedger {
 *   snapshot(now: number): Core.M3LAgentRunLedger; // frozen, omit-only
 *   recordInvocation(): void;
 *   observeDecisionLog(available: boolean): void;
 *   recordDryRunShape(shapeKey: string): void;
 *   takeGateDelta(): AgentRunLedgerGateDelta; // deltas since the last call, then resets
 * }
 * ```
 *
 * Two library rules drive nearly every assertion below:
 *
 * 1. **Omitted is not zero — omitted is unobservable.** A ledger field the
 *    script cannot honestly observe must be *absent* (`Object.hasOwn` false),
 *    which makes a declared budget escalate on its `.unobservable` rule id
 *    instead of silently passing. `toBeUndefined()` cannot tell the two apart,
 *    so these tests use `Object.hasOwn` throughout.
 * 2. **A present key holding `undefined` is malformed and throws.** The
 *    library reads presence with `Object.hasOwn`, so under
 *    `exactOptionalPropertyTypes` an absent field must be omitted with a
 *    conditional spread, never assigned `undefined`. The only real proof of
 *    that discipline is a round-trip through the *real*
 *    `Core.evaluateAgentAction`, which is why the evaluator is never faked here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import { decisionLogPolicy, minimalPolicy } from "../support/policyFixtures.js";

/** A fixed, caller-sampled instant. The evaluator reads no clock; nor may the ledger. */
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

/** The read-only bootstrap action every ledger snapshot below is judged against. */
function bootstrapAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "explain-policy",
    kind: "read-only",
    parameterNames: ["command"],
  };
}

/** The health-check action, granted by {@link decisionLogPolicy}. */
function healthCheckAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
    parameterNames: ["command"],
  };
}

/** A policy declaring only `invocationsPerRun`, so no other ceiling masks it. */
function budgetPolicyForInvocations(ceiling: number): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        operations: ["health-check", "explain-policy"],
        readOnlyOperations: ["health-check", "explain-policy"],
      },
    ],
    budgets: { invocationsPerRun: ceiling },
  });
}

/**
 * Every own key of `snapshot` whose value is `undefined` — the malformed shape
 * that makes the library throw. Must always be empty.
 */
function ownKeysHoldingUndefined(
  snapshot: Core.M3LAgentRunLedger,
): readonly string[] {
  return Object.entries(snapshot)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
}

/** `count` distinct, real shape keys, minted through the library's own hasher. */
function shapeKeys(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) =>
    Core.agentActionShapeKey({
      script: "agent-operator",
      operation: `probe-${String(index)}`,
      kind: "read-only",
    }),
  );
}

/** The first key of {@link shapeKeys}, guarded for `noUncheckedIndexedAccess`. */
function oneShapeKey(): string {
  const key = shapeKeys(1)[0];
  if (key === undefined) throw new Error("shapeKeys(1) produced no key");
  return key;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentRunLedger — a virgin snapshot omits what it cannot observe", () => {
  // Absent, not zero: this script has no token/cost metering and no cross-run
  // day counter, and reporting a fabricated 0 for any of them would fail OPEN
  // — it would tell the evaluator a budget is satisfied when nothing has
  // actually been measured.
  // The field names are typed `keyof Core.M3LAgentRunLedger`, not plain
  // strings: every ledger field is optional and the probe is `Object.hasOwn`,
  // so a library rename would leave a string-typed row passing vacuously
  // (`Object.hasOwn(snapshot, "tokensThisRunOld")` is `false` for the same
  // reason the assertion wants it to be `false`). Typed, a rename is a
  // compile error here.
  const OMITTED_LEDGER_FIELDS: ReadonlyArray<
    [field: keyof Core.M3LAgentRunLedger, why: string]
  > = [
    ["tokensThisRun", "no token metering exists in this slice"],
    ["costThisRun", "no cost metering exists in this slice"],
    ["invocationsToday", "no cross-run day counter exists"],
    ["todayCountedAt", "no cross-run day counter exists"],
    ["decisionLogAvailable", "the log has not been observed yet"],
    ["loopIterations", "no model loop has run yet"],
  ];

  it.each(OMITTED_LEDGER_FIELDS)("omits %s (%s)", (field, _why) => {
    const snapshot = new AgentRunLedger().snapshot(NOW);

    expect(Object.hasOwn(snapshot, field)).toBe(false);
  });

  it("carries the caller-sampled now verbatim", () => {
    const snapshot = new AgentRunLedger().snapshot(NOW);

    expect(Object.hasOwn(snapshot, "now")).toBe(true);
    expect(snapshot.now).toBe(NOW);
  });

  it("never emits an own key holding undefined, in any observed state", () => {
    const ledger = new AgentRunLedger();

    expect(ownKeysHoldingUndefined(ledger.snapshot(NOW))).toEqual([]);

    ledger.recordInvocation();
    ledger.observeDecisionLog(true);
    ledger.recordDryRunShape(oneShapeKey());

    expect(ownKeysHoldingUndefined(ledger.snapshot(NOW))).toEqual([]);
  });
});

describe("AgentRunLedger — snapshots survive the real evaluator", () => {
  // The only real proof of the omit-vs-present-undefined discipline: the
  // library validates the ledger with `Object.hasOwn`, so a snapshot that sets
  // a key to `undefined` throws here rather than being read as absent.
  it("evaluates a virgin snapshot without throwing", () => {
    const decision = Core.evaluateAgentAction({
      action: bootstrapAction(),
      policy: minimalPolicy(),
      run: new AgentRunLedger().snapshot(NOW),
    });

    expect(decision.verdict).toBe("auto-approved");
  });

  it("evaluates a fully exercised snapshot without throwing", () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    ledger.recordInvocation();
    ledger.observeDecisionLog(true);
    for (const key of shapeKeys(3)) ledger.recordDryRunShape(key);

    const decision = Core.evaluateAgentAction({
      action: bootstrapAction(),
      policy: minimalPolicy(),
      run: ledger.snapshot(NOW),
    });

    expect(Core.isAgentActionAutoApproved(decision)).toBe(true);
  });
});

describe("AgentRunLedger — recordInvocation", () => {
  it("counts invocations onto invocationsThisRun", () => {
    const ledger = new AgentRunLedger();

    ledger.recordInvocation();
    ledger.recordInvocation();
    ledger.recordInvocation();

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "invocationsThisRun")).toBe(true);
    expect(snapshot.invocationsThisRun).toBe(3);
  });

  it("keeps invocationsThisRun a safe integer the evaluator reads as a budget observation", () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    ledger.recordInvocation();

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      // A ceiling of 2, already reached: budgets are reject-AT
      // (`observed >= ceiling`), the opposite polarity to the structural
      // reject-above ceilings.
      policy: budgetPolicyForInvocations(2),
      run: ledger.snapshot(NOW),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.invocations-per-run");
  });
});

describe("AgentRunLedger — observeDecisionLog", () => {
  it.each([[true], [false]])(
    "records the observation %s as a present key",
    (available) => {
      const ledger = new AgentRunLedger();

      ledger.observeDecisionLog(available);

      const snapshot = ledger.snapshot(NOW);
      expect(Object.hasOwn(snapshot, "decisionLogAvailable")).toBe(true);
      expect(snapshot.decisionLogAvailable).toBe(available);
    },
  );

  // The three states are semantically distinct to the library, not two:
  // observed-unavailable is a hard escalation, unobserved is an
  // `.unobservable` escalation, and observed-available clears the rule
  // entirely. A ledger that conflated `false` with absent would pass the
  // presence assertion above and still be wrong here.
  it.each([
    [
      "unobserved",
      (_ledger: AgentRunLedger): void => {
        // deliberately no observation
      },
      "decision-log-unavailable.unobservable",
    ],
    [
      "observed unavailable",
      (ledger: AgentRunLedger): void => {
        ledger.observeDecisionLog(false);
      },
      "decision-log-unavailable",
    ],
  ])("an %s log escalates on rule %s", (_label, observe, expectedRule) => {
    const ledger = new AgentRunLedger();
    observe(ledger);

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: decisionLogPolicy(),
      run: ledger.snapshot(NOW),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe(expectedRule);
  });

  it("clears both decision-log rules once the log is observed available", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDecisionLog(true);

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: decisionLogPolicy(),
      run: ledger.snapshot(NOW),
    });

    expect(decision.rule).not.toBe("decision-log-unavailable");
    expect(decision.rule).not.toBe("decision-log-unavailable.unobservable");
    expect(Core.isAgentActionAutoApproved(decision)).toBe(true);
  });
});

describe("AgentRunLedger — recordDryRunShape", () => {
  it("deduplicates repeated shape keys", () => {
    const ledger = new AgentRunLedger();
    const key = oneShapeKey();

    ledger.recordDryRunShape(key);
    ledger.recordDryRunShape(key);
    ledger.recordDryRunShape(key);

    expect(ledger.snapshot(NOW).dryRunCompletedShapes).toEqual([key]);
  });

  it("accepts exactly M3L_AGENT_MAX_DRY_RUN_SHAPES shapes and the evaluator accepts the snapshot", () => {
    const ledger = new AgentRunLedger();
    for (const key of shapeKeys(Core.M3L_AGENT_MAX_DRY_RUN_SHAPES)) {
      ledger.recordDryRunShape(key);
    }

    const snapshot = ledger.snapshot(NOW);
    expect(snapshot.dryRunCompletedShapes).toHaveLength(
      Core.M3L_AGENT_MAX_DRY_RUN_SHAPES,
    );
    // The ledger's ceiling must be the library's ceiling: 256 is accepted by
    // both (reject-ABOVE), so this snapshot must not throw.
    expect(() =>
      Core.evaluateAgentAction({
        action: bootstrapAction(),
        policy: minimalPolicy(),
        run: snapshot,
      }),
    ).not.toThrow();
  });

  it("rejects the shape above the ceiling rather than silently dropping it", () => {
    const ledger = new AgentRunLedger();
    const keys = shapeKeys(Core.M3L_AGENT_MAX_DRY_RUN_SHAPES + 1);
    for (const key of keys.slice(0, Core.M3L_AGENT_MAX_DRY_RUN_SHAPES)) {
      ledger.recordDryRunShape(key);
    }
    const overflow = keys[Core.M3L_AGENT_MAX_DRY_RUN_SHAPES];
    if (overflow === undefined) throw new Error("missing overflow shape key");

    let thrown: unknown;
    try {
      ledger.recordDryRunShape(overflow);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    // Truncation is the failure mode this guards: silently dropping a
    // completed shape reintroduces the dry-run-first requirement for a shape
    // the caller already cleared.
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).toHaveLength(
      Core.M3L_AGENT_MAX_DRY_RUN_SHAPES,
    );
  });

  it("does not reject a duplicate recorded while already at the ceiling", () => {
    const ledger = new AgentRunLedger();
    const keys = shapeKeys(Core.M3L_AGENT_MAX_DRY_RUN_SHAPES);
    for (const key of keys) ledger.recordDryRunShape(key);
    const first = keys[0];
    if (first === undefined) throw new Error("missing shape key");

    // Dedupe runs before the bound: re-recording an already-known shape adds
    // nothing, so it cannot push the list above the ceiling.
    expect(() => {
      ledger.recordDryRunShape(first);
    }).not.toThrow();
  });
});

describe("AgentRunLedger — takeGateDelta", () => {
  it("returns what accumulated since the previous call and then resets", () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    ledger.recordInvocation();
    ledger.recordDryRunShape(oneShapeKey());

    const first = ledger.takeGateDelta();
    expect(first.invocations).toBe(2);
    expect(first.dryRunShapes).toBe(1);

    const second = ledger.takeGateDelta();
    expect(second.invocations).toBe(0);
    expect(second.dryRunShapes).toBe(0);
    // Two consecutive calls with no activity between them must differ: a
    // `takeGateDelta` that returned a running total instead of a delta would
    // pass every assertion above and fail this one.
    expect(second).not.toEqual(first);
  });

  it("keeps the cumulative snapshot counters intact across a take", () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    ledger.takeGateDelta();
    ledger.recordInvocation();

    // The delta reset is bookkeeping for the gate, not a reset of the run.
    expect(ledger.snapshot(NOW).invocationsThisRun).toBe(2);
  });
});

describe("AgentRunLedger — the caller owns the clock", () => {
  it("never reads Date.now, in any operation", () => {
    const ledger = new AgentRunLedger();
    const key = oneShapeKey();
    const nowSpy = vi.spyOn(Date, "now");

    ledger.recordInvocation();
    ledger.observeDecisionLog(true);
    ledger.recordDryRunShape(key);
    ledger.takeGateDelta();
    ledger.snapshot(NOW);

    // `evaluateAgentAction` reads no clock — the caller samples `now` once and
    // passes it in. A ledger that sampled its own would let two evaluations in
    // one turn disagree about the per-day window.
    expect(nowSpy).not.toHaveBeenCalled();
  });
});

describe("AgentRunLedger — snapshots are frozen and independent", () => {
  it("freezes the snapshot and its shape list", () => {
    const ledger = new AgentRunLedger();
    ledger.recordDryRunShape(oneShapeKey());
    const snapshot = ledger.snapshot(NOW);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.dryRunCompletedShapes)).toBe(true);
    expect(() => Object.assign(snapshot, { invocationsThisRun: 99 })).toThrow(
      TypeError,
    );
  });

  it("hands out a fresh object per call, so an older snapshot never mutates", () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    const first = ledger.snapshot(NOW);

    ledger.recordInvocation();
    const second = ledger.snapshot(NOW + 1000);

    expect(second).not.toBe(first);
    expect(first.invocationsThisRun).toBe(1);
    expect(second.invocationsThisRun).toBe(2);
    expect(first.now).toBe(NOW);
    expect(second.now).toBe(NOW + 1000);
  });
});
