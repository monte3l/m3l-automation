/**
 * Tests for `core/agent` V7 slice 1 — the decision-log entry (RED phase:
 * none of this exists yet — `M3LAgentIdentity`, `M3LAgentDecisionOutcome`,
 * `M3LAgentDecisionLogEntry`, `M3LAgentDecisionLogEntryOptions`,
 * `agentDecisionLogEntry`, `serializeAgentDecisionLogEntry`, and
 * `M3L_AGENT_MAX_LOG_ENTRY_BYTES` are none of them implemented or exported).
 *
 * Contract source: docs/reference/core/agent.md § The decision-log entry (all
 * subsections), § Public API (the new "The decision log" group), and the new
 * "V7 slice 1 — decision-log entry" Landing plan row.
 *
 * This slice is pure — no I/O, no clock read. Every decision fed to
 * `agentDecisionLogEntry` below is produced by a real `evaluateAgentAction`
 * call over a real `validateAgentPolicy`-validated policy, exactly like the
 * sibling V6 test files, so the projector is always exercised against the
 * library's own frozen `M3LAgentActionRecord` rather than a hand-built stub
 * that could accidentally admit a shape the real evaluator never produces.
 *
 * `M3LAgentDecision` itself carries no runtime brand (unlike `M3LAgentPolicy`,
 * which `evaluateAgentAction` checks against a module-private `WeakSet`), so
 * this file's malformed-`options` cases are free to reuse one real decision
 * fixture across every `identity` / `now` / `outcome` / `tokens` / `cost`
 * violation — the case under test is the only thing wrong with the bag.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  M3L_AGENT_MAX_LOG_ENTRY_BYTES,
  M3L_AGENT_MAX_PARAMETER_NAMES,
  M3LAgentActionValidationError,
  M3LError,
  agentDecisionLogEntry,
  evaluateAgentAction,
  serializeAgentDecisionLogEntry,
  validateAgentPolicy,
} from "../src/core/index.js";
import type {
  M3LAgentDecision,
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionLogEntryOptions,
  M3LAgentDecisionOutcome,
  M3LAgentIdentity,
  M3LAgentPolicy,
  M3LAgentPolicyRuleId,
  M3LAgentVerdict,
  M3LDestructiveTarget,
} from "../src/core/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

/** A non-sensitive target under {@link gradedPolicy}'s spec. */
const SAFE_TARGET: M3LDestructiveTarget = {
  profile: "sandbox",
  region: "eu-central-1",
};

/** A fixed instant so every timestamp assertion below is deterministic. */
const NOW_MS = Date.UTC(2026, 7, 30, 12, 34, 56, 789);

/** A minimal, valid identity — only the required `name`. */
const IDENTITY_MINIMAL: M3LAgentIdentity = { name: "agent-x" };

/** A fully populated, valid identity. */
const IDENTITY_FULL: M3LAgentIdentity = {
  name: "agent-x",
  modelId: "anthropic.claude-tool-use-v1",
  awsPrincipal: "arn:aws:iam::123456789012:role/agent-role",
};

