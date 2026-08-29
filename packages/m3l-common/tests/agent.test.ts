/**
 * Tests for `core/agent` slice 1 — the declaration validator half (RED
 * phase: `validateAgentPolicy` is a placeholder that throws "not yet
 * implemented").
 *
 * Contract source: docs/reference/core/agent.md § The policy declaration,
 * § `validateAgentPolicy`, § Verdicts and rule ids (the two guards), and
 * § Public API (the two error classes and the three declared ceilings).
 *
 * The evaluator's own contract — the tier decision table, the ten ACT
 * action-validation rules, the fail-closed table, and guard polarity — lives
 * in the sibling `agent-evaluate.test.ts` (both files stay under the
 * `check:file-budget` test ceiling that way).
 *
 * Every rejection case below asserts a **non-empty `error.context`** as well
 * as the class and the code. That is contract ("`context` names the offending
 * grant index or key and the violation kind, never a value") and it is also
 * what keeps these tests honest in the RED phase: the placeholder throws the
 * very same error class with no context, so a class-only assertion would pass
 * vacuously against an unimplemented validator.
 *
 * All symbols are imported through the public Core barrel rather than a deep
 * `src/core/agent/...` path, so a dropped `export *` line fails here too.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
  M3L_AGENT_MAX_SCRIPT_GRANTS,
  M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES,
  M3LAgentActionValidationError,
  M3LAgentPolicyDeclarationError,
  M3LError,
  isAgentActionAutoApproved,
  isAgentPolicyRuleId,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentActionRecord,
  M3LAgentDecision,
  M3LAgentEvaluationOptions,
  M3LAgentPolicy,
  M3LAgentPolicyDeclaration,
  M3LAgentPolicyRuleId,
  M3LAgentScriptGrant,
  M3LAgentVerdict,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A declaration that must validate. Every rejection fixture below is this
 * shape with exactly one thing wrong, so the case under test is the only
 * reason the validator can reject.
 */
const VALID_DECLARATION = {
  version: 1,
  scripts: [
    { script: "s3-report", allOperations: true },
    { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
  ],
  sensitiveTargets: { profiles: ["prod"], regions: ["eu-west-1"] },
};

/** A fresh, structurally independent copy of {@link VALID_DECLARATION}. */
function validDeclaration(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(VALID_DECLARATION)) as Record<
    string,
    unknown
  >;
}

/** A declaration carrying exactly one grant, overridden by the caller. */
function withGrant(grant: unknown): Record<string, unknown> {
  return { version: 1, scripts: [grant] };
}

/** A declaration carrying exactly one grading spec, overridden by the caller. */
function withSensitiveTargets(spec: unknown): Record<string, unknown> {
  return {
    version: 1,
    scripts: [{ script: "s3-report", allOperations: true }],
    sensitiveTargets: spec,
  };
}

