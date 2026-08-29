/**
 * Security regression tests for `core/agent` slice 1.
 *
 * One block per fix, each pinning the **corrected verdict** rather than
 * merely "it throws", and each paired with a control case that a
 * reject-everything implementation would fail. Every case here was reproduced
 * by execution against the pre-fix build, and the comment above each block
 * records what the pre-fix behaviour was — that is what makes these tests
 * contested rather than decorative.
 *
 * Contract source: docs/reference/core/agent.md § Validating the action,
 * § The tier decision table, § Fail-closed defaults, § Guard polarity, and
 * the `@remarks` on `validateAgentPolicy` (the runtime brand) and
 * `M3LAgentActionRecordTarget` (the own-`undefined` keys).
 *
 * The happy-path contract lives in the sibling `agent-evaluate.test.ts` and
 * `agent.test.ts`; this file carries only the hardening cases, so
 * neither of those grows past the `check:file-budget` test ceiling.
 */

import { describe, expect, test, vi } from "vitest";

import {
  M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
  M3L_AGENT_MAX_PARAMETER_NAMES,
  M3LAgentActionValidationError,
  M3LAgentPolicyDeclarationError,
  M3LError,
  evaluateAgentAction,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentAction,
  M3LAgentDecision,
  M3LAgentEvaluationOptions,
  M3LAgentPolicy,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/** A policy that grades targets: profile "prod" and region "eu-west-1". */
function gradedPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    sensitiveTargets: { profiles: ["prod"], regions: ["eu-west-1"] },
  });
}

/** The same grant with no grading spec declared at all. */
function ungradedPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
  });
}

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
 * Asserts the options bag is rejected at step 0 with the named field and
 * violation, and returns the error. Asserting the `context` pair — not just
 * the class — is what stops a case passing because something unrelated threw.
 */
function expectActionRejected(
  options: unknown,
  field: string,
  violation: string,
): M3LAgentActionValidationError {
  const thrown = catchThrown(() =>
    evaluateAgentAction(options as M3LAgentEvaluationOptions),
  );
  expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
  // The documented triage is `instanceof M3LError`; a subclass check alone
  // would not notice a class that stopped extending it.
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAgentActionValidationError;
  expect(error.code).toBe("ERR_AGENT_INVALID_ACTION");
  expect(error.context["field"]).toBe(field);
  expect(error.context["violation"]).toBe(violation);
  return error;
}

/**
 * Asserts the declaration is rejected with the named field and violation, and
 * returns the error. The declaration boundary throws its OWN error class —
 * `M3LAgentPolicyDeclarationError`, not the action one.
 */