/** A policy that grades one profile as sensitive. Built lazily per test. */
function gradedPolicy(): M3LAgentPolicy {
  return validateAgentPolicy({
    version: 1,
    scripts: [
      { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
    ],
    sensitiveTargets: { profiles: ["prod"] },
  });
}

/** `read-only-auto-approved` / `"auto-approved"`. */
function autoApprovedDecision(): M3LAgentDecision {
  return evaluateAgentAction({
    policy: gradedPolicy(),
    action: {
      script: "dynamodb-crud",
      operation: "get-item",
      kind: "read-only",
      target: SAFE_TARGET,
      parameterNames: ["table", "key"],
    },
  });
}

/** `target-ungraded-escalated` / `"escalate"` — no `target` on the action. */
function escalateDecision(): M3LAgentDecision {
  return evaluateAgentAction({
    policy: gradedPolicy(),
    action: {
      script: "dynamodb-crud",
      operation: "put-item",
      kind: "mutating",
      parameterNames: ["table", "item"],
    },
  });
}

/** `script-not-allowlisted` / `"denied"`. */
function deniedDecision(): M3LAgentDecision {
  return evaluateAgentAction({
    policy: gradedPolicy(),
    action: {
      script: "unknown-script",
      kind: "read-only",
      parameterNames: ["table"],
    },
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
 * Asserts `run` throws `M3LAgentActionValidationError` and that its
 * `context` names both the offending field and the violation kind (as
 * non-empty strings, without pinning their exact spelling — this slice's
 * contract requires the naming, not a specific vocabulary). Returns the
 * error so each case can additionally assert its own value never leaked.
 */
function expectLogEntryRejected(
  run: () => unknown,
): M3LAgentActionValidationError {
  const thrown = catchThrown(run);
  expect(thrown).toBeInstanceOf(M3LAgentActionValidationError);
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAgentActionValidationError;
  expect(error.code).toBe("ERR_AGENT_INVALID_ACTION");
  const field = error.context["field"];
  const violation = error.context["violation"];
  expect(typeof field).toBe("string");
  expect((field as string).length).toBeGreaterThan(0);
  expect(typeof violation).toBe("string");
  expect((violation as string).length).toBeGreaterThan(0);
  return error;
}

/** Calls `agentDecisionLogEntry` with an intentionally untyped bag. */
function callWithOptions(options: unknown): unknown {
  return agentDecisionLogEntry(options as M3LAgentDecisionLogEntryOptions);
}

/** A well-formed options bag, for tests that only vary one field. */
function validOptions(): M3LAgentDecisionLogEntryOptions {
  return {
    decision: autoApprovedDecision(),
    identity: IDENTITY_MINIMAL,
    now: NOW_MS,
  };
}

/* -------------------------------------------------------------------------- */
/* Every verdict is recorded                                                  */
/* -------------------------------------------------------------------------- */

describe("every verdict is recorded", () => {
  test.each([
    ["auto-approved", autoApprovedDecision],
    ["escalate", escalateDecision],
    ["denied", deniedDecision],
  ] as const)(
    "projects a %s decision without filtering it",
    (
      expectedVerdict: M3LAgentVerdict,
      buildDecision: () => M3LAgentDecision,
    ) => {
      const decision = buildDecision();
      const entry = agentDecisionLogEntry({
        decision,
        identity: IDENTITY_MINIMAL,
        now: NOW_MS,
      });
      expect(entry.verdict).toBe(expectedVerdict);
      expect(entry.verdict).toBe(decision.verdict);
      expect(entry.rule).toBe(decision.rule);
      expect(entry.reason).toBe(decision.reason);
      expect(entry.script).toBe(decision.action.script);
      expect(entry.kind).toBe(decision.action.kind);
      expect(entry.shapeKey).toBe(decision.action.shapeKey);
      expect(entry.parameterNames).toEqual(decision.action.parameterNames);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Names, never values                                                       */
/* -------------------------------------------------------------------------- */

describe("names, never values", () => {
  test("the serialized entry carries parameter names and no other flat field", () => {
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "put-item",
        kind: "mutating",
        target: SAFE_TARGET,
        parameterNames: ["accountNumber", "apiSecretKey", "customerEmail"],
      },
    });
    const entry = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    const serialized = serializeAgentDecisionLogEntry(entry);

    for (const name of decision.action.parameterNames) {
      expect(serialized).toContain(name);
    }

    // The projector's only input is the library's own frozen action record —
    // `M3LAgentActionRecord.parameterNames` is structurally names-only, so
    // there is nowhere on `M3LAgentDecision` a value could have entered. The
    // strongest thing this file can check is that the entry exposes exactly
    // the documented flat field set (this decision has both `operation` and
    // `target`) and nothing beyond it that could smuggle one in.
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "identity",
        "kind",
        "operation",
        "parameterNames",
        "reason",
        "rule",
        "script",
        "shapeKey",
        "target",
        "timestamp",
        "verdict",
      ].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The clock stays outside the module                                        */
/* -------------------------------------------------------------------------- */

describe("timestamp derivation", () => {
  test("timestamp is the ISO-8601 UTC rendering of the caller's now", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(entry.timestamp).toBe(new Date(NOW_MS).toISOString());
  });

  test("the same now and decision always produce the same entry (no clock read)", () => {
    const decision = autoApprovedDecision();
    const first = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    const second = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(JSON.parse(JSON.stringify(second))).toEqual(
      JSON.parse(JSON.stringify(first)),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Freezing and independence from caller objects                             */
/* -------------------------------------------------------------------------- */

describe("freezing and independence from caller objects", () => {
  test("the returned entry is deep-frozen", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_FULL,
      now: NOW_MS,
      outcome: { dryRun: false, exitCode: 0, registryName: "prod-registry" },
      tokens: 42,
      cost: 0.01,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.identity)).toBe(true);
    expect(Object.isFrozen(entry.parameterNames)).toBe(true);
    expect(entry.outcome).not.toBeUndefined();
    if (entry.outcome !== undefined) {
      expect(Object.isFrozen(entry.outcome)).toBe(true);
    }
  });

  test("mutating the returned entry's own property throws in strict mode", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(() => {
      (entry as { timestamp: string }).timestamp = "mutated";
    }).toThrow(TypeError);
  });

  test("mutating the caller's identity object after the call does not change the produced entry", () => {
    const identity: { name: string; modelId?: string } = {
      name: "agent-x",
      modelId: "model-a",
    };
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity,
      now: NOW_MS,
    });
    identity.name = "mutated-after-the-fact";
    identity.modelId = "mutated-model";
    expect(entry.identity.name).toBe("agent-x");
    expect(entry.identity.modelId).toBe("model-a");
  });

  test("two entries built from equal-but-distinct identity objects do not share an identity reference", () => {
    const identityA: M3LAgentIdentity = { name: "agent-x" };
    const identityB: M3LAgentIdentity = { name: "agent-x" };
    const entryA = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: identityA,
      now: NOW_MS,
    });
    const entryB = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: identityB,
      now: NOW_MS,
    });
    expect(entryA.identity).not.toBe(entryB.identity);
    expect(entryA.identity).not.toBe(identityA);
    expect(entryA.identity).toEqual(entryB.identity);
  });
});

/* -------------------------------------------------------------------------- */
/* Optional fields are omitted, never null                                   */
/* -------------------------------------------------------------------------- */

describe("optional fields are omitted, never null", () => {
  test("outcome/tokens/cost are absent from the entry when not supplied", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
    expect(Object.hasOwn(entry, "tokens")).toBe(false);
    expect(Object.hasOwn(entry, "cost")).toBe(false);
  });

  test("outcome/tokens/cost are present and typed correctly when supplied", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
      outcome: { dryRun: true },
      tokens: 10,
      cost: 0.02,
    });
    expect(entry.outcome).toEqual({ dryRun: true });
    expect(entry.tokens).toBe(10);
    expect(entry.cost).toBe(0.02);
  });

  test("identity.modelId and identity.awsPrincipal are omitted from the serialized JSON when absent, never null", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: { name: "agent-x" },
      now: NOW_MS,
    });
    const parsed = JSON.parse(serializeAgentDecisionLogEntry(entry)) as {
      identity: Record<string, unknown>;
    };
    expect(Object.hasOwn(parsed.identity, "modelId")).toBe(false);
    expect(Object.hasOwn(parsed.identity, "awsPrincipal")).toBe(false);
    expect(JSON.stringify(parsed.identity)).not.toContain("null");
  });

  test("operation is omitted from the serialized JSON when the action declares none", () => {
    // `gradedPolicy()` allowlists only two named operations, so an
    // operation-less action there would hit step 2's
    // "operation-not-allowlisted" denial -- a real verdict, but one that
    // exercises the allowlist rather than this field's projection. A
    // dedicated `allOperations: true` grant keeps the verdict meaningful
    // (read-only-auto-approved) while still declaring no `operation`.
    const policy = validateAgentPolicy({
      version: 1,
      scripts: [{ script: "dynamodb-crud", allOperations: true }],
      sensitiveTargets: { profiles: ["prod"] },
    });
    const decision = evaluateAgentAction({
      policy,
      action: {
        script: "dynamodb-crud",
        kind: "read-only",
        target: SAFE_TARGET,
        parameterNames: ["table"],
      },
    });
    expect(decision.action.operation).toBeUndefined();
    const entry = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    const parsed = JSON.parse(serializeAgentDecisionLogEntry(entry)) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(parsed, "operation")).toBe(false);
    expect(entry.operation).toBeUndefined();
  });

  test("target is omitted from the serialized JSON when the action declares none", () => {
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
      },
    });
    const entry = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    const parsed = JSON.parse(serializeAgentDecisionLogEntry(entry)) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(parsed, "target")).toBe(false);
    expect(entry.target).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* serializeAgentDecisionLogEntry                                            */
