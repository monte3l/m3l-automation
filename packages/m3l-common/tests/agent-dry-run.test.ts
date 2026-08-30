/**
 * Tests for `core/agent` slice 2 — the declared cross-check on `kind`
 * (`readOnlyOperations`), the dry-run-first discipline (step 6),
 * `agentActionShapeKey`, `validateAgentPolicy` rules 15/16, and the four new
 * barrel exports (RED phase: none of this exists yet — `M3LAgentRunLedger`,
 * `M3LAgentBudgets`, `agentActionShapeKey`, and `M3L_AGENT_MAX_DRY_RUN_SHAPES`
 * are not implemented, and `readOnlyOperations` / `dryRunFirst` are not
 * accepted by `validateAgentPolicy` yet).
 *
 * Contract source: docs/reference/core/agent.md § The declared cross-check on
 * `kind`, § The tier decision table (steps 4 and 6), § Dry-run-first,
 * § `validateAgentPolicy` rules 15/16, § Verdicts and rule ids, and
 * § Public API (the four slice-2 exports).
 *
 * Budgets and ceilings (step 3) proper are the sibling `agent-budgets.test.ts`
 * — this file only exercises a budget scenario where it is the ONLY way to
 * prove step 3 runs before step 4's cross-check (item 6 below) and where it
 * is needed to produce all seven new rule ids for the pairing table (item
 * 40). Slice 1's own contract (the ten ACT rules, the tier table's steps 1/2/
 * 5/7, the fail-closed table, guard polarity) lives in `agent-evaluate.test.ts`
 * and `agent.test.ts`.
 *
 * Every policy here is built through the real `validateAgentPolicy`, exactly
 * like the sibling files.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  M3L_AGENT_MAX_DRY_RUN_SHAPES,
  M3L_AGENT_MAX_LOG_ENTRY_BYTES,
  M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
  M3LAgentActionValidationError,
  M3LAgentPolicyDeclarationError,
  agentActionShapeKey,
  agentDecisionLogEntry,
  canonicalJsonHash,
  evaluateAgentAction,
  isAgentPolicyRuleId,
  serializeAgentDecisionLogEntry,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentAction,
  M3LAgentActionKind,
  M3LAgentActionRecord,
  M3LAgentBudgets,
  M3LAgentDecision,
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionLogEntryOptions,
  M3LAgentDecisionOutcome,
  M3LAgentEvaluationOptions,
  M3LAgentIdentity,
  M3LAgentPolicy,
  M3LAgentPolicyDeclaration,
  M3LAgentPolicyRuleId,
  M3LAgentRunLedger,
  M3LAgentScriptGrant,
  M3LAgentVerdict,
  M3LDestructiveTarget,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/** A non-sensitive target under every policy below (none grades "sandbox"). */
const SAFE_TARGET: M3LDestructiveTarget = {
  profile: "sandbox",
  region: "eu-central-1",
};

/** A target every policy below grades sensitive (profile "prod"). */
const SENSITIVE_TARGET: M3LDestructiveTarget = {
  profile: "prod",
  region: "eu-central-1",
};