function expectDeclarationRejected(
  declaration: unknown,
  field: string,
  violation: string,
): M3LAgentPolicyDeclarationError {
  const thrown = catchThrown(() => validateAgentPolicy(declaration));
  expect(thrown).toBeInstanceOf(M3LAgentPolicyDeclarationError);
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAgentPolicyDeclarationError;
  expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
  expect(error.context["field"]).toBe(field);
  expect(error.context["violation"]).toBe(violation);
  return error;
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

/**
 * Overrides `names`' own `Symbol.iterator` so an iterator-driven walk yields
 * `smuggled` entries regardless of `length`. `Array.isArray` still passes, so
 * the value clears every array guard and only the ceiling check stands
 * between it and the projection.
 */
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

/** Counts what an iterator-driven (pre-fix) walk would have projected. */
function iterationLength(value: Iterable<string>): number {
  return [...value].length;
}

/* -------------------------------------------------------------------------- */
/* F1 — the operation allowlist must not be widened by Object.prototype       */
/* -------------------------------------------------------------------------- */

describe("F1: an inherited allOperations never widens a named-operation grant", () => {
  test("a non-allowlisted operation is denied even with Object.prototype.allOperations = true", () => {
    // Pre-fix: `grant.allOperations` resolved `true` up the prototype chain,
    // step 2 was skipped entirely, and this returned
    // auto-approved/"read-only-auto-approved". The grant is built OUTSIDE the
    // pollution so the validator sees a clean prototype and the only thing
    // under test is the READ in `decide.ts`.
    const policy = ungradedPolicy();
    const action: M3LAgentAction = {
      script: "dynamodb-crud",
      operation: "delete-table",
      kind: "read-only",
    };

    const decision = withPollutedObjectPrototype("allOperations", true, () => {
      const grant = policy.scripts[0];
      expect(grant).toBeDefined();
      // The pollution is live and the two readings genuinely disagree: a dot
      // read resolves the inherited `true`, `Object.hasOwn` does not. If this
      // ever stopped holding, the assertion below would pass vacuously.
      expect(grant?.allOperations).toBe(true);
      expect(Object.hasOwn(grant as object, "allOperations")).toBe(false);

      return evaluateAgentAction({ policy, action });
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("operation-not-allowlisted");
  });

  test("the same grant still allows its own named operation under the same pollution", () => {
    // The contested half: an implementation that ignored `allOperations`
    // altogether would also deny this one.
    const policy = ungradedPolicy();

    const decision = withPollutedObjectPrototype("allOperations", true, () =>
      evaluateAgentAction({
        policy,
        action: {
          script: "dynamodb-crud",
          operation: "get-item",
          kind: "read-only",
        },
      }),
    );

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("an inherited operations list never allowlists an operation", () => {
    // The mirror image of the fix: `operations` is the absent own key when a
    // grant is `allOperations: true`, so the same dot read would have let a
    // polluted list stand in for the grant's own.
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "dynamodb-crud", operations: ["get-item"] }],
    });

    const decision = withPollutedObjectPrototype(
      "operations",
      ["delete-table"],
      () =>
        evaluateAgentAction({
          policy,
          action: {
            script: "dynamodb-crud",
            operation: "delete-table",
            kind: "read-only",
          },
        }),
    );

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("operation-not-allowlisted");
  });
});

/* -------------------------------------------------------------------------- */
/* F2 — an ungraded policy must escalate, whatever the prototype carries      */
/* -------------------------------------------------------------------------- */

describe("F2: an inherited sensitiveTargets never grades an ungraded policy", () => {
  test("a prod mutation escalates as policy-ungraded with Object.prototype.sensitiveTargets = {}", () => {
    // Pre-fix: `policy.sensitiveTargets` resolved the inherited `{}`, the
    // ungraded arm was skipped, `sensitiveTargets({})` graded nothing
    // sensitive, and a prod mutation came back
    // auto-approved/"graded-mutation-auto-approved" under a policy that had
    // opted OUT of grading precisely so everything would escalate.
    const policy = ungradedPolicy();
    const inheritedSpec = {};

    const decision = withPollutedObjectPrototype(
      "sensitiveTargets",
      inheritedSpec,
      () => {
        // Both readings are live and disagree.
        expect(policy.sensitiveTargets).toBe(inheritedSpec);
        expect(Object.hasOwn(policy, "sensitiveTargets")).toBe(false);

        return evaluateAgentAction({
          policy,
          action: {
            script: "dynamodb-crud",
            operation: "put-item",
            kind: "mutating",
            target: { profile: "prod" },
          },
        });
      },
    );

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("policy-ungraded-escalated");
  });

  test("a genuinely graded policy still auto-approves a non-sensitive mutation", () => {
    // The contested half: an implementation that escalated every mutation
    // would pass the case above and fail this one.
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        target: { profile: "sandbox", region: "eu-central-1" },
      },
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });
});

/* -------------------------------------------------------------------------- */
/* F3 — ACT-11: the options bag carries only the three declared keys          */
/* -------------------------------------------------------------------------- */