/* -------------------------------------------------------------------------- */

describe("serializeAgentDecisionLogEntry", () => {
  // No failure-path test here by design, not by omission: the only argument
  // `serializeAgentDecisionLogEntry` accepts is `M3LAgentDecisionLogEntry`,
  // and the only place that type is ever produced is `agentDecisionLogEntry`
  // itself, which returns nothing but an already-validated, frozen, JSON-safe
  // entry (a `Date`-derived ISO string, frozen arrays/objects, and no
  // caller-supplied reference — see `projectEntry` above). There is no
  // reachable value of that type `JSON.stringify` can fail on (no `bigint`,
  // no function, no circular reference), so this function has no failure
  // mode by construction to characterize.
  test("returns exactly one line without a trailing newline", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_FULL,
      now: NOW_MS,
      outcome: { dryRun: false, exitCode: 0 },
      tokens: 120,
      cost: 0.004,
    });
    const serialized = serializeAgentDecisionLogEntry(entry);
    expect(serialized.includes("\n")).toBe(false);
    expect(serialized.endsWith("\n")).toBe(false);
    expect(() => {
      JSON.parse(serialized);
    }).not.toThrow();
  });

  test("round-trips to the entry's own JSON projection", () => {
    const entry = agentDecisionLogEntry({
      decision: escalateDecision(),
      identity: IDENTITY_FULL,
      now: NOW_MS,
      tokens: 5,
    });
    const serialized = serializeAgentDecisionLogEntry(entry);
    expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(entry)));
  });
});

