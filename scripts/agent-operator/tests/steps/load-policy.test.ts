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
    const secretLookingContent = "token=abc123-super-secret { not json";
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

describe("policyFixtures.realAgentPolicy (the committed, deployed policy)", () => {
  // Reads and validates the REAL committed data/input/agent-policy.json
  // unmocked, per .claude/rules/tests.md's "when the subject IS a committed
  // artifact, read the real filesystem unmocked" rule — this proves the
  // policy actually shipped is valid and shaped the way the docs claim, and
  // guards against someone editing it into an invalid or over-granted state.
  it("validates and matches the documented shape: version 1, 17 grants, every grant read-only-annotated, both discipline flags, and all five budget ceilings", async () => {
    const policy = await realAgentPolicy();

    expect(policy.version).toBe(1);
    expect(policy.scripts).toHaveLength(17);
    for (const grant of policy.scripts) {
      expect(grant.readOnlyOperations).toBeDefined();
      expect(grant.readOnlyOperations?.length).toBeGreaterThan(0);
    }
    expect(policy.requireDecisionLog).toBe(true);
    expect(policy.dryRunFirst).toBe(true);
    expect(policy.budgets).toEqual({
      invocationsPerRun: expect.any(Number) as number,
      invocationsPerDay: expect.any(Number) as number,
      tokensPerRun: expect.any(Number) as number,
      costPerRun: expect.any(Number) as number,
      loopIterations: expect.any(Number) as number,
    });
  });
});

describe("policyFixtures.castPolicy (validator-is-the-only-door guarantee)", () => {
  it("is rejected by evaluateAgentAction's step 0 even though it type-checks as M3LAgentPolicy", () => {
    expect(() =>
      Core.evaluateAgentAction({
        policy: castPolicy(),
        action: { script: "agent-operator", kind: "read-only" },
      }),
    ).toThrowError(Core.M3LAgentActionValidationError);
  });
});
