/**
 * Tests for `core/agent` slice 1 — the evaluator half (RED phase:
 * `evaluateAgentAction` and `validateAgentPolicy` are placeholders that throw
 * "not yet implemented").
 *
 * Contract source: docs/reference/core/agent.md § Validating the action (the
 * ten ACT rules), § The tier decision table, § Fail-closed defaults, § Guard
 * polarity, § Verdicts and rule ids, and § The evaluator.
 *
 * The declaration validator, the two error classes, the two guards and the
 * declared ceilings are covered by the sibling `agent.test.ts`.
 *
 * Every policy here is built through the real `validateAgentPolicy`. A cast
 * policy is no longer merely discouraged: `evaluateAgentAction` checks the
 * runtime brand (a module-private `WeakSet`), so an object the validator did
 * not itself produce is rejected outright and cannot reach a verdict arm —
 * `agent-hardening.test.ts` § F4 pins that. The one cast left in this file is
 * on an **action**, for the forward-compatibility `kind` arm, and it says so
 * inline.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  M3L_AGENT_MAX_PARAMETER_NAMES,
  M3LAgentActionValidationError,
  evaluateAgentAction,
  isAgentPolicyRuleId,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentAction,
  M3LAgentActionKind,
  M3LAgentActionRecord,
  M3LAgentDecision,
  M3LAgentEvaluationOptions,
  M3LAgentPolicy,
  M3LAgentPolicyRuleId,
  M3LAgentVerdict,
  M3LDestructiveTarget,
  M3LDestructiveTargetPredicate,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A policy whose declaration grades targets. Built lazily inside each test:
 * a module-level call would throw during Vitest's *collection* pass in the
 * RED phase and take the whole file (and `check:test-counts`) with it.
 */
function gradedPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
      { script: "s3-report", allOperations: true },
    ],
    sensitiveTargets: { profiles: ["prod"], regions: ["eu-west-1"] },
  });
}

/** The same grants, with no grading spec declared at all. */
function ungradedPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
      { script: "s3-report", allOperations: true },
    ],
  });
}

/** A non-sensitive target under {@link gradedPolicy}'s spec. */
const SAFE_TARGET: M3LDestructiveTarget = {
  profile: "sandbox",
  region: "eu-central-1",
};

/** A target the declared spec grades sensitive (profile "prod"). */
const SENSITIVE_TARGET: M3LDestructiveTarget = {
  profile: "prod",
  region: "eu-central-1",
};

/** An allowlisted, graded, non-sensitive mutation — the step-7 shape. */
const APPROVABLE_MUTATION: M3LAgentAction = {
  script: "dynamodb-crud",
  operation: "put-item",
  kind: "mutating",
  target: SAFE_TARGET,
  parameterNames: ["table", "item"],
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
 * Asserts the options bag is rejected at step 0 and returns the error.
 *
 * Like the declaration helper in the sibling file, this asserts a **non-empty
 * `context`** as well as the class and code: the contract says `context`
 * names the offending field and the violation kind, and asserting it is what
 * stops these cases passing vacuously against the RED placeholder (which
 * throws the same class with no context).
 */
function expectActionRejected(options: unknown): M3LAgentActionValidationError {
  const thrown = catchThrown(() =>
    evaluateAgentAction(options as M3LAgentEvaluationOptions),
  );
  expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
  const error = thrown as M3LAgentActionValidationError;
  expect(error.code).toBe("ERR_AGENT_INVALID_ACTION");
  expect(Object.keys(error.context).length).toBeGreaterThan(0);
  return error;
}

/** Evaluates `action` against the graded policy with no extra predicate. */
function decideGraded(action: unknown): M3LAgentDecision {
  return evaluateAgentAction({
    policy: gradedPolicy(),
    action: action as M3LAgentAction,
  });
}

class NotAPlainObject {
  readonly script = "s3-report";
  readonly kind: M3LAgentActionKind = "read-only";
}

/**
 * Runs `run` with `key` present on `Object.prototype`, then removes it.
 *
 * `Object.create({ ... })` cannot exercise an inherited-property read here: a
 * custom prototype fails `isPlainObject`, so the value is rejected as "not a
 * plain object" before any presence read happens. Polluting `Object.prototype`
 * is the only way an inherited property reaches a value that still satisfies
 * `isPlainObject` — and it is the real threat model these `Object.hasOwn`
 * reads exist to defeat.
 *
 * `configurable: true` is what makes the removal possible, and the removal
 * lives in a `finally` because a leaked `Object.prototype` key would corrupt
 * every later test in the run and surface somewhere unrelated. The property is
 * non-enumerable, matching real pollution and leaving `Object.keys` scans
 * untouched.
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

/* -------------------------------------------------------------------------- */
/* Step 0 — the ten ACT action-validation rules                               */
/* -------------------------------------------------------------------------- */

describe("ACT-1: action is a plain object", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", [{ script: "s3-report", kind: "read-only" }]],
    ["a string", "s3-report"],
    ["a number", 7],
    ["a Date", new Date(0)],
    ["a class instance", new NotAPlainObject()],
  ])("rejects an action that is %s", (_label: string, action: unknown) => {
    expectActionRejected({ policy: gradedPolicy(), action });
  });

  test("rejects an options bag that is not an object at all", () => {
    expectActionRejected(null);
  });
});