/* -------------------------------------------------------------------------- */
/* M3L_AGENT_MAX_LOG_ENTRY_BYTES                                             */
/* -------------------------------------------------------------------------- */

describe("M3L_AGENT_MAX_LOG_ENTRY_BYTES", () => {
  test("is 65536", () => {
    expect(M3L_AGENT_MAX_LOG_ENTRY_BYTES).toBe(65536);
  });

  test("serializing a line past the ceiling does not throw (enforcement is slice 2)", () => {
    const bigNames = Array.from(
      { length: M3L_AGENT_MAX_PARAMETER_NAMES },
      (_unused, index) => `parameter-name-${index}-${"x".repeat(300)}`,
    );
    const decision = evaluateAgentAction({
      policy: gradedPolicy(),
      action: {
        script: "dynamodb-crud",
        operation: "get-item",
        kind: "read-only",
        target: SAFE_TARGET,
        parameterNames: bigNames,
      },
    });
    const entry = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    let serialized = "";
    expect(() => {
      serialized = serializeAgentDecisionLogEntry(entry);
    }).not.toThrow();
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(
      M3L_AGENT_MAX_LOG_ENTRY_BYTES,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-loud: agentDecisionLogEntry                                          */
/* -------------------------------------------------------------------------- */

/** A well-formed options bag built around an arbitrary `decision` value. */
function optionsWithDecision(decision: unknown): unknown {
  return { decision, identity: IDENTITY_MINIMAL, now: NOW_MS };
}

describe("[decision] structural validation (no runtime brand — validated here)", () => {
  test("throws when decision is not a plain object", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision("not-a-decision")),
    );
    expect(error.context["field"]).toBe("decision");
    expect(error.context["violation"]).toBe("not-a-plain-object");
  });

  test("throws on an unknown key on decision", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({ ...autoApprovedDecision(), extra: "x" }),
      ),
    );
    expect(error.context["field"]).toBe("decision");
    expect(error.context["violation"]).toBe("unknown-key");
  });

  test("throws when decision.action is not a plain object", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({ ...autoApprovedDecision(), action: "nope" }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action");
    expect(error.context["violation"]).toBe("not-a-plain-object");
  });

  test("throws on an unknown key on decision.action", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, extra: "x" },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action");
    expect(error.context["violation"]).toBe("unknown-key");
  });

  test("throws when decision.action.script is blank or non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, script: "   " },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.script");
    expect(error.context["violation"]).toBe("blank-or-non-string");
    expect(JSON.stringify(error.context)).not.toContain('"   "');
  });

  test("throws when decision.action.kind is blank or non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, kind: 42 },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.kind");
    expect(error.context["violation"]).toBe("blank-or-non-string");
    expect(Object.values(error.context)).not.toContain(42);
  });

  test("throws when decision.action.shapeKey is blank or non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, shapeKey: "" },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.shapeKey");
    expect(error.context["violation"]).toBe("blank-or-non-string");
  });

  test("throws when decision.action.parameterNames is not an array of strings", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, parameterNames: "nope" },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.parameterNames");
    expect(error.context["violation"]).toBe("not-an-array-of-strings");
    expect(JSON.stringify(error.context)).not.toContain("nope");
  });

  test("throws when decision.action.dryRun is not a boolean", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, dryRun: "false" },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.dryRun");
    expect(error.context["violation"]).toBe("not-a-boolean");
    expect(JSON.stringify(error.context)).not.toContain('"false"');
  });

  test("throws when decision.verdict is blank or non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision({ ...decision, verdict: "" })),
    );
    expect(error.context["field"]).toBe("decision.verdict");
    expect(error.context["violation"]).toBe("blank-or-non-string");
  });

  test("throws when decision.rule is blank or non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision({ ...decision, rule: 5 })),
    );
    expect(error.context["field"]).toBe("decision.rule");
    expect(error.context["violation"]).toBe("blank-or-non-string");
    expect(Object.values(error.context)).not.toContain(5);
  });

  test("throws when decision.reason is blank or non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision({ ...decision, reason: "   " })),
    );
    expect(error.context["field"]).toBe("decision.reason");
    expect(error.context["violation"]).toBe("blank-or-non-string");
  });

  // [CRITICAL] Regression pin: `decision` carries no runtime brand (unlike
  // `M3LAgentPolicy`, whose validator membership is checked in a
  // module-private `WeakSet`), so before structural validation existed here,
  // a decision this malformed produced a frozen, plausible, throw-free entry
  // silently missing `script` / `kind` / `shapeKey` / `target`. Deleting the
  // `assertValidDecision` call in `buildAgentDecisionLogEntry` must make this
  // test fail.
  test("[CRITICAL] a decision whose action is missing script/kind/shapeKey/dryRun throws instead of silently producing an entry", () => {
    const malformedDecision: unknown = {
      action: { parameterNames: [] },
      verdict: "auto-approved",
      rule: "r",
      reason: "x",
    };
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision(malformedDecision)),
    );
    expect(error.context["field"]).toBe("decision.action.script");
    expect(error.context["violation"]).toBe("blank-or-non-string");
  });
});

