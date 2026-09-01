/**
 * Tests for `steps/run-ledger` — the mutable run counters `agent-operator`
 * keeps, and the frozen `Core.M3LAgentRunLedger` snapshots it hands to
 * `Core.evaluateAgentAction`.
 *
 * Written RED, before `steps/run-ledger.ts` existed; the module now exists and
 * these tests pass, so they stand as the regression pin on its contract —
 * every assertion below is the behaviour the module was built to satisfy, not
 * a description of work still outstanding. The metered-spend surface below
 * (`AgentRunSpend`/`observeSpend`) is itself written RED, ahead of its own
 * implementation, for the same reason.
 *
 * `takeGateDelta`/`AgentRunLedgerGateDelta` were REMOVED (V8 final slice):
 * the method's only consumer was its own tests, since
 * `AgentDecisionRecordInput` carries no field for a per-gate delta — the
 * evaluator reads absolute counters, not deltas.
 *
 * The contract these tests pin:
 *
 * ```ts
 * export interface AgentRunSpend {
 *   readonly tokensThisRun: number;
 *   readonly loopIterations: number;
 *   readonly costThisRun: number | undefined; // undefined => unobservable
 * }
 * export class AgentRunLedger {
 *   snapshot(now: number): Core.M3LAgentRunLedger; // frozen, omit-only
 *   recordInvocation(): void;
 *   observeDecisionLog(available: boolean): void;
 *   recordDryRunShape(shapeKey: string): void;
 *   observeSpend(spend: AgentRunSpend): void; // fail-closed until called once
 *   observeDailyBaseline(baseline: AgentDailyBaseline): void; // ditto
 *   get invocationCount(): number;
 * }
 * ```
 *
 * Two library rules drive nearly every assertion below:
 *
 * 1. **Omitted is not zero — omitted is unobservable.** A ledger field the
 *    script cannot honestly observe must be *absent* (`Object.hasOwn` false),
 *    which makes a declared budget escalate on its `.unobservable` rule id
 *    instead of silently passing. `toBeUndefined()` cannot tell the two apart,
 *    so these tests use `Object.hasOwn` throughout. `tokensThisRun`,
 *    `costThisRun`, and `loopIterations` are the sharpest case of this rule:
 *    they stay absent until `observeSpend` is called even once, so a run with
 *    no metering seam escalates on the matching `budget.*.unobservable` rule
 *    rather than reading as zero spend.
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
import type {
  AgentDailyBaseline,
  AgentRunSpend,
} from "../../src/steps/run-ledger.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import {
  budgetPolicy,
  decisionLogPolicy,
  minimalPolicy,
} from "../support/policyFixtures.js";

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
    ["tokensThisRun", "observeSpend has not been called yet"],
    ["costThisRun", "observeSpend has not been called yet"],
    ["invocationsToday", "observeDailyBaseline has not been called yet"],
    ["todayCountedAt", "observeDailyBaseline has not been called yet"],
    ["decisionLogAvailable", "the log has not been observed yet"],
    ["loopIterations", "observeSpend has not been called yet"],
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
    ledger.observeDailyBaseline({ invocationsToday: 3, countedAt: NOW });

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

/** A well-formed observation with every field present, for tests that don't care about the values. */
function validSpend(overrides: Partial<AgentRunSpend> = {}): AgentRunSpend {
  return {
    tokensThisRun: 100,
    loopIterations: 2,
    costThisRun: 0.5,
    ...overrides,
  };
}

