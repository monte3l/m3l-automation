/**
 * Tests for `core/agent` V7 slice 2 — escalating when the decision log is
 * unavailable (step 3b) (RED phase: `M3LAgentPolicyDeclaration.requireDecisionLog`,
 * `M3LAgentRunLedger.decisionLogAvailable`, and the two new rule ids
 * `decision-log-unavailable` / `decision-log-unavailable.unobservable` do not
 * exist yet, so the type-level assertions below fail `pnpm typecheck` and
 * every functional scenario either throws `ERR_AGENT_INVALID_ACTION` /
 * `ERR_AGENT_POLICY_DECLARATION` for an unknown key, or reaches the wrong
 * arm, until the feature lands).
 *
 * Contract source: docs/reference/core/agent.md § Escalating when the log is
 * unavailable, § Budgets and exhaustion → An absent observation escalates on
 * its own id (the mirrored idiom this feature copies), and the step ordering
 * fixed in `internal/agent/decide.ts` (step 3b sits after step 3, before
 * step 4).
 *
 * Slice-1/2 fundamentals (the twelve ACT rules, steps 1/2/5/7, budgets,
 * dry-run-first, the twenty-id rule vocabulary) are owned by the sibling
 * files (`agent.test.ts`, `agent-evaluate.test.ts`, `agent-budgets.test.ts`,
 * `agent-dry-run.test.ts`) and are exercised here only to the extent needed
 * to prove step 3b's ordering.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  M3LAgentActionValidationError,
  M3LAgentPolicyDeclarationError,
  M3LError,
  evaluateAgentAction,
  isAgentPolicyRuleId,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentAction,
  M3LAgentDecision,
  M3LAgentEvaluationOptions,
  M3LAgentPolicy,
  M3LAgentPolicyDeclaration,
  M3LAgentPolicyRuleId,
  M3LAgentRunLedger,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/** One grant, no grading, no budgets, no dryRunFirst, no requireDecisionLog. */
const BASE_DECLARATION = {
  version: 1,
  scripts: [{ script: "dynamodb-crud", operations: ["get-item", "put-item"] }],
} as const;

/** Same grant, plus ADR-0048 grading so a mutation can reach step 7. */
const GRADED_DECLARATION = {
  ...BASE_DECLARATION,
  sensitiveTargets: { profiles: ["prod"] },
} as const;

/** A validated policy over {@link BASE_DECLARATION} plus `extra`. */
function policyWith(extra: Record<string, unknown> = {}): M3LAgentPolicy {
  return validateAgentPolicy({ ...BASE_DECLARATION, ...extra });
}

/** A validated policy over {@link GRADED_DECLARATION} plus `extra`. */
function gradedPolicyWith(extra: Record<string, unknown> = {}): M3LAgentPolicy {
  return validateAgentPolicy({ ...GRADED_DECLARATION, ...extra });
}

/**
 * Builds a run ledger from loosely-typed fields, including
 * `decisionLogAvailable` before the real type declares it. Typing `fields` as
 * `Record<string, unknown>` rather than `M3LAgentRunLedger` avoids an
 * excess-property check on every call-site literal that sets
 * `decisionLogAvailable` — no assertion is needed at the `return`, since
 * `M3LAgentRunLedger`'s fields are all optional.
 */
function ledger(fields: Record<string, unknown> = {}): M3LAgentRunLedger {
  return fields;
}

const SAFE_TARGET = { profile: "sandbox", region: "eu-central-1" };
const SENSITIVE_TARGET = { profile: "prod", region: "eu-central-1" };

/** Reaches `read-only-auto-approved` (step 4) when nothing else intervenes. */
const READ_ONLY_ACTION: M3LAgentAction = {
  script: "dynamodb-crud",
  operation: "get-item",
  kind: "read-only",
};

/** Reaches `graded-mutation-auto-approved` (step 7) under a graded policy. */
const MUTATING_ACTION: M3LAgentAction = {
  script: "dynamodb-crud",
  operation: "put-item",
  kind: "mutating",
  target: SAFE_TARGET,
  parameterNames: ["table", "item"],
};

/** Reaches `sensitive-target-escalated` (step 5) under a graded policy. */
const SENSITIVE_MUTATING_ACTION: M3LAgentAction = {
  ...MUTATING_ACTION,
  target: SENSITIVE_TARGET,
};