describe("[decision.action.target] structural validation", () => {
  // [CRITICAL] Regression pin: the review bot's exact finding. Before
  // `assertValidDecisionActionTarget` existed, `action.target` was read and
  // copied verbatim into the entry (`projectEntry`) without ever being
  // validated, so a hand-built decision with `action.target = "prod"` (a
  // bare string, not a target object) produced a frozen entry whose
  // `target` was silently `{}` — an audit record missing its coordinates
  // instead of throwing. Deleting the `assertValidDecisionActionTarget`
  // call in `assertValidDecisionAction` must make this test fail.
  test("[CRITICAL] a string action.target throws instead of silently producing an entry with an empty target", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, target: "prod" },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.target");
    expect(error.context["violation"]).toBe("not-a-plain-object");
    expect(JSON.stringify(error.context)).not.toContain("prod");
  });

  // A `null` target must be rejected with this same precise label — never
  // the generic `traversal-threw` backstop, which the module's own header
  // comment reserves for a hostile Proxy/accessor trap breaking the
  // traversal, not for merely malformed input.
  test("a null action.target throws the same not-a-plain-object label, not the traversal-threw backstop", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, target: null },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.target");
    expect(error.context["violation"]).toBe("not-a-plain-object");
    expect(error.context["violation"]).not.toBe("traversal-threw");
  });

  test("an absent action.target is accepted", () => {
    const decision = escalateDecision();
    expect(decision.action.target).toBeUndefined();
    const entry = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(entry.target).toBeUndefined();
  });

  test("a valid target round-trips into the entry unchanged", () => {
    const decision = autoApprovedDecision();
    const entry = agentDecisionLogEntry({
      decision,
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(entry.target).toEqual({
      profile: SAFE_TARGET.profile,
      region: SAFE_TARGET.region,
      accountId: undefined,
    });
  });

  // `M3LAgentActionRecordTarget` uses the "required, holding `undefined`"
  // shape for `region` / `accountId` (`core/agent/action-types.ts`) — an own
  // key present but holding `undefined` is legitimate input, not "absent",
  // so it must be accepted rather than rejected as malformed. Getting this
  // wrong would break the library's own projection of a real action record.
  test("an own target key holding undefined is accepted, not rejected", () => {
    const decision = autoApprovedDecision();
    const entry = agentDecisionLogEntry({
      decision: {
        ...decision,
        action: {
          ...decision.action,
          target: { profile: "p", region: undefined, accountId: undefined },
        },
      },
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
    });
    expect(entry.target).toEqual({
      profile: "p",
      region: undefined,
      accountId: undefined,
    });
  });

  test.each(["profile", "region", "accountId"] as const)(
    "throws its own qualified label when target.%s is blank",
    (key) => {
      const decision = autoApprovedDecision();
      const error = expectLogEntryRejected(() =>
        callWithOptions(
          optionsWithDecision({
            ...decision,
            action: {
              ...decision.action,
              target: { ...SAFE_TARGET, [key]: "   " },
            },
          }),
        ),
      );
      expect(error.context["field"]).toBe(`decision.action.target.${key}`);
      expect(error.context["violation"]).toBe("blank-or-non-string");
    },
  );

  test.each(["profile", "region", "accountId"] as const)(
    "throws its own qualified label when target.%s is non-string",
    (key) => {
      const decision = autoApprovedDecision();
      const error = expectLogEntryRejected(() =>
        callWithOptions(
          optionsWithDecision({
            ...decision,
            action: {
              ...decision.action,
              target: { ...SAFE_TARGET, [key]: 42 },
            },
          }),
        ),
      );
      expect(error.context["field"]).toBe(`decision.action.target.${key}`);
      expect(error.context["violation"]).toBe("blank-or-non-string");
      expect(Object.values(error.context)).not.toContain(42);
    },
  );

  test("rejects an unknown key on target", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: {
            ...decision.action,
            target: { ...SAFE_TARGET, az: "eu-central-1a" },
          },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.target");
    expect(error.context["violation"]).toBe("unknown-key");
  });
});

