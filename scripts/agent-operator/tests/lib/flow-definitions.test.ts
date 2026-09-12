/**
 * Tests for `lib/flow-definitions` — the verification seam that turns an
 * operator-declared `flowAllowlist` (a bare `ReadonlySet<string>` of flow
 * names, unlike `triage-presets`' `name -> path` map) into a
 * `VerifiedFlowNames` brand plus the single `gradedProfile` every step
 * agrees on.
 *
 * Written RED, before `src/lib/flow-definitions.ts` exists. Mirrors
 * `tests/lib/triage-presets.test.ts`'s idiom throughout: an async
 * `captureRejected` helper, fixed `M3LAgentOperatorCliError` code assertions
 * rather than message text, a per-path fixture table for the injected
 * `readProvider`, and a dedicated never-echo-a-value test built on a
 * distinctive sentinel.
 *
 * A flow definition's raw content — per the contract — is a top-level
 * `steps` array; each step carries a `script` and a `parameters` record,
 * and `yes` / `yesSensitive` / `aws.profile` all live inside `parameters`.
 *
 * DIVERGENCE NOTE (containment escape, refusal #3): `triage-presets`'
 * containment check is reachable because its allowlist VALUE is an
 * arbitrary, unvalidated relative path. `flowAllowlist` here is a bare set
 * of NAMES, and check order runs the brand check (`assertAllowedFlowName`,
 * whose `AGENT_OPERATOR_FLOW_NAME_RE` forbids every `.`/`/` character)
 * *before* the containment/extension check — so by the time containment
 * would run, the name can no longer carry a traversal segment or an
 * extension at all. A `.rejects` test asserting an "escape" for a
 * brand-valid name would therefore be unreachable/tautological (the kind of
 * precedent-shaped-but-untriggerable test this suite's own rules forbid).
 * The best-faith equivalent proven below is a mutation-provable PIN on the
 * resolved path: the fixture table only registers the `.yaml` absolute
 * path, so a implementation regression that queried `.yml` (as
 * `triage-presets` accepts but `flow/load.ts`'s `FLOW_EXTENSION` never
 * does) would throw "no fixture registered" and fail this test loudly.
 * Flagged for the hub rather than silently fabricated.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Core } from "@monte3l/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  RECONCILE_GRADED_PROFILE_KEY,
  verifyFlowNames,
} from "../../src/lib/flow-definitions.js";
import type {
  FlowDefinitionReader,
  VerifiedFlowNames,
  VerifiedFlowTarget,
  VerifyFlowNamesDeps,
} from "../../src/lib/flow-definitions.js";
import { realAgentPolicy } from "../support/policyFixtures.js";

/** One step of a flow definition fixture: `script` plus its raw `parameters`. */
interface FlowStepFixture {
  readonly script: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A canned per-path flow definition fixture: its raw `steps` array. */
interface FlowDefinitionFixture {
  readonly steps: readonly FlowStepFixture[];
}

/** The provider a caller-supplied `readProvider` returns for one path. */
interface StubProvider {
  rawKeys(): readonly string[];
  getRawValue(key: string): unknown;
}

const WORKSPACE_ROOT = "/workspace/m3l-automation";

/** One otherwise-valid step: a script that declares `aws.profile`, set to `"prod"`, plus `yes: true`. */
function validStep(overrides: Partial<FlowStepFixture> = {}): FlowStepFixture {
  return {
    script: "sqs-etl",
    parameters: { "aws.profile": "prod", yes: true },
    ...overrides,
  };
}

/** A minimal, otherwise-valid flow definition: one valid step. */
function validDefinition(
  steps: readonly FlowStepFixture[] = [validStep()],
): FlowDefinitionFixture {
  return { steps };
}

/** The absolute path `verifyFlowNames` is expected to resolve a flow name to. */
function flowPath(name: string): string {
  return join(WORKSPACE_ROOT, "data", "config", "flows", `${name}.yaml`);
}

/**
 * Builds a `readProvider` stub from a table keyed by the EXACT absolute path
 * `verifyFlowNames` is expected to resolve and hand to it. A path requested
 * that has no fixture throws loudly rather than silently defaulting, so a
 * wrong-resolution bug (including a wrong-extension lookup) surfaces as a
 * test failure here rather than a confusing pass downstream.
 */
function makeReadProvider(
  fixturesByAbsolutePath: ReadonlyMap<string, FlowDefinitionFixture>,
): (absolutePath: string) => StubProvider {
  return (absolutePath: string): StubProvider => {
    const fixture = fixturesByAbsolutePath.get(absolutePath);
    if (fixture === undefined) {
      throw new Error(`no fixture registered for path: ${absolutePath}`);
    }
    return {
      rawKeys: () => ["steps"],
      getRawValue: (key: string) =>
        key === "steps" ? fixture.steps : undefined,
    };
  };
}

/** Builds a `declaredParameters` stub from a `scriptName -> parameter names` table; an unlisted script declares nothing. */
function declaredParamsFor(
  table: Readonly<Record<string, readonly string[]>>,
): (scriptName: string) => Promise<readonly string[]> {
  return (scriptName: string) => Promise.resolve(table[scriptName] ?? []);
}

/**
 * Builds a real, validator-produced `Core.M3LAgentPolicy` granting exactly
 * the `run` verb to each named script — one grant per name, via
 * `operations: ["run"]` (never `allOperations`, so refusal 7's own
 * `allOperations` wildcard arm is exercised only by the tests that name it
 * explicitly). Used to satisfy refusal 7 in every fixture that predates it,
 * so those cases keep passing for the reason they always did rather than
 * because the new refusal happens not to fire.
 */
function policyGrantingRun(...scripts: readonly string[]): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: scripts.map((script) => ({ script, operations: ["run"] })),
  });
}