describe("F3: an unknown options-bag key is rejected (ACT-11)", () => {
  /** A mutation the graded policy auto-approves when nothing adds sensitivity. */
  const SAFE_MUTATION: M3LAgentAction = {
    script: "dynamodb-crud",
    operation: "put-item",
    kind: "mutating",
    target: { profile: "sandbox", region: "eu-central-1" },
  };

  test("the one-s-short typo throws instead of silently dropping the predicate", () => {
    // Pre-fix: the misspelled key was ignored, the predicate was called 0
    // times, and the verdict was auto-approved — the exact fail-open the
    // predicate was passed to prevent. TypeScript only flags an excess key on
    // a fresh call-site literal, never on a bag built as a variable, so this
    // is the runtime half of that check.
    const predicate = vi.fn(() => true);

    expectActionRejected(
      {
        policy: gradedPolicy(),
        action: SAFE_MUTATION,
        additionalSensitiveTarget: predicate,
      },
      "options",
      "unknown-key",
    );

    expect(predicate).not.toHaveBeenCalled();
  });

  test("the error names the offending key without leaking a value", () => {
    const error = expectActionRejected(
      {
        policy: gradedPolicy(),
        action: SAFE_MUTATION,
        additionalSensitiveTarget: () => true,
      },
      "options",
      "unknown-key",
    );

    expect(error.context["key"]).toBe("additionalSensitiveTarget");
  });

  test("the identical bag WITHOUT the stray key auto-approves — the pre-fix verdict", () => {
    // Pins the pre-fix outcome the throwing case above must diverge from: an
    // implementation that ignores an unknown key sees exactly this bag, and
    // this bag auto-approves. The typo'd bag therefore cannot be passing for
    // some incidental reason.
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: SAFE_MUTATION,
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("graded-mutation-auto-approved");
  });

  test("the correctly spelled key is honoured and escalates", () => {
    // The contested half: an implementation that threw on every options bag
    // would pass the two cases above and fail this one.
    const predicate = vi.fn(() => true);

    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: SAFE_MUTATION,
      additionalSensitiveTargets: predicate,
    });

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("sensitive-target-escalated");
    expect(predicate).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* F4 — the runtime brand: the validator is the only door                     */
/* -------------------------------------------------------------------------- */

describe("F4: only a policy validateAgentPolicy produced may be evaluated", () => {
  const READ_ONLY_ACTION: M3LAgentAction = {
    script: "delete-everything",
    operation: "wipe",
    kind: "read-only",
  };

  test("a cast, unvalidated declaration is rejected", () => {
    // Pre-fix: the compile-time-only brand stopped nothing at runtime, so a
    // round-tripped declaration evaluated as if it had been validated.
    const declaration = {
      version: 1,
      scripts: [{ script: "delete-everything", allOperations: true }],
    };
    const forged = JSON.parse(JSON.stringify(declaration)) as M3LAgentPolicy;

    expectActionRejected(
      { policy: forged, action: READ_ONLY_ACTION },
      "options.policy",
      "not-a-validated-policy",
    );
  });

  test("a spread of a validated policy is rejected — no cast required", () => {
    // The single most important case in the module: a spread keeps the brand
    // TYPE, so this line compiles with no cast anywhere. Pre-fix it took the
    // script from denied/"script-not-allowlisted" to
    // auto-approved/"read-only-auto-approved" — authority invented by an
    // object literal.
    const validated = ungradedPolicy();
    const widened: M3LAgentPolicy = {
      ...validated,
      scripts: [{ script: "delete-everything", allOperations: true }],
    };

    expectActionRejected(
      { policy: widened, action: READ_ONLY_ACTION },
      "options.policy",
      "not-a-validated-policy",
    );
  });

  test("the un-spread original still evaluates, and denies the smuggled script", () => {
    // Proves the spread case above is contested: the same action against the
    // genuine policy produces a verdict rather than a throw, and that verdict
    // is the denial the spread was trying to escape.
    const decision = evaluateAgentAction({
      policy: ungradedPolicy(),
      action: READ_ONLY_ACTION,
    });

    expect(decision.verdict).toBe("denied");
    expect(decision.rule).toBe("script-not-allowlisted");
  });

  test("the smuggled grants auto-approve once genuinely validated — the pre-fix verdict", () => {
    // Pins what the forged and spread policies above would have produced
    // pre-fix: their grant content is perfectly evaluable, so the ONLY thing
    // standing between the cast/spread and an auto-approval is the runtime
    // brand. Without it, both cases above return auto-approved rather than
    // throwing.
    const genuinelyValidated = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "delete-everything", allOperations: true }],
    });

    const decision = evaluateAgentAction({
      policy: genuinelyValidated,
      action: READ_ONLY_ACTION,
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("read-only-auto-approved");
  });

  test("an absent policy throws a typed M3LError, not a bare TypeError", () => {
    // Pre-fix: `policy.scripts.find(...)` raised
    // `TypeError: Cannot read properties of undefined`, which broke the
    // `instanceof M3LError` triage both of this module's error classes
    // promise in their own @example.
    const bag: Partial<M3LAgentEvaluationOptions> = {
      action: READ_ONLY_ACTION,
    };
    const thrown = catchThrown(() =>
      evaluateAgentAction(bag as M3LAgentEvaluationOptions),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as M3LAgentActionValidationError).code).toBe(
      "ERR_AGENT_INVALID_ACTION",
    );
    expect((thrown as M3LAgentActionValidationError).context["violation"]).toBe(
      "not-a-validated-policy",
    );
  });

  test("an inherited policy key does not satisfy the brand check", () => {
    // `Object.hasOwn` presence again: a polluted prototype must not supply
    // the policy the caller omitted.
    const policy = ungradedPolicy();

    withPollutedObjectPrototype("policy", policy, () => {
      const bag: Partial<M3LAgentEvaluationOptions> = {
        action: READ_ONLY_ACTION,
      };
      expectActionRejected(bag, "options.policy", "not-a-validated-policy");
    });
  });
});