describe("[decision] closed-vocabulary validation (verdict / rule / kind)", () => {
  test("decision.verdict outside the closed vocabulary is a distinct violation from blank-or-non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision({ ...decision, verdict: "banana" })),
    );
    expect(error.context["field"]).toBe("decision.verdict");
    expect(error.context["violation"]).toBe("not-a-known-verdict");
    expect(error.context["violation"]).not.toBe("blank-or-non-string");
    expect(JSON.stringify(error.context)).not.toContain("banana");
  });

  test("decision.rule outside the closed vocabulary is a distinct violation from blank-or-non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(optionsWithDecision({ ...decision, rule: "r" })),
    );
    expect(error.context["field"]).toBe("decision.rule");
    expect(error.context["violation"]).toBe("not-a-known-rule-id");
    expect(error.context["violation"]).not.toBe("blank-or-non-string");
    expect(JSON.stringify(error.context)).not.toContain('"r"');
  });

  test("decision.action.kind outside the closed vocabulary is a distinct violation from blank-or-non-string", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions(
        optionsWithDecision({
          ...decision,
          action: { ...decision.action, kind: "sideways" },
        }),
      ),
    );
    expect(error.context["field"]).toBe("decision.action.kind");
    expect(error.context["violation"]).toBe("not-a-known-kind");
    expect(error.context["violation"]).not.toBe("blank-or-non-string");
    expect(JSON.stringify(error.context)).not.toContain("sideways");
  });
});

describe("[identity.name] blank or non-string", () => {
  test("throws when identity.name is blank", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        identity: { name: "   " },
      }),
    );
    expect(JSON.stringify(error.context)).not.toContain('"   "');
  });

  test("throws when identity.name is not a string", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        identity: { name: 42 },
      }),
    );
    expect(Object.values(error.context)).not.toContain(42);
  });
});

describe("[identity.modelId / identity.awsPrincipal] non-string", () => {
  test("throws when identity.modelId is not a string", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        identity: { name: "agent-x", modelId: 42 },
      }),
    );
    expect(Object.values(error.context)).not.toContain(42);
  });

  test("throws when identity.awsPrincipal is not a string", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        identity: { name: "agent-x", awsPrincipal: { arn: "not-a-string" } },
      }),
    );
    expect(JSON.stringify(error.context)).not.toContain("not-a-string");
  });

  test("throws on an unknown key inside identity", () => {
    expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        identity: { name: "agent-x", nickname: "agent-x" },
      }),
    );
  });
});

describe("[now] non-finite, non-integer, or outside Date's representable range", () => {
  test.each([
    [Number.NaN, "non-finite (NaN)"],
    [Number.POSITIVE_INFINITY, "non-finite (+Infinity)"],
    [1234.5, "non-integer"],
    [8_700_000_000_000_000, "outside Date's representable range"],
    [-8_700_000_000_000_000, "outside Date's representable range (negative)"],
  ])("throws when now is %s (%s)", (now: number, _label: string) => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({ ...validOptions(), now }),
    );
    expect(
      Object.values(error.context).some(
        (value) => typeof value === "number" && value === now,
      ),
    ).toBe(false);
  });
});

describe("[now] missing entirely — a distinct violation from non-finite/non-integer", () => {
  test("throws its own violation label when now is absent", () => {
    const decision = autoApprovedDecision();
    const error = expectLogEntryRejected(() =>
      callWithOptions({ decision, identity: IDENTITY_MINIMAL }),
    );
    expect(error.context["field"]).toBe("now");
    expect(error.context["violation"]).toBe("missing");
  });

  test("the absent-now label differs from the non-finite/non-integer label", () => {
    const decision = autoApprovedDecision();
    const missingError = expectLogEntryRejected(() =>
      callWithOptions({ decision, identity: IDENTITY_MINIMAL }),
    );
    const nonFiniteError = expectLogEntryRejected(() =>
      callWithOptions({
        decision,
        identity: IDENTITY_MINIMAL,
        now: Number.NaN,
      }),
    );
    expect(missingError.context["violation"]).not.toBe(
      nonFiniteError.context["violation"],
    );
  });
});