/** Reaches `target-ungraded-escalated` (step 5) — no target at all. */
const UNGRADED_TARGET_ACTION: M3LAgentAction = {
  script: "dynamodb-crud",
  operation: "put-item",
  kind: "mutating",
};

/** Reaches `script-not-allowlisted` (step 1, denied). */
const UNKNOWN_SCRIPT_ACTION: M3LAgentAction = {
  script: "unknown-script",
  kind: "mutating",
};

/** Reaches `operation-not-allowlisted` (step 2, denied). */
const UNALLOWED_OPERATION_ACTION: M3LAgentAction = {
  script: "dynamodb-crud",
  operation: "delete-item",
  kind: "mutating",
};

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
 * Asserts the options bag is rejected at step 0 with
 * `M3LAgentActionValidationError`. When `field` is given it is asserted
 * exactly; `violation` is only checked to be a non-empty string, never a
 * pinned literal, and the raw offending value is asserted absent from the
 * context — "names the field and violation kind, never a value".
 */
function expectActionRejected(
  options: unknown,
  field?: string,
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
  expect(typeof error.context["violation"]).toBe("string");
  return error;
}

/** Same as {@link expectActionRejected} but for `validateAgentPolicy`. */
function expectDeclarationRejected(
  declaration: unknown,
  field?: string,
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
  expect(typeof error.context["violation"]).toBe("string");
  return error;
}

/* -------------------------------------------------------------------------- */
/* 1. The additive-minor proof                                                */
/* -------------------------------------------------------------------------- */

/**
 * One arm per distinct terminal rule reachable without `requireDecisionLog`
 * declared. `baseRun` is the ledger state (other than `decisionLogAvailable`)
 * needed to reach that arm at all.
 */
const ARMS: readonly (readonly [
  label: string,
  buildPolicy: () => M3LAgentPolicy,
  action: M3LAgentAction,
  baseRun: Record<string, unknown>,
])[] = [
  [
    "denied: script-not-allowlisted",
    () => policyWith(),
    UNKNOWN_SCRIPT_ACTION,
    {},
  ],
  [
    "denied: operation-not-allowlisted",
    () => policyWith(),
    UNALLOWED_OPERATION_ACTION,
    {},
  ],
  [
    "auto-approved: read-only-auto-approved",
    () => policyWith(),
    READ_ONLY_ACTION,
    {},
  ],
  [
    "auto-approved: graded-mutation-auto-approved",
    () => gradedPolicyWith(),
    MUTATING_ACTION,
    {},
  ],
  [
    "escalate: target-ungraded-escalated",
    () => policyWith(),
    UNGRADED_TARGET_ACTION,
    {},
  ],
  [
    "escalate: policy-ungraded-escalated",
    () => policyWith(),
    MUTATING_ACTION,
    {},
  ],
  [
    "escalate: sensitive-target-escalated",
    () => gradedPolicyWith(),
    SENSITIVE_MUTATING_ACTION,
    {},
  ],
  [
    "escalate: budget.invocations-per-run",
    () => policyWith({ budgets: { invocationsPerRun: 1 } }),
    READ_ONLY_ACTION,
    { invocationsThisRun: 1 },
  ],
];

describe("1. additive-minor proof: no requireDecisionLog means byte-identical verdicts", () => {
  test.each(ARMS)(
    "%s: unaffected by decisionLogAvailable true, false, or absent",
    (_label, buildPolicy, action, baseRun) => {
      const policy = buildPolicy();
      const baseline = evaluateAgentAction({
        policy,
        action,
        run: ledger(baseRun),
      });
      const withTrue = evaluateAgentAction({
        policy,
        action,
        run: ledger({ ...baseRun, decisionLogAvailable: true }),
      });
      const withFalse = evaluateAgentAction({
        policy,
        action,
        run: ledger({ ...baseRun, decisionLogAvailable: false }),
      });

      expect(withTrue).toEqual(baseline);
      expect(withFalse).toEqual(baseline);
      expect(withTrue.verdict).toBe(baseline.verdict);
      expect(withTrue.rule).toBe(baseline.rule);
      expect(withTrue.reason).toBe(baseline.reason);
    },
  );

  test("no run at all is identical to a run carrying no decisionLogAvailable key", () => {
    const policy = policyWith();
    const withNoRun = evaluateAgentAction({ policy, action: READ_ONLY_ACTION });
    const withEmptyRun = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: ledger({}),
    });

    expect(withEmptyRun).toEqual(withNoRun);
  });
});