describe("ACT-2: script is a present, non-blank string", () => {
  test.each([
    ["absent", { kind: "read-only" }],
    ["an empty string", { script: "", kind: "read-only" }],
    ["whitespace only", { script: "   ", kind: "read-only" }],
    ["a tab", { script: "\t", kind: "read-only" }],
    ["a non-string", { script: 7, kind: "read-only" }],
    ["null", { script: null, kind: "read-only" }],
  ])("rejects an action whose script is %s", (_label, action: unknown) => {
    expectActionRejected({ policy: gradedPolicy(), action });
  });
});

describe("ACT-3: kind is exactly read-only or mutating", () => {
  test.each([
    ["absent", { script: "s3-report" }],
    ["a near-miss literal", { script: "s3-report", kind: "readonly" }],
    ["a differently-cased literal", { script: "s3-report", kind: "Read-Only" }],
    ["an empty string", { script: "s3-report", kind: "" }],
    ["a non-string", { script: "s3-report", kind: 1 }],
    ["null", { script: "s3-report", kind: null }],
  ])("rejects an action whose kind is %s", (_label, action: unknown) => {
    expectActionRejected({ policy: gradedPolicy(), action });
  });

  test("a typo'd kind throws rather than escalating as unclassifiable", () => {
    // Both arms are genuinely contested here: an implementation that let an
    // unrecognised `kind` fall through to step 4 would return
    // escalate/"unclassifiable-escalated" for this exact input instead of
    // throwing. The page chooses the loud failure so a caller bug cannot hide
    // behind a verdict that looks like policy working correctly.
    const thrown = catchThrown(() =>
      evaluateAgentAction({
        policy: gradedPolicy(),
        action: {
          script: "s3-report",
          kind: "archival",
        } as unknown as M3LAgentAction,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
  });
});

describe("ACT-4: operation, when present, is a non-blank string", () => {
  test.each([
    ["an empty string", ""],
    ["whitespace only", "  "],
    ["a non-string", 7],
    ["null", null],
  ])(
    "rejects an action whose operation is %s",
    (_label, operation: unknown) => {
      expectActionRejected({
        policy: gradedPolicy(),
        action: { script: "dynamodb-crud", kind: "read-only", operation },
      });
    },
  );
});

describe("ACT-5: target, when present, is a plain object of non-blank scalars", () => {
  test.each([
    ["null", null],
    ["an array", ["sandbox"]],
    ["a string", "sandbox"],
    ["missing profile", { region: "eu-central-1" }],
    ["a blank profile", { profile: "  " }],
    ["a non-string profile", { profile: 7 }],
    ["a blank region", { profile: "sandbox", region: "" }],
    ["a non-string region", { profile: "sandbox", region: 7 }],
    ["a blank accountId", { profile: "sandbox", accountId: "   " }],
    ["a non-string accountId", { profile: "sandbox", accountId: 111 }],
    ["an unknown own key", { profile: "sandbox", arn: "arn:aws:iam::x" }],
    ["a dangerous own key", { profile: "sandbox", constructor: {} }],
  ])("rejects an action whose target is %s", (_label, target: unknown) => {
    expectActionRejected({
      policy: gradedPolicy(),
      action: { script: "dynamodb-crud", kind: "read-only", target },
    });
  });

  test("accepts a target carrying only a profile", () => {
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        target: { profile: "sandbox" },
      },
    });

    expect(decision.action.target).toEqual({
      profile: "sandbox",
      region: undefined,
      accountId: undefined,
    });
  });
});