describe("[tokens] negative or non-finite", () => {
  test.each([
    [-1, "negative"],
    [Number.NaN, "non-finite (NaN)"],
    [Number.POSITIVE_INFINITY, "non-finite (+Infinity)"],
  ])("throws when tokens is %s (%s)", (tokens: number, _label: string) => {
    expectLogEntryRejected(() =>
      callWithOptions({ ...validOptions(), tokens }),
    );
  });
});

describe("[cost] negative or non-finite", () => {
  test.each([
    [-0.01, "negative"],
    [Number.NaN, "non-finite (NaN)"],
    [Number.POSITIVE_INFINITY, "non-finite (+Infinity)"],
  ])("throws when cost is %s (%s)", (cost: number, _label: string) => {
    expectLogEntryRejected(() => callWithOptions({ ...validOptions(), cost }));
  });
});

describe("[outcome] malformed fields", () => {
  test("throws when outcome.exitCode is not an integer", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        outcome: { dryRun: false, exitCode: 1.5 },
      }),
    );
    expect(Object.values(error.context)).not.toContain(1.5);
  });

  test("throws when outcome.registryName is blank", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        outcome: { dryRun: false, registryName: "" },
      }),
    );
    expect(JSON.stringify(error.context)).not.toContain('""');
  });

  test("throws when outcome.dryRun is not a boolean", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        outcome: { dryRun: "true" },
      }),
    );
    expect(JSON.stringify(error.context)).not.toContain('"true"');
  });

  test("throws on an unknown key inside outcome", () => {
    expectLogEntryRejected(() =>
      callWithOptions({
        ...validOptions(),
        outcome: { dryRun: false, exitTypo: 0 },
      }),
    );
  });
});

describe("[options bag] unknown or dangerous keys", () => {
  test("rejects an unknown own key on the options bag", () => {
    const error = expectLogEntryRejected(() =>
      callWithOptions({ ...validOptions(), extra: "not-recognised" }),
    );
    expect(JSON.stringify(error.context)).not.toContain("not-recognised");
  });

  test.each(["constructor", "prototype"])(
    "rejects a dangerous own %s key on the options bag",
    (key) => {
      expectLogEntryRejected(() =>
        callWithOptions({ ...validOptions(), [key]: {} }),
      );
    },
  );

  test("rejects an own __proto__ key on the options bag parsed out of a JSON document", () => {
    const parsed: unknown = JSON.parse(
      `{"decision":${JSON.stringify(
        autoApprovedDecision(),
      )},"identity":{"name":"agent-x"},"now":${String(NOW_MS)},"__proto__":{"polluted":true}}`,
    );
    expectLogEntryRejected(() => callWithOptions(parsed));
  });
});

/* -------------------------------------------------------------------------- */
/* Type-level contract                                                       */
/* -------------------------------------------------------------------------- */