describe("F4 (cont.): the bag's own keys are what count", () => {
  test("an absent action is rejected — an inherited one does not stand in", () => {
    // The `Object.hasOwn(bag, "action")` false arm, and the reason it is a
    // `hasOwn` read: with `Object.prototype.action` polluted, a bracket read
    // resolves a perfectly evaluable action the caller never passed.
    const policy = ungradedPolicy();
    const inheritedAction: M3LAgentAction = {
      script: "dynamodb-crud",
      operation: "get-item",
      kind: "read-only",
    };

    withPollutedObjectPrototype("action", inheritedAction, () => {
      const bag: Partial<M3LAgentEvaluationOptions> = { policy };
      expect((bag as Record<string, unknown>)["action"]).toBe(inheritedAction);
      expect(Object.hasOwn(bag, "action")).toBe(false);

      expectActionRejected(bag, "action", "not-a-plain-object");
    });
  });

  test("the same action passed as an own key evaluates normally", () => {
    // The contested half: the rejection above is about presence, not about
    // the action being malformed.
    const decision = evaluateAgentAction({
      policy: ungradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      },
    });

    expect(decision.verdict).toBe("auto-approved");
  });
});

/* -------------------------------------------------------------------------- */
/* F5 — a hostile Symbol.iterator must not smuggle entries past a ceiling     */
/* -------------------------------------------------------------------------- */

describe("F5: bounded string lists are read by index, never by iterator", () => {
  test("parameterNames at the ceiling with a hostile iterator is rejected", () => {
    // The array is sparse: `length` is exactly the ceiling, so the bound
    // passes, but every index holds a hole. Pre-fix the `for...of` walk read
    // the OVERRIDDEN iterator and projected 5 000 fabricated names past a 256
    // bound; the indexed walk reads index 0, finds a hole, and rejects.
    const hostile = withHostileIterator(
      new Array<string>(M3L_AGENT_MAX_PARAMETER_NAMES),
      5000,
    );

    // The smuggling channel is live: an iterator-driven read genuinely yields
    // 5 000 entries for a 256-length array.
    expect(iterationLength(hostile)).toBe(5000);
    expect(hostile.length).toBe(M3L_AGENT_MAX_PARAMETER_NAMES);

    expectActionRejected(
      {
        policy: ungradedPolicy(),
        action: {
          script: "dynamodb-crud",
          operation: "get-item",
          kind: "read-only",
          parameterNames: hostile,
        },
      },
      "action.parameterNames",
      "blank-or-non-string-entry",
    );
  });

  test("a populated array with a hostile iterator projects its indices, not its iterator", () => {
    const names = Array.from(
      { length: M3L_AGENT_MAX_PARAMETER_NAMES },
      (_unused, index) => `parameter-${String(index)}`,
    );
    const hostile = withHostileIterator(names, 5000);

    const decision = evaluateAgentAction({
      policy: ungradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
        parameterNames: hostile,
      },
    });

    // Neither 5 000 (the iterator's answer) nor a silent truncation.
    expect(decision.action.parameterNames).toHaveLength(
      M3L_AGENT_MAX_PARAMETER_NAMES,
    );
    expect(decision.action.parameterNames[0]).toBe("parameter-0");
    expect(decision.action.parameterNames.at(-1)).toBe("parameter-255");
  });

  test("a legitimate list one over the ceiling is rejected, not truncated", () => {
    const tooMany = Array.from(
      { length: M3L_AGENT_MAX_PARAMETER_NAMES + 1 },
      (_unused, index) => `parameter-${String(index)}`,
    );

    expectActionRejected(
      {
        policy: ungradedPolicy(),
        action: {
          script: "dynamodb-crud",
          operation: "get-item",
          kind: "read-only",
          parameterNames: tooMany,
        },
      },
      "action.parameterNames",
      "too-many-entries",
    );
  });

  test("a grant's operations at the ceiling with a hostile iterator is rejected", () => {
    const hostile = withHostileIterator(
      new Array<string>(M3L_AGENT_MAX_OPERATIONS_PER_GRANT),
      5000,
    );
    expect(iterationLength(hostile)).toBe(5000);

    const thrown = catchThrown(() =>
      validateAgentPolicy({
        version: 1,
        scripts: [{ script: "dynamodb-crud", operations: hostile }],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentPolicyDeclarationError);
    expect(thrown).toBeInstanceOf(M3LError);
    const error = thrown as M3LAgentPolicyDeclarationError;
    expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
    expect(error.context["field"]).toBe("scripts.operations");
    expect(error.context["violation"]).toBe("blank-or-non-string-entry");
  });

  test("a grant's operations legitimately at the ceiling validates and is not truncated", () => {
    const operations = Array.from(
      { length: M3L_AGENT_MAX_OPERATIONS_PER_GRANT },
      (_unused, index) => `operation-${String(index)}`,
    );
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "dynamodb-crud", operations }],
    });

    const grant = policy.scripts[0];
    expect(grant?.operations).toHaveLength(M3L_AGENT_MAX_OPERATIONS_PER_GRANT);

    // ...and the last one is genuinely allowlisted, which a truncating
    // projection would have dropped.
    const decision = evaluateAgentAction({
      policy,
      action: {
        script: "dynamodb-crud",
        operation: "operation-127",
        kind: "read-only",
      },
    });
    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("read-only-auto-approved");
  });
});