/* -------------------------------------------------------------------------- */
/* 2-4. requireDecisionLog: true, gated on decisionLogAvailable                */
/* -------------------------------------------------------------------------- */

describe("2-4. requireDecisionLog: true", () => {
  test("2. observed false escalates with decision-log-unavailable", () => {
    const policy = policyWith({ requireDecisionLog: true });

    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: ledger({ decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("decision-log-unavailable");
  });

  test("3. no run at all escalates with decision-log-unavailable.unobservable", () => {
    const policy = policyWith({ requireDecisionLog: true });

    const decision = evaluateAgentAction({ policy, action: READ_ONLY_ACTION });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("decision-log-unavailable.unobservable");
  });

  test("3b. a run present but with no decisionLogAvailable own key is also unobservable", () => {
    const policy = policyWith({ requireDecisionLog: true });

    const decision = evaluateAgentAction({
      policy,
      action: READ_ONLY_ACTION,
      run: ledger({}),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("decision-log-unavailable.unobservable");
  });

  test("4. observed true reaches exactly the read-only arm it would have reached anyway", () => {
    const gated = evaluateAgentAction({
      policy: policyWith({ requireDecisionLog: true }),
      action: READ_ONLY_ACTION,
      run: ledger({ decisionLogAvailable: true }),
    });
    const ungated = evaluateAgentAction({
      policy: policyWith(),
      action: READ_ONLY_ACTION,
    });

    expect(gated.verdict).toBe(ungated.verdict);
    expect(gated.rule).toBe(ungated.rule);
    expect(gated.reason).toBe(ungated.reason);
  });

  test("4b. observed true reaches exactly the graded-mutation arm it would have reached anyway", () => {
    const gated = evaluateAgentAction({
      policy: gradedPolicyWith({ requireDecisionLog: true }),
      action: MUTATING_ACTION,
      run: ledger({ decisionLogAvailable: true }),
    });
    const ungated = evaluateAgentAction({
      policy: gradedPolicyWith(),
      action: MUTATING_ACTION,
    });

    expect(gated.verdict).toBe(ungated.verdict);
    expect(gated.rule).toBe(ungated.rule);
    expect(gated.reason).toBe(ungated.reason);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. requireDecisionLog: false behaves identically to absent                 */
/* -------------------------------------------------------------------------- */

describe("5. requireDecisionLog: false is the same as absent (strict-true polarity)", () => {
  test.each([true, false])(
    "decisionLogAvailable=%s produces the identical decision under false vs absent",
    (decisionLogAvailable) => {
      const withAbsent = evaluateAgentAction({
        policy: policyWith(),
        action: READ_ONLY_ACTION,
        run: ledger({ decisionLogAvailable }),
      });
      const withFalse = evaluateAgentAction({
        policy: policyWith({ requireDecisionLog: false }),
        action: READ_ONLY_ACTION,
        run: ledger({ decisionLogAvailable }),
      });

      expect(withFalse).toEqual(withAbsent);
    },
  );

  test("no run at all also matches between false and absent", () => {
    const withAbsent = evaluateAgentAction({
      policy: policyWith(),
      action: READ_ONLY_ACTION,
    });
    const withFalse = evaluateAgentAction({
      policy: policyWith({ requireDecisionLog: false }),
      action: READ_ONLY_ACTION,
    });

    expect(withFalse).toEqual(withAbsent);
  });

  test("the declaration accepts the boolean false and records it", () => {
    const policy = policyWith({ requireDecisionLog: false });

    expect(policy.requireDecisionLog).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Ordering, all four directions                                           */
/* -------------------------------------------------------------------------- */

describe("6. step 3b's ordering: below the deny arms, after budgets, above steps 4 and 7", () => {
  test("a denied action (script-not-allowlisted) stays denied with the log unavailable", () => {
    const decision = evaluateAgentAction({
      policy: policyWith({ requireDecisionLog: true }),
      action: UNKNOWN_SCRIPT_ACTION,
      run: ledger({ decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("script-not-allowlisted");
  });

  test("a denied action (operation-not-allowlisted) stays denied with the log unavailable", () => {
    const decision = evaluateAgentAction({
      policy: policyWith({ requireDecisionLog: true }),
      action: UNALLOWED_OPERATION_ACTION,
      run: ledger({ decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("operation-not-allowlisted");
  });

  test("a budget-exhausted action keeps reporting its budget rule, not the log rule", () => {
    const decision = evaluateAgentAction({
      policy: policyWith({
        budgets: { invocationsPerRun: 1 },
        requireDecisionLog: true,
      }),
      action: READ_ONLY_ACTION,
      run: ledger({ invocationsThisRun: 1, decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.invocations-per-run");
  });

  test("covers the step-4 read-only auto-approval arm", () => {
    const decision = evaluateAgentAction({
      policy: policyWith({ requireDecisionLog: true }),
      action: READ_ONLY_ACTION,
      run: ledger({ decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("decision-log-unavailable");
  });

  test("supersedes the step-5 sensitive-target ESCALATE arm too, reporting decision-log-unavailable", () => {
    // INTENDED, NOT A BUG — do not "fix" this to report
    // `sensitive-target-escalated`.
    //
    // Step 3b sits above the whole `switch (record.kind)`, so it supersedes
    // the escalate arms below it as well as the two auto-approval arms its
    // own comment names. That placement is deliberate: it is what lets ONE
    // check cover the read-only auto-approval arm (step 4) and the graded
    // mutation arm (step 7) at a single site. The verdict is `escalate`
    // either way, so no authority is widened or narrowed by the
    // supersession, and "the decision log is unavailable" is the more
    // actionable signal for the human the escalation is handed to — the
    // sensitivity of the target is still recoverable from the recorded
    // action.
    const decision = evaluateAgentAction({
      policy: gradedPolicyWith({ requireDecisionLog: true }),
      action: SENSITIVE_MUTATING_ACTION,
      run: ledger({ decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("decision-log-unavailable");
  });

  test("with the log available, the same sensitive action reports sensitive-target-escalated", () => {
    // The mirror of the case above: step 3b declines, and step 5 is reached
    // exactly as it would have been without `requireDecisionLog` at all — so
    // the supersession above is the log check firing, not the sensitive-target
    // arm having become unreachable.
    const gated = evaluateAgentAction({
      policy: gradedPolicyWith({ requireDecisionLog: true }),
      action: SENSITIVE_MUTATING_ACTION,
      run: ledger({ decisionLogAvailable: true }),
    });
    const ungated = evaluateAgentAction({
      policy: gradedPolicyWith(),
      action: SENSITIVE_MUTATING_ACTION,
    });

    expect(gated.verdict).toBe("escalate");
    expect(gated.rule).toBe("sensitive-target-escalated");
    expect(gated.reason).toBe(ungated.reason);
  });

  test("covers the step-7 graded-mutation auto-approval arm", () => {
    const decision = evaluateAgentAction({
      policy: gradedPolicyWith({ requireDecisionLog: true }),
      action: MUTATING_ACTION,
      run: ledger({ decisionLogAvailable: false }),
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("decision-log-unavailable");
  });
});

/* -------------------------------------------------------------------------- */
/* 7. isAgentPolicyRuleId and the twenty-two-member union                     */
/* -------------------------------------------------------------------------- */

const SLICE_1_AND_2_RULE_IDS = [
  "script-not-allowlisted",
  "operation-not-allowlisted",
  "read-only-auto-approved",
  "target-ungraded-escalated",
  "policy-ungraded-escalated",
  "sensitive-target-escalated",
  "graded-mutation-auto-approved",
  "unclassifiable-escalated",
  "budget.invocations-per-run",
  "budget.invocations-per-day",
  "budget.tokens-per-run",
  "budget.cost-per-run",
  "budget.loop-iterations",
  "dry-run-first",
  "kind-cross-check-escalated",
  "budget.invocations-per-run.unobservable",
  "budget.invocations-per-day.unobservable",
  "budget.tokens-per-run.unobservable",
  "budget.cost-per-run.unobservable",
  "budget.loop-iterations.unobservable",
] as const;

/** V7 slice 2's two additions — the ones this file is responsible for. */
const NEW_RULE_IDS = [
  "decision-log-unavailable",
  "decision-log-unavailable.unobservable",
] as const;

const ALL_TWENTY_TWO_RULE_IDS = [
  ...SLICE_1_AND_2_RULE_IDS,
  ...NEW_RULE_IDS,
] as const;

describe("7. isAgentPolicyRuleId recognises the two new ids", () => {
  test.each(NEW_RULE_IDS)("recognises %s", (ruleId) => {
    expect(isAgentPolicyRuleId(ruleId)).toBe(true);
  });

  test("a near-miss of the new ids still returns false", () => {
    expect(isAgentPolicyRuleId("decision-log-unavailable-escalated")).toBe(
      false,
    );
    expect(isAgentPolicyRuleId("decision-log.unavailable")).toBe(false);
    expect(isAgentPolicyRuleId("decision-log-unavailable.unobserved")).toBe(
      false,
    );
  });
});

test("7b. the rule-id union is now twenty-two members", () => {
  expect(ALL_TWENTY_TWO_RULE_IDS).toHaveLength(22);
  expect(new Set(ALL_TWENTY_TWO_RULE_IDS).size).toBe(22);
  expect(ALL_TWENTY_TWO_RULE_IDS.every((id) => isAgentPolicyRuleId(id))).toBe(
    true,
  );

  expectTypeOf<M3LAgentPolicyRuleId>().toEqualTypeOf<
    (typeof ALL_TWENTY_TWO_RULE_IDS)[number]
  >();
});

/* -------------------------------------------------------------------------- */
/* 8. Validation                                                              */
/* -------------------------------------------------------------------------- */

describe("8. validation: requireDecisionLog and decisionLogAvailable", () => {
  test.each([
    ["the string 'true'", "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", {}],
  ])(
    "a declaration with requireDecisionLog=%s throws, naming the field and violation, never the value",
    (_label, requireDecisionLog) => {
      const error = expectDeclarationRejected(
        { ...BASE_DECLARATION, requireDecisionLog },
        "requireDecisionLog",
      );

      expect(Object.values(error.context)).not.toContain(requireDecisionLog);
    },
  );

  test.each([
    ["the string 'true'", "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", {}],
  ])(
    "a run ledger with decisionLogAvailable=%s throws, naming the field and violation, never the value",
    (_label, decisionLogAvailable) => {
      // Unconditional, like every other ACT rule on the ledger (ACT-14):
      // no policy needs to declare `requireDecisionLog` for a malformed
      // `decisionLogAvailable` to be rejected.
      const error = expectActionRejected(
        {
          policy: policyWith(),
          action: READ_ONLY_ACTION,
          run: { decisionLogAvailable },
        },
        "options.run.decisionLogAvailable",
      );

      expect(Object.values(error.context)).not.toContain(decisionLogAvailable);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Type-level contract                                                        */
/* -------------------------------------------------------------------------- */

describe("type-level: the two new optional fields", () => {
  test("M3LAgentPolicyDeclaration['requireDecisionLog'] is boolean | undefined (plain ?: form)", () => {
    expectTypeOf<
      M3LAgentPolicyDeclaration["requireDecisionLog"]
    >().toEqualTypeOf<boolean | undefined>();
  });

  test("M3LAgentRunLedger['decisionLogAvailable'] is boolean | undefined (plain ?: form)", () => {
    expectTypeOf<M3LAgentRunLedger["decisionLogAvailable"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  test("a declaration literal with requireDecisionLog omitted still satisfies the type", () => {
    const declaration: M3LAgentPolicyDeclaration = {
      version: 1,
      scripts: [{ script: "s3-report", allOperations: true }],
    };

    expect(declaration.requireDecisionLog).toBeUndefined();
  });

  test("a decision from evaluateAgentAction keeps M3LAgentDecision's shape unchanged", () => {
    const decision: M3LAgentDecision = evaluateAgentAction({
      policy: policyWith(),
      action: READ_ONLY_ACTION,
    });

    expectTypeOf(decision.rule).toEqualTypeOf<M3LAgentPolicyRuleId>();
  });
});
