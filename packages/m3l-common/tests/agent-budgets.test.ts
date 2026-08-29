/**
 * Tests for `core/agent` slice 2 — budgets and ceilings (step 3), plus the
 * ACT-13/14/15 run-ledger validation rules and validator rules 13/14
 * (RED phase: `M3LAgentBudgets`, `M3LAgentRunLedger`, and
 * `M3L_AGENT_MAX_DRY_RUN_SHAPES` do not exist in `core/agent` yet, so this
 * file cannot even resolve its imports until slice 2 lands).
 *
 * Contract source: docs/reference/core/agent.md § Validating the action
 * (ACT-13/14/15), § `validateAgentPolicy` rules 13/14, § Budgets and
 * exhaustion, § The per-day window.
 *
 * Dry-run-first (step 6, ACT rules on `dryRun`/`shapeKey`, validator rule 16,
 * `agentActionShapeKey`) is owned by the sibling `agent-dry-run.test.ts` and
 * is out of scope here except where a budgets-only scenario incidentally
 * needs a run ledger shape.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  M3L_AGENT_MAX_DRY_RUN_SHAPES,
  M3LAgentActionValidationError,
  M3LAgentPolicyDeclarationError,
  M3LError,
  evaluateAgentAction,
  isAgentPolicyRuleId,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentAction,
  M3LAgentEvaluationOptions,
  M3LAgentPolicy,
  M3LAgentPolicyRuleId,
  M3LAgentRunLedger,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Base declaration: one grant, no grading, no budgets, no dryRunFirst. */
const BASE_DECLARATION = {
  version: 1,
  scripts: [{ script: "dynamodb-crud", operations: ["get-item", "put-item"] }],
} as const;

/** A validated policy declaring the given `budgets`. Built lazily per test. */
function policyWithBudgets(budgets: unknown): M3LAgentPolicy {
  return validateAgentPolicy({ ...BASE_DECLARATION, budgets });
}

/** The same grant, with no `budgets` own key declared at all (slice 1). */
function policyNoBudgets(): M3LAgentPolicy {
  return validateAgentPolicy(BASE_DECLARATION);
}

/** An allowlisted read-only action that reaches step 4 when steps 1-3 pass. */
const READ_ONLY_ACTION: M3LAgentAction = {
  script: "dynamodb-crud",
  operation: "get-item",
  kind: "read-only",
};

class NotAPlainObject {}

/** Runs `run` and returns whatever it threw, or `undefined` if it did not. */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Asserts the options bag is rejected at step 0. When `field`/`violation` are
 * given they are asserted exactly, matching `agent-hardening.test.ts`'s
 * convention; when omitted, only the class/code/non-empty-context are
 * checked, for the many ACT-14 cases whose exact violation string the
 * contract page does not name.
 */
function expectActionRejected(
  options: unknown,
  field?: string,
  violation?: string,
): M3LAgentActionValidationError {
  const thrown = catchThrown(() =>
    evaluateAgentAction(options as M3LAgentEvaluationOptions),
  );
  expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAgentActionValidationError;
  expect(error.code).toBe("ERR_AGENT_INVALID_ACTION");
  if (field === undefined) {
    expect(Object.keys(error.context).length).toBeGreaterThan(0);
  } else {
    expect(error.context["field"]).toBe(field);
  }
  if (violation !== undefined) {
    expect(error.context["violation"]).toBe(violation);
  }
  return error;
}

/** Same as {@link expectActionRejected} but for `validateAgentPolicy`. */
function expectDeclarationRejected(
  declaration: unknown,
  field?: string,
  violation?: string,
): M3LAgentPolicyDeclarationError {
  const thrown = catchThrown(() => validateAgentPolicy(declaration));
  expect(thrown).toBeInstanceOf(M3LAgentPolicyDeclarationError);
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAgentPolicyDeclarationError;
  expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
  if (field === undefined) {
    expect(Object.keys(error.context).length).toBeGreaterThan(0);
  } else {
    expect(error.context["field"]).toBe(field);
  }
  if (violation !== undefined) {
    expect(error.context["violation"]).toBe(violation);
  }
  return error;
}

/**
 * Runs `run` with `key` present on `Object.prototype`, then removes it.
 * Copied from `agent-evaluate.test.ts` — see that file for the full
 * rationale (an inherited own-key read is the real threat model
 * `Object.hasOwn` presence checks exist to defeat).
 */
function withPollutedObjectPrototype<T>(
  key: string,
  value: unknown,
  run: () => T,
): T {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

/** Overrides `names`'s own `Symbol.iterator` to yield `smuggled` fake entries. */
function withHostileIterator(names: string[], smuggled: number): string[] {
  Object.defineProperty(names, Symbol.iterator, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function* hostile(): Generator<string> {
      for (let index = 0; index < smuggled; index++) {
        yield `smuggled-${String(index)}`;
      }
    },
  });
  return names;
}

/** The length an iterator-driven walk over `value` would report. */
function iterationLength(value: Iterable<string>): number {
  return [...value].length;
}