/* -------------------------------------------------------------------------- */
/* F6 — a hostile traversal surfaces as this module's typed error             */
/* -------------------------------------------------------------------------- */

describe("F6: a throwing accessor or Proxy trap surfaces as M3LAgentActionValidationError", () => {
  test("a throwing getter on the action is wrapped, with the cause chained", () => {
    // Pre-fix: the RangeError escaped raw from inside a guard that reads as
    // total, breaking the `instanceof M3LError` triage.
    const boom = new RangeError("boom");
    const action = {
      get script(): string {
        throw boom;
      },
    };

    const error = expectActionRejected(
      { policy: ungradedPolicy(), action },
      "options",
      "traversal-threw",
    );

    expect(error).not.toBeInstanceOf(RangeError);
    // `cause` IS chained here (the source says so explicitly), and the two
    // halves of that decision are asserted together: the live `.cause` stays
    // available to a maintainer debugging by hand, while the serialisation
    // channel carries a name and nothing else. Since #734 `M3LError.toJSON()`
    // allowlists its cause projection, so a foreign (non-`M3LError`) cause
    // collapses to `{ name }` — a secret in the RangeError's message cannot
    // reach a serialised record.
    expect(error.cause).toBe(boom);
    expect(error.cause).toBeInstanceOf(RangeError);

    const serialised = error.toJSON();
    expect(serialised.cause).toEqual({ name: "RangeError" });
    expect(Object.keys(serialised.cause ?? {})).toEqual(["name"]);
    expect(JSON.stringify(serialised)).not.toContain("boom");
  });

  test("a Proxy whose ownKeys trap throws is wrapped, with the cause chained", () => {
    const boom = new Error("boom");
    const action = new Proxy(
      {},
      {
        ownKeys(): never {
          throw boom;
        },
      },
    );

    const error = expectActionRejected(
      { policy: ungradedPolicy(), action },
      "options",
      "traversal-threw",
    );

    expect(error.cause).toBe(boom);
  });

  test("an already-typed failure is re-thrown unchanged, not double-wrapped", () => {
    // The contested half: an implementation that wrapped everything would
    // report "traversal-threw" for an ordinary ACT violation too, losing the
    // field name the whole `context` contract exists to carry.
    const error = expectActionRejected(
      {
        policy: ungradedPolicy(),
        action: { script: "dynamodb-crud", kind: "readonly" },
      },
      "action.kind",
      "unrecognised-kind",
    );

    expect(error.cause).toBeUndefined();
  });

  test("a throwing getter on a DECLARATION is wrapped as the declaration error", () => {
    // The declaration walk has its own catch arm and its own error class: a
    // hostile document must not surface as the ACTION error, and must not
    // surface raw either.
    const boom = new RangeError("boom");
    const declaration = {
      version: 1,
      get scripts(): unknown {
        throw boom;
      },
    };

    const error = expectDeclarationRejected(
      declaration,
      "declaration",
      "traversal-threw",
    );

    expect(error).not.toBeInstanceOf(M3LAgentActionValidationError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error.cause).toBe(boom);
    expect(error.toJSON().cause).toEqual({ name: "RangeError" });
  });

  test("a Proxy declaration whose ownKeys trap throws is wrapped too", () => {
    const boom = new Error("boom");
    const declaration = new Proxy(
      {},
      {
        ownKeys(): never {
          throw boom;
        },
      },
    );

    const error = expectDeclarationRejected(
      declaration,
      "declaration",
      "traversal-threw",
    );

    expect(error.cause).toBe(boom);
  });

  test("an ordinary declaration violation keeps its own field and violation", () => {
    // The contested half for the declaration walk: a validator that wrapped
    // everything would report "traversal-threw" here and lose rule 8's name.
    const error = expectDeclarationRejected(
      {
        version: 1,
        scripts: [{ script: "s3-report", allOperations: "true" }],
      },
      "scripts.allOperations",
      "not-boolean-true",
    );

    expect(error.cause).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* F7 — the projected target keeps region/accountId as own keys               */
/* -------------------------------------------------------------------------- */

describe("F7: the record's target carries region and accountId as own keys", () => {
  /** Evaluates a mutation whose target declares `profile` only. */
  function decideProfileOnlyTarget(): M3LAgentDecision {
    return evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        target: { profile: "sandbox" },
      },
    });
  }

  test("an omitted region is present as an own key holding undefined", () => {
    // The guard against a later "cleanup" into a conditional spread: an own
    // key cannot be shadowed by a polluted `Object.prototype`, an omitted one
    // can. The type says required-holding-`undefined` for the same reason.
    const target = decideProfileOnlyTarget().action.target;

    expect(target).toBeDefined();
    expect(Object.hasOwn(target as object, "region")).toBe(true);
    expect(Object.hasOwn(target as object, "accountId")).toBe(true);
    expect(target?.region).toBeUndefined();
    expect(target?.accountId).toBeUndefined();
    expect(Object.keys(target as object).sort()).toEqual([
      "accountId",
      "profile",
      "region",
    ]);
    expect(Object.isFrozen(target)).toBe(true);
  });

  test("the own undefined key wins over a polluted Object.prototype.region", () => {
    // "eu-north-1" is deliberately NOT in the graded policy's regions list, so
    // the grading verdict cannot mask the read being tested.
    withPollutedObjectPrototype("region", "eu-north-1", () => {
      // The pollution is live: a target projected by conditional spread — the
      // shape this test exists to forbid — would read the inherited value.
      const conditionallySpread: Record<string, unknown> = {
        profile: "sandbox",
      };
      expect(conditionallySpread["region"]).toBe("eu-north-1");

      const decision = decideProfileOnlyTarget();

      expect(decision.action.target?.region).toBeUndefined();
      expect(decision.verdict).toBe("auto-approved");
      expect(decision.rule).toBe("graded-mutation-auto-approved");
    });
  });

  test("a declared accountId is carried into grading", () => {
    // The third scalar's own branch in the record -> ADR-0048 widening: a
    // target whose accountId is present must be handed to the graded
    // predicate WITH that key, or an accountIds-only spec would grade
    // nothing.
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "dynamodb-crud", operations: ["put-item"] }],
      sensitiveTargets: { accountIds: ["111122223333"] },
    });
    const mutate = (accountId: string): M3LAgentDecision =>
      evaluateAgentAction({
        policy,
        action: {
          script: "dynamodb-crud",
          operation: "put-item",
          kind: "mutating",
          target: { profile: "sandbox", accountId },
        },
      });

    const sensitive = mutate("111122223333");
    expect(sensitive.verdict).toBe("escalate");
    expect(sensitive.rule).toBe("sensitive-target-escalated");
    expect(sensitive.action.target?.accountId).toBe("111122223333");

    // The contested half: a different account under the same spec is not
    // sensitive, so the escalation above comes from the accountId matching
    // and not from every mutation escalating.
    const other = mutate("444455556666");
    expect(other.verdict).toBe("auto-approved");
    expect(other.rule).toBe("graded-mutation-auto-approved");
  });

  test("a declared region is copied through, not shared by reference", () => {
    // The contested half: an implementation that hardcoded `undefined` for
    // both scalars would pass the two cases above.
    const mutableTarget = { profile: "sandbox", region: "eu-central-1" };
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        target: mutableTarget,
      },
    });

    expect(decision.action.target?.region).toBe("eu-central-1");
    expect(decision.action.target).not.toBe(mutableTarget);

    mutableTarget.profile = "prod";
    expect(decision.action.target?.profile).toBe("sandbox");
  });
});