describe("ACT-6: parameterNames, when present, is a bounded array of non-blank strings", () => {
  test.each([
    ["not an array", "table"],
    ["null", null],
    ["containing a non-string", ["table", 7]],
    ["containing an empty string", ["table", ""]],
    ["containing a whitespace-only string", ["table", "  "]],
  ])(
    "rejects an action whose parameterNames is %s",
    (_label, parameterNames: unknown) => {
      expectActionRejected({
        policy: gradedPolicy(),
        action: { script: "dynamodb-crud", kind: "read-only", parameterNames },
      });
    },
  );

  test("rejects more names than M3L_AGENT_MAX_PARAMETER_NAMES rather than truncating", () => {
    expectActionRejected({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
        parameterNames: Array.from(
          { length: M3L_AGENT_MAX_PARAMETER_NAMES + 1 },
          (_unused, index) => `p-${index}`,
        ),
      },
    });
  });

  test("accepts exactly M3L_AGENT_MAX_PARAMETER_NAMES names (reject-above bound)", () => {
    const parameterNames = Array.from(
      { length: M3L_AGENT_MAX_PARAMETER_NAMES },
      (_unused, index) => `p-${index}`,
    );

    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
        parameterNames,
      },
    });

    expect(decision.action.parameterNames).toHaveLength(
      M3L_AGENT_MAX_PARAMETER_NAMES,
    );
  });
});

describe("ACT-7: dryRun, when present, is a boolean", () => {
  test.each([
    ['the string "yes"', "yes"],
    ['the string "false"', "false"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
  ])("rejects an action whose dryRun is %s", (_label, dryRun: unknown) => {
    // Present-but-valueless is malformed input, not "absent": a coercion to
    // `false` here would silently turn a caller's intended dry run into a
    // real one.
    expectActionRejected({
      policy: gradedPolicy(),
      action: { script: "dynamodb-crud", kind: "read-only", dryRun },
    });
  });

  test.each([true, false])(
    "accepts and records the boolean dryRun %s",
    (dryRun: boolean) => {
      const decision = evaluateAgentAction({
        policy: gradedPolicy(),
        action: {
          script: "dynamodb-crud",
          operation: "get-item",
          kind: "read-only",
          dryRun,
        },
      });

      expect(decision.action.dryRun).toBe(dryRun);
    },
  );
});

describe("ACT-8: unknown own keys on the action", () => {
  test.each([
    ["a typo'd known key", { dryrun: true }],
    ["an invented key", { reason: "because the model said so" }],
    ["a slice-2 key that has not landed", { budget: { tokens: 10 } }],
  ])("rejects an action carrying %s", (_label, extra: object) => {
    expectActionRejected({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
        ...extra,
      },
    });
  });
});

describe("ACT-9: dangerous keys on the action", () => {
  test.each([["constructor"], ["prototype"]])(
    "rejects an action carrying an own %s key",
    (key: string) => {
      expectActionRejected({
        policy: gradedPolicy(),
        action: { script: "s3-report", kind: "read-only", [key]: {} },
      });
    },
  );

  test("rejects an own __proto__ key parsed out of a JSON document", () => {
    const action: unknown = JSON.parse(
      '{"script":"s3-report","kind":"read-only","__proto__":{"polluted":true}}',
    );

    expectActionRejected({ policy: gradedPolicy(), action });
  });
});

describe("ACT-10: additionalSensitiveTargets, when present, is a function", () => {
  test.each([
    ["a string", "sensitive"],
    ["a number", 1],
    ["null", null],
    ["an object", { profiles: ["prod"] }],
    ["an array", [() => true]],
    ["a boolean", true],
  ])(
    "rejects a non-function additionalSensitiveTargets that is %s",
    (_label, additionalSensitiveTargets: unknown) => {
      // The failure must surface as this module's typed error, not as a bare
      // TypeError from the call site at step 5.
      expectActionRejected({
        policy: gradedPolicy(),
        action: APPROVABLE_MUTATION,
        additionalSensitiveTargets,
      });
    },
  );
});

describe("step 0 runs before every verdict arm", () => {
  test("a malformed action for a non-allowlisted script throws instead of returning denied", () => {
    // Contested on purpose: step 1 would return denied/"script-not-allowlisted"
    // for this script, so an implementation that validated after the allowlist
    // would return a verdict rather than throw.
    expectActionRejected({
      policy: gradedPolicy(),
      action: { script: "not-allowlisted", kind: "readonly" },
    });
  });

  test("presence is read with Object.hasOwn, so an inherited operation counts as absent", () => {
    // Contested on purpose: "get-item" IS allowlisted for this grant, so an
    // implementation reading presence as `action["operation"] !== undefined`
    // would see the inherited value, clear step 2, and auto-approve at the
    // read-only tier. Only an `Object.hasOwn` read leaves `operation` absent
    // and denies. The action itself is an ordinary literal, so ACT-1 passes
    // and the denial can only come from step 2.
    const action: Record<string, unknown> = {
      script: "dynamodb-crud",
      kind: "read-only",
    };

    const decision = withPollutedObjectPrototype(
      "operation",
      "get-item",
      () => {
        // The pollution is live and the two readings genuinely disagree: a bare
        // bracket read resolves the inherited value, Object.hasOwn does not. If
        // this ever stopped holding the case below would pass vacuously.
        expect(action["operation"]).toBe("get-item");
        expect(Object.hasOwn(action, "operation")).toBe(false);

        return decideGraded(action);
      },
    );

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("operation-not-allowlisted");
  });
});