/* -------------------------------------------------------------------------- */
/* Step 3 — budgets: presence, order, comparison                             */
/* -------------------------------------------------------------------------- */

describe("step 3 is skipped entirely when budgets is absent", () => {
  test("[1] a policy with no budgets own key: a valid run changes no verdict", () => {
    const policy = policyNoBudgets();
    const withoutRun = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
    });
    const withRun = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsThisRun: 999,
        tokensThisRun: 999_999,
        costThisRun: 999_999,
        loopIterations: 999,
      },
    });

    expect(withoutRun.rule).toBe("read-only-auto-approved");
    expect(withRun.rule).toBe("read-only-auto-approved");
    expect(withRun.verdict).toBe(withoutRun.verdict);
  });

  test("[2] a polluted Object.prototype.budgets cannot make step 3 run", () => {
    const policy = policyNoBudgets();
    expect(Object.hasOwn(policy, "budgets")).toBe(false);

    const decision = withPollutedObjectPrototype(
      "budgets",
      { invocationsPerRun: 1 },
      () => {
        // The pollution is live: a bare dot read would see a ceiling nobody
        // declared, but `Object.hasOwn` must not.
        expect((policy as unknown as { budgets: unknown }).budgets).toEqual({
          invocationsPerRun: 1,
        });
        return evaluateAgentAction({
          policy,
          action: READ_ONLY_ACTION,
          run: { invocationsThisRun: 5 },
        });
      },
    );

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("[3] a polluted Object.prototype.tokensPerRun cannot invent a ceiling budgets never declared", () => {
    const policy = policyWithBudgets({ invocationsPerRun: 100 });

    const decision = withPollutedObjectPrototype("tokensPerRun", 1, () =>
      evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run: { invocationsThisRun: 5, tokensThisRun: 999 },
      }),
    );

    expect(decision.rule).toBe("read-only-auto-approved");
  });
});

describe("[4] evaluation order is fixed, not declaration key order", () => {
  test.each([
    ["costPerRun then tokensPerRun", { costPerRun: 5, tokensPerRun: 100 }],
    ["tokensPerRun then costPerRun", { tokensPerRun: 100, costPerRun: 5 }],
  ])(
    "both ceilings exhausted, declared as %s, both yield budget.tokens-per-run",
    (_label, budgets) => {
      const policy = policyWithBudgets(budgets);
      const decision = evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run: { tokensThisRun: 100, costThisRun: 5 },
      });

      expect(decision.rule).toBe("budget.tokens-per-run");
    },
  );
});

describe("[5] the exhaustion comparison is reject-AT: observed >= ceiling", () => {
  test.each([
    [9, "read-only-auto-approved"],
    [10, "budget.invocations-per-run"],
    [11, "budget.invocations-per-run"],
  ])(
    "ceiling 10, observed invocationsThisRun %i -> %s",
    (invocationsThisRun, expectedRule) => {
      const policy = policyWithBudgets({ invocationsPerRun: 10 });
      const decision = evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run: { invocationsThisRun },
      });

      expect(decision.rule).toBe(expectedRule);
    },
  );
});

describe("[6] contrast: structural ceilings are reject-ABOVE, not reject-at", () => {
  test("dryRunCompletedShapes: exactly M3L_AGENT_MAX_DRY_RUN_SHAPES passes, one more throws", () => {
    const atCeiling = Array.from(
      { length: M3L_AGENT_MAX_DRY_RUN_SHAPES },
      (_unused, index) => `shape-${index}`,
    );
    const overCeiling = Array.from(
      { length: M3L_AGENT_MAX_DRY_RUN_SHAPES + 1 },
      (_unused, index) => `shape-${index}`,
    );

    const decision = evaluateAgentAction({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes: atCeiling },
    });
    expect(decision.rule).toBe("read-only-auto-approved");

    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes: overCeiling },
    });
  });

  // `M3L_AGENT_MAX_PARAMETER_NAMES` (256) and `M3L_AGENT_MAX_SCRIPT_GRANTS`
  // (128) are the same reject-above shape and are already pinned in
  // `agent-evaluate.test.ts` and `agent-hardening.test.ts`; not re-derived
  // here to avoid duplicate ownership of those scenarios.
});

describe("[7] a declared ceiling whose observation is absent escalates with its own .unobservable rule id", () => {
  test.each([
    ["invocationsPerRun", "budget.invocations-per-run.unobservable"],
    ["invocationsPerDay", "budget.invocations-per-day.unobservable"],
    ["tokensPerRun", "budget.tokens-per-run.unobservable"],
    ["costPerRun", "budget.cost-per-run.unobservable"],
    ["loopIterations", "budget.loop-iterations.unobservable"],
  ] as const)(
    "declared %s with an empty run ledger escalates as %s",
    (key, expectedRule) => {
      const policy = policyWithBudgets({ [key]: 10 });
      const decision = evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run: {},
      });

      expect(decision.rule).toBe(expectedRule);
    },
  );

  test("discrimination: same ceiling, an exhausted observation yields the bare id while an absent observation yields the .unobservable id, and the two decisions carry different rule values", () => {
    const policy = policyWithBudgets({ tokensPerRun: 10 });
    const exhausted = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: { tokensThisRun: 10 },
    });
    const unobservable = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {},
    });

    expect(exhausted.rule).toBe("budget.tokens-per-run");
    expect(unobservable.rule).toBe("budget.tokens-per-run.unobservable");
    expect(exhausted.rule).not.toBe(unobservable.rule);
  });
});