/** Captures the thrown value from an async thunk, or `undefined` when it resolves. */
async function captureRejected(
  thunk: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await thunk();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("verifyFlowNames — empty allowlist (refusal 1)", () => {
  it("throws ERR_AGENT_OPERATOR_FLOW when flowAllowlist has no entries", async () => {
    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set(),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map()),
        declaredParameters: declaredParamsFor({}),
        policy: policyGrantingRun("sqs-etl"),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });
});

describe("verifyFlowNames — a name failing the brand (refusal 2)", () => {
  it.each([
    [
      "a flag-shaped name that assertAllowedFlowName's regex refuses",
      "--dry-run",
    ],
    ["a traversal-shaped name", "../escape"],
  ])(
    "throws ERR_AGENT_OPERATOR_FLOW for %s (%s), never reading a definition",
    async (_label, name) => {
      const readProvider = vi.fn((): StubProvider => ({
        rawKeys: () => ["steps"],
        getRawValue: () => validDefinition().steps,
      }));

      const thrown = await captureRejected(() =>
        verifyFlowNames({
          flowAllowlist: new Set([name]),
          workspaceRoot: WORKSPACE_ROOT,
          readProvider,
          declaredParameters: declaredParamsFor({}),
          policy: policyGrantingRun("sqs-etl"),
        }),
      );

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_FLOW",
      );
      expect(readProvider).not.toHaveBeenCalled();
    },
  );
});