describe("AgentRunLedger — observeSpend: fail-closed until observed", () => {
  // THE single most important assertion in this wave: a run that never wires
  // up a metering seam must escalate on the matching `budget.*.unobservable`
  // rule, never read as zero spend. `Object.hasOwn` is required here, not
  // `toBeUndefined()` — see the module-doc rule 1 above.
  it("[FAIL-CLOSED] omits tokensThisRun, costThisRun, and loopIterations as own keys until observeSpend has been called at least once", () => {
    const snapshot = new AgentRunLedger().snapshot(NOW);

    expect(Object.hasOwn(snapshot, "tokensThisRun")).toBe(false);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(false);
    expect(Object.hasOwn(snapshot, "loopIterations")).toBe(false);
  });

  it.each([
    ["tokensPerRun", "budget.tokens-per-run.unobservable"],
    ["costPerRun", "budget.cost-per-run.unobservable"],
    ["loopIterations", "budget.loop-iterations.unobservable"],
  ])(
    "a policy declaring only %s escalates on %s before any observeSpend call",
    (budgetKey, expectedRule) => {
      const ledger = new AgentRunLedger();

      const decision = Core.evaluateAgentAction({
        action: healthCheckAction(),
        policy: budgetPolicy({ [budgetKey]: 1000 }),
        run: ledger.snapshot(NOW),
      });

      expect(decision.verdict).toBe("escalate");
      expect(decision.rule).toBe(expectedRule);
    },
  );

  // The structural guarantee: constructing the metered invoker (not any
  // particular call count) is what makes zero spend an OBSERVED fact. This
  // ledger-level test pins the ledger half of that guarantee — the
  // `createMeteredInvoker` half is pinned in `metering-invoker.test.ts`.
  it("makes tokensThisRun, costThisRun, and loopIterations observable at zero the moment observeSpend is first called, auto-approving a policy that declares those budgets", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDecisionLog(true);

    ledger.observeSpend({
      tokensThisRun: 0,
      loopIterations: 0,
      costThisRun: 0,
    });

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "tokensThisRun")).toBe(true);
    expect(snapshot.tokensThisRun).toBe(0);
    expect(Object.hasOwn(snapshot, "loopIterations")).toBe(true);
    expect(snapshot.loopIterations).toBe(0);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(true);
    expect(snapshot.costThisRun).toBe(0);

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: budgetPolicy({
        tokensPerRun: 1000,
        costPerRun: 5,
        loopIterations: 10,
      }),
      run: snapshot,
    });

    expect(Core.isAgentActionAutoApproved(decision)).toBe(true);
  });

  it("carries the latest observed tokensThisRun and loopIterations onto every subsequent snapshot", () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend({
      tokensThisRun: 40,
      loopIterations: 1,
      costThisRun: 0.1,
    });
    ledger.observeSpend({
      tokensThisRun: 90,
      loopIterations: 3,
      costThisRun: 0.3,
    });

    const snapshot = ledger.snapshot(NOW);
    expect(snapshot.tokensThisRun).toBe(90);
    expect(snapshot.loopIterations).toBe(3);
    expect(snapshot.costThisRun).toBe(0.3);
  });

  it("omits costThisRun once observed undefined, while still emitting tokensThisRun and loopIterations as present keys", () => {
    const ledger = new AgentRunLedger();

    ledger.observeSpend({
      tokensThisRun: 500,
      loopIterations: 2,
      costThisRun: undefined,
    });

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "tokensThisRun")).toBe(true);
    expect(snapshot.tokensThisRun).toBe(500);
    expect(Object.hasOwn(snapshot, "loopIterations")).toBe(true);
    expect(snapshot.loopIterations).toBe(2);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(false);
  });

  it("an unobservable cost escalates on budget.cost-per-run.unobservable even while tokensThisRun and loopIterations are observed and satisfied", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDecisionLog(true);
    ledger.observeSpend({
      tokensThisRun: 10,
      loopIterations: 1,
      costThisRun: undefined,
    });

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: budgetPolicy({ tokensPerRun: 1000, costPerRun: 5 }),
      run: ledger.snapshot(NOW),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.cost-per-run.unobservable");
  });

  it("never emits an own key holding undefined for costThisRun, in any observed state", () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend({
      tokensThisRun: 1,
      loopIterations: 1,
      costThisRun: undefined,
    });

    expect(ownKeysHoldingUndefined(ledger.snapshot(NOW))).toEqual([]);
  });

  const INVALID_SPEND_CASES: ReadonlyArray<
    [label: string, spend: AgentRunSpend]
  > = [
    [
      "a non-finite tokensThisRun",
      validSpend({ tokensThisRun: Number.POSITIVE_INFINITY }),
    ],
    ["a NaN tokensThisRun", validSpend({ tokensThisRun: Number.NaN })],
    ["a negative tokensThisRun", validSpend({ tokensThisRun: -1 })],
    [
      "a non-safe-integer (fractional) tokensThisRun",
      validSpend({ tokensThisRun: 1.5 }),
    ],
    [
      "a non-finite loopIterations",
      validSpend({ loopIterations: Number.POSITIVE_INFINITY }),
    ],
    ["a NaN loopIterations", validSpend({ loopIterations: Number.NaN })],
    ["a negative loopIterations", validSpend({ loopIterations: -1 })],
    [
      "a non-safe-integer (fractional) loopIterations",
      validSpend({ loopIterations: 2.2 }),
    ],
    ["a negative costThisRun", validSpend({ costThisRun: -0.01 })],
    [
      "a non-finite costThisRun",
      validSpend({ costThisRun: Number.POSITIVE_INFINITY }),
    ],
    ["a NaN costThisRun", validSpend({ costThisRun: Number.NaN })],
  ];

  it.each(INVALID_SPEND_CASES)(
    "rejects observeSpend given %s, naming OUR bug rather than surfacing as a policy-evaluation error",
    (_label, spend) => {
      const ledger = new AgentRunLedger();

      let thrown: unknown;
      try {
        ledger.observeSpend(spend);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_DECISION_LOG",
      );
    },
  );

  it("accepts a fractional costThisRun (cost is the one field allowed to be non-integer)", () => {
    const ledger = new AgentRunLedger();

    expect(() => {
      ledger.observeSpend(validSpend({ costThisRun: 1.23456 }));
    }).not.toThrow();
    expect(ledger.snapshot(NOW).costThisRun).toBe(1.23456);
  });

  it("rejects a regression: a tokensThisRun lower than the last observed value", () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend(validSpend({ tokensThisRun: 100 }));

    let thrown: unknown;
    try {
      ledger.observeSpend(validSpend({ tokensThisRun: 50 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    // The regression must not corrupt the last-good observation.
    expect(ledger.snapshot(NOW).tokensThisRun).toBe(100);
  });

  it("rejects a regression: a loopIterations lower than the last observed value", () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend(validSpend({ loopIterations: 3 }));

    let thrown: unknown;
    try {
      ledger.observeSpend(validSpend({ loopIterations: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    expect(ledger.snapshot(NOW).loopIterations).toBe(3);
  });

  it("does not reject observeSpend called again with an equal tokensThisRun and loopIterations", () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend(validSpend({ tokensThisRun: 100, loopIterations: 2 }));

    expect(() => {
      ledger.observeSpend(
        validSpend({ tokensThisRun: 100, loopIterations: 2 }),
      );
    }).not.toThrow();
  });
});

describe("AgentRunLedger — observeDailyBaseline: the per-day pair", () => {
  /** A baseline anchored to the same UTC day every assertion evaluates under. */
  function baseline(invocationsToday: number): AgentDailyBaseline {
    return { invocationsToday, countedAt: NOW };
  }

  it("[FAIL-CLOSED] omits invocationsToday and todayCountedAt until observeDailyBaseline has been called", () => {
    const snapshot = new AgentRunLedger().snapshot(NOW);

    expect(Object.hasOwn(snapshot, "invocationsToday")).toBe(false);
    expect(Object.hasOwn(snapshot, "todayCountedAt")).toBe(false);
    expect(
      Core.evaluateAgentAction({
        action: healthCheckAction(),
        policy: budgetPolicy({ invocationsPerDay: 400 }),
        run: snapshot,
      }).rule,
    ).toBe("budget.invocations-per-day.unobservable");
  });

  // The pair must be all-or-nothing. The evaluator checks presence of all
  // three of invocationsToday/todayCountedAt/now BEFORE it applies the
  // UTC-day window, so a half-present pair is unobservable anyway — and it
  // *looks* observed to anyone reading the snapshot, which is strictly worse
  // than being plainly absent. Splitting the single conditional spread in
  // `snapshot()` into two independent spreads fails this.
  it.each([
    ["virgin", false, false, false],
    ["invocations only", true, false, false],
    ["spend only", false, true, false],
    ["baseline only", false, false, true],
    ["all three", true, true, true],
  ] as ReadonlyArray<
    readonly [
      label: string,
      invocations: boolean,
      spend: boolean,
      daily: boolean,
    ]
  >)(
    "emits invocationsToday and todayCountedAt together or not at all (%s)",
    (_label, invocations, spend, daily) => {
      const ledger = new AgentRunLedger();
      if (invocations) ledger.recordInvocation();
      if (spend) {
        ledger.observeSpend({
          tokensThisRun: 10,
          loopIterations: 1,
          costThisRun: 0.5,
        });
      }
      if (daily) ledger.observeDailyBaseline(baseline(5));

      const snapshot = ledger.snapshot(NOW);

      expect(Object.hasOwn(snapshot, "invocationsToday")).toBe(
        Object.hasOwn(snapshot, "todayCountedAt"),
      );
      expect(Object.hasOwn(snapshot, "invocationsToday")).toBe(daily);
      expect(ownKeysHoldingUndefined(snapshot)).toEqual([]);
    },
  );

  it("composes the baseline with this run's own invocations on every snapshot", () => {
    // A snapshot emitting the bare baseline would under-count within a long
    // run and fail OPEN at the ceiling — the run's own calls would never
    // count against the day.
    const ledger = new AgentRunLedger();
    ledger.observeDailyBaseline(baseline(5));

    expect(ledger.snapshot(NOW).invocationsToday).toBe(5);

    ledger.recordInvocation();
    ledger.recordInvocation();
    ledger.recordInvocation();

    expect(ledger.snapshot(NOW).invocationsToday).toBe(8);
  });

  it("emits todayCountedAt verbatim, so the caller owns the UTC-day anchor", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDailyBaseline({ invocationsToday: 1, countedAt: NOW });

    expect(ledger.snapshot(NOW + 1000).todayCountedAt).toBe(NOW);
  });

  it("makes a declared invocationsPerDay satisfiable once observed", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDailyBaseline(baseline(0));
    ledger.observeDecisionLog(true);

    expect(
      Core.evaluateAgentAction({
        action: healthCheckAction(),
        policy: budgetPolicy({ invocationsPerDay: 400 }),
        run: ledger.snapshot(NOW),
      }).verdict,
    ).toBe("auto-approved");
  });

  it("reports the reject-AT bound as budget.invocations-per-day, never .unobservable", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDailyBaseline(baseline(399));
    ledger.observeDecisionLog(true);
    ledger.recordInvocation();

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: budgetPolicy({ invocationsPerDay: 400 }),
      run: ledger.snapshot(NOW),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.invocations-per-day");
  });

  it.each([
    ["a negative invocationsToday", { invocationsToday: -1, countedAt: NOW }],
    [
      "a fractional invocationsToday",
      { invocationsToday: 1.5, countedAt: NOW },
    ],
    ["a negative countedAt", { invocationsToday: 1, countedAt: -1 }],
    [
      "a non-finite countedAt",
      { invocationsToday: 1, countedAt: Number.POSITIVE_INFINITY },
    ],
  ] as ReadonlyArray<readonly [label: string, baseline: AgentDailyBaseline]>)(
    "rejects %s with ERR_AGENT_OPERATOR_BUDGET_STATE",
    (_label, bad) => {
      const ledger = new AgentRunLedger();

      let thrown: unknown;
      try {
        ledger.observeDailyBaseline(bad);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      // NOT ERR_AGENT_OPERATOR_DECISION_LOG: the audit log is healthy here,
      // and sending an operator to `data/agent-log/` would waste their time
      // on the wrong file in the wrong directory.
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_BUDGET_STATE",
      );
      // A rejected baseline leaves the pair absent — never half-seeded.
      const snapshot = ledger.snapshot(NOW);
      expect(Object.hasOwn(snapshot, "invocationsToday")).toBe(false);
      expect(Object.hasOwn(snapshot, "todayCountedAt")).toBe(false);
    },
  );
});

describe("AgentRunLedger — invocationCount", () => {
  it("reports the same number snapshot() emits as invocationsThisRun", () => {
    // The accessor exists so a caller never writes
    // `snapshot(now).invocationsThisRun ?? 0` — every library ledger field is
    // typed optional, and a defaulted observation is the exact mistake the
    // omit-vs-zero discipline exists to prevent.
    const ledger = new AgentRunLedger();

    expect(ledger.invocationCount).toBe(0);

    ledger.recordInvocation();
    ledger.recordInvocation();

    expect(ledger.invocationCount).toBe(2);
    expect(ledger.snapshot(NOW).invocationsThisRun).toBe(
      ledger.invocationCount,
    );
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
    ledger.observeSpend({
      tokensThisRun: 1,
      loopIterations: 1,
      costThisRun: 0,
    });
    ledger.observeDailyBaseline({ invocationsToday: 1, countedAt: NOW });
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