/* -------------------------------------------------------------------------- */
/* The tier decision table: rule id <-> verdict pairings                      */
/* -------------------------------------------------------------------------- */

/**
 * One reachable scenario per rule id, with the verdict the page's table pins
 * to it. The pairing is "locked by a test, not by the type" — `rule` is typed
 * as the whole union on every arm — so this table is the lock.
 *
 * `unclassifiable-escalated` is absent here because no input can reach it
 * through the public API today; see its own describe block below.
 */
const PAIRINGS = [
  [
    "script-not-allowlisted",
    "denied",
    (): M3LAgentDecision =>
      decideGraded({ script: "unknown-script", kind: "read-only" }),
  ],
  [
    "operation-not-allowlisted",
    "denied",
    (): M3LAgentDecision =>
      decideGraded({
        script: "dynamodb-crud",
        operation: "delete-table",
        kind: "read-only",
      }),
  ],
  [
    "read-only-auto-approved",
    "auto-approved",
    (): M3LAgentDecision =>
      decideGraded({
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      }),
  ],
  [
    "target-ungraded-escalated",
    "escalate",
    (): M3LAgentDecision =>
      decideGraded({
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
      }),
  ],
  [
    "policy-ungraded-escalated",
    "escalate",
    (): M3LAgentDecision =>
      evaluateAgentAction({
        policy: ungradedPolicy(),
        action: APPROVABLE_MUTATION,
      }),
  ],
  [
    "sensitive-target-escalated",
    "escalate",
    (): M3LAgentDecision =>
      decideGraded({
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        target: SENSITIVE_TARGET,
      }),
  ],
  [
    "graded-mutation-auto-approved",
    "auto-approved",
    (): M3LAgentDecision => decideGraded(APPROVABLE_MUTATION),
  ],
] as const satisfies ReadonlyArray<
  readonly [M3LAgentPolicyRuleId, M3LAgentVerdict, () => M3LAgentDecision]
>;

describe("the rule id <-> verdict pairing", () => {
  test.each(PAIRINGS)(
    "%s pairs with the verdict %s",
    (
      rule: M3LAgentPolicyRuleId,
      verdict: M3LAgentVerdict,
      produce: () => M3LAgentDecision,
    ) => {
      const decision = produce();

      expect(decision.rule).toBe(rule);
      expect(decision.verdict).toBe(verdict);
    },
  );

  test.each(PAIRINGS)(
    "the %s decision names a rule id this build knows and carries a reason",
    (
      _rule: M3LAgentPolicyRuleId,
      _verdict: M3LAgentVerdict,
      produce: () => M3LAgentDecision,
    ) => {
      const decision = produce();

      expect(isAgentPolicyRuleId(decision.rule)).toBe(true);
      expect(typeof decision.reason).toBe("string");
      expect(decision.reason.length).toBeGreaterThan(0);
    },
  );

  test("every slice-1 rule id except the forward-compat arm is produced by a scenario above", () => {
    const covered = PAIRINGS.map(([rule]) => rule);

    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).toHaveLength(7);
  });
});

/* -------------------------------------------------------------------------- */
/* Evaluation order — each arm terminal, each precedence genuinely contested  */
/* -------------------------------------------------------------------------- */

