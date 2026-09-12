/**
 * `tests/support/policyFixtures` — real, validator-produced
 * `Core.M3LAgentPolicy` fixtures for `agent-operator`'s step tests.
 *
 * Every fixture (other than {@link castPolicy}, which exists to prove the
 * opposite) is built by calling `Core.validateAgentPolicy` on a plain
 * declaration — never by casting a literal to `Core.M3LAgentPolicy`. The
 * validator is the only door: it records the exact frozen object it returns
 * in a module-private `WeakSet`, and step 0 of `Core.evaluateAgentAction`
 * rejects any policy object that is not a member, throwing
 * `Core.M3LAgentActionValidationError` — even though the brand itself is
 * erased at compile time and a cast type-checks fine. See
 * `tests/steps/load-policy.test.ts` for the assertion that exercises this.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Core } from "@m3l-automation/m3l-common";

/**
 * Absolute path to the committed, realistic policy fixture. Resolved from
 * `import.meta.url`, never `process.cwd()`, so it is stable regardless of
 * where `vitest` is invoked from.
 */
const REAL_POLICY_PATH = fileURLToPath(
  new URL("../../../../data/input/agent-policy.json", import.meta.url),
);

/**
 * Reads and validates the committed `data/input/agent-policy.json` — the
 * real deployed 17-script policy, not a synthetic stand-in. Read fresh (not
 * memoized) on every call so no test can accidentally share mutable state
 * through the return value.
 */
export async function realAgentPolicy(): Promise<Core.M3LAgentPolicy> {
  return Core.validateAgentPolicy(await realAgentPolicyDeclaration());
}

/**
 * The committed `data/input/agent-policy.json` as a raw, unvalidated
 * declaration — for a test that must write the real deployed policy into its
 * own temp input directory and let the step under test load and validate it
 * (`realAgentPolicy` returns an already-validated policy, which cannot be
 * handed to a file-reading step).
 */
export async function realAgentPolicyDeclaration(): Promise<unknown> {
  const text = await readFile(REAL_POLICY_PATH, "utf8");
  return JSON.parse(text) as unknown;
}

/** A minimal valid declaration: one script, one named-operation grant, nothing optional. */
export function minimalPolicyDeclaration(): unknown {
  return {
    version: 1,
    scripts: [{ script: "agent-operator", operations: ["explain-policy"] }],
  };
}

/** {@link minimalPolicyDeclaration}, run through the real validator. */
export function minimalPolicy(): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy(minimalPolicyDeclaration());
}

/** A declaration that populates every optional top-level field, for renderer tests. */
export function fullPolicyDeclaration(): unknown {
  return {
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        operations: ["explain-policy", "health-check"],
        readOnlyOperations: ["explain-policy", "health-check"],
      },
      { script: "s3-objects", allOperations: true },
    ],
    sensitiveTargets: { profiles: ["prod"] },
    budgets: {
      invocationsPerRun: 10,
      invocationsPerDay: 50,
      tokensPerRun: 1000,
      costPerRun: 1.5,
      loopIterations: 8,
    },
    dryRunFirst: true,
    requireDecisionLog: true,
  };
}

/** {@link fullPolicyDeclaration}, run through the real validator. */
export function fullPolicy(): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy(fullPolicyDeclaration());
}

/**
 * A cast, non-validator-produced "policy" — the forgery `Core.evaluateAgentAction`
 * must reject at step 0. **Never treat this as a real fixture**; it exists
 * solely to prove the validator is the only door (ADR-0060).
 */
export function castPolicy(): Core.M3LAgentPolicy {
  return {
    version: 1,
    scripts: [{ script: "agent-operator", allOperations: true }],
  } as unknown as Core.M3LAgentPolicy;
}

/**
 * Declaration variants `Core.validateAgentPolicy` must reject, each paired
 * with a human-readable label for `test.each`. Used to prove
 * `loadAgentPolicy` wraps the *real* validator's failure as `cause`, never a
 * home-grown substitute.
 */
export function invalidPolicyDeclarations(): ReadonlyArray<
  readonly [label: string, declaration: unknown]
> {
  return [
    [
      "a grant with neither operations nor allOperations",
      { version: 1, scripts: [{ script: "agent-operator" }] },
    ],
    [
      "a grant with both operations and allOperations",
      {
        version: 1,
        scripts: [
          {
            script: "agent-operator",
            operations: ["explain-policy"],
            allOperations: true,
          },
        ],
      },
    ],
    [
      "an empty budgets object",
      {
        version: 1,
        scripts: [{ script: "agent-operator", allOperations: true }],
        budgets: {},
      },
    ],
    [
      "a budget ceiling of 0",
      {
        version: 1,
        scripts: [{ script: "agent-operator", allOperations: true }],
        budgets: { invocationsPerRun: 0 },
      },
    ],
    [
      "a duplicate script grant",
      {
        version: 1,
        scripts: [
          { script: "agent-operator", allOperations: true },
          { script: "agent-operator", operations: ["explain-policy"] },
        ],
      },
    ],
    [
      "more than M3L_AGENT_MAX_SCRIPT_GRANTS grants",
      {
        version: 1,
        scripts: Array.from(
          { length: Core.M3L_AGENT_MAX_SCRIPT_GRANTS + 1 },
          (_unused, index) => ({
            script: `script-${String(index)}`,
            allOperations: true,
          }),
        ),
      },
    ],
  ];
}

/**
 * A declaration that requires the decision log but declares **no budgets**.
 *
 * The distinction matters: `evaluateAgentAction` runs budgets (step 3)
 * *before* the decision-log-unavailable escalation (step 3b) and every arm is
 * terminal, so a policy that declares any budget the caller cannot observe
 * escalates on that budget's `.unobservable` id and step 3b is never reached.
 * The `decision-log-unavailable*` rules are therefore only observable from a
 * budget-free policy — which is what this fixture is for.
 */
export function decisionLogPolicyDeclaration(): unknown {
  return {
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        operations: ["health-check", "explain-policy"],
        readOnlyOperations: ["health-check", "explain-policy"],
      },
    ],
    requireDecisionLog: true,
  };
}

/** {@link decisionLogPolicyDeclaration}, run through the real validator. */
export function decisionLogPolicy(): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy(decisionLogPolicyDeclaration());
}

/**
 * {@link decisionLogPolicyDeclaration} plus exactly the supplied `budgets`, so
 * a test can pin which budget ceiling the evaluator reports first without
 * every other ceiling in `data/input/agent-policy.json` masking it.
 */
export function budgetPolicy(
  budgets: Readonly<Record<string, number>>,
): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy(budgetPolicyDeclaration(budgets));
}

/**
 * {@link budgetPolicy}'s declaration, unvalidated — for a test that must write
 * a budget-declaring policy into its own temp input directory and let
 * `loadAgentPolicy` read and validate it. `budgetPolicy` returns an
 * already-validated policy, which cannot be handed to a file-reading step.
 */
export function budgetPolicyDeclaration(
  budgets: Readonly<Record<string, number>>,
): unknown {
  return {
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        operations: ["health-check", "explain-policy"],
        readOnlyOperations: ["health-check", "explain-policy"],
      },
    ],
    requireDecisionLog: true,
    budgets,
  };
}