/** `count` distinct non-blank strings, for the ceiling boundary cases. */
function uniqueList(prefix: string, count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}-${index}`,
  );
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
 * Asserts `declaration` is rejected as a declaration error and returns the
 * error for further, case-specific assertions.
 */
function expectRejected(declaration: unknown): M3LAgentPolicyDeclarationError {
  const thrown = catchThrown(() => validateAgentPolicy(declaration));
  expect(thrown).toBeInstanceOf(M3LAgentPolicyDeclarationError);
  const error = thrown as M3LAgentPolicyDeclarationError;
  expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
  expect(Object.keys(error.context).length).toBeGreaterThan(0);
  return error;
}

/** A class instance — neither a plain object nor an exotic built-in. */
class NotAPlainObject {
  readonly version = 1;
  readonly scripts = [{ script: "s3-report", allOperations: true }];
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
/* Happy path, projection, freezing, branding                                 */
/* -------------------------------------------------------------------------- */

describe("validateAgentPolicy — a well-formed declaration", () => {
  test("returns a policy carrying the declared version, grants and grading spec", () => {
    const policy = validateAgentPolicy(validDeclaration());

    expect(policy.version).toBe(1);
    expect(policy.scripts).toHaveLength(2);
    expect(policy.scripts.map((grant) => grant.script)).toEqual([
      "s3-report",
      "dynamodb-crud",
    ]);
    expect(policy.sensitiveTargets).toEqual({
      profiles: ["prod"],
      regions: ["eu-west-1"],
    });
  });

  test("round-trips through JSON identically to the declaration it validated", () => {
    // The declaration is preset-storable and diff-reviewable, so validation
    // adds no own key and drops none. The brand is not a key at all: it is a
    // module-private `WeakSet` of the objects the validator produced, which is
    // external to the object and therefore invisible to `JSON.stringify`. A
    // symbol or own-key brand would either surface in this round-trip or be
    // forgeable by `Object.defineProperty`; registry membership can be granted
    // only by `validateAgentPolicy` itself, which is what survives
    // serialisation-shaped tampering (see `agent-hardening.test.ts` § F4).
    const policy = validateAgentPolicy(validDeclaration());

    expect(JSON.parse(JSON.stringify(policy))).toEqual(VALID_DECLARATION);
  });

  test("accepts a grant declared with allOperations true and no operations list", () => {
    const policy = validateAgentPolicy(
      withGrant({ script: "s3-report", allOperations: true }),
    );

    expect(policy.scripts[0]?.allOperations).toBe(true);
    expect(policy.scripts[0]?.operations).toBeUndefined();
  });

  test("accepts a declaration with no sensitiveTargets spec at all", () => {
    // Absence of the spec is legal (it is the grading opt-in); it is an
    // all-omitted *present* spec that rule 9 rejects.
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "s3-report", allOperations: true }],
    });

    expect(policy.sensitiveTargets).toBeUndefined();
  });

  test.each([
    ["profiles only", { profiles: ["prod"] }],
    ["regions only", { regions: ["eu-west-1"] }],
    ["accountIds only", { accountIds: ["111122223333"] }],
  ])(
    "accepts a sensitiveTargets spec declaring %s",
    (_label: string, spec: Record<string, readonly string[]>) => {
      const policy = validateAgentPolicy(withSensitiveTargets(spec));

      expect(policy.sensitiveTargets).toEqual(spec);
    },
  );
});

describe("validateAgentPolicy — freezing and independence from the caller", () => {
  test("deep-freezes the policy, its grants, and every declared list", () => {
    const policy = validateAgentPolicy(validDeclaration());

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.scripts)).toBe(true);
    expect(Object.isFrozen(policy.scripts[0])).toBe(true);
    expect(Object.isFrozen(policy.scripts[1])).toBe(true);
    expect(Object.isFrozen(policy.scripts[1]?.operations)).toBe(true);
    expect(Object.isFrozen(policy.sensitiveTargets)).toBe(true);
    expect(Object.isFrozen(policy.sensitiveTargets?.profiles)).toBe(true);
  });

  test("mutating the caller's declaration afterwards cannot change the policy", () => {
    // The traversal projects into a fresh structure, so nothing downstream
    // re-reads the caller's object.
    const declaration = validDeclaration();
    const policy = validateAgentPolicy(declaration);

    const scripts = declaration["scripts"] as Record<string, unknown>[];
    const grant = scripts[1] as { script: string; operations: string[] };
    grant.script = "hijacked";
    grant.operations.push("delete-table");
    scripts.push({ script: "smuggled", allOperations: true });

    expect(policy.scripts).toHaveLength(2);
    expect(policy.scripts[1]?.script).toBe("dynamodb-crud");
    expect(policy.scripts[1]?.operations).toEqual(["get-item", "put-item"]);
  });

  test("mutating the caller's sensitiveTargets lists afterwards cannot change the policy", () => {
    const declaration = validDeclaration();
    const policy = validateAgentPolicy(declaration);

    const spec = declaration["sensitiveTargets"] as { profiles: string[] };
    spec.profiles.length = 0;

    expect(policy.sensitiveTargets?.profiles).toEqual(["prod"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The twelve declaration rules                                               */
/* -------------------------------------------------------------------------- */

describe("validateAgentPolicy — rule 1: the declaration is a plain object", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", [{ version: 1, scripts: [] }]],
    ["a string", '{"version":1}'],
    ["a number", 1],
    ["a Date", new Date(0)],
    ["a class instance", new NotAPlainObject()],
  ])("rejects a declaration that is %s", (_label: string, input: unknown) => {
    expectRejected(input);
  });
});

describe("validateAgentPolicy — rule 2: version is the literal 1", () => {
  test.each([
    ["absent", { scripts: [{ script: "s3-report", allOperations: true }] }],
    [
      'the string "1"',
      { version: "1", scripts: [{ script: "s3-report", allOperations: true }] },
    ],
    [
      "a later version",
      { version: 2, scripts: [{ script: "s3-report", allOperations: true }] },
    ],
    [
      "null",
      {
        version: null,
        scripts: [{ script: "s3-report", allOperations: true }],
      },
    ],
  ])("rejects a declaration whose version is %s", (_label, input: unknown) => {
    expectRejected(input);
  });

  test("names the field but never the rejected version value in context", () => {
    const error = expectRejected({
      version: 4242,
      scripts: [{ script: "s3-report", allOperations: true }],
    });

    expect(JSON.stringify(error.context)).not.toContain("4242");
  });
});

describe("validateAgentPolicy — rule 3: the scripts list", () => {
  test.each([
    ["absent", { version: 1 }],
    ["not an array", { version: 1, scripts: { script: "s3-report" } }],
    ["null", { version: 1, scripts: null }],
    ["empty", { version: 1, scripts: [] }],
  ])(
    "rejects a declaration whose scripts list is %s",
    (_label, input: unknown) => {
      expectRejected(input);
    },
  );

  test("rejects more grants than M3L_AGENT_MAX_SCRIPT_GRANTS", () => {
    expectRejected({
      version: 1,
      scripts: uniqueList("script", M3L_AGENT_MAX_SCRIPT_GRANTS + 1).map(
        (script) => ({ script, allOperations: true }),
      ),
    });
  });

  test("accepts exactly M3L_AGENT_MAX_SCRIPT_GRANTS grants (reject-above bound)", () => {
    const policy = validateAgentPolicy({
      version: 1,
      scripts: uniqueList("script", M3L_AGENT_MAX_SCRIPT_GRANTS).map(
        (script) => ({ script, allOperations: true }),
      ),
    });

    expect(policy.scripts).toHaveLength(M3L_AGENT_MAX_SCRIPT_GRANTS);
  });
});

describe("validateAgentPolicy — rule 4: a grant and its script name", () => {
  test.each([
    ["not a plain object", "s3-report"],
    ["null", null],
    ["an array", ["s3-report"]],
    ["missing script", { allOperations: true }],
    ["a non-string script", { script: 7, allOperations: true }],
    ["an empty script", { script: "", allOperations: true }],
    ["a whitespace-only script", { script: "   ", allOperations: true }],
    ["a tab-only script", { script: "\t", allOperations: true }],
  ])("rejects a grant that is %s", (_label, grant: unknown) => {
    expectRejected(withGrant(grant));
  });
});

describe("validateAgentPolicy — rule 5: duplicate scripts", () => {
  test("rejects two grants naming the same script (no last-wins merge)", () => {
    expectRejected({
      version: 1,
      scripts: [
        { script: "dynamodb-crud", operations: ["get-item"] },
        { script: "dynamodb-crud", allOperations: true },
      ],
    });
  });

  test("accepts two grants naming different scripts", () => {
    const policy = validateAgentPolicy(validDeclaration());

    expect(policy.scripts).toHaveLength(2);
  });
});

describe("validateAgentPolicy — rule 6: exactly one of operations / allOperations", () => {
  test("rejects a grant declaring neither (omission never means everything)", () => {
    expectRejected(withGrant({ script: "s3-report" }));
  });

  test("rejects a grant declaring both", () => {
    expectRejected(
      withGrant({
        script: "s3-report",
        operations: ["get-item"],
        allOperations: true,
      }),
    );
  });

  test("rejects a grant whose operations key is inherited rather than own", () => {
    // Presence is read with Object.hasOwn, so an inherited `operations`
    // resolves as absent — the grant then declares neither.
    //
    // Contested on purpose: ["get-item"] is a legal operations list, so an
    // implementation reading presence as `grant["operations"] !== undefined`
    // would accept this declaration outright. The grant is an ordinary
    // literal, so rule 4 (plain object) passes and rule 6 is the only rule
    // left that can reject it.
    const grant: Record<string, unknown> = { script: "dynamodb-crud" };

    withPollutedObjectPrototype("operations", ["get-item"], () => {
      // The pollution is live and the two readings genuinely disagree.
      expect(grant["operations"]).toEqual(["get-item"]);
      expect(Object.hasOwn(grant, "operations")).toBe(false);

      expectRejected(withGrant(grant));
    });
  });
});

describe("validateAgentPolicy — rule 7: the operations list", () => {
  test.each([
    ["empty", []],
    ["not an array", "get-item"],
    ["null", null],
    ["containing a non-string", ["get-item", 7]],
    ["containing an empty string", ["get-item", ""]],
    ["containing a whitespace-only string", ["get-item", "  "]],
    ["containing duplicates", ["get-item", "get-item"]],
  ])("rejects an operations list that is %s", (_label, operations: unknown) => {
    expectRejected(withGrant({ script: "dynamodb-crud", operations }));
  });

  test("rejects more operations than M3L_AGENT_MAX_OPERATIONS_PER_GRANT", () => {
    expectRejected(
      withGrant({
        script: "dynamodb-crud",
        operations: uniqueList("op", M3L_AGENT_MAX_OPERATIONS_PER_GRANT + 1),
      }),
    );
  });

  test("accepts exactly M3L_AGENT_MAX_OPERATIONS_PER_GRANT operations", () => {
    const policy = validateAgentPolicy(
      withGrant({
        script: "dynamodb-crud",
        operations: uniqueList("op", M3L_AGENT_MAX_OPERATIONS_PER_GRANT),
      }),
    );

    expect(policy.scripts[0]?.operations).toHaveLength(
      M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
    );
  });
});

describe("validateAgentPolicy — rule 8: allOperations is the boolean true", () => {
  test.each([
    ["false", false],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", {}],
  ])(
    "rejects a grant whose allOperations is %s",
    (_label, allOperations: unknown) => {
      expectRejected(withGrant({ script: "s3-report", allOperations }));
    },
  );
});

describe("validateAgentPolicy — rule 9: the grading spec is a plain object with at least one list", () => {
  test.each([
    ["null", null],
    ["an array", [["prod"]]],
    ["a string", "prod"],
    ["a number", 1],
  ])("rejects a sensitiveTargets spec that is %s", (_label, spec: unknown) => {
    expectRejected(withSensitiveTargets(spec));
  });

  test("rejects an all-omitted grading spec — the validator's single most important rule", () => {
    // `sensitiveTargets({})` builds a predicate that matches nothing, which
    // would silently grade every target as non-sensitive and auto-approve
    // every mutation. Accepting `{}` here is the module's worst fail-open.
    const error = expectRejected(withSensitiveTargets({}));

    expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
  });

  test("rejects a grading spec whose only key is an unknown one (rule 9 one level down)", () => {
    // `{ regionz: [...] }` omits all three known lists AND carries an unknown
    // key: it must never be read as "a spec that grades regions".
    expectRejected(withSensitiveTargets({ regionz: ["eu-west-1"] }));
  });

  test("rejects a grading spec whose lists are all inherited rather than own", () => {
    // Contested on purpose: ["prod"] is a legal grading list, so an
    // implementation reading presence as `spec["profiles"] !== undefined`
    // would accept this declaration and grade `prod` sensitive. The spec is an
    // ordinary literal, so rule 9's "every list omitted" arm is the only rule
    // left that can reject it.
    const spec: Record<string, unknown> = {};

    withPollutedObjectPrototype("profiles", ["prod"], () => {
      // The pollution is live and the two readings genuinely disagree.
      expect(spec["profiles"]).toEqual(["prod"]);
      expect(Object.hasOwn(spec, "profiles")).toBe(false);

      expectRejected(withSensitiveTargets(spec));
    });
  });
});

describe("validateAgentPolicy — rule 10: each grading list", () => {
  test.each([
    ["empty", { profiles: [] }],
    ["not an array", { profiles: "prod" }],
    ["null", { regions: null }],
    ["containing a non-string", { profiles: ["prod", 7] }],
    ["containing an empty string", { regions: ["eu-west-1", ""] }],
    ["containing a whitespace-only string", { accountIds: ["1111", "  "] }],
    ["containing duplicates", { profiles: ["prod", "prod"] }],
  ])("rejects a grading spec whose list is %s", (_label, spec: unknown) => {
    expectRejected(withSensitiveTargets(spec));
  });

  test("counts the ceiling across all three lists, not per list", () => {
    // 100 + 100 + 57 = 257 entries: no single list is over 256, so a per-list
    // bound would accept this. The declared bound is a total.
    expectRejected(
      withSensitiveTargets({
        profiles: uniqueList("profile", 100),
        regions: uniqueList("region", 100),
        accountIds: uniqueList("account", 57),
      }),
    );
  });

  test("accepts exactly M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES entries in total", () => {
    const policy = validateAgentPolicy(
      withSensitiveTargets({
        profiles: uniqueList("profile", 100),
        regions: uniqueList("region", 100),
        accountIds: uniqueList(
          "account",
          M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES - 200,
        ),
      }),
    );

    expect(policy.sensitiveTargets?.accountIds).toHaveLength(
      M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES - 200,
    );
  });

  test("names the field but never the rejected list value in context", () => {
    const error = expectRejected(
      withSensitiveTargets({ profiles: "zzz-not-a-list" }),
    );

    expect(JSON.stringify(error.context)).not.toContain("zzz-not-a-list");
  });
});

describe("validateAgentPolicy — rule 11: unknown keys, at all three levels", () => {
  test("rejects an unknown key at the top level", () => {
    expectRejected({ ...validDeclaration(), scriptz: [] });
  });

  test("rejects an unknown key on a grant", () => {
    expectRejected(
      withGrant({
        script: "dynamodb-crud",
        operations: ["get-item"],
        operationz: ["put-item"],
      }),
    );
  });

  test("rejects an unknown key on the sensitiveTargets object", () => {
    // The page's own example: this satisfies rules 9 and 10 (profiles is a
    // valid list) and would silently drop every region grading.
    expectRejected(
      withSensitiveTargets({ profiles: ["prod"], regionz: ["eu-west-1"] }),
    );
  });
});

describe("validateAgentPolicy — rule 12: dangerous keys, at all three levels", () => {
  test.each([
    ["constructor", "constructor"],
    ["prototype", "prototype"],
  ])("rejects an own %s key at the top level", (_label, key: string) => {
    expectRejected({ ...validDeclaration(), [key]: {} });
  });

  test.each([
    ["constructor", "constructor"],
    ["prototype", "prototype"],
  ])("rejects an own %s key on a grant", (_label, key: string) => {
    expectRejected(
      withGrant({ script: "s3-report", allOperations: true, [key]: {} }),
    );
  });

  test("rejects an own __proto__ key parsed out of a JSON document", () => {
    // JSON.parse creates a real own "__proto__" data property, which an
    // object literal cannot; this is the exact shape a policy preset file
    // produces.
    const declaration: unknown = JSON.parse(
      '{"version":1,"scripts":[{"script":"s3-report","allOperations":true}],"__proto__":{"polluted":true}}',
    );

    expectRejected(declaration);
  });

  test("rejects an own __proto__ key on the sensitiveTargets object", () => {
    const spec: unknown = JSON.parse(
      '{"profiles":["prod"],"__proto__":{"polluted":true}}',
    );

    expectRejected(withSensitiveTargets(spec));
  });

  test("a non-own __proto__ on an ordinary object literal is not a rejection", () => {
    // Every object literal reaches `__proto__` through its prototype chain;
    // reading presence with Object.hasOwn is what keeps that from being read
    // as a dangerous own key.
    const policy = validateAgentPolicy(validDeclaration());

    expect(policy.version).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The declared ceilings                                                      */
/* -------------------------------------------------------------------------- */

describe("the declared structural ceilings", () => {
  test.each([
    ["M3L_AGENT_MAX_SCRIPT_GRANTS", M3L_AGENT_MAX_SCRIPT_GRANTS, 128],
    [
      "M3L_AGENT_MAX_OPERATIONS_PER_GRANT",
      M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
      128,
    ],
    [
      "M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES",
      M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES,
      256,
    ],
  ])("%s is %i", (_label: string, actual: number, expected: number) => {
    expect(actual).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* The two error classes                                                      */
/* -------------------------------------------------------------------------- */

describe("M3LAgentPolicyDeclarationError", () => {
  test("is an M3LError whose code is pinned to ERR_AGENT_POLICY_DECLARATION", () => {
    const error = new M3LAgentPolicyDeclarationError("bad declaration");

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_AGENT_POLICY_DECLARATION");
    expect(error.message).toBe("bad declaration");
  });

  test("carries the supplied context and chains the supplied cause", () => {
    const cause = new Error("underlying");
    const error = new M3LAgentPolicyDeclarationError("bad declaration", {
      context: { field: "scripts", violation: "not-an-array" },
      cause,
    });

    expect(error.context).toEqual({
      field: "scripts",
      violation: "not-an-array",
    });
    expect(error.cause).toBe(cause);
  });

  test("defaults context to an empty record when none is supplied", () => {
    expect(new M3LAgentPolicyDeclarationError("bad").context).toEqual({});
  });
});

describe("M3LAgentActionValidationError", () => {
  test("is an M3LError whose code is pinned to ERR_AGENT_INVALID_ACTION", () => {
    const error = new M3LAgentActionValidationError("bad action");

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_AGENT_INVALID_ACTION");
    expect(error.message).toBe("bad action");
  });

  test("carries the supplied context and chains the supplied cause", () => {
    const cause = new Error("underlying");
    const error = new M3LAgentActionValidationError("bad action", {
      context: { field: "kind", violation: "unrecognised" },
      cause,
    });

    expect(error.context).toEqual({ field: "kind", violation: "unrecognised" });
    expect(error.cause).toBe(cause);
  });

  test("is distinguishable from the declaration error by instanceof", () => {
    const error = new M3LAgentActionValidationError("bad action");

    expect(error).not.toBeInstanceOf(M3LAgentPolicyDeclarationError);
  });
});

/* -------------------------------------------------------------------------- */
/* The two guards                                                             */
/* -------------------------------------------------------------------------- */

const KNOWN_RULE_IDS = [
  "script-not-allowlisted",
  "operation-not-allowlisted",
  "read-only-auto-approved",
  "target-ungraded-escalated",
  "policy-ungraded-escalated",
  "sensitive-target-escalated",
  "graded-mutation-auto-approved",
  "unclassifiable-escalated",
] as const;

describe("isAgentPolicyRuleId", () => {
  test.each(KNOWN_RULE_IDS)("recognises %s", (ruleId: string) => {
    expect(isAgentPolicyRuleId(ruleId)).toBe(true);
  });

  test("recognises exactly the eight ids this build knows", () => {
    expect(KNOWN_RULE_IDS).toHaveLength(8);
  });

  test.each([
    ["an id from a later minor", "budget.tokens-per-run"],
    ["a near-miss id", "script-not-allowed"],
    ["an empty string", ""],
    ["a non-string", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", { rule: "script-not-allowlisted" }],
  ])("returns false for %s", (_label: string, value: unknown) => {
    expect(isAgentPolicyRuleId(value)).toBe(false);
  });

  test.each([["__proto__"], ["constructor"], ["toString"], ["hasOwnProperty"]])(
    "returns false for the inherited Object.prototype key %s",
    (key: string) => {
      // The backing table is read with Object.hasOwn, so a prototype-chain
      // key is not a rule id.
      expect(isAgentPolicyRuleId(key)).toBe(false);
    },
  );

  test("narrows an unknown value to M3LAgentPolicyRuleId", () => {
    const value: unknown = "script-not-allowlisted";

    if (isAgentPolicyRuleId(value)) {
      expectTypeOf(value).toEqualTypeOf<M3LAgentPolicyRuleId>();
    } else {
      expect.unreachable("the value is a known rule id");
    }
  });
});

describe("isAgentActionAutoApproved", () => {
  const record: M3LAgentActionRecord = {
    script: "s3-report",
    operation: undefined,
    kind: "read-only",
    target: undefined,
    parameterNames: [],
    dryRun: false,
  };

  test.each([
    ["auto-approved", "read-only-auto-approved", true],
    ["escalate", "target-ungraded-escalated", false],
    ["denied", "script-not-allowlisted", false],
  ] as const)(
    "returns %s for a %s decision",
    (
      verdict: M3LAgentVerdict,
      rule: M3LAgentPolicyRuleId,
      expected: boolean,
    ) => {
      const decision = {
        verdict,
        rule,
        reason: "because",
        action: record,
      } as M3LAgentDecision;

      expect(isAgentActionAutoApproved(decision)).toBe(expected);
    },
  );

  test('returns false for escalate — the polarity `verdict !== "denied"` gets wrong', () => {
    // The hand-written alternative would run every escalation; this is the
    // whole reason the guard ships as a named export.
    // Returned through a function so the value keeps its declared union type
    // rather than being narrowed to the `escalate` arm by control flow — the
    // point of the second assertion is that the wrong gate below cannot tell
    // this decision apart from an approved one.
    const escalation = (): M3LAgentDecision => ({
      verdict: "escalate",
      rule: "sensitive-target-escalated",
      reason: "because",
      action: record,
    });
    const decision = escalation();

    expect(isAgentActionAutoApproved(decision)).toBe(false);
    expect(decision.verdict !== "denied").toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Type-level contract                                                        */
/* -------------------------------------------------------------------------- */

describe("type-level contract", () => {
  test("M3LAgentPolicy is branded: a bare declaration is not one", () => {
    expectTypeOf<M3LAgentPolicy>().toMatchTypeOf<M3LAgentPolicyDeclaration>();
    expectTypeOf<M3LAgentPolicyDeclaration>().not.toMatchTypeOf<M3LAgentPolicy>();
  });

  test("the evaluator's policy field accepts only the branded type", () => {
    expectTypeOf<
      M3LAgentEvaluationOptions["policy"]
    >().toEqualTypeOf<M3LAgentPolicy>();
    expectTypeOf<M3LAgentPolicyDeclaration>().not.toMatchTypeOf<
      M3LAgentEvaluationOptions["policy"]
    >();
  });

  test("validateAgentPolicy takes unknown and returns the branded policy", () => {
    expectTypeOf(validateAgentPolicy).parameters.toEqualTypeOf<[unknown]>();
    expectTypeOf(validateAgentPolicy).returns.toEqualTypeOf<M3LAgentPolicy>();
  });

  test("a grant's operations and allOperations are both optional and readonly", () => {
    expectTypeOf<M3LAgentScriptGrant["script"]>().toEqualTypeOf<string>();
    expectTypeOf<M3LAgentScriptGrant["operations"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();
    expectTypeOf<M3LAgentScriptGrant["allOperations"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  test("M3LAgentPolicyRuleId is the closed eight-member union this build knows", () => {
    expectTypeOf<M3LAgentPolicyRuleId>().toEqualTypeOf<
      (typeof KNOWN_RULE_IDS)[number]
    >();
  });
});
