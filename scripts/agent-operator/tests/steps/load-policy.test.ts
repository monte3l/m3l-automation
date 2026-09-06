/**
 * Tests for `steps/load-policy` — loading and validating `agent-operator`'s
 * deployment policy file (PR 1, ADR-0060).
 *
 * `loadAgentPolicy({ paths, policyFile })` reads `policyFile` through
 * `new Core.M3LInputFileReader({ paths, code: "ERR_AGENT_OPERATOR_POLICY" })`'s
 * `readJSONRecord` (so `asRecord` screens `__proto__`/`constructor`/
 * `prototype` before the declaration ever reaches the validator), then calls
 * `Core.validateAgentPolicy`. On any failure it throws
 * `M3LAgentOperatorCliError` coded `ERR_AGENT_OPERATOR_POLICY`, chaining the
 * original failure as `cause`. There is deliberately NO inline fallback
 * policy: a missing file must be a loud failure, never a silent degradation
 * to a built-in grant.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { loadAgentPolicy } from "../../src/steps/load-policy.js";
import {
  castPolicy,
  invalidPolicyDeclarations,
  realAgentPolicy,
} from "../support/policyFixtures.js";

const POLICY_FILE = "agent-policy.json";

let inputDir: string;

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "agent-operator-policy-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(inputDir, { recursive: true, force: true });
});

function makePaths(): Core.M3LPaths {
  vi.stubEnv("M3L_INPUT_DIR", inputDir);
  return new Core.M3LPaths();
}

async function writeFixture(name: string, content: string): Promise<void> {
  await writeFile(path.join(inputDir, name), content, "utf8");
}

describe("loadAgentPolicy", () => {
  it("reads and validates a well-formed policy file, returning the real validator's branded policy", async () => {
    await writeFixture(
      POLICY_FILE,
      JSON.stringify({
        version: 1,
        scripts: [{ script: "agent-operator", operations: ["explain-policy"] }],
      }),
    );

    const policy = await loadAgentPolicy({
      paths: makePaths(),
      policyFile: POLICY_FILE,
    });

    expect(policy.scripts).toEqual([
      { script: "agent-operator", operations: ["explain-policy"] },
    ]);

    // Proves the returned value is the REAL branded output of
    // validateAgentPolicy, not a look-alike object: evaluateAgentAction's
    // step 0 rejects anything not recorded by the validator's own WeakSet.
    const decision = Core.evaluateAgentAction({
      policy,
      action: {
        script: "agent-operator",
        operation: "explain-policy",
        kind: "read-only",
      },
    });
    expect(decision.verdict).toBe("auto-approved");
  });

  it("throws ERR_AGENT_OPERATOR_POLICY when the policy file is missing, with no inline fallback", async () => {
    // No file written at all. A fallback policy would make this resolve
    // instead of reject — the assertion below is exactly what "no inline
    // fallback" means operationally.
    let thrown: unknown;
    try {
      await loadAgentPolicy({
        paths: makePaths(),
        policyFile: "does-not-exist.json",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_POLICY",
    );
  });

  it("throws ERR_AGENT_OPERATOR_POLICY on malformed JSON, leaking no snippet of the file's content", async () => {
    // gitleaks scans source literals, not runtime values. Assembling the
    // planted marker at runtime keeps the fixture byte-identical to the
    // `token=<credential>` shape this test needs, without committing a single
    // source literal that reads as a real credential
    // (`diagnostics-run-report.test.ts:144-148` is the established pattern).
    const sensitiveKey = "to" + "ken";
    const fakeCredential = ["abc123", "super", "secret"].join("-");
    const secretLookingContent = `${sensitiveKey}=${fakeCredential} { not json`;
    await writeFixture(POLICY_FILE, secretLookingContent);

    let thrown: unknown;
    try {
      await loadAgentPolicy({ paths: makePaths(), policyFile: POLICY_FILE });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_POLICY");
    // F10/W5: JSON.parse's own SyntaxError.message embeds a ~10-character
    // snippet of the malformed content — neither the thrown message nor a
    // chained cause's message may repeat any fragment of it.
    expect(asError.message).not.toContain("abc123");
    expect(asError.message).not.toContain("token=");
    const causeMessage =
      asError.cause instanceof Error ? asError.cause.message : "";
    expect(causeMessage).not.toContain("abc123");
  });

  it("throws ERR_AGENT_OPERATOR_POLICY with the validator's own error chained as cause, for a structurally invalid policy", async () => {
    await writeFixture(
      POLICY_FILE,
      JSON.stringify({ version: 2, scripts: [] }),
    );

    let thrown: unknown;
    try {
      await loadAgentPolicy({ paths: makePaths(), policyFile: POLICY_FILE });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_POLICY",
    );
    expect((thrown as M3LAgentOperatorCliError).cause).toBeInstanceOf(
      Core.M3LAgentPolicyDeclarationError,
    );
  });

  it.each(invalidPolicyDeclarations())(
    "throws ERR_AGENT_OPERATOR_POLICY for %s",
    async (_label, declaration) => {
      await writeFixture(POLICY_FILE, JSON.stringify(declaration));

      let thrown: unknown;
      try {
        await loadAgentPolicy({ paths: makePaths(), policyFile: POLICY_FILE });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_POLICY",
      );
    },
  );

  it("throws ERR_AGENT_OPERATOR_POLICY for a __proto__ payload, and prototype pollution never occurs", async () => {
    await writeFixture(
      POLICY_FILE,
      JSON.stringify({ __proto__: { polluted: true } }),
    );

    let thrown: unknown;
    try {
      await loadAgentPolicy({ paths: makePaths(), policyFile: POLICY_FILE });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_POLICY",
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("the committed data/input/agent-policy.json (realAgentPolicy)", () => {
  it("validates and holds the shape the docs claim: 17 grants, both discipline flags, every budget ceiling, and a non-empty readOnlyOperations per grant", async () => {
    // Guards against someone hand-editing the committed policy into an
    // invalid or over-granted state without exercising the real deployed
    // file through the real validator (not a synthetic stand-in).
    const policy = await realAgentPolicy();

    expect(policy.version).toBe(1);
    expect(policy.scripts).toHaveLength(17);
    expect(policy.requireDecisionLog).toBe(true);
    expect(policy.dryRunFirst).toBe(true);

    const budgets = policy.budgets;
    expect(budgets).toBeDefined();
    const ceilings: ReadonlyArray<keyof Core.M3LAgentBudgets> = [
      "invocationsPerRun",
      "invocationsPerDay",
      "tokensPerRun",
      "costPerRun",
      "loopIterations",
    ];
    for (const ceiling of ceilings) {
      expect(typeof budgets?.[ceiling]).toBe("number");
    }

    for (const grant of policy.scripts) {
      expect(grant.readOnlyOperations).toBeDefined();
      expect(grant.readOnlyOperations?.length).toBeGreaterThan(0);
    }
  });

  /**
   * A healthy, well-under-ceiling run observation. Every budget field is
   * populated so no ceiling reads as unobservable (trap B in the dispatch
   * brief): an absent `run` — or one missing a single field the deployed
   * policy declares a ceiling for — makes the evaluator report
   * `budget.*.unobservable` instead of the rule under test, masking every
   * case below behind the wrong rule id. `dryRunCompletedShapes` is the only
   * field callers vary per case.
   */
  function healthyRunLedger(
    dryRunCompletedShapes: readonly string[] = [],
  ): Core.M3LAgentRunLedger {
    const now = Date.now();
    return {
      invocationsThisRun: 1,
      invocationsToday: 1,
      todayCountedAt: now,
      now,
      tokensThisRun: 100,
      costThisRun: 0.01,
      loopIterations: 1,
      decisionLogAvailable: true,
      dryRunCompletedShapes,
    };
  }

  it("case 1: agent-operator run-preset (read-only) is auto-approved via read-only-auto-approved", async () => {
    const policy = await realAgentPolicy();

    const decision = Core.evaluateAgentAction({
      policy,
      action: {
        script: "agent-operator",
        operation: "run-preset",
        kind: "read-only",
        parameterNames: [
          "command",
          "policyFile",
          "decisionLogDir",
          "agentName",
          "modelId",
        ],
      },
      run: healthyRunLedger(),
    });

    expect(decision.verdict).toBe("auto-approved");
    expect(decision.rule).toBe("read-only-auto-approved");
  });

  it("case 2/3/4/5/6: json-etl run's mutating two-phase seam and the s3-objects denial", async () => {
    const policy = await realAgentPolicy();

    // Phase 1 (dry run, sandbox): auto-approved as a graded mutation.
    const phase1Sandbox = Core.evaluateAgentAction({
      policy,
      action: {
        script: "json-etl",
        operation: "run",
        kind: "mutating",
        target: { profile: "sandbox" },
        parameterNames: ["presetName"],
        dryRun: true,
      },
      run: healthyRunLedger(),
    });
    expect(phase1Sandbox.verdict).toBe("auto-approved");
    expect(phase1Sandbox.rule).toBe("graded-mutation-auto-approved");
    const sandboxShapeKey = phase1Sandbox.action.shapeKey;

    // Case 3: phase 2, same shape, but no dry run of it has completed in
    // this run yet (an empty ledger). This is the entire point of the
    // two-phase seam ADR-0060 slice 2 introduces: the real (non-dry-run)
    // action is refused until a dry run of the SAME shape has completed in
    // the SAME run — proving the seam actually gates, not just that a dry
    // run happens to be auto-approved on its own.
    const phase2NoRecordedShape = Core.evaluateAgentAction({
      policy,
      action: {
        script: "json-etl",
        operation: "run",
        kind: "mutating",
        target: { profile: "sandbox" },
        parameterNames: ["presetName"],
      },
      run: healthyRunLedger(),
    });
    expect(phase2NoRecordedShape.verdict).toBe("escalate");
    expect(phase2NoRecordedShape.rule).toBe("dry-run-first");

    // Case 4: phase 2, same shape, WITH phase 1's shape key recorded as
    // completed — now auto-approved.
    const phase2WithRecordedShape = Core.evaluateAgentAction({
      policy,
      action: {
        script: "json-etl",
        operation: "run",
        kind: "mutating",
        target: { profile: "sandbox" },
        parameterNames: ["presetName"],
      },
      run: healthyRunLedger([sandboxShapeKey]),
    });
    expect(phase2WithRecordedShape.verdict).toBe("auto-approved");
    expect(phase2WithRecordedShape.rule).toBe("graded-mutation-auto-approved");

    // Case 5: a prod target, with a dry run of the identical shape already
    // recorded (dry-run-first is satisfied), must still escalate.
    //
    // Correction against the dispatch brief: the brief asserted "the prod
    // phase-1 shape key differs from the sandbox one — reusing the sandbox
    // key would make this pass for the wrong reason." That is not what the
    // source does: `computeAgentActionShapeKey`
    // (packages/m3l-common/src/internal/agent/shape.ts) hashes only
    // `script`, `operation`, `kind`, and `parameterNames` — `target` and
    // `dryRun` are "deliberately excluded" (see that file's own comment) —
    // so the prod and sandbox phase-1 actions here hash to the SAME shape
    // key. Verified directly below rather than trusting the brief's claim.
    // That equality is exactly why this case is still meaningful: it proves
    // `sensitive-target-escalated` (step 5, `decideMutation`) wins over
    // `dry-run-first` (step 6) even when dry-run-first is fully satisfied —
    // matching `decide.ts`'s own documented step ordering (grading sits
    // above dry-run-first so a sensitive target can never be waved through
    // by having been dry-run).
    const phase1Prod = Core.evaluateAgentAction({
      policy,
      action: {
        script: "json-etl",
        operation: "run",
        kind: "mutating",
        target: { profile: "prod" },
        parameterNames: ["presetName"],
        dryRun: true,
      },
      run: healthyRunLedger(),
    });
    const prodShapeKey = phase1Prod.action.shapeKey;
    expect(prodShapeKey).toBe(sandboxShapeKey);

    const phase2Prod = Core.evaluateAgentAction({
      policy,
      action: {
        script: "json-etl",
        operation: "run",
        kind: "mutating",
        target: { profile: "prod" },
        parameterNames: ["presetName"],
      },
      run: healthyRunLedger([prodShapeKey]),
    });
    expect(phase2Prod.verdict).toBe("escalate");
    expect(phase2Prod.rule).toBe("sensitive-target-escalated");

    // Case 6: an ungranted script (s3-objects has no "run" operation grant)
    // is denied outright, regardless of the shape/dry-run state.
    const ungrantedScript = Core.evaluateAgentAction({
      policy,
      action: {
        script: "s3-objects",
        operation: "run",
        kind: "mutating",
        target: { profile: "sandbox" },
        parameterNames: ["presetName"],
      },
      run: healthyRunLedger(),
    });
    expect(ungrantedScript.verdict).toBe("denied");
    expect(ungrantedScript.rule).toBe("operation-not-allowlisted");
  });

  it("case 7: the agent-operator grant lists run-preset in both operations and readOnlyOperations", async () => {
    const policy = await realAgentPolicy();
    const grant = policy.scripts.find((s) => s.script === "agent-operator");
    expect(grant).toBeDefined();
    expect(grant?.operations).toContain("run-preset");
    expect(grant?.readOnlyOperations).toContain("run-preset");
  });

  it("case 8: the json-etl grant lists run in operations but deliberately NOT in readOnlyOperations", async () => {
    const policy = await realAgentPolicy();
    const grant = policy.scripts.find((s) => s.script === "json-etl");
    expect(grant).toBeDefined();
    expect(grant?.operations).toContain("run");
    // Deliberate omission: readOnlyOperations is the cross-check
    // decideReadOnly uses to escalate a mis-declared kind. If "run" were
    // added here too, an agent could declare kind: "read-only" for a
    // mutating operation and have the cross-check wave it through instead
    // of escalating it — defeating the entire cross-check.
    expect(grant?.readOnlyOperations).not.toContain("run");
  });
});

describe("policyFixtures.castPolicy (validator-is-the-only-door guarantee)", () => {
  it("is rejected by evaluateAgentAction's step 0 even though it type-checks as M3LAgentPolicy", () => {
    expect(() =>
      Core.evaluateAgentAction({
        policy: castPolicy(),
        action: { script: "agent-operator", kind: "read-only" },
      }),
    ).toThrow(Core.M3LAgentActionValidationError);
  });
});