test("[8] no run ledger at all escalates with the first declared ceiling in FIXED order, carrying the .unobservable suffix", () => {
  const policy = policyWithBudgets({ loopIterations: 3, invocationsPerDay: 5 });
  const decision = evaluateAgentAction({ policy, action: READ_ONLY_ACTION });

  // invocationsPerDay precedes loopIterations in the FIXED evaluation order
  // (invocationsPerRun, invocationsPerDay, tokensPerRun, costPerRun,
  // loopIterations), even though loopIterations was declared first.
  expect(decision.rule).toBe("budget.invocations-per-day.unobservable");
});

describe("[9] observation mapping: each ceiling reads its own named ledger field", () => {
  test.each([
    [
      "invocationsPerRun",
      { invocationsThisRun: 3 },
      "budget.invocations-per-run",
    ],
    ["tokensPerRun", { tokensThisRun: 3 }, "budget.tokens-per-run"],
    ["costPerRun", { costThisRun: 3 }, "budget.cost-per-run"],
    ["loopIterations", { loopIterations: 3 }, "budget.loop-iterations"],
  ] as const)(
    "%s reads from the matching ledger field",
    (key, run, expectedRule) => {
      const policy = policyWithBudgets({ [key]: 3 });
      const decision = evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run,
      });

      expect(decision.rule).toBe(expectedRule);
    },
  );

  test("invocationsPerDay reads from invocationsToday", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 3 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: { invocationsToday: 3, todayCountedAt: 0, now: 0 },
    });

    expect(decision.rule).toBe("budget.invocations-per-day");
  });
});

describe("[10] invocationsPerDay needs all three of invocationsToday/todayCountedAt/now", () => {
  test.each([
    ["invocationsToday absent", { todayCountedAt: 0, now: 0 }],
    ["todayCountedAt absent", { invocationsToday: 0, now: 0 }],
    ["now absent", { invocationsToday: 0, todayCountedAt: 0 }],
  ])(
    "escalates as .unobservable when %s, even though the other two are present",
    (_label, run) => {
      const policy = policyWithBudgets({ invocationsPerDay: 5 });
      const decision = evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run,
      });

      expect(decision.rule).toBe("budget.invocations-per-day.unobservable");
    },
  );

  test("presence is checked BEFORE the window: a missing invocationsToday escalates as .unobservable even though the two present timestamps would roll the window", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        todayCountedAt: Date.UTC(2026, 0, 1),
        now: Date.UTC(2026, 0, 2),
      },
    });

    expect(decision.rule).toBe("budget.invocations-per-day.unobservable");
  });

  test("presence is checked BEFORE the window: a missing now escalates as .unobservable even though the two present values would roll the window", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsToday: 999,
        todayCountedAt: Date.UTC(2026, 0, 1),
      },
    });

    expect(decision.rule).toBe("budget.invocations-per-day.unobservable");
  });
});

describe("[11] the per-day window: same UTC day compares as-is, a different UTC day reads as 0", () => {
  test("same UTC day: the observed invocationsToday is compared as-is", () => {
    const sameDay = Date.UTC(2026, 0, 1, 10, 0, 0, 0);
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: { invocationsToday: 5, todayCountedAt: sameDay, now: sameDay },
    });

    expect(decision.rule).toBe("budget.invocations-per-day");
  });

  test("different UTC day: the window rolled, so invocationsToday reads as 0 and passes", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsToday: 999,
        todayCountedAt: Date.UTC(2026, 0, 1),
        now: Date.UTC(2026, 0, 2),
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });
});

describe("[12] UTC boundary precision", () => {
  test("23:59:59.999 to the next day's 00:00:00.000 rolls the window", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsToday: 999,
        todayCountedAt: Date.UTC(2026, 0, 1, 23, 59, 59, 999),
        now: Date.UTC(2026, 0, 2, 0, 0, 0, 0),
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("one millisecond earlier: same UTC day, the window does not roll", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsToday: 999,
        todayCountedAt: Date.UTC(2026, 0, 1, 23, 59, 59, 999),
        now: Date.UTC(2026, 0, 1, 23, 59, 59, 998),
      },
    });

    expect(decision.rule).toBe("budget.invocations-per-day");
  });
});