/** An allowlisted, graded, non-sensitive mutation — the step-7 shape. */
const MUTATING_ACTION: M3LAgentAction = {
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

/** Asserts a declaration is rejected and returns the error. */
function expectPolicyRejected(
  declaration: unknown,
): M3LAgentPolicyDeclarationError {
  const thrown = catchThrown(() => validateAgentPolicy(declaration));
  expect(thrown).toBeInstanceOf(M3LAgentPolicyDeclarationError);
  const error = thrown as M3LAgentPolicyDeclarationError;
  expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
  expect(Object.keys(error.context).length).toBeGreaterThan(0);
  return error;
}

/** Asserts an options bag (or a bare action, for `agentActionShapeKey`) is rejected. */
function expectActionInputRejected(
  run: () => unknown,
): M3LAgentActionValidationError {
  const thrown = catchThrown(run);
  expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
  const error = thrown as M3LAgentActionValidationError;
  expect(error.code).toBe("ERR_AGENT_INVALID_ACTION");
  expect(Object.keys(error.context).length).toBeGreaterThan(0);
  return error;
}

/** `count` distinct non-blank strings, for the ceiling boundary cases. */
function uniqueList(prefix: string, count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}-${index}`,
  );
}

/**
 * Runs `run` with `key` present on `Object.prototype`, then removes it. Same
 * helper as the sibling files — see their doc comment for the full rationale.
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
/* Policies for the readOnlyOperations cross-check (step 4)                  */
/* -------------------------------------------------------------------------- */

/** Operation-scoped grant declaring `readOnlyOperations: ["get-item"]`. */
function crossCheckPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      {
        script: "dynamodb-crud",
        operations: ["get-item", "put-item", "delete-item"],
        readOnlyOperations: ["get-item"],
      },
    ],
    sensitiveTargets: { profiles: ["prod"] },
  });
}

/** The identical grant with no `readOnlyOperations` key at all (item 4). */
function noCrossCheckPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      {
        script: "dynamodb-crud",
        operations: ["get-item", "put-item", "delete-item"],
      },
    ],
    sensitiveTargets: { profiles: ["prod"] },
  });
}

/** An `allOperations` grant that also declares `readOnlyOperations` (item 7). */
function allOperationsCrossCheckPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      {
        script: "s3-report",
        allOperations: true,
        readOnlyOperations: ["list-objects"],
      },
    ],
    sensitiveTargets: { profiles: ["prod"] },
  });
}

/* -------------------------------------------------------------------------- */
/* Step 4 — the declared cross-check on `kind` (readOnlyOperations)          */
/* -------------------------------------------------------------------------- */

describe("step 4: the readOnlyOperations cross-check", () => {
  test("1. a read-only claim for an operation on readOnlyOperations auto-approves", () => {
    const decision = evaluateAgentAction({
      policy: crossCheckPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
    expect(decision.verdict).toBe("auto-approved");
  });

  test("2. a read-only claim for an allowlisted operation NOT on readOnlyOperations escalates", () => {
    const decision = evaluateAgentAction({
      policy: crossCheckPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "delete-item",
        kind: "read-only",
      },
    });

    expect(decision.rule).toBe("kind-cross-check-escalated");
    expect(decision.verdict).toBe("escalate");
  });

  describe("3. one-directional: a mutating claim for an operation ON readOnlyOperations is never doubted", () => {
    test("falls through to step 5 and auto-approves a safe target", () => {
      const decision = evaluateAgentAction({
        policy: crossCheckPolicy(),
        action: {
          script: "dynamodb-crud",
          operation: "get-item",
          kind: "mutating",
          target: SAFE_TARGET,
        },
      });

      expect(decision.rule).toBe("graded-mutation-auto-approved");
      expect(decision.verdict).toBe("auto-approved");
    });

    test("falls through to step 5 and escalates a sensitive target", () => {
      const decision = evaluateAgentAction({
        policy: crossCheckPolicy(),
        action: {
          script: "dynamodb-crud",
          operation: "get-item",
          kind: "mutating",
          target: SENSITIVE_TARGET,
        },
      });

      expect(decision.rule).toBe("sensitive-target-escalated");
      expect(decision.verdict).toBe("escalate");
    });
  });

  test("4. a grant with no readOnlyOperations own key behaves exactly as slice 1 did", () => {
    const decision = evaluateAgentAction({
      policy: noCrossCheckPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "delete-item",
        kind: "read-only",
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
    expect(decision.verdict).toBe("auto-approved");
  });

  test("5. a polluted Object.prototype.readOnlyOperations does not fabricate a cross-check", () => {
    // Contested: `[]` would fail every operation's membership test if read
    // through a plain dot read, so an implementation using `grant.readOnlyOperations`
    // instead of `Object.hasOwn` would escalate this instead of auto-approving.
    const policy = noCrossCheckPolicy();

    withPollutedObjectPrototype("readOnlyOperations", [], () => {
      const decision = evaluateAgentAction({
        policy,
        action: {
          script: "dynamodb-crud",
          operation: "delete-item",
          kind: "read-only",
        },
      });

      expect(decision.rule).toBe("read-only-auto-approved");
      expect(decision.verdict).toBe("auto-approved");
    });
  });

  test("6. step 3's budget exhaustion wins over the step-4 cross-check", () => {
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [
        {
          script: "dynamodb-crud",
          operations: ["get-item", "put-item", "delete-item"],
          readOnlyOperations: ["get-item"],
        },
      ],
      sensitiveTargets: { profiles: ["prod"] },
      budgets: { invocationsPerRun: 1 },
    });

    // A read-only claim for "delete-item" would escalate as
    // "kind-cross-check-escalated" if step 4 ran at all — the exhausted
    // budget must pre-empt it.
    const decision = evaluateAgentAction({
      policy,
      action: {
        script: "dynamodb-crud",
        operation: "delete-item",
        kind: "read-only",
      },
      run: { invocationsThisRun: 1 },
    });

    expect(decision.rule).toBe("budget.invocations-per-run");
    expect(decision.verdict).toBe("escalate");
  });

  describe("7. the cross-check applies to an allOperations grant too", () => {
    test("a read-only claim for an operation outside the list escalates", () => {
      const decision = evaluateAgentAction({
        policy: allOperationsCrossCheckPolicy(),
        action: {
          script: "s3-report",
          operation: "delete-bucket",
          kind: "read-only",
        },
      });

      expect(decision.rule).toBe("kind-cross-check-escalated");
      expect(decision.verdict).toBe("escalate");
    });

    test("a read-only claim with no operation at all escalates — the only route to that clause", () => {
      // On an operation-scoped grant, step 2 would already have denied an
      // absent operation; only a whole-script grant can reach step 4 with
      // nothing to corroborate.
      const decision = evaluateAgentAction({
        policy: allOperationsCrossCheckPolicy(),
        action: { script: "s3-report", kind: "read-only" },
      });

      expect(decision.rule).toBe("kind-cross-check-escalated");
      expect(decision.verdict).toBe("escalate");
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Policies for dry-run-first (step 6)                                       */
/* -------------------------------------------------------------------------- */

function dryRunFirstPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    sensitiveTargets: { profiles: ["prod"] },
    dryRunFirst: true,
  });
}

function dryRunFirstFalsePolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    sensitiveTargets: { profiles: ["prod"] },
    dryRunFirst: false,
  });
}

/** The slice-1 equivalent: no `dryRunFirst` key at all. */
function noDryRunFirstPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    sensitiveTargets: { profiles: ["prod"] },
  });
}

/** `dryRunFirst: true` but no grading spec at all (step 5's other ungraded arm). */
function dryRunFirstNoSensitiveTargetsPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    dryRunFirst: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Step 6 — dry-run-first                                                    */
/* -------------------------------------------------------------------------- */

describe("step 6: dry-run-first", () => {
  test("8. dryRunFirst absent: step 6 is skipped entirely", () => {
    const decision = evaluateAgentAction({
      policy: noDryRunFirstPolicy(),
      action: MUTATING_ACTION,
    });

    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });

  test("9. dryRunFirst: false validates and behaves identically to absent", () => {
    // The deliberate asymmetry with allOperations: `allOperations: false` is a
    // declaration ERROR (rule 8); `dryRunFirst: false` is legal (rule 16) and
    // means the same as omitting the key.
    expect(() =>
      validateAgentPolicy({
        version: 1,
        scripts: [{ script: "s3-report", allOperations: false }],
      }),
    ).toThrow(M3LAgentPolicyDeclarationError);
    expect(() =>
      validateAgentPolicy({
        version: 1,
        scripts: [{ script: "s3-report", allOperations: true }],
        dryRunFirst: false,
      }),
    ).not.toThrow();

    const decision = evaluateAgentAction({
      policy: dryRunFirstFalsePolicy(),
      action: MUTATING_ACTION,
    });

    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });

  test("11. a polluted Object.prototype.dryRunFirst = true does not enable step 6", () => {
    const policy = noDryRunFirstPolicy();

    withPollutedObjectPrototype("dryRunFirst", true, () => {
      const decision = evaluateAgentAction({ policy, action: MUTATING_ACTION });

      expect(decision.rule).toBe("graded-mutation-auto-approved");
      expect(decision.verdict).toBe("auto-approved");
    });
  });

  test("12. dryRunFirst true, shape not yet in the ledger, escalates as dry-run-first", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: MUTATING_ACTION,
      run: { dryRunCompletedShapes: ["some-other-shape"] },
    });

    expect(decision.rule).toBe("dry-run-first");
    expect(decision.verdict).toBe("escalate");
  });

  test("13. record.dryRun === true skips step 6 (strict true; false is not a skip)", () => {
    const dryRunDecision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: { ...MUTATING_ACTION, dryRun: true },
    });

    expect(dryRunDecision.rule).toBe("graded-mutation-auto-approved");

    const realRunDecision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: { ...MUTATING_ACTION, dryRun: false },
    });

    expect(realRunDecision.rule).toBe("dry-run-first");
  });

  test("14. round-trip: the dry run's own shapeKey, fed back, unlocks the real run", () => {
    const firstDecision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: MUTATING_ACTION,
    });

    expect(firstDecision.rule).toBe("dry-run-first");

    const run: M3LAgentRunLedger = {
      dryRunCompletedShapes: [firstDecision.action.shapeKey],
    };
    const secondDecision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: MUTATING_ACTION,
      run,
    });

    expect(secondDecision.rule).toBe("graded-mutation-auto-approved");
    expect(secondDecision.verdict).toBe("auto-approved");
  });

  test("15. dryRunFirst true, no run at all, escalates — no separate unobservable id", () => {
    const options: M3LAgentEvaluationOptions = {
      policy: dryRunFirstPolicy(),
      action: MUTATING_ACTION,
    };

    expect(options.run).toBeUndefined();

    const decision = evaluateAgentAction(options);

    expect(decision.rule).toBe("dry-run-first");
    expect(decision.verdict).toBe("escalate");
  });

  test.each<[string, M3LAgentRunLedger]>([
    ["dryRunCompletedShapes: []", { dryRunCompletedShapes: [] }],
    ["the key absent entirely", {}],
  ])("16. a run with %s still escalates as dry-run-first", (_label, run) => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: MUTATING_ACTION,
      run,
    });

    expect(decision.rule).toBe("dry-run-first");
  });

  test("17. step 5's sensitivity arm wins over step 6, even on a never-dry-run shape", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: { ...MUTATING_ACTION, target: SENSITIVE_TARGET },
    });

    expect(decision.rule).toBe("sensitive-target-escalated");
  });

  test("18. a dry run against a sensitive target still escalates at step 5 — dryRun is not a bypass", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: { ...MUTATING_ACTION, target: SENSITIVE_TARGET, dryRun: true },
    });

    expect(decision.rule).toBe("sensitive-target-escalated");
  });

  test("19. step 5's ungraded-target arm beats step 6", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
      },
    });

    expect(decision.rule).toBe("target-ungraded-escalated");
  });

  test("19. step 5's ungraded-policy arm beats step 6", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstNoSensitiveTargetsPolicy(),
      action: MUTATING_ACTION,
    });

    expect(decision.rule).toBe("policy-ungraded-escalated");
  });

  test("20. a read-only action never reaches step 6 — step 4 is terminal", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      },
    });

    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("21. dry-run-first cannot turn a denied verdict into anything else", () => {
    const decision = evaluateAgentAction({
      policy: dryRunFirstPolicy(),
      action: { script: "unknown-script", kind: "mutating" },
    });

    expect(decision.rule).toBe("script-not-allowlisted");
    expect(decision.verdict).toBe("denied");
  });
});

/* -------------------------------------------------------------------------- */
/* agentActionShapeKey                                                       */
/* -------------------------------------------------------------------------- */

/** Mirrors `core/json`'s own code-point comparator, which is not exported. */
function toCodePoints(value: string): number[] {
  return Array.from(value, (character) => character.codePointAt(0) as number);
}

function compareCodePoints(a: string, b: string): number {
  const aPoints = toCodePoints(a);
  const bPoints = toCodePoints(b);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < length; index++) {
    const diff = (aPoints[index] as number) - (bPoints[index] as number);
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}

/** Computes the shape key exactly as the contract's literal specifies. */
function expectedShapeKey(fields: {
  script: string;
  operation?: string;
  kind: string;
  parameterNames: readonly string[];
}): string {
  return canonicalJsonHash({
    script: fields.script,
    operation: fields.operation,
    kind: fields.kind,
    parameterNames: [...fields.parameterNames].sort(compareCodePoints),
  });
}

describe("agentActionShapeKey", () => {
  test("22. equals the shapeKey the evaluator projected for the same action", () => {
    // Uses a script no policy allowlists, so the decision is `denied` — proof
    // the key is computed for every action, whatever the verdict.
    const action: M3LAgentAction = {
      script: "unknown-script",
      operation: "put-item",
      kind: "mutating",
      parameterNames: ["a", "b"],
    };
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "dynamodb-crud", operations: ["put-item"] }],
    });
    const decision = evaluateAgentAction({ policy, action });

    expect(decision.rule).toBe("script-not-allowlisted");
    expect(agentActionShapeKey(action)).toBe(decision.action.shapeKey);
  });

  test("23. is deterministic across repeated calls", () => {
    const action: M3LAgentAction = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating",
      parameterNames: ["table", "item"],
    };

    expect(agentActionShapeKey(action)).toBe(agentActionShapeKey(action));
  });

  test("24. sorts parameterNames, so reordering them hashes identically", () => {
    const base = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating" as const,
    };

    expect(agentActionShapeKey({ ...base, parameterNames: ["b", "a"] })).toBe(
      agentActionShapeKey({ ...base, parameterNames: ["a", "b"] }),
    );
  });

  test("25. preserves duplicates — a repeat is a different shape", () => {
    const base = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating" as const,
    };

    expect(
      agentActionShapeKey({ ...base, parameterNames: ["a", "a"] }),
    ).not.toBe(agentActionShapeKey({ ...base, parameterNames: ["a"] }));
  });

  test("26. target is not in the key", () => {
    const base: Omit<M3LAgentAction, "target"> = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating",
      parameterNames: ["table"],
    };

    const noTarget = agentActionShapeKey(base);
    const sandbox = agentActionShapeKey({ ...base, target: SAFE_TARGET });
    const prodWithRegion = agentActionShapeKey({
      ...base,
      target: { profile: "prod", region: "eu-west-1" },
    });

    expect(sandbox).toBe(noTarget);
    expect(prodWithRegion).toBe(noTarget);
  });

  test("27. dryRun is not in the key — load-bearing for the round-trip (test 14)", () => {
    const base: M3LAgentAction = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating",
      parameterNames: ["table"],
    };

    expect(agentActionShapeKey({ ...base, dryRun: true })).toBe(
      agentActionShapeKey({ ...base, dryRun: false }),
    );
    expect(agentActionShapeKey({ ...base, dryRun: true })).toBe(
      agentActionShapeKey(base),
    );
  });

  describe("28. script, operation, and kind ARE in the key", () => {
    const base = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating" as const,
      parameterNames: ["table"],
    };

    test("a different script changes the key", () => {
      expect(agentActionShapeKey({ ...base, script: "s3-report" })).not.toBe(
        agentActionShapeKey(base),
      );
    });

    test("a different operation changes the key", () => {
      expect(agentActionShapeKey({ ...base, operation: "get-item" })).not.toBe(
        agentActionShapeKey(base),
      );
    });

    test("a different kind changes the key", () => {
      expect(agentActionShapeKey({ ...base, kind: "read-only" })).not.toBe(
        agentActionShapeKey(base),
      );
    });

    test("an absent operation hashes differently than a present one", () => {
      const { operation: _operation, ...withoutOperation } = base;

      expect(agentActionShapeKey(withoutOperation)).not.toBe(
        agentActionShapeKey(base),
      );
    });
  });

  test("29. returns a 64-character lowercase hex digest", () => {
    const key = agentActionShapeKey(MUTATING_ACTION);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("30. sorts by Unicode code point, not by Array.prototype.sort's UTF-16 order", () => {
    // U+1F600 (a surrogate pair, leading unit 0xD83D) is LOWER by UTF-16 code
    // unit than U+FFFF, so a bare `.sort()` orders the emoji first — the
    // opposite of true code-point order, where 0x1F600 > 0xFFFF.
    const emoji = "\u{1F600}";
    const highBmp = "￿";

    expect([emoji, highBmp].sort()).toEqual([emoji, highBmp]);
    expect([emoji, highBmp].sort(compareCodePoints)).toEqual([highBmp, emoji]);

    const action: M3LAgentAction = {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating",
      parameterNames: [emoji, highBmp],
    };

    expect(agentActionShapeKey(action)).toBe(
      expectedShapeKey({
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        parameterNames: [emoji, highBmp],
      }),
    );
  });

  test("31. the frozen record.parameterNames is copied before sorting, not sorted in place", () => {
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "dynamodb-crud", operations: ["put-item"] }],
    });
    const decision = evaluateAgentAction({
      policy,
      action: { ...MUTATING_ACTION, parameterNames: ["b", "a"] },
    });

    // If the hash sorted the frozen record array in place it would throw
    // (frozen arrays cannot be mutated); reaching this assertion at all is
    // part of the proof, and the caller-visible order must survive untouched.
    expect(decision.action.parameterNames).toEqual(["b", "a"]);
  });

  describe("32. validates only by ACT-1 through ACT-9, plus traversal-threw", () => {
    class NotAPlainObject {
      readonly script = "s3-report";
      readonly kind: M3LAgentActionKind = "read-only";
    }

    test.each([
      ["a non-plain-object action", new NotAPlainObject()],
      ["a blank script", { script: "  ", kind: "read-only" }],
      ["an absent script", { kind: "read-only" }],
      [
        "kind: readonly (misspelled)",
        { script: "s3-report", kind: "readonly" },
      ],
      [
        "a blank operation",
        { script: "s3-report", kind: "read-only", operation: " " },
      ],
      [
        "a malformed target",
        { script: "s3-report", kind: "read-only", target: { profile: "" } },
      ],
      [
        "257 parameterNames",
        {
          script: "s3-report",
          kind: "read-only",
          parameterNames: uniqueList("p", 257),
        },
      ],
      [
        "a non-boolean dryRun",
        { script: "s3-report", kind: "read-only", dryRun: "yes" },
      ],
      [
        "an unknown own key",
        { script: "s3-report", kind: "read-only", reason: "why" },
      ],
      [
        "a dangerous own key",
        { script: "s3-report", kind: "read-only", constructor: {} },
      ],
    ])("rejects an action that is %s", (_label, action: unknown) => {
      expectActionInputRejected(() =>
        agentActionShapeKey(action as M3LAgentAction),
      );
    });

    test("needs no policy and never throws M3LAgentPolicyDeclarationError", () => {
      const key = agentActionShapeKey({
        script: "s3-report",
        kind: "read-only",
      });

      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test("33. context.field reads 'action' for a top-level failure, not 'options'", () => {
    const error = expectActionInputRejected(() =>
      agentActionShapeKey({ kind: "read-only" } as unknown as M3LAgentAction),
    );

    expect(error.context["field"]).toBe("action");
  });

  test("34. a throwing accessor never surfaces as a raw error", () => {
    const cause = new RangeError("hostile getter");
    const hostile = new Proxy(
      { script: "s3-report", kind: "read-only" },
      {
        get(target, property, receiver): unknown {
          if (property === "script") throw cause;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const error = expectActionInputRejected(() =>
      agentActionShapeKey(hostile as unknown as M3LAgentAction),
    );

    expect(error.context["violation"]).toBe("traversal-threw");
    expect(error.cause).toBe(cause);
  });
});

/* -------------------------------------------------------------------------- */
/* validateAgentPolicy — rule 15: readOnlyOperations                          */
/* -------------------------------------------------------------------------- */

describe("validateAgentPolicy — rule 15: readOnlyOperations", () => {
  test.each([
    ["not an array", "get-item"],
    ["empty (non-empty required)", []],
    ["containing a blank string", ["get-item", "  "]],
    ["containing a non-string", ["get-item", 7]],
    ["containing duplicates", ["get-item", "get-item"]],
  ])(
    "rejects a readOnlyOperations that is %s",
    (_label, readOnlyOperations: unknown) => {
      expectPolicyRejected({
        version: 1,
        scripts: [
          {
            script: "dynamodb-crud",
            operations: ["get-item", "put-item"],
            readOnlyOperations,
          },
        ],
      });
    },
  );

  test("rejects more than M3L_AGENT_MAX_OPERATIONS_PER_GRANT entries", () => {
    expectPolicyRejected({
      version: 1,
      scripts: [
        {
          script: "dynamodb-crud",
          operations: uniqueList("op", M3L_AGENT_MAX_OPERATIONS_PER_GRANT + 1),
          readOnlyOperations: uniqueList(
            "op",
            M3L_AGENT_MAX_OPERATIONS_PER_GRANT + 1,
          ),
        },
      ],
    });
  });

  test("accepts exactly M3L_AGENT_MAX_OPERATIONS_PER_GRANT entries", () => {
    const operations = uniqueList("op", M3L_AGENT_MAX_OPERATIONS_PER_GRANT);
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [
        { script: "dynamodb-crud", operations, readOnlyOperations: operations },
      ],
    });

    expect(policy.scripts[0]?.readOnlyOperations).toHaveLength(
      M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
    );
  });

  test("36. on an operation-scoped grant, an unreachable entry throws", () => {
    expectPolicyRejected({
      version: 1,
      scripts: [
        {
          script: "dynamodb-crud",
          operations: ["get-item"],
          readOnlyOperations: ["put-item"],
        },
      ],
    });
  });

  test("36. on an allOperations grant, only the shape rules apply", () => {
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [
        {
          script: "s3-report",
          allOperations: true,
          readOnlyOperations: ["anything"],
        },
      ],
    });

    expect(policy.scripts[0]?.readOnlyOperations).toEqual(["anything"]);
  });

  test("38. freezes readOnlyOperations and copies it from the caller's array", () => {
    const readOnlyOperations = ["get-item"];
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [
        {
          script: "dynamodb-crud",
          operations: ["get-item", "put-item"],
          readOnlyOperations,
        },
      ],
    });
    const grant = policy.scripts[0] as M3LAgentScriptGrant;

    expect(Object.isFrozen(grant.readOnlyOperations)).toBe(true);

    readOnlyOperations.push("put-item");

    expect(grant.readOnlyOperations).toEqual(["get-item"]);
  });
});

/* -------------------------------------------------------------------------- */
/* validateAgentPolicy — rule 16: dryRunFirst                                */
/* -------------------------------------------------------------------------- */

describe("validateAgentPolicy — rule 16: dryRunFirst", () => {
  test.each([true, false])("accepts the boolean %s", (dryRunFirst: boolean) => {
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "s3-report", allOperations: true }],
      dryRunFirst,
    });

    expect(policy.dryRunFirst).toBe(dryRunFirst);
  });

  test.each([
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
    ["an object", {}],
  ])("rejects a dryRunFirst that is %s", (_label, dryRunFirst: unknown) => {
    expectPolicyRejected({
      version: 1,
      scripts: [{ script: "s3-report", allOperations: true }],
      dryRunFirst,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Guards, rule ids, and back-compat                                          */
/* -------------------------------------------------------------------------- */

const NEW_RULE_IDS = [
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

const SLICE_1_RULE_IDS = [
  "script-not-allowlisted",
  "operation-not-allowlisted",
  "read-only-auto-approved",
  "target-ungraded-escalated",
  "policy-ungraded-escalated",
  "sensitive-target-escalated",
  "graded-mutation-auto-approved",
  "unclassifiable-escalated",
] as const;

const ALL_TWENTY_RULE_IDS = [...SLICE_1_RULE_IDS, ...NEW_RULE_IDS] as const;

describe("39. isAgentPolicyRuleId over the twenty-id vocabulary", () => {
  test.each(ALL_TWENTY_RULE_IDS)("recognises %s", (ruleId: string) => {
    expect(isAgentPolicyRuleId(ruleId)).toBe(true);
  });

  test("recognises exactly twenty ids", () => {
    expect(ALL_TWENTY_RULE_IDS).toHaveLength(20);
    expect(new Set(ALL_TWENTY_RULE_IDS).size).toBe(20);
  });

  test.each([
    ["a near-miss missing the dot-suffix", "budget.invocations"],
    ["the bare namespace", "budget"],
    ["a trailing dot with nothing after it", "budget."],
    ["a near-miss of dry-run-first", "dry-run"],
    ["a near-miss of kind-cross-check-escalated", "kind-cross-check"],
    [
      "a near-miss of the .unobservable suffix (misspelled)",
      "budget.invocations-per-run.unobserved",
    ],
    [
      "a bare id with a trailing dot but no suffix",
      "budget.invocations-per-run.",
    ],
    ["an empty string", ""],
    ["null", null],
    ["a number", 42],
  ])("returns false for %s", (_label, value: unknown) => {
    expect(isAgentPolicyRuleId(value)).toBe(false);
  });

  test("returns false for a Symbol", () => {
    expect(isAgentPolicyRuleId(Symbol("budget.invocations-per-run"))).toBe(
      false,
    );
  });
});

/** A budget ceiling name; each is enumerated explicitly in the `test.each` below. */
type BudgetCeiling =
  | "invocationsPerRun"
  | "invocationsPerDay"
  | "tokensPerRun"
  | "costPerRun"
  | "loopIterations";

function budgetsFor(ceiling: BudgetCeiling): M3LAgentBudgets {
  switch (ceiling) {
    case "invocationsPerRun":
      return { invocationsPerRun: 1 };
    case "invocationsPerDay":
      return { invocationsPerDay: 1 };
    case "tokensPerRun":
      return { tokensPerRun: 1 };
    case "costPerRun":
      return { costPerRun: 1 };
    case "loopIterations":
      return { loopIterations: 1 };
  }
}

function ledgerObserving(ceiling: BudgetCeiling): M3LAgentRunLedger {
  const now = 1_700_000_000_000;
  switch (ceiling) {
    case "invocationsPerRun":
      return { invocationsThisRun: 1 };
    case "invocationsPerDay":
      return { invocationsToday: 1, todayCountedAt: now, now };
    case "tokensPerRun":
      return { tokensThisRun: 1 };
    case "costPerRun":
      return { costThisRun: 1 };
    case "loopIterations":
      return { loopIterations: 1 };
  }
}

function budgetExhaustedDecision(ceiling: BudgetCeiling): M3LAgentDecision {
  const policy = validateAgentPolicy({
    version: 1,
    scripts: [{ script: "dynamodb-crud", operations: ["put-item"] }],
    sensitiveTargets: { profiles: ["prod"] },
    budgets: budgetsFor(ceiling),
  });

  return evaluateAgentAction({
    policy,
    action: MUTATING_ACTION,
    run: ledgerObserving(ceiling),
  });
}

/** Same declared ceiling as {@link budgetExhaustedDecision}, but the ledger
 * carries no observation for it at all — the `.unobservable` counterpart. */
function budgetUnobservableDecision(ceiling: BudgetCeiling): M3LAgentDecision {
  const policy = validateAgentPolicy({
    version: 1,
    scripts: [{ script: "dynamodb-crud", operations: ["put-item"] }],
    sensitiveTargets: { profiles: ["prod"] },
    budgets: budgetsFor(ceiling),
  });

  return evaluateAgentAction({
    policy,
    action: MUTATING_ACTION,
    run: {},
  });
}

describe("40. all twelve new rule ids pair with the escalate verdict", () => {
  test.each<[M3LAgentPolicyRuleId, () => M3LAgentDecision]>([
    [
      "budget.invocations-per-run",
      () => budgetExhaustedDecision("invocationsPerRun"),
    ],
    [
      "budget.invocations-per-day",
      () => budgetExhaustedDecision("invocationsPerDay"),
    ],
    ["budget.tokens-per-run", () => budgetExhaustedDecision("tokensPerRun")],
    ["budget.cost-per-run", () => budgetExhaustedDecision("costPerRun")],
    ["budget.loop-iterations", () => budgetExhaustedDecision("loopIterations")],
    [
      "dry-run-first",
      () =>
        evaluateAgentAction({
          policy: dryRunFirstPolicy(),
          action: MUTATING_ACTION,
        }),
    ],
    [
      "kind-cross-check-escalated",
      () =>
        evaluateAgentAction({
          policy: crossCheckPolicy(),
          action: {
            script: "dynamodb-crud",
            operation: "delete-item",
            kind: "read-only",
          },
        }),
    ],
    [
      "budget.invocations-per-run.unobservable",
      () => budgetUnobservableDecision("invocationsPerRun"),
    ],
    [
      "budget.invocations-per-day.unobservable",
      () => budgetUnobservableDecision("invocationsPerDay"),
    ],
    [
      "budget.tokens-per-run.unobservable",
      () => budgetUnobservableDecision("tokensPerRun"),
    ],
    [
      "budget.cost-per-run.unobservable",
      () => budgetUnobservableDecision("costPerRun"),
    ],
    [
      "budget.loop-iterations.unobservable",
      () => budgetUnobservableDecision("loopIterations"),
    ],
  ])("%s produces verdict escalate", (rule, produce) => {
    const decision = produce();

    expect(decision.rule).toBe(rule);
    expect(decision.verdict).toBe("escalate");
  });
});

describe("41-42. type-level contract", () => {
  test("41. M3LAgentPolicyRuleId is the closed twenty-member union", () => {
    expectTypeOf<M3LAgentPolicyRuleId>().toEqualTypeOf<
      (typeof ALL_TWENTY_RULE_IDS)[number]
    >();
  });

  test("42. M3LAgentEvaluationOptions['run'] is M3LAgentRunLedger | undefined", () => {
    expectTypeOf<M3LAgentEvaluationOptions["run"]>().toEqualTypeOf<
      M3LAgentRunLedger | undefined
    >();
  });

  test("42. a bag with no run still satisfies M3LAgentEvaluationOptions", () => {
    const options: M3LAgentEvaluationOptions = {
      action: { script: "s3-report", kind: "read-only" },
      policy: noDryRunFirstPolicy(),
    };

    expect(options.run).toBeUndefined();
  });

  test("42. M3LAgentActionRecord has no optional keys — required, holding undefined", () => {
    expectTypeOf<M3LAgentActionRecord>().toEqualTypeOf<
      Required<M3LAgentActionRecord>
    >();
  });

  test("42. M3LAgentPolicyDeclaration['budgets'] is M3LAgentBudgets | undefined", () => {
    expectTypeOf<M3LAgentPolicyDeclaration["budgets"]>().toEqualTypeOf<
      M3LAgentBudgets | undefined
    >();
  });

  test("M3LAgentActionKind stays the two-member union", () => {
    expectTypeOf<M3LAgentActionKind>().toEqualTypeOf<
      "read-only" | "mutating"
    >();
  });

  test("M3LAgentVerdict stays closed at three members", () => {
    expectTypeOf<M3LAgentVerdict>().toEqualTypeOf<
      "auto-approved" | "escalate" | "denied"
    >();
  });
});

/**
 * The fifteen runtime (value) exports V7 slice 1 leaves the submodule barrel
 * with: slice 1/2's twelve plus the three the decision-log entry adds
 * (`agentDecisionLogEntry`, `serializeAgentDecisionLogEntry`,
 * `M3L_AGENT_MAX_LOG_ENTRY_BYTES`). The three additions are exercised below
 * so a dropped export fails this file at both runtime and typecheck, not
 * just the barrel-inventory count.
 */
const RUNTIME_EXPORTS = [
  "M3L_AGENT_MAX_PARAMETER_NAMES",
  "M3L_AGENT_MAX_OPERATIONS_PER_GRANT",
  "M3L_AGENT_MAX_SCRIPT_GRANTS",
  "M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES",
  "M3L_AGENT_MAX_DRY_RUN_SHAPES",
  "isAgentActionAutoApproved",
  "isAgentPolicyRuleId",
  "M3LAgentActionValidationError",
  "M3LAgentPolicyDeclarationError",
  "validateAgentPolicy",
  "evaluateAgentAction",
  "agentActionShapeKey",
  "M3L_AGENT_MAX_LOG_ENTRY_BYTES",
  "agentDecisionLogEntry",
  "serializeAgentDecisionLogEntry",
] as const;

/**
 * The sixteen type-only exports. Not independently runtime-checkable — this
 * file's own top-level `import type { ... }` block already imports all of
 * them, so a missing one fails the whole file at typecheck.
 */
const TYPE_ONLY_EXPORTS = [
  "M3LAgentAction",
  "M3LAgentActionKind",
  "M3LAgentActionRecord",
  "M3LAgentPolicy",
  "M3LAgentPolicyDeclaration",
  "M3LAgentScriptGrant",
  "M3LAgentDecision",
  "M3LAgentPolicyRuleId",
  "M3LAgentVerdict",
  "M3LAgentEvaluationOptions",
  "M3LAgentBudgets",
  "M3LAgentRunLedger",
  "M3LAgentIdentity",
  "M3LAgentDecisionOutcome",
  "M3LAgentDecisionLogEntry",
  "M3LAgentDecisionLogEntryOptions",
] as const;

test("43. M3L_AGENT_MAX_DRY_RUN_SHAPES is 256", () => {
  expect(M3L_AGENT_MAX_DRY_RUN_SHAPES).toBe(256);
});

test("43. core/agent barrel surfaces exactly thirty-one named exports (15 runtime + 16 type-only)", async () => {
  expect(RUNTIME_EXPORTS.length + TYPE_ONLY_EXPORTS.length).toBe(31);

  const barrel: Record<string, unknown> =
    await import("../src/core/agent/index.js");

  expect(Object.keys(barrel).sort()).toEqual([...RUNTIME_EXPORTS].sort());
});

describe("43. the V7 slice 1 decision-log additions are live on the barrel", () => {
  test("agentDecisionLogEntry / serializeAgentDecisionLogEntry / M3L_AGENT_MAX_LOG_ENTRY_BYTES round-trip", () => {
    expect(M3L_AGENT_MAX_LOG_ENTRY_BYTES).toBe(65536);

    const decision = evaluateAgentAction({
      policy: noDryRunFirstPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      },
    });
    const identity: M3LAgentIdentity = { name: "agent-x" };
    const outcome: M3LAgentDecisionOutcome = { dryRun: false, exitCode: 0 };
    const entry: M3LAgentDecisionLogEntry = agentDecisionLogEntry({
      decision,
      identity,
      now: Date.UTC(2026, 7, 30),
      outcome,
    } satisfies M3LAgentDecisionLogEntryOptions);

    expect(typeof serializeAgentDecisionLogEntry(entry)).toBe("string");
  });
});

describe("44. every slice-1 scenario keeps its verdict, rule, and reason", () => {
  test("read-only-auto-approved is unchanged, and shapeKey is a string", () => {
    const decision = evaluateAgentAction({
      policy: noDryRunFirstPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      },
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("read-only-auto-approved");
    expect(typeof decision.reason).toBe("string");
    expect(decision.action).toMatchObject({
      script: "dynamodb-crud",
      operation: "get-item",
      kind: "read-only",
      target: undefined,
      parameterNames: [],
      dryRun: false,
    });
    expect(typeof decision.action.shapeKey).toBe("string");
  });

  test("graded-mutation-auto-approved is unchanged, and shapeKey is a string", () => {
    const decision = evaluateAgentAction({
      policy: noDryRunFirstPolicy(),
      action: MUTATING_ACTION,
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("graded-mutation-auto-approved");
    expect(decision.action).toMatchObject({
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating",
      parameterNames: ["table", "item"],
      dryRun: false,
    });
    expect(typeof decision.action.shapeKey).toBe("string");
  });

  test("script-not-allowlisted is unchanged, and shapeKey is a string", () => {
    const decision = evaluateAgentAction({
      policy: noDryRunFirstPolicy(),
      action: { script: "unknown-script", kind: "mutating" },
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("script-not-allowlisted");
    expect(typeof decision.action.shapeKey).toBe("string");
  });
});

test("45. a slice-1 grant materialises no readOnlyOperations own key", () => {
  const policy = noDryRunFirstPolicy();

  expect(Object.keys(policy.scripts[0] as object)).not.toContain(
    "readOnlyOperations",
  );
});