describe("evaluation order", () => {
  test("step 1 wins over step 2 when both the script and the operation are unlisted", () => {
    // Contested: "delete-table" is not in any grant's operations either, so an
    // implementation that checked the operation first would return
    // "operation-not-allowlisted".
    const decision = decideGraded({
      script: "unknown-script",
      operation: "delete-table",
      kind: "read-only",
    });

    expect(decision.rule).toBe("script-not-allowlisted");
    expect(decision.verdict).toBe("denied");
  });

  test("step 2 wins over step 4 for an unlisted operation on a read-only action", () => {
    // Contested: the action is read-only, so an implementation that ran the
    // tier arm first would auto-approve it.
    const decision = decideGraded({
      script: "dynamodb-crud",
      operation: "delete-table",
      kind: "read-only",
    });

    expect(decision.rule).toBe("operation-not-allowlisted");
    expect(decision.verdict).toBe("denied");
  });

  test("an operation-scoped grant denies an action carrying no operation at all", () => {
    const decision = decideGraded({
      script: "dynamodb-crud",
      kind: "read-only",
    });

    expect(decision.rule).toBe("operation-not-allowlisted");
    expect(decision.verdict).toBe("denied");
  });

  test("step 4's read-only arm wins over step 5's ungraded arms", () => {
    // Contested twice over: this action carries no target AND runs against a
    // policy with no grading spec, so both step-5 escalation arms would fire
    // if the read-only arm were not terminal.
    const decision = evaluateAgentAction({
      policy: ungradedPolicy(),
      action: { script: "s3-report", kind: "read-only" },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
    expect(decision.verdict).toBe("auto-approved");
  });

  test("step 5 checks the action's target before the policy's grading spec", () => {
    // Contested: the policy declares no grading spec either, so the losing arm
    // ("policy-ungraded-escalated") is genuinely reachable for this input.
    const decision = evaluateAgentAction({
      policy: ungradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
      },
    });

    expect(decision.rule).toBe("target-ungraded-escalated");
    expect(decision.verdict).toBe("escalate");
  });

  test("step 5's sensitivity arm wins over step 7's auto-approval", () => {
    // Contested: everything else about this action is step-7 approvable — it
    // is allowlisted, mutating, and carries a graded target.
    const decision = decideGraded({
      ...APPROVABLE_MUTATION,
      target: SENSITIVE_TARGET,
    });

    expect(decision.rule).toBe("sensitive-target-escalated");
    expect(decision.verdict).toBe("escalate");
  });

  test("a region-graded sensitive target escalates the same way a profile-graded one does", () => {
    const decision = decideGraded({
      ...APPROVABLE_MUTATION,
      target: { profile: "sandbox", region: "eu-west-1" },
    });

    expect(decision.rule).toBe("sensitive-target-escalated");
  });

  test("step 7 auto-approves the allowlisted, graded, non-sensitive mutation", () => {
    const decision = decideGraded(APPROVABLE_MUTATION);

    expect(decision.rule).toBe("graded-mutation-auto-approved");
    expect(decision.verdict).toBe("auto-approved");
  });

  test.each([
    ["a differently-cased script name", "DynamoDB-Crud"],
    ["a leading-space script name", " dynamodb-crud"],
    ["a trailing-space script name", "dynamodb-crud "],
  ])(
    "matches the script verbatim, so %s is not allowlisted",
    (_label, script: string) => {
      const decision = decideGraded({
        script,
        operation: "get-item",
        kind: "read-only",
      });

      expect(decision.rule).toBe("script-not-allowlisted");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Guard polarity                                                             */
/* -------------------------------------------------------------------------- */

describe("guard polarity: allOperations widens only on strict boolean true", () => {
  /*
   * The four garbage-`allOperations` cases that used to live here (`1`,
   * `"true"`, `{}`, `["yes"]`, each driven through `evaluateAgentAction` on a
   * `as unknown as M3LAgentPolicy` cast) are GONE, deliberately. The runtime
   * brand rejects any policy object `validateAgentPolicy` did not itself
   * produce, so those inputs no longer reach a verdict arm at all — they now
   * throw `ERR_AGENT_INVALID_ACTION` / `options.policy` /
   * `not-a-validated-policy`, which `agent-hardening.test.ts` § F4 pins.
   * The scenario is unreachable, not untested.
   *
   * Nothing lost coverage:
   *
   * - The strict-`true` polarity guard still stands in
   *   `internal/agent/decide.ts` as defence in depth for that internal entry
   *   point, and BOTH its branches are exercised here by legitimate validated
   *   policies. `allOperations !== true` taken: every `dynamodb-crud` case in
   *   this file uses a named-operation grant, which leaves `allOperations` an
   *   absent own key, so step 2 runs — see the `operation-not-allowlisted`
   *   pairing and "matches the script verbatim …". `allOperations === true`
   *   taken: the two `s3-report` cases immediately below, "does widen the
   *   grant when allOperations is the boolean true" and "a widened grant also
   *   allows an action carrying no operation", where step 2 is skipped.
   * - Rejecting a garbage `allOperations` value is now the **validator's**
   *   job alone, covered by `agent.test.ts`'s
   *   `describe("validateAgentPolicy — rule 8: allOperations is the boolean
   *   true")` and its `test.each` "rejects a grant whose allOperations is %s"
   *   over `false`, `"true"`, `1`, `null`, and `{}`.
   */

  test("does widen the grant when allOperations is the boolean true", () => {
    // The other half of the pair: proves the denials above come from the
    // strictness of the check and not from the operation arm always denying.
    const decision = decideGraded({
      script: "s3-report",
      operation: "delete-every-object",
      kind: "read-only",
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("a widened grant also allows an action carrying no operation", () => {
    const decision = decideGraded({ script: "s3-report", kind: "read-only" });

    expect(decision.rule).toBe("read-only-auto-approved");
  });
});

describe("guard polarity: sensitivity escalates on truthiness", () => {
  test.each([
    ["the number 1", 1],
    ["a non-empty string", "yes"],
    ["an object", { sensitive: true }],
    ["an empty array", []],
  ])(
    "escalates when additionalSensitiveTargets returns %s",
    (_label, returned: unknown) => {
      // `additionalSensitiveTargets` is caller-supplied, so a JavaScript
      // caller can return a truthy non-boolean. A `=== true` check here would
      // be a fail-open hole in the place with the widest blast radius:
      // contested, because this action is otherwise step-7 approvable.
      const additionalSensitiveTargets = (() =>
        returned) as unknown as M3LDestructiveTargetPredicate;

      const decision = evaluateAgentAction({
        policy: gradedPolicy(),
        action: APPROVABLE_MUTATION,
        additionalSensitiveTargets,
      });

      expect(decision.verdict).toBe("escalate");
      expect(decision.rule).toBe("sensitive-target-escalated");
    },
  );

  test("auto-approves when additionalSensitiveTargets returns false", () => {
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: APPROVABLE_MUTATION,
      additionalSensitiveTargets: () => false,
    });

    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });

  test("auto-approves when additionalSensitiveTargets is absent entirely", () => {
    // "Absent, contributes nothing" is a distinct state from "present and
    // returned falsy", and neither may escalate on its own.
    const decision = decideGraded(APPROVABLE_MUTATION);

    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });

  test("the extra predicate can only add sensitivity, never remove it", () => {
    // Contested: under AND semantics a `false` here would de-escalate a
    // target the declaration itself grades sensitive.
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: { ...APPROVABLE_MUTATION, target: SENSITIVE_TARGET },
      additionalSensitiveTargets: () => false,
    });

    expect(decision.rule).toBe("sensitive-target-escalated");
  });

  test("receives the target under judgement", () => {
    const additionalSensitiveTargets = vi.fn(() => false);

    evaluateAgentAction({
      policy: gradedPolicy(),
      action: APPROVABLE_MUTATION,
      additionalSensitiveTargets,
    });

    expect(additionalSensitiveTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "sandbox",
        region: "eu-central-1",
      }),
    );
  });
});

describe("a throwing sensitivity predicate propagates unchanged", () => {
  test("propagates the caller's Error instance identically, producing no verdict", () => {
    const failure = new Error("STS lookup failed");
    const thrown = catchThrown(() =>
      evaluateAgentAction({
        policy: gradedPolicy(),
        action: APPROVABLE_MUTATION,
        additionalSensitiveTargets: () => {
          throw failure;
        },
      }),
    );

    expect(thrown).toBe(failure);
  });

  test("propagates a non-Error throw un-normalized", () => {
    const thrown = catchThrown(() =>
      evaluateAgentAction({
        policy: gradedPolicy(),
        action: APPROVABLE_MUTATION,
        additionalSensitiveTargets: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to prove the caller's exception is propagated unchanged rather than wrapped or normalized
          throw "boom";
        },
      }),
    );

    expect(thrown).toBe("boom");
  });

  test.each([
    [
      "step 4 has already returned (read-only)",
      { script: "s3-report", kind: "read-only" } satisfies M3LAgentAction,
    ],
    [
      "step 5's target-ungraded arm has already returned",
      {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
      } satisfies M3LAgentAction,
    ],
  ])("is never invoked once %s", (_label: string, action: M3LAgentAction) => {
    // Those arms are terminal, so a predicate that throws must not be able
    // to turn a decided verdict into an exception.
    const additionalSensitiveTargets = vi.fn(() => {
      throw new Error("must not be called");
    });

    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action,
      additionalSensitiveTargets,
    });

    expect(additionalSensitiveTargets).not.toHaveBeenCalled();
    expect(decision.verdict).not.toBe("denied");
  });

  test("is never invoked once step 5's policy-ungraded arm has returned", () => {
    const additionalSensitiveTargets = vi.fn(() => true);

    const decision = evaluateAgentAction({
      policy: ungradedPolicy(),
      action: APPROVABLE_MUTATION,
      additionalSensitiveTargets,
    });

    expect(decision.rule).toBe("policy-ungraded-escalated");
    expect(additionalSensitiveTargets).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The forward-compatibility arm                                              */
/* -------------------------------------------------------------------------- */

describe("unclassifiable-escalated — the fail-closed forward-compat arm", () => {
  test("is part of this build's rule vocabulary", () => {
    expect(isAgentPolicyRuleId("unclassifiable-escalated")).toBe(true);
  });

  test("an M3LAgentActionKind no rule handles is representable and pairs with escalate", () => {
    // The runtime arm is unreachable through the public API today: ACT-3
    // rejects any `kind` outside the two literals at step 0, and a cast
    // cannot bypass a runtime allowlist — so the strongest reachable
    // assertion is the one in the ACT-3 block above ("a typo'd kind throws
    // rather than escalating as unclassifiable"), plus this pairing.
    //
    // The arm becomes reachable the moment `M3LAgentActionKind` gains a third
    // member and ACT-3's allowlist is widened without extending step 4; at
    // that point this test should be replaced by one that evaluates the new
    // kind and asserts escalate/"unclassifiable-escalated" end to end.
    const decision: M3LAgentDecision = {
      verdict: "escalate",
      rule: "unclassifiable-escalated",
      reason: "an M3LAgentActionKind no rule handles",
      action: {
        script: "s3-report",
        operation: undefined,
        kind: "archival" as unknown as M3LAgentActionKind,
        target: undefined,
        parameterNames: [],
        dryRun: false,
        // Plain placeholder: this fixture only exercises the
        // escalate/"unclassifiable-escalated" pairing, not the
        // dry-run-first discipline that gives `shapeKey` meaning (see
        // agent-dry-run.test.ts for the real `agentActionShapeKey` contract).
        shapeKey: "placeholder-shape-key",
      },
    };

    expect(decision.verdict).toBe("escalate");
    expect(isAgentPolicyRuleId(decision.rule)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The frozen projection carried on every decision                            */
/* -------------------------------------------------------------------------- */

describe("the action projection carried on the decision", () => {
  test("defaults the optional fields to required keys holding undefined / [] / false", () => {
    const decision = decideGraded({ script: "s3-report", kind: "read-only" });
    const record = decision.action;

    expect(Object.hasOwn(record, "operation")).toBe(true);
    expect(record.operation).toBeUndefined();
    expect(Object.hasOwn(record, "target")).toBe(true);
    expect(record.target).toBeUndefined();
    expect(record.parameterNames).toEqual([]);
    expect(record.dryRun).toBe(false);
    expect(record.script).toBe("s3-report");
    expect(record.kind).toBe("read-only");
  });

  test("projects the target as a fresh object carrying only the three ADR-0048 scalars", () => {
    const decision = decideGraded({
      ...APPROVABLE_MUTATION,
      target: { profile: "sandbox" },
    });
    const target = decision.action.target;

    expect(target).toBeDefined();
    expect(Object.keys(target ?? {}).sort()).toEqual([
      "accountId",
      "profile",
      "region",
    ]);
    expect(target?.region).toBeUndefined();
    expect(target?.accountId).toBeUndefined();
  });

  test("deep-freezes the record, its parameterNames copy, and its target copy", () => {
    const decision = decideGraded(APPROVABLE_MUTATION);

    expect(Object.isFrozen(decision.action)).toBe(true);
    expect(Object.isFrozen(decision.action.parameterNames)).toBe(true);
    expect(Object.isFrozen(decision.action.target)).toBe(true);
  });

  test("mutating the caller's target after the call cannot rewrite the decision", () => {
    // A reference copy would leave `action.target.profile = "prod"` able to
    // rewrite `decision.action.target.profile` after the fact, making the
    // decision log and the verdict disagree.
    const target: { profile: string; region?: string } = {
      profile: "sandbox",
      region: "eu-central-1",
    };
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: { ...APPROVABLE_MUTATION, target },
    });

    target.profile = "prod";
    target.region = "eu-west-1";

    expect(decision.action.target?.profile).toBe("sandbox");
    expect(decision.action.target?.region).toBe("eu-central-1");
    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });

  test("mutating the caller's parameterNames array after the call cannot rewrite the decision", () => {
    const parameterNames = ["table", "item"];
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: { ...APPROVABLE_MUTATION, parameterNames },
    });

    parameterNames.push("smuggled");
    parameterNames[0] = "rewritten";

    expect(decision.action.parameterNames).toEqual(["table", "item"]);
  });

  test("a denied decision carries the same full projection an approved one does", () => {
    const decision = decideGraded({
      script: "unknown-script",
      operation: "get-item",
      kind: "mutating",
      target: SAFE_TARGET,
      parameterNames: ["table"],
      dryRun: true,
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.action).toEqual({
      script: "unknown-script",
      operation: "get-item",
      kind: "mutating",
      target: {
        profile: "sandbox",
        region: "eu-central-1",
        accountId: undefined,
      },
      parameterNames: ["table"],
      dryRun: true,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest's expect.any() is typed `any`; this only asserts shapeKey is a string, not a fixed value
      shapeKey: expect.any(String),
    });
  });
});

describe("the library-authored reason", () => {
  test("is composed from the script, operation, kind and target scalars", () => {
    const decision = decideGraded(APPROVABLE_MUTATION);

    expect(decision.reason).toContain("dynamodb-crud");
    expect(decision.reason).toContain("put-item");
  });

  test("never embeds a parameter name or value", () => {
    const decision = decideGraded({
      ...APPROVABLE_MUTATION,
      parameterNames: ["zzz-parameter-name"],
    });

    expect(decision.reason).not.toContain("zzz-parameter-name");
  });
});

/* -------------------------------------------------------------------------- */
/* Type-level contract                                                        */
/* -------------------------------------------------------------------------- */

describe("type-level contract", () => {
  test("evaluateAgentAction takes one options bag and returns a decision", () => {
    expectTypeOf(evaluateAgentAction).parameters.toEqualTypeOf<
      [M3LAgentEvaluationOptions]
    >();
    expectTypeOf(evaluateAgentAction).returns.toEqualTypeOf<M3LAgentDecision>();
  });

  test("M3LAgentDecision discriminates on verdict", () => {
    type Approved = Extract<M3LAgentDecision, { verdict: "auto-approved" }>;
    type Escalated = Extract<M3LAgentDecision, { verdict: "escalate" }>;
    type Denied = Extract<M3LAgentDecision, { verdict: "denied" }>;

    expectTypeOf<Approved["verdict"]>().toEqualTypeOf<"auto-approved">();
    expectTypeOf<Escalated["verdict"]>().toEqualTypeOf<"escalate">();
    expectTypeOf<Denied["verdict"]>().toEqualTypeOf<"denied">();
    expectTypeOf<
      M3LAgentDecision["verdict"]
    >().toEqualTypeOf<M3LAgentVerdict>();
  });

  test("every arm carries the whole rule union — the pairing is not type-enforced", () => {
    type Denied = Extract<M3LAgentDecision, { verdict: "denied" }>;

    expectTypeOf<Denied["rule"]>().toEqualTypeOf<M3LAgentPolicyRuleId>();
  });

  test("M3LAgentVerdict is closed at three members", () => {
    expectTypeOf<M3LAgentVerdict>().toEqualTypeOf<
      "auto-approved" | "escalate" | "denied"
    >();
  });

  test("M3LAgentActionRecord has no optional keys — required, holding undefined", () => {
    expectTypeOf<M3LAgentActionRecord>().toEqualTypeOf<
      Required<M3LAgentActionRecord>
    >();
    expectTypeOf<M3LAgentActionRecord["operation"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<M3LAgentActionRecord["target"]>().toEqualTypeOf<
      | {
          readonly profile: string;
          readonly region: string | undefined;
          readonly accountId: string | undefined;
        }
      | undefined
    >();
    expectTypeOf<M3LAgentActionRecord["dryRun"]>().toEqualTypeOf<boolean>();
  });

  test("the record's target is NOT M3LDestructiveTarget — own keys hold undefined", () => {
    // The record's target deliberately declares `region` / `accountId` as
    // REQUIRED keys holding `undefined`, because the projection emits them as
    // own properties (an own key cannot be shadowed by a polluted
    // `Object.prototype`). `M3LDestructiveTarget` declares them optional,
    // which under `exactOptionalPropertyTypes` means "absent, or a string —
    // never `undefined`" — so `if ("region" in target)` narrowed to `string`
    // and read `undefined` at runtime. The two types must not be equal.
    expectTypeOf<M3LAgentActionRecord["target"]>().not.toEqualTypeOf<
      M3LDestructiveTarget | undefined
    >();

    // The caller-supplied field is unchanged: it still IS ADR-0048's own
    // descriptor, optional keys and all.
    expectTypeOf<M3LAgentAction["target"]>().toEqualTypeOf<
      M3LDestructiveTarget | undefined
    >();
  });

  test("M3LAgentAction's optional fields stay optional for callers", () => {
    const minimal: M3LAgentAction = { script: "s3-report", kind: "read-only" };

    expect(minimal.operation).toBeUndefined();
    expectTypeOf<M3LAgentAction["kind"]>().toEqualTypeOf<M3LAgentActionKind>();
    expectTypeOf<M3LAgentActionKind>().toEqualTypeOf<
      "read-only" | "mutating"
    >();
  });

  test("additionalSensitiveTargets is the core/prompt predicate, optional", () => {
    expectTypeOf<
      M3LAgentEvaluationOptions["additionalSensitiveTargets"]
    >().toEqualTypeOf<M3LDestructiveTargetPredicate | undefined>();
  });
});