describe("[13] the per-day window is timezone-independent", () => {
  const ORIGINAL_TZ = process.env["TZ"];

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = ORIGINAL_TZ;
    }
  });

  test.each(["Pacific/Kiritimati", "Etc/GMT+12"])(
    "a UTC-day rollover reads the same way under TZ=%s",
    (tz) => {
      process.env["TZ"] = tz;
      const policy = policyWithBudgets({ invocationsPerDay: 5 });
      const decision = evaluateAgentAction({
        policy,
        action: READ_ONLY_ACTION,
        run: {
          invocationsToday: 999,
          todayCountedAt: Date.UTC(2026, 0, 1, 23, 59, 59, 999),
          now: Date.UTC(2026, 0, 2, 0, 0, 0, 0),
        },
      });

      expect(decision.rule).toBe("read-only-auto-approved");
    },
  );
});

describe("[14] backwards skew is a same-day test, not an ordering test", () => {
  test("same UTC day: now earlier than todayCountedAt does not roll the window", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsToday: 5,
        todayCountedAt: Date.UTC(2026, 0, 1, 12, 0, 0, 0),
        now: Date.UTC(2026, 0, 1, 6, 0, 0, 0),
      },
    });

    expect(decision.rule).toBe("budget.invocations-per-day");
  });

  test("across days backwards: now in a previous UTC day still rolls the window", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsToday: 999,
        todayCountedAt: Date.UTC(2026, 0, 2, 12, 0, 0, 0),
        now: Date.UTC(2026, 0, 1, 12, 0, 0, 0),
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });
});

test("[15] budgets gate a read-only action too — step 3 sits above step 4", () => {
  const policy = policyWithBudgets({ invocationsPerRun: 10 });
  const decision = evaluateAgentAction({
    policy,
    action: READ_ONLY_ACTION,
    run: { invocationsThisRun: 10 },
  });

  expect(decision.rule).toBe("budget.invocations-per-run");
  expect(decision.rule).not.toBe("read-only-auto-approved");
});