describe("verifyFlowNames — containment / extension is pinned to .yaml (refusal 3)", () => {
  // See the module-level DIVERGENCE NOTE: a true "escape" input is
  // unreachable once refusal 2's brand regex has already run, so this proves
  // the positive contract instead — resolution stays inside
  // <workspaceRoot>/data/config/flows and always ends .yaml, never .yml
  // (unlike triage-presets, which accepts .yml). The fixture table below
  // registers ONLY the .yaml path, so a regression that queried the wrong
  // extension or escaped the flows directory would throw "no fixture
  // registered" and fail this test.
  it("resolves a valid flow name to <workspaceRoot>/data/config/flows/<name>.yaml, never .yml", async () => {
    const name = "dlq-reconcile";
    const readProvider = vi.fn(
      makeReadProvider(new Map([[flowPath(name), validDefinition()]])),
    );

    const verified = await verifyFlowNames({
      flowAllowlist: new Set([name]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider,
      declaredParameters: declaredParamsFor({ "sqs-etl": ["aws.profile"] }),
      policy: policyGrantingRun("sqs-etl"),
    });

    expect(verified.flows.has(name)).toBe(true);
    expect(readProvider).toHaveBeenCalledWith(flowPath(name));
  });
});

describe("verifyFlowNames — yesSensitive vs yes (refusal 4)", () => {
  it("throws ERR_AGENT_OPERATOR_FLOW when a step declares yesSensitive", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({
        parameters: { "aws.profile": "prod", yesSensitive: true },
      }),
    ]);

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({ "sqs-etl": ["aws.profile"] }),
        policy: policyGrantingRun("sqs-etl"),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });

  // The documented asymmetry: `yes` must be ALLOWED, or every destructive
  // step fails under the agent's ignored stdin — only `yesSensitive` (the
  // escalated typed-echo bypass) is refused.
  it("accepts a step declaring yes: true", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ parameters: { "aws.profile": "prod", yes: true } }),
    ]);

    const verified = await verifyFlowNames({
      flowAllowlist: new Set([name]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
      declaredParameters: declaredParamsFor({ "sqs-etl": ["aws.profile"] }),
      policy: policyGrantingRun("sqs-etl"),
    });

    expect(verified.flows.has(name)).toBe(true);
    expect(verified.gradedProfile).toBe("prod");
  });
});

describe("verifyFlowNames — declared aws.profile agreement (refusal 5)", () => {
  it("throws ERR_AGENT_OPERATOR_FLOW when two steps declare divergent aws.profile values", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "dev" } }),
    ]);

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({}),
        policy: policyGrantingRun("sqs-etl"),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });

  it("throws ERR_AGENT_OPERATOR_FLOW when zero steps declare aws.profile anywhere", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "json-etl", parameters: {} }),
    ]);

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({ "json-etl": [] }),
        policy: policyGrantingRun("json-etl"),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });
});

describe("verifyFlowNames — a step omitting a script-declared aws.profile (refusal 6)", () => {
  it("throws ERR_AGENT_OPERATOR_FLOW when a step omits aws.profile and its script declares that parameter", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
      validStep({ script: "sqs-etl", parameters: {} }),
    ]);

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({
          "sqs-etl": ["aws.profile", "queueUrl", "dlqUrl"],
        }),
        policy: policyGrantingRun("sqs-etl"),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });

  // The json-etl-shaped complement: without this case the rule would
  // over-refuse every real flow whose step's script simply has no
  // aws.profile parameter to declare in the first place.
  it("accepts a step omitting aws.profile whose script does not declare that parameter", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
      validStep({ script: "json-etl", parameters: {} }),
    ]);

    const verified = await verifyFlowNames({
      flowAllowlist: new Set([name]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
      declaredParameters: declaredParamsFor({
        "sqs-etl": ["aws.profile"],
        "json-etl": ["input", "output"],
      }),
      policy: policyGrantingRun("sqs-etl", "json-etl"),
    });

    expect(verified.flows.has(name)).toBe(true);
    expect(verified.gradedProfile).toBe("prod");
  });
});