describe("type-level contract", () => {
  // Every optional below is the NARROW, omit-only `?: T` spelling, not
  // `?: T | undefined`: under `exactOptionalPropertyTypes`, only the wider
  // spelling would accept a present key explicitly holding `undefined` at
  // compile time, and the runtime validator throws on exactly that -- the
  // narrow spelling is what makes the type and the validator agree.

  test("M3LAgentIdentity has the documented (narrow) shape", () => {
    expectTypeOf<M3LAgentIdentity>().toEqualTypeOf<{
      readonly name: string;
      readonly modelId?: string;
      readonly awsPrincipal?: string;
    }>();
  });

  test("M3LAgentIdentity accepts a bare name", () => {
    const identity: M3LAgentIdentity = { name: "agent-x" };
    expect(identity.name).toBe("agent-x");
  });

  test("M3LAgentIdentity rejects modelId explicitly holding undefined at compile time (exactOptionalPropertyTypes)", () => {
    // A `const` with a runtime read below, not a bare type-only statement:
    // if `modelId` ever widens back to `?: string | undefined`, `tsc`
    // reports the now-unused `@ts-expect-error` as its own error, rather
    // than this test quietly continuing to pass on an object it never
    // actually type-checked.
    // @ts-expect-error -- modelId is `?: string` (narrow, omit-only); an
    // explicit `undefined` is rejected under exactOptionalPropertyTypes.
    const identity: M3LAgentIdentity = { name: "agent-x", modelId: undefined };
    expect(identity.name).toBe("agent-x");
  });

  test("a returned entry's identity round-trips as an M3LAgentIdentity", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_FULL,
      now: NOW_MS,
    });
    // No cast: this only compiles if `entry.identity` is exactly assignable
    // back to `M3LAgentIdentity`, the round-trip direction the narrow
    // spelling exists to keep working (a caller re-recording a returned
    // identity, e.g. for a follow-up decision).
    const rePassed: M3LAgentIdentity = entry.identity;
    expect(rePassed).toEqual(IDENTITY_FULL);
  });

  test("M3LAgentDecisionOutcome has the documented (narrow) shape", () => {
    expectTypeOf<M3LAgentDecisionOutcome>().toEqualTypeOf<{
      readonly dryRun: boolean;
      readonly exitCode?: number;
      readonly registryName?: string;
    }>();
  });

  test("M3LAgentDecisionOutcome rejects exitCode explicitly holding undefined at compile time (exactOptionalPropertyTypes)", () => {
    // @ts-expect-error -- exitCode is `?: number` (narrow, omit-only); an
    // explicit `undefined` is rejected under exactOptionalPropertyTypes.
    const outcome: M3LAgentDecisionOutcome = {
      dryRun: false,
      exitCode: undefined,
    };
    expect(outcome.dryRun).toBe(false);
  });

  test("a returned entry's outcome round-trips as an M3LAgentDecisionOutcome", () => {
    const entry = agentDecisionLogEntry({
      decision: autoApprovedDecision(),
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
      outcome: { dryRun: true, exitCode: 0 },
    });
    expect(entry.outcome).not.toBeUndefined();
    if (entry.outcome !== undefined) {
      const rePassed: M3LAgentDecisionOutcome = entry.outcome;
      expect(rePassed).toEqual({ dryRun: true, exitCode: 0 });
    }
  });

  test("M3LAgentDecisionLogEntryOptions has the documented (narrow) shape", () => {
    expectTypeOf<M3LAgentDecisionLogEntryOptions>().toEqualTypeOf<{
      readonly decision: M3LAgentDecision;
      readonly identity: M3LAgentIdentity;
      readonly now: number;
      readonly outcome?: M3LAgentDecisionOutcome;
      readonly tokens?: number;
      readonly cost?: number;
    }>();
  });

  test("M3LAgentDecisionLogEntryOptions rejects tokens explicitly holding undefined at compile time (exactOptionalPropertyTypes)", () => {
    // @ts-expect-error -- tokens is `?: number` (narrow, omit-only); an
    // explicit `undefined` is rejected under exactOptionalPropertyTypes.
    const options: M3LAgentDecisionLogEntryOptions = {
      decision: autoApprovedDecision(),
      identity: IDENTITY_MINIMAL,
      now: NOW_MS,
      tokens: undefined,
    };
    expect(options.now).toBe(NOW_MS);
  });

  test("M3LAgentDecisionLogEntry has the documented readonly fields", () => {
    expectTypeOf<M3LAgentDecisionLogEntry>().toExtend<{
      readonly timestamp: string;
      readonly identity: M3LAgentIdentity;
      readonly script: string;
      readonly kind: string;
      readonly parameterNames: readonly string[];
      readonly shapeKey: string;
      readonly verdict: M3LAgentVerdict;
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
    }>();
  });

  test("timestamp is a plain string", () => {
    expectTypeOf<
      M3LAgentDecisionLogEntry["timestamp"]
    >().toEqualTypeOf<string>();
  });

  test("verdict is M3LAgentVerdict", () => {
    expectTypeOf<
      M3LAgentDecisionLogEntry["verdict"]
    >().toEqualTypeOf<M3LAgentVerdict>();
  });

  test("rule is M3LAgentPolicyRuleId", () => {
    expectTypeOf<
      M3LAgentDecisionLogEntry["rule"]
    >().toEqualTypeOf<M3LAgentPolicyRuleId>();
  });

  test("agentDecisionLogEntry has the documented signature", () => {
    expectTypeOf(agentDecisionLogEntry).toEqualTypeOf<
      (options: M3LAgentDecisionLogEntryOptions) => M3LAgentDecisionLogEntry
    >();
  });

  test("serializeAgentDecisionLogEntry has the documented signature", () => {
    expectTypeOf(serializeAgentDecisionLogEntry).toEqualTypeOf<
      (entry: M3LAgentDecisionLogEntry) => string
    >();
  });
});