describe("[16] budgets sit BELOW steps 1 and 2", () => {
  const EXHAUSTED_RUN: M3LAgentRunLedger = {
    invocationsThisRun: 5,
    invocationsToday: 5,
    todayCountedAt: 0,
    now: 0,
    tokensThisRun: 5,
    costThisRun: 5,
    loopIterations: 5,
  };

  test("a non-allowlisted script is still denied, even with every budget exhausted", () => {
    const policy = policyWithBudgets({
      invocationsPerRun: 1,
      invocationsPerDay: 1,
      tokensPerRun: 1,
      costPerRun: 0.01,
      loopIterations: 1,
    });
    const decision = evaluateAgentAction({
      policy,
      action: { script: "not-allowlisted", kind: "read-only" },
      run: EXHAUSTED_RUN,
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("script-not-allowlisted");
  });

  test("a non-allowlisted operation is still denied, even with every budget exhausted", () => {
    const policy = policyWithBudgets({ invocationsPerRun: 1 });
    const decision = evaluateAgentAction({
      policy,
      action: {
        script: "dynamodb-crud",
        operation: "delete-table",
        kind: "read-only",
      },
      run: EXHAUSTED_RUN,
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("operation-not-allowlisted");
  });
});

describe("[17] costPerRun compares fractionally", () => {
  test.each([
    [4.999, "read-only-auto-approved"],
    [5, "budget.cost-per-run"],
    [5.0001, "budget.cost-per-run"],
  ])("ceiling 5, costThisRun %f -> %s", (costThisRun, expectedRule) => {
    const policy = policyWithBudgets({ costPerRun: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: { costThisRun },
    });

    expect(decision.rule).toBe(expectedRule);
  });
});

describe("[18] asymmetric zero and negative rejection", () => {
  test("an observation of 0 for every integer field is legal and passes", () => {
    const policy = policyWithBudgets({
      invocationsPerRun: 5,
      tokensPerRun: 5,
      costPerRun: 5,
      loopIterations: 5,
    });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: {
        invocationsThisRun: 0,
        tokensThisRun: 0,
        costThisRun: 0,
        loopIterations: 0,
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("todayCountedAt and now of 0 (the epoch) are legal", () => {
    const policy = policyWithBudgets({ invocationsPerDay: 5 });
    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: { invocationsToday: 0, todayCountedAt: 0, now: 0 },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test.each([
    "invocationsThisRun",
    "invocationsToday",
    "tokensThisRun",
    "loopIterations",
    "todayCountedAt",
    "now",
  ])("a negative %s observation is rejected", (key) => {
    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { [key]: -1 },
    });
  });

  test("a negative costThisRun observation is rejected", () => {
    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { costThisRun: -0.5 },
    });
  });
});

test("[19] the evaluator never mutates the ledger and the decision carries no ledger field", () => {
  const run: M3LAgentRunLedger = {
    invocationsThisRun: 3,
    tokensThisRun: 10,
    costThisRun: 1.5,
    loopIterations: 2,
  };
  const snapshotKeys = Object.keys(run);
  const snapshotValues = { ...run };

  const decision = evaluateAgentAction({
    policy: policyWithBudgets({ invocationsPerRun: 10 }),
    action: READ_ONLY_ACTION,
    run,
  });

  expect(Object.keys(run)).toEqual(snapshotKeys);
  expect(run).toEqual(snapshotValues);
  expect(Object.hasOwn(decision, "run")).toBe(false);
  expect(Object.hasOwn(decision, "ledger")).toBe(false);
});

test("[20] the ledger is projected once at step 0: a getter that changes its answer cannot move the verdict", () => {
  // The step 0 -> step 6 TOCTOU case for `dryRunCompletedShapes` (validated
  // here, consulted at step 6) belongs to the sibling `agent-dry-run.test.ts`
  // since step 6 is out of this file's scope. This proves the same
  // "projected once, frozen" invariant using a budget field, which step 3
  // alone consumes.
  let calls = 0;
  const run = {
    get invocationsThisRun(): number {
      calls += 1;
      // A re-read after step 0 would see 99 and exceed the ceiling; a single
      // projection at step 0 means the verdict is decided from ONE value.
      return calls === 1 ? 3 : 99;
    },
  };

  const decision = evaluateAgentAction({
    policy: policyWithBudgets({ invocationsPerRun: 10 }),
    action: READ_ONLY_ACTION,
    run,
  });

  expect(decision.rule).toBe("read-only-auto-approved");
});

test("[21] the budget reason names the ceiling and the observed value, never a parameter", () => {
  const decision = evaluateAgentAction({
    policy: policyWithBudgets({ invocationsPerRun: 10 }),
    action: { ...READ_ONLY_ACTION, parameterNames: ["zzz-secret-param"] },
    run: { invocationsThisRun: 15 },
  });

  expect(decision.reason).toContain("10");
  expect(decision.reason).toContain("15");
  expect(decision.reason).not.toContain("zzz-secret-param");
});

/* -------------------------------------------------------------------------- */
/* ACT-13: the run ledger, when present, is a plain object                   */
/* -------------------------------------------------------------------------- */

describe("[22] ACT-13: run, when present, is a plain object", () => {
  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["a Date", new Date(0)],
    ["a number", 5],
    ["a class instance", new NotAPlainObject()],
  ])("rejects a run that is %s", (_label, run) => {
    expectActionRejected(
      { policy: policyNoBudgets(), action: READ_ONLY_ACTION, run },
      "options.run",
      "not-a-plain-object",
    );
  });

  test("an own run key holding explicit undefined is present (Object.hasOwn) and rejected", () => {
    expectActionRejected(
      { policy: policyNoBudgets(), action: READ_ONLY_ACTION, run: undefined },
      "options.run",
      "not-a-plain-object",
    );
  });
});

describe("[23] ACT-13: unknown and dangerous keys on run", () => {
  test("rejects an unknown own key on run", () => {
    const error = expectActionRejected(
      {
        policy: policyNoBudgets(),
        action: READ_ONLY_ACTION,
        run: { invocationsThisRun: 1, typo: 1 },
      },
      "options.run",
      "unknown-key",
    );

    expect(error.context["key"]).toBe("typo");
  });

  test.each(["constructor", "prototype"])(
    "rejects a dangerous own %s key on run",
    (key) => {
      expectActionRejected(
        {
          policy: policyNoBudgets(),
          action: READ_ONLY_ACTION,
          run: { invocationsThisRun: 1, [key]: {} },
        },
        "options.run",
        "dangerous-key",
      );
    },
  );

  test("rejects an own __proto__ key on run parsed out of a JSON document", () => {
    const run: unknown = JSON.parse(
      '{"invocationsThisRun":1,"__proto__":{"polluted":true}}',
    );

    expectActionRejected(
      { policy: policyNoBudgets(), action: READ_ONLY_ACTION, run },
      "options.run",
      "dangerous-key",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* ACT-14: every numeric ledger field                                        */
/* -------------------------------------------------------------------------- */

const INTEGER_LEDGER_FIELDS = [
  "invocationsThisRun",
  "invocationsToday",
  "loopIterations",
  "tokensThisRun",
  "todayCountedAt",
  "now",
] as const;

const INVALID_INTEGER_VALUES = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["-1", -1],
  ["1.5", 1.5],
  ['the string "5"', "5"],
  ["null", null],
  ["true", true],
  ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
] as const;

const INVALID_LEDGER_INTEGER_CASES = INTEGER_LEDGER_FIELDS.flatMap((field) =>
  INVALID_INTEGER_VALUES.map(
    ([label, value]) => [field, label, value] as const,
  ),
);

describe("[24] ACT-14: every numeric ledger field is a finite, non-negative safe integer", () => {
  test.each(INVALID_LEDGER_INTEGER_CASES)(
    "rejects run.%s = %s",
    (field, _label, value) => {
      expectActionRejected({
        policy: policyNoBudgets(),
        action: READ_ONLY_ACTION,
        run: { [field]: value },
      });
    },
  );

  test.each(INTEGER_LEDGER_FIELDS)(
    "accepts 0 and a positive safe integer for %s",
    (field) => {
      const zero = evaluateAgentAction({
        policy: policyNoBudgets(),
        action: READ_ONLY_ACTION,
        run: { [field]: 0 },
      });
      const positive = evaluateAgentAction({
        policy: policyNoBudgets(),
        action: READ_ONLY_ACTION,
        run: { [field]: 42 },
      });

      expect(zero.rule).toBe("read-only-auto-approved");
      expect(positive.rule).toBe("read-only-auto-approved");
    },
  );
});

describe("[25] ACT-14: costThisRun accepts fractions but rejects non-finite/negative/non-number", () => {
  test.each([0.42, 1.5, 0])("accepts the value %f", (costThisRun) => {
    const decision = evaluateAgentAction({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { costThisRun },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0.5", -0.5],
    ['the string "1.5"', "1.5"],
    ["null", null],
  ])("rejects costThisRun = %s", (_label, costThisRun) => {
    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { costThisRun },
    });
  });
});

test("[26] ACT-14 is unconditional: a malformed ledger field throws even with no budgets declared at all", () => {
  expectActionRejected({
    policy: policyNoBudgets(),
    action: READ_ONLY_ACTION,
    run: { tokensThisRun: -1 },
  });
});

/* -------------------------------------------------------------------------- */
/* ACT-15: dryRunCompletedShapes                                             */
/* -------------------------------------------------------------------------- */

describe("[27] ACT-15: dryRunCompletedShapes is a bounded array of non-blank, non-duplicate strings", () => {
  test.each([
    ["not an array", "shape-a"],
    ["null", null],
    ["containing a non-string", ["shape-a", 7]],
    ["containing an empty string", ["shape-a", ""]],
    ["containing a whitespace-only string", ["shape-a", "  "]],
    ["containing a duplicate entry", ["shape-a", "shape-a"]],
  ])(
    "rejects a dryRunCompletedShapes that is %s",
    (_label, dryRunCompletedShapes) => {
      expectActionRejected({
        policy: policyNoBudgets(),
        action: READ_ONLY_ACTION,
        run: { dryRunCompletedShapes },
      });
    },
  );

  test("rejects more than M3L_AGENT_MAX_DRY_RUN_SHAPES entries rather than truncating", () => {
    const dryRunCompletedShapes = Array.from(
      { length: M3L_AGENT_MAX_DRY_RUN_SHAPES + 1 },
      (_unused, index) => `shape-${index}`,
    );

    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes },
    });
  });

  test("accepts exactly M3L_AGENT_MAX_DRY_RUN_SHAPES entries (reject-above bound)", () => {
    const dryRunCompletedShapes = Array.from(
      { length: M3L_AGENT_MAX_DRY_RUN_SHAPES },
      (_unused, index) => `shape-${index}`,
    );

    const decision = evaluateAgentAction({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("accepts an empty dryRunCompletedShapes list", () => {
    const decision = evaluateAgentAction({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes: [] },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });
});

describe("[28] duplicate asymmetry: dryRunCompletedShapes rejects duplicates, parameterNames preserves them", () => {
  test("dryRunCompletedShapes rejects a duplicate entry", () => {
    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes: ["shape-a", "shape-a"] },
    });
  });

  test("parameterNames preserves a duplicate entry", () => {
    const decision = evaluateAgentAction({
      policy: policyNoBudgets(),
      action: { ...READ_ONLY_ACTION, parameterNames: ["table", "table"] },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
    expect(decision.action.parameterNames).toEqual(["table", "table"]);
  });
});

describe("[29] ACT-15 length is read by INDEX, not through a hostile Symbol.iterator", () => {
  test("a populated list at the ceiling with a hostile iterator is not truncated or smuggled", () => {
    const names = Array.from(
      { length: M3L_AGENT_MAX_DRY_RUN_SHAPES },
      (_unused, index) => `shape-${index}`,
    );
    const hostile = withHostileIterator(names, 5000);

    expect(iterationLength(hostile)).toBe(5000);
    expect(hostile.length).toBe(M3L_AGENT_MAX_DRY_RUN_SHAPES);

    const decision = evaluateAgentAction({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes: hostile },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("a sparse list at the ceiling with a hostile iterator is rejected, not smuggled past", () => {
    const hostile = withHostileIterator(
      new Array<string>(M3L_AGENT_MAX_DRY_RUN_SHAPES),
      5000,
    );

    expect(iterationLength(hostile)).toBe(5000);
    expect(hostile.length).toBe(M3L_AGENT_MAX_DRY_RUN_SHAPES);

    expectActionRejected({
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      run: { dryRunCompletedShapes: hostile },
    });
  });
});

test("[30] ACT-11 extended: run joins the allowed options-bag keys; a typo'd runs throws", () => {
  const error = expectActionRejected(
    {
      policy: policyNoBudgets(),
      action: READ_ONLY_ACTION,
      runs: { invocationsThisRun: 1 },
    },
    "options",
    "unknown-key",
  );

  expect(error.context["key"]).toBe("runs");

  // The contested half: the correctly spelled key is honoured.
  const decision = evaluateAgentAction({
    policy: policyWithBudgets({ invocationsPerRun: 1 }),
    action: READ_ONLY_ACTION,
    run: { invocationsThisRun: 1 },
  });
  expect(decision.rule).toBe("budget.invocations-per-run");
});

test("[31] a throwing getter on the run ledger is wrapped as traversal-threw, cause chained, toJSON collapsed", () => {
  const boom = new RangeError("boom");
  const run = {
    get invocationsThisRun(): number {
      throw boom;
    },
  };

  const error = expectActionRejected(
    { policy: policyNoBudgets(), action: READ_ONLY_ACTION, run },
    "options",
    "traversal-threw",
  );

  expect(error.cause).toBe(boom);
  expect(error.cause).toBeInstanceOf(RangeError);
  const serialised = error.toJSON();
  expect(serialised.cause).toEqual({ name: "RangeError" });
  expect(Object.keys(serialised.cause ?? {})).toEqual(["name"]);
  expect(JSON.stringify(serialised)).not.toContain("boom");
});

test("[32] ACT evaluation order: a forged policy is reported over a malformed run, every time", () => {
  const declaration = {
    version: 1,
    scripts: [{ script: "dynamodb-crud", operations: ["get-item"] }],
  };
  const forged = JSON.parse(JSON.stringify(declaration)) as M3LAgentPolicy;

  expectActionRejected(
    { policy: forged, action: READ_ONLY_ACTION, run: { typo: 1 } },
    "options.policy",
    "not-a-validated-policy",
  );
});

/* -------------------------------------------------------------------------- */
/* validateAgentPolicy rules 13/14 — budgets                                 */
/* -------------------------------------------------------------------------- */

describe("[33] validateAgentPolicy — rule 13: budgets is a plain object with at least one ceiling", () => {
  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["a number", 5],
  ])("rejects a budgets that is %s", (_label, budgets) => {
    expectDeclarationRejected(
      { ...BASE_DECLARATION, budgets },
      "budgets",
      "not-a-plain-object",
    );
  });

  test("rejects budgets: {} — all five ceilings omitted", () => {
    expectDeclarationRejected({ ...BASE_DECLARATION, budgets: {} }, "budgets");
  });

  test("accepts a budgets declaring exactly one ceiling", () => {
    const policy = validateAgentPolicy({
      ...BASE_DECLARATION,
      budgets: { invocationsPerRun: 1 },
    });

    expect(policy.budgets).toEqual({ invocationsPerRun: 1 });
  });
});

describe("[34] validateAgentPolicy — rule 11 extended: budgets keys are allowlisted", () => {
  test("rejects an unknown key on budgets", () => {
    const error = expectDeclarationRejected(
      { ...BASE_DECLARATION, budgets: { invocationsPerRun: 1, typo: 2 } },
      "budgets",
      "unknown-key",
    );

    expect(error.context["key"]).toBe("typo");
  });

  test.each(["constructor", "prototype"])(
    "rejects a dangerous %s key on budgets",
    (key) => {
      expectDeclarationRejected(
        { ...BASE_DECLARATION, budgets: { invocationsPerRun: 1, [key]: {} } },
        "budgets",
        "dangerous-key",
      );
    },
  );

  test("rejects an own __proto__ key on budgets parsed out of a JSON document", () => {
    const budgets: unknown = JSON.parse(
      '{"invocationsPerRun":1,"__proto__":{"polluted":true}}',
    );

    expectDeclarationRejected(
      { ...BASE_DECLARATION, budgets },
      "budgets",
      "dangerous-key",
    );
  });
});

const BUDGET_INTEGER_KEYS = [
  "invocationsPerRun",
  "invocationsPerDay",
  "tokensPerRun",
  "loopIterations",
] as const;

const INVALID_BUDGET_INTEGER_VALUES = [
  ["0", 0],
  ["-1", -1],
  ["1.5", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ['the string "5"', "5"],
  ["null", null],
  ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
] as const;

const INVALID_BUDGET_INTEGER_CASES = BUDGET_INTEGER_KEYS.flatMap((key) =>
  INVALID_BUDGET_INTEGER_VALUES.map(
    ([label, value]) => [key, label, value] as const,
  ),
);

describe("[35] validateAgentPolicy — rule 14: a budget ceiling is a positive finite safe integer", () => {
  test.each(INVALID_BUDGET_INTEGER_CASES)(
    "rejects budgets.%s = %s",
    (key, _label, value) => {
      expectDeclarationRejected({
        ...BASE_DECLARATION,
        budgets: { [key]: value },
      });
    },
  );

  test.each(BUDGET_INTEGER_KEYS)("accepts 1 for %s", (key) => {
    const policy = validateAgentPolicy({
      ...BASE_DECLARATION,
      budgets: { [key]: 1 },
    });

    expect((policy.budgets as Record<string, number>)[key]).toBe(1);
  });
});

describe("[36] validateAgentPolicy — rule 14: costPerRun may be fractional but must be positive and finite", () => {
  test.each([0.01, 5.5])(
    "accepts the fractional costPerRun %f",
    (costPerRun) => {
      const policy = validateAgentPolicy({
        ...BASE_DECLARATION,
        budgets: { costPerRun },
      });

      expect(policy.budgets?.costPerRun).toBe(costPerRun);
    },
  );

  test.each([
    ["0", 0],
    ["-1", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ['the string "1"', "1"],
  ])("rejects costPerRun = %s", (_label, costPerRun) => {
    expectDeclarationRejected({ ...BASE_DECLARATION, budgets: { costPerRun } });
  });
});

test("[37] budgets projection: frozen, immune to post-validation mutation, and JSON round-trips", () => {
  const budgets = { invocationsPerRun: 5, costPerRun: 1.5 };
  const policy = validateAgentPolicy({ ...BASE_DECLARATION, budgets });

  expect(Object.isFrozen(policy.budgets)).toBe(true);

  budgets.invocationsPerRun = 999;
  expect(policy.budgets?.invocationsPerRun).toBe(5);

  const roundTripped: unknown = JSON.parse(JSON.stringify(policy));
  expect(roundTripped).toEqual({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    budgets: { invocationsPerRun: 5, costPerRun: 1.5 },
  });
});

test("[38] a throwing get budgets() surfaces as traversal-threw with the cause chained", () => {
  const boom = new RangeError("boom");
  const declaration = {
    ...BASE_DECLARATION,
    get budgets(): unknown {
      throw boom;
    },
  };

  const error = expectDeclarationRejected(
    declaration,
    "declaration",
    "traversal-threw",
  );

  expect(error.cause).toBe(boom);
});

/* -------------------------------------------------------------------------- */
/* Back-compat: a slice-1 declaration and call site are untouched            */
/* -------------------------------------------------------------------------- */

test("[39] a slice-1 declaration's Object.keys and JSON.stringify are unchanged", () => {
  const declaration = {
    version: 1,
    scripts: [{ script: "s3-report", allOperations: true }],
  };
  const policy = validateAgentPolicy(declaration);

  expect("budgets" in policy).toBe(false);
  expect(Object.hasOwn(policy, "budgets")).toBe(false);
  expect(Object.hasOwn(policy, "dryRunFirst")).toBe(false);
  expect(JSON.stringify(policy)).toBe(
    JSON.stringify({
      version: 1,
      scripts: [{ script: "s3-report", allOperations: true }],
    }),
  );
});

test("[40] a valid run passed to a slice-1 policy (no budgets) changes no verdict", () => {
  const policy = policyNoBudgets();
  const withoutRun = evaluateAgentAction({ policy, action: READ_ONLY_ACTION });
  const withRun = evaluateAgentAction({
    policy,
    action: READ_ONLY_ACTION,
    run: {
      invocationsThisRun: 3,
      tokensThisRun: 10,
      costThisRun: 1.5,
      loopIterations: 2,
    },
  });

  expect(withRun.verdict).toBe(withoutRun.verdict);
  expect(withRun.rule).toBe(withoutRun.rule);
});

test("[41] a malformed run throws even against a slice-1 policy declaring no budgets — step 0 precedes every policy read", () => {
  expectActionRejected({
    policy: policyNoBudgets(),
    action: READ_ONLY_ACTION,
    run: { invocationsThisRun: -1 },
  });
});

/* -------------------------------------------------------------------------- */
/* Type-level contract                                                        */
/* -------------------------------------------------------------------------- */

describe("type-level contract: budgets and the run ledger", () => {
  // `M3LAgentPolicyDeclaration["budgets"]` and `M3LAgentEvaluationOptions["run"]`
  // are not pinned with `expectTypeOf` here: until `M3LAgentBudgets` and
  // `M3LAgentRunLedger` exist, referencing them inside a union resolves as an
  // `any`-like error type and trips `@typescript-eslint/no-redundant-type-
  // constituents`, which is not one of the RED-phase exceptions (unlike
  // `no-unsafe-*`). The runtime behavior those two fields drive is already
  // covered throughout this file (e.g. items 1, 19, 22, 40); this block keeps
  // only the one type-level assertion that does not need either missing type.

  test("the ten budget rule ids (exhausted and .unobservable) are members of M3LAgentPolicyRuleId", () => {
    const ids: M3LAgentPolicyRuleId[] = [
      "budget.invocations-per-run",
      "budget.invocations-per-day",
      "budget.tokens-per-run",
      "budget.cost-per-run",
      "budget.loop-iterations",
      "budget.invocations-per-run.unobservable",
      "budget.invocations-per-day.unobservable",
      "budget.tokens-per-run.unobservable",
      "budget.cost-per-run.unobservable",
      "budget.loop-iterations.unobservable",
    ];

    expect(ids.every((id) => isAgentPolicyRuleId(id))).toBe(true);
  });
});