describe("verifyFlowNames — step script must hold its own run grant (refusal 7)", () => {
  it("throws ERR_AGENT_OPERATOR_FLOW when the step's script has a grant that omits run", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
    ]);
    const policy = Core.validateAgentPolicy({
      version: 1,
      scripts: [{ script: "sqs-etl", operations: ["inspect", "dry-run"] }],
    });

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({}),
        policy,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });

  it("throws ERR_AGENT_OPERATOR_FLOW when the step's script has no grant at all", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
    ]);
    // A non-empty `scripts` array naming an UNRELATED script only —
    // `validateAgentPolicy` rejects an empty `scripts` list outright, so a
    // "no grant anywhere" fixture must still declare something else.
    const policy = Core.validateAgentPolicy({
      version: 1,
      scripts: [{ script: "json-etl", operations: ["run"] }],
    });

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({}),
        policy,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });

  // Per-script, not "any script qualifies": one of the two step scripts
  // below IS granted run, and the definition must still be refused because
  // the OTHER one is not.
  it("throws ERR_AGENT_OPERATOR_FLOW when only one of two step scripts lacks a run grant", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
      validStep({ script: "json-etl", parameters: { "aws.profile": "prod" } }),
    ]);
    const policy = Core.validateAgentPolicy({
      version: 1,
      scripts: [
        { script: "sqs-etl", operations: ["run"] },
        { script: "json-etl", operations: ["inspect"] },
      ],
    });

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({}),
        policy,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_FLOW",
    );
  });

  // The complement of the three refusal cases above: without this, the rule
  // could be over-refusing (e.g. requiring `allOperations` outright) and
  // nothing here would notice.
  it("accepts a definition whose every step script is granted run", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
      validStep({ script: "json-etl", parameters: { "aws.profile": "prod" } }),
    ]);
    const policy = policyGrantingRun("sqs-etl", "json-etl");

    const verified = await verifyFlowNames({
      flowAllowlist: new Set([name]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
      declaredParameters: declaredParamsFor({}),
      policy,
    });

    expect(verified.flows.has(name)).toBe(true);
    expect(verified.gradedProfile).toBe("prod");
  });

  // src/lib/flow-definitions.ts's own remarks on refusal 7 state that
  // `allOperations: true` DOES satisfy the check (a deliberate,
  // script-scoped whole-script opt-in, unlike the parent `m3l`/`run` grant
  // this refusal exists to stop from acting as an accidental wildcard).
  // Proven against the real behaviour, not assumed.
  it("accepts a step script granted via allOperations: true", async () => {
    const name = "dlq-reconcile";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
    ]);
    const policy = Core.validateAgentPolicy({
      version: 1,
      scripts: [{ script: "sqs-etl", allOperations: true }],
    });

    const verified = await verifyFlowNames({
      flowAllowlist: new Set([name]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
      declaredParameters: declaredParamsFor({}),
      policy,
    });

    expect(verified.flows.has(name)).toBe(true);
    expect(verified.gradedProfile).toBe("prod");
  });
});

describe("verifyFlowNames — the committed dlq-reconcile flow never exceeds the committed policy's run grants (integration)", () => {
  // Ties the two shipped artifacts together: if a future edit to
  // `data/input/agent-policy.json` ever revoked a step script's `run` grant
  // (or a future edit to `data/config/flows/dlq-reconcile.yaml` named a
  // script the policy does not grant `run` to), refusal 7 would make the
  // shipped flow unrunnable, and this is the test that would catch it —
  // rather than that surfacing only at real `m3l flow run` time.
  it("verifies dlq-reconcile against the real, committed agent-policy.json", async () => {
    const workspaceRoot = fileURLToPath(
      new URL("../../../../", import.meta.url),
    );
    const policy = await realAgentPolicy();

    const verified = await verifyFlowNames({
      flowAllowlist: new Set(["dlq-reconcile"]),
      workspaceRoot,
      readProvider: (absolutePath: string) =>
        new Core.M3LYAMLConfigProvider(absolutePath),
      declaredParameters: () => Promise.resolve([]),
      policy,
    });

    expect(verified.flows.has("dlq-reconcile")).toBe(true);
  });
});

describe("verifyFlowNames — multi-entry success path", () => {
  it("resolves a VerifiedFlowTarget containing every allowlisted name and the single gradedProfile", async () => {
    const names = ["sqs-roundtrip", "dlq-reconcile"] as const;
    const definitionsByPath = new Map<string, FlowDefinitionFixture>(
      names.map((name) => [
        flowPath(name),
        validDefinition([
          validStep({ parameters: { "aws.profile": "prod", yes: true } }),
          validStep({ parameters: { "aws.profile": "prod" } }),
        ]),
      ]),
    );

    const verified: VerifiedFlowTarget = await verifyFlowNames({
      flowAllowlist: new Set(names),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(definitionsByPath),
      declaredParameters: declaredParamsFor({ "sqs-etl": ["aws.profile"] }),
      policy: policyGrantingRun("sqs-etl"),
    });

    for (const name of names) {
      expect(verified.flows.has(name)).toBe(true);
    }
    expect(verified.flows.size).toBe(names.length);
    expect(verified.gradedProfile).toBe("prod");
  });

  it("returns a defensive copy: mutating the input flowAllowlist afterwards does not change the returned flows", async () => {
    const name = "dlq-reconcile";
    const flowAllowlist = new Set([name]);

    const verified = await verifyFlowNames({
      flowAllowlist,
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(
        new Map([[flowPath(name), validDefinition()]]),
      ),
      declaredParameters: declaredParamsFor({ "sqs-etl": ["aws.profile"] }),
      policy: policyGrantingRun("sqs-etl"),
    });

    // Never checked by `verifyFlowNames` — mutated on the caller's own
    // handle after the brand was already minted.
    flowAllowlist.add("unverified-injected");

    expect(verified.flows.has("unverified-injected")).toBe(false);
    expect(verified.flows.size).toBe(1);
  });
});

describe("verifyFlowNames — never echoes a rejected VALUE", () => {
  it("does not contain the sentinel profile value anywhere in the thrown message or context", async () => {
    const name = "dlq-reconcile";
    const sentinel = "SENTINEL-LEAK-VALUE";
    const definition = validDefinition([
      validStep({ script: "sqs-etl", parameters: { "aws.profile": "prod" } }),
      validStep({ script: "sqs-etl", parameters: { "aws.profile": sentinel } }),
    ]);

    const thrown = await captureRejected(() =>
      verifyFlowNames({
        flowAllowlist: new Set([name]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map([[flowPath(name), definition]])),
        declaredParameters: declaredParamsFor({}),
        policy: policyGrantingRun("sqs-etl"),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain(sentinel);
    expect(JSON.stringify(error.context ?? {})).not.toContain(sentinel);
  });
});

describe("verifyFlowNames — RECONCILE_GRADED_PROFILE_KEY", () => {
  it('is the literal "aws.profile"', () => {
    expect(RECONCILE_GRADED_PROFILE_KEY).toBe("aws.profile");
  });
});

describe("verifyFlowNames — VerifiedFlowNames brand", () => {
  it("is not assignable from a plain ReadonlySet<string>", () => {
    expectTypeOf<ReadonlySet<string>>().not.toExtend<VerifiedFlowNames>();
  });

  it("verifyFlowNames's return type unwraps to VerifiedFlowTarget", () => {
    expectTypeOf(verifyFlowNames).returns.toEqualTypeOf<
      Promise<VerifiedFlowTarget>
    >();
  });
});

describe("verifyFlowNames — exported deps/reader types", () => {
  it("VerifyFlowNamesDeps and FlowDefinitionReader are importable by name and usable to type a caller's own implementation", () => {
    const reader: FlowDefinitionReader = {
      rawKeys: () => ["steps"],
      getRawValue: (key: string) =>
        key === "steps" ? validDefinition().steps : undefined,
    };

    const deps: VerifyFlowNamesDeps = {
      flowAllowlist: new Set(["dlq-reconcile"]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: () => reader,
      declaredParameters: declaredParamsFor({ "sqs-etl": ["aws.profile"] }),
      policy: policyGrantingRun("sqs-etl"),
    };

    expect(deps.flowAllowlist.size).toBe(1);
    expect(deps.readProvider("/any/path").rawKeys()).toEqual(["steps"]);
  });
});
