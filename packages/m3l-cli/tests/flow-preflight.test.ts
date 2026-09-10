/**
 * Tests for src/flow/preflight.ts — the pre-flight PARAMETER-RESOLUTION check
 * `m3l flow run` runs once, before step 1 executes (issue #883).
 *
 * `flow/validate.ts` checks the SHAPE of a flow definition and is fail-CLOSED
 * (any ambiguity is rejected). This module checks whether a step's target
 * script would actually RECEIVE its required parameters at run time — a step
 * `parameters` value is only one of several places a required value can come
 * from (env, `.env`, `defaultValue` all count too) — and is deliberately the
 * INVERSE posture: fail-OPEN. It refuses a run only for what is PROVABLY
 * unsatisfiable (`report.missing`); anything it cannot see for certain is a
 * warning (`report.unverified`) and the run proceeds. A test asserting
 * something lands in `unverified` rather than `missing` is proving that
 * fail-open behavior on purpose, not documenting a bug.
 *
 * `checkFlowPreflight`/`rejectFlowPreflight` are pure — no mocks, plain
 * object literals for the definition/context. `resolveEnvFileReach` is the
 * module's one filesystem touch and is tested against a real per-test
 * `mkdtemp` sandbox (this repo's test-I/O policy), never mocked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliEnvFileSetting } from "../src/cli/flags.js";
import type {
  M3LCliFlowDefinition,
  M3LCliFlowStep,
} from "../src/flow/types.js";
import {
  checkFlowPreflight,
  rejectFlowPreflight,
  resolveEnvFileReach,
} from "../src/flow/preflight.js";
import type {
  M3LCliFlowPreflightContext,
  M3LCliFlowPreflightMissingParameter,
  M3LCliFlowPreflightMissingStep,
  M3LCliFlowPreflightScriptLocation,
} from "../src/flow/preflight.js";

/**
 * A full `Core.M3LConfigParameterDescriptor` with sensible defaults,
 * overridable per test. Mirrors `flow-validate.test.ts`'s `declared`/`rawStep`
 * helper pattern.
 */
function descriptor(
  overrides: Partial<Core.M3LConfigParameterDescriptor> &
    Pick<Core.M3LConfigParameterDescriptor, "name">,
): Core.M3LConfigParameterDescriptor {
  return {
    aliases: [],
    type: "STRING",
    required: false,
    defaultValue: undefined,
    description: "",
    secret: false,
    operations: [],
    ...overrides,
  };
}

/**
 * A `M3LCliFlowStep` with the module's sensible defaults, overridable per
 * test: `execution: "auto"`, `onSuccess: "continue"`, `onFailure: "stop"`,
 * `onPartial: "stop"`, empty `parameters`.
 */
function step(
  overrides: Partial<M3LCliFlowStep> & Pick<M3LCliFlowStep, "id" | "script">,
): M3LCliFlowStep {
  return {
    parameters: {},
    execution: "auto",
    onSuccess: "continue",
    onFailure: "stop",
    onPartial: "stop",
    ...overrides,
  };
}

/** A `M3LCliFlowDefinition` wrapping `steps`, named `demo` by default. */
function flowDefinition(
  steps: readonly M3LCliFlowStep[],
  overrides: Partial<M3LCliFlowDefinition> = {},
): M3LCliFlowDefinition {
  return {
    name: "demo",
    maxStepExecutions: 50,
    steps,
    ...overrides,
  };
}

/**
 * A base `M3LCliFlowPreflightContext`: empty `env`, empty
 * `envFileReachByScript`, no `startStepId` — each test overrides only what it
 * needs.
 */
function baseContext(
  overrides: Partial<M3LCliFlowPreflightContext> = {},
): M3LCliFlowPreflightContext {
  return {
    parametersByScript: new Map(),
    env: {},
    envFileReachByScript: new Map(),
    ...overrides,
  };
}

/**
 * Calls `rejectFlowPreflight`, typed `void` rather than propagating its real
 * `never` return type — TypeScript's control-flow analysis would otherwise
 * prove the fallback throw in `captureRejectFlowPreflight` below unreachable
 * (it correctly infers the try block can never complete normally when the
 * only statement in it is typed `never`), which defeats the point of that
 * fallback: a genuine defensive check that the real function keeps its
 * promise to always throw.
 */
function callRejectFlowPreflight(
  flowName: string,
  missing: readonly M3LCliFlowPreflightMissingStep[],
): void {
  rejectFlowPreflight(flowName, missing);
}

/**
 * Runs `rejectFlowPreflight` and returns the `M3LCliError` it threw. Fails
 * the test when the call returns normally, and rethrows any non-`M3LCliError`
 * value so a wrong error class is visible rather than swallowed.
 */
function captureRejectFlowPreflight(
  flowName: string,
  missing: readonly M3LCliFlowPreflightMissingStep[],
): M3LCliError {
  try {
    callRejectFlowPreflight(flowName, missing);
  } catch (error) {
    if (error instanceof M3LCliError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    "expected rejectFlowPreflight to throw, but it returned normally",
  );
}

/** Renders one missing parameter exactly as `rejectFlowPreflight` must. */
function renderMissingParameter(
  parameter: M3LCliFlowPreflightMissingParameter,
): string {
  if (parameter.secret) {
    return `${parameter.name} [secret — set ${Core.deriveEnvVarName(parameter.name)} in the environment, ADR-0085]`;
  }
  if (parameter.requiredForOperation !== undefined) {
    return `${parameter.name} [required for operation '${parameter.requiredForOperation}']`;
  }
  return parameter.name;
}

/** Renders the exact aggregated rejection message `rejectFlowPreflight` must produce. */
function expectedPreflightMessage(
  flowName: string,
  missing: readonly M3LCliFlowPreflightMissingStep[],
): string {
  const topLine = `flow '${flowName}' cannot run: ${missing.length} step(s) would not receive a required parameter — no step was executed`;
  const stepLines = missing.map(
    (missingStep) =>
      `  flow step '${missingStep.stepId}' (${missingStep.script}) is missing: ${missingStep.parameters
        .map(renderMissingParameter)
        .join(", ")}`,
  );
  return [topLine, ...stepLines].join("\n");
}

describe("checkFlowPreflight — unconditional required parameters", () => {
  test("reports a required parameter with no value anywhere as missing", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "flag", secret: false }],
      },
    ]);
    expect(report.unverified).toEqual([]);
  });

  test("does not report a non-required parameter with no value anywhere", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: false })]],
      ]),
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });

  test("marks a missing unconditional parameter's secret flag from the descriptor", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [descriptor({ name: "api-token", required: true, secret: true })],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "api-token", secret: true }],
      },
    ]);
  });
});

describe("checkFlowPreflight — declared defaults", () => {
  test("never reports a required parameter carrying a declared default, even with an env-file reach that would otherwise make it unverified", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", execution: "spawn" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [descriptor({ name: "flag", required: true, defaultValue: "x" })],
        ],
      ]),
      // Reach `true` would otherwise route an unsupplied required parameter
      // to `unverified` — proving the default check runs BEFORE the
      // env-file tier is ever consulted, not merely that it runs at all.
      envFileReachByScript: new Map([["s", true]]),
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });
});

describe("checkFlowPreflight — the emission rule (execution-mode-dependent)", () => {
  /** The set of edge values shared by the spawn-like and in-process tables. */
  const SPAWN_LIKE_EMISSION_ROWS: readonly [string, unknown, boolean][] = [
    ["true", true, true],
    ["a non-empty string value", "value", true],
    ["false", false, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["an empty array", [], false],
  ];

  const IN_PROCESS_EMISSION_ROWS: readonly [string, unknown, boolean][] = [
    ["true", true, true],
    ["a non-empty string value", "value", true],
    ["false", false, true],
    ["null", null, true],
    ["undefined", undefined, false],
    ["an empty array", [], true],
  ];

  const SPAWN_LIKE_MODES = ["spawn", "auto"] as const;

  describe.each(SPAWN_LIKE_MODES)(
    "spawn/auto (execution: %s) — false/null/undefined/[] never supply a value",
    (execution) => {
      test.each(SPAWN_LIKE_EMISSION_ROWS)("%s", (_label, value, supplied) => {
        const definition = flowDefinition([
          step({
            id: "one",
            script: "s",
            execution,
            parameters: { flag: value },
          }),
        ]);
        const context = baseContext({
          parametersByScript: new Map([
            ["s", [descriptor({ name: "flag", required: true })]],
          ]),
        });

        const report = checkFlowPreflight(definition, context);

        if (supplied) {
          expect(report.missing).toEqual([]);
          expect(report.unverified).toEqual([]);
        } else {
          expect(report.missing).toEqual([
            {
              stepId: "one",
              script: "s",
              parameters: [{ name: "flag", secret: false }],
            },
          ]);
        }
      });
    },
  );

  describe("in-process — only undefined fails to supply a value", () => {
    test.each(IN_PROCESS_EMISSION_ROWS)("%s", (_label, value, supplied) => {
      const definition = flowDefinition([
        step({
          id: "one",
          script: "s",
          execution: "in-process",
          parameters: { flag: value },
        }),
      ]);
      const context = baseContext({
        parametersByScript: new Map([
          ["s", [descriptor({ name: "flag", required: true })]],
        ]),
      });

      const report = checkFlowPreflight(definition, context);

      if (supplied) {
        expect(report.missing).toEqual([]);
        expect(report.unverified).toEqual([]);
      } else {
        expect(report.missing).toEqual([
          {
            stepId: "one",
            script: "s",
            parameters: [{ name: "flag", secret: false }],
          },
        ]);
      }
    });
  });

  test("an entirely absent key is never supplied, on a name that also collides with an inherited Object.prototype member", () => {
    // A naive `step.parameters["toString"] !== undefined` read (bracket
    // access, no `Object.hasOwn` guard) would resolve the INHERITED
    // `Object.prototype.toString` function and misreport this as supplied.
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: {} }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "toString", required: true })]],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "toString", secret: false }],
      },
    ]);
  });
});

describe("checkFlowPreflight — the environment probe", () => {
  test("a required 'aws.profile' parameter omitted from a step's parameters is satisfied by env AWS_PROFILE — the decisive #883 regression test (dlq-reconcile's documented reliance on ambient AWS_PROFILE)", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "dlq-reconcile" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "dlq-reconcile",
          [descriptor({ name: "aws.profile", required: true })],
        ],
      ]),
      env: { AWS_PROFILE: "prod" },
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });

  test("a required parameter is satisfied via the environment through one of its ALIASES' derived env var name", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "canonical-name",
              aliases: ["alt-name"],
              required: true,
            }),
          ],
        ],
      ]),
      env: { ALT_NAME: "present" },
    });

    expect(checkFlowPreflight(definition, context).missing).toEqual([]);
  });

  test("an empty-string env value still counts as supplied", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "aws.profile", required: true })]],
      ]),
      env: { AWS_PROFILE: "" },
    });

    expect(checkFlowPreflight(definition, context).missing).toEqual([]);
  });

  test("an unrelated env var does not satisfy an unrelated required parameter", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "aws.profile", required: true })]],
      ]),
      env: { SOME_OTHER_VAR: "x" },
    });

    expect(checkFlowPreflight(definition, context).missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "aws.profile", secret: false }],
      },
    ]);
  });
});

describe("checkFlowPreflight — conditional per-operation requirements (ADR-0055)", () => {
  test("a selector with no own value in the step's parameters contributes nothing to the required set and is reported unverified", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
              ],
            }),
            descriptor({ name: "queueUrl", required: false }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    // `command`'s OWN `required: true` is still evaluated normally — it has
    // no value either, so it lands in `missing` on its own account.
    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "command", secret: false }],
      },
    ]);
    // `queueUrl` is NOT required — the conditional set never resolved — so
    // it never appears in `missing`; only the additive unverified warning.
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]).toMatchObject({ stepId: "one", script: "s" });
    expect(report.unverified[0]?.reason).toContain("command");
  });

  test("a non-string selector value contributes nothing and produces no warning, matching the runtime validator's own vacuous guard", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: { command: true } }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
              ],
            }),
            descriptor({ name: "queueUrl", required: false }),
          ],
        ],
      ]),
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });

  test("a string selector value naming no declared operation contributes nothing and produces no warning", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: { command: "bogus" } }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
              ],
            }),
            descriptor({ name: "queueUrl", required: false }),
          ],
        ],
      ]),
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });

  test("a string selector value naming a declared operation makes its requiredParameters required, tagged requiredForOperation", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: { command: "dump" } }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
              ],
            }),
            descriptor({ name: "queueUrl", required: false }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [
          { name: "queueUrl", secret: false, requiredForOperation: "dump" },
        ],
      },
    ]);
    expect(report.unverified).toEqual([]);
  });

  test("a string value naming an operation with multiple requiredParameters requires all of them", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: { command: "drain" } }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
                {
                  name: "drain",
                  description: "",
                  requiredParameters: ["queueUrl", "batchSize"],
                },
              ],
            }),
            descriptor({ name: "queueUrl", required: false }),
            descriptor({ name: "batchSize", required: false }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);
    const names = report.missing[0]?.parameters.map((p) => p.name).toSorted();
    expect(names).toEqual(["batchSize", "queueUrl"]);
  });

  test("two selectors on the same script contribute the UNION of their conditional requirements", () => {
    const definition = flowDefinition([
      step({
        id: "one",
        script: "s",
        parameters: { command: "dump", mode: "fast" },
      }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
              ],
            }),
            descriptor({
              name: "mode",
              required: false,
              operations: [
                {
                  name: "fast",
                  description: "",
                  requiredParameters: ["batchSize"],
                },
              ],
            }),
            descriptor({ name: "queueUrl", required: false }),
            descriptor({ name: "batchSize", required: false }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);
    const names = report.missing[0]?.parameters.map((p) => p.name).toSorted();
    expect(names).toEqual(["batchSize", "queueUrl"]);
  });

  test("an unresolvable requiredParameters entry (a malformed script descriptor) is reported as unverified, not silently dropped", () => {
    // Regression test: `command`'s `dump` operation declares
    // `requiredParameters: ["nonexistentParam"]`, but the script's
    // `declared` list has no descriptor named or aliased `nonexistentParam`
    // — a malformed script descriptor. This must surface as an `unverified`
    // warning naming the bad entry, not silently vanish.
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: { command: "dump" } }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["nonexistentParam"],
                },
              ],
            }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    // `command` itself has a value ("dump") supplied by the step's own
    // parameters, so it is satisfied on its own account — no phantom
    // "missing" finding can come from the unresolvable entry either, since
    // there is no canonical descriptor to report as missing.
    expect(report.missing).toEqual([]);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]).toMatchObject({ stepId: "one", script: "s" });
    expect(report.unverified[0]?.reason).toContain(
      "malformed operation declaration",
    );
    expect(report.unverified[0]?.reason).toContain("nonexistentParam");
  });

  test("resolves a requiredParameters entry by EXACT canonical name before any alias — a different descriptor's matching alias must not win", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", parameters: { command: "dump" } }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            // Declared FIRST, and its alias also happens to equal
            // "queueUrl" — a naive single-pass (name-or-alias, in
            // declaration order) resolves HERE first.
            descriptor({
              name: "topic",
              aliases: ["queueUrl"],
              required: false,
            }),
            descriptor({
              name: "command",
              required: true,
              operations: [
                {
                  name: "dump",
                  description: "",
                  requiredParameters: ["queueUrl"],
                },
              ],
            }),
            // Declared LAST, but its OWN canonical name is the exact
            // match — pass 1 (exact name, across ALL descriptors) must
            // find this one before pass 2 ever considers "topic"'s alias.
            descriptor({ name: "queueUrl", required: false }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [
          { name: "queueUrl", secret: false, requiredForOperation: "dump" },
        ],
      },
    ]);
  });
});

describe("checkFlowPreflight — the env-file blind spot", () => {
  test("a required parameter with no other supply and envFileReachByScript true becomes unverified, not missing", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", execution: "spawn" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "apiToken", required: true })]],
      ]),
      envFileReachByScript: new Map([["s", true]]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([]);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]?.stepId).toBe("one");
    expect(report.unverified[0]?.script).toBe("s");
    expect(report.unverified[0]?.reason).toContain("apiToken");
  });

  test("a required parameter with no other supply and envFileReachByScript false (or absent) lands in missing", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", execution: "spawn" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "apiToken", required: true })]],
      ]),
      // envFileReachByScript deliberately empty — absent maps to false.
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "apiToken", secret: false }],
      },
    ]);
    expect(report.unverified).toEqual([]);
  });

  test("in-process execution forces env-file reach to false even when envFileReachByScript says true for the script", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", execution: "in-process" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "apiToken", required: true })]],
      ]),
      envFileReachByScript: new Map([["s", true]]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "apiToken", secret: false }],
      },
    ]);
    expect(report.unverified).toEqual([]);
  });

  test("merges multiple env-file-blind-spot parameters for the same step into ONE unverified entry naming all of them", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s", execution: "spawn" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({ name: "apiToken", required: true }),
            descriptor({ name: "signingKey", required: true }),
          ],
        ],
      ]),
      envFileReachByScript: new Map([["s", true]]),
    });

    const report = checkFlowPreflight(definition, context);

    expect(report.missing).toEqual([]);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]?.reason).toContain("apiToken");
    expect(report.unverified[0]?.reason).toContain("signingKey");
  });

  test("a parameter already supplied by the step's own parameters produces neither a missing nor an unverified finding, even when envFileReachByScript says true", () => {
    const definition = flowDefinition([
      step({
        id: "one",
        script: "s",
        execution: "spawn",
        parameters: { apiToken: "x" },
      }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "apiToken", required: true })]],
      ]),
      envFileReachByScript: new Map([["s", true]]),
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });
});

describe("checkFlowPreflight — reachability scoping", () => {
  test("with no startStepId, reachability starts at the first declared step and continues in file order", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s" }),
      step({ id: "two", script: "s" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
    });

    const report = checkFlowPreflight(definition, context);
    expect(report.missing.map((m) => m.stepId)).toEqual(["one", "two"]);
  });

  test("a step reachable only through a { goto } arm from a reachable step IS checked", () => {
    // "first" deliberately omits `onPartial` — the fixed point must still
    // treat it as onFailure's target rather than fail to compile/crash.
    const first: M3LCliFlowStep = {
      id: "first",
      script: "s",
      parameters: {},
      execution: "auto",
      onSuccess: { goto: "third" },
      onFailure: "stop",
    };
    const definition = flowDefinition([
      first,
      step({ id: "second", script: "s" }), // unreachable — nothing points to it
      step({ id: "third", script: "s" }), // reachable ONLY via the goto above
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
    });

    const report = checkFlowPreflight(definition, context);
    expect(report.missing.map((m) => m.stepId).toSorted()).toEqual([
      "first",
      "third",
    ]);
  });

  test("a step reachable only from an otherwise-unreachable step is NOT checked — reachability does not leak transitively", () => {
    const definition = flowDefinition([
      step({
        id: "start",
        script: "s",
        parameters: { flag: "x" }, // satisfied — isolates the leak claim
        onSuccess: "stop",
        onFailure: "stop",
      }),
      step({
        id: "unreached",
        script: "s",
        onSuccess: { goto: "leaked" },
        onFailure: "stop",
      }),
      step({ id: "leaked", script: "s" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
    });

    expect(checkFlowPreflight(definition, context).missing).toEqual([]);
  });

  test("a { goto } cycle terminates the fixed point rather than looping forever", () => {
    const definition = flowDefinition([
      step({
        id: "a",
        script: "s",
        onSuccess: { goto: "b" },
        onFailure: "stop",
      }),
      step({
        id: "b",
        script: "s",
        onSuccess: { goto: "a" },
        onFailure: "stop",
      }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
      startStepId: "a",
    });

    // A normal return (not a timeout) proves the fixed point terminates;
    // both steps being reachable proves the cycle was actually walked.
    const report = checkFlowPreflight(definition, context);
    expect(report.missing.map((m) => m.stepId).toSorted()).toEqual(["a", "b"]);
  });

  test("a startStepId later in the sequence means an earlier broken step produces no finding", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s" }), // broken, but before the start point
      step({ id: "two", script: "s", parameters: { flag: "x" } }), // clean
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
      startStepId: "two",
    });

    expect(checkFlowPreflight(definition, context).missing).toEqual([]);
  });

  test("a startStepId naming no declared step treats ALL steps as reachable, mirroring runFlow's resolveStartIndex", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s" }),
      step({ id: "two", script: "s" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
      startStepId: "does-not-exist",
    });

    const report = checkFlowPreflight(definition, context);
    expect(report.missing.map((m) => m.stepId)).toEqual(["one", "two"]);
  });

  test("an empty step list has nothing reachable", () => {
    const definition = flowDefinition([]);
    const context = baseContext();

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });
});

describe("checkFlowPreflight — a script absent from the pre-flight context", () => {
  test("a script with no key at all in parametersByScript is reported unverified, never falsely missing or falsely clean", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "unknown-script" }),
    ]);
    const context = baseContext({
      // Genuinely empty — no key for "unknown-script" at all, distinct from
      // a map that maps it to an empty array.
      parametersByScript: new Map(),
    });

    const report = checkFlowPreflight(definition, context);

    // An unknown script must never silently manufacture a false "missing"
    // finding either, since there is nothing declared to check it against.
    expect(report.missing).toEqual([]);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]?.stepId).toBe("one");
    expect(report.unverified[0]?.script).toBe("unknown-script");
    expect(report.unverified[0]?.reason).toContain(
      "has no known parameter descriptors",
    );
    expect(report.unverified[0]?.reason).toContain("unknown-script");
  });

  test("a script explicitly declaring zero parameters is clean, distinct from a script absent from the context entirely", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "empty-script" }),
    ]);
    const context = baseContext({
      // An EXPLICIT empty array for the script — the script legitimately
      // declares no parameters at all, rather than being unknown to this
      // context.
      parametersByScript: new Map([["empty-script", []]]),
    });

    expect(checkFlowPreflight(definition, context)).toEqual({
      missing: [],
      unverified: [],
    });
  });
});

describe("checkFlowPreflight — aggregation", () => {
  test("reports every independently-broken step in one call, not just the first", () => {
    const definition = flowDefinition([
      step({ id: "one", script: "s" }),
      step({ id: "two", script: "s" }),
    ]);
    const context = baseContext({
      parametersByScript: new Map([
        ["s", [descriptor({ name: "flag", required: true })]],
      ]),
    });

    const report = checkFlowPreflight(definition, context);
    expect(report.missing.map((m) => m.stepId)).toEqual(["one", "two"]);
  });

  test("reports every missing parameter of a single step, not just the first", () => {
    const definition = flowDefinition([step({ id: "one", script: "s" })]);
    const context = baseContext({
      parametersByScript: new Map([
        [
          "s",
          [
            descriptor({ name: "first-flag", required: true }),
            descriptor({ name: "second-flag", required: true }),
          ],
        ],
      ]),
    });

    const report = checkFlowPreflight(definition, context);
    const names = report.missing[0]?.parameters.map((p) => p.name).toSorted();
    expect(names).toEqual(["first-flag", "second-flag"]);
  });
});

describe("rejectFlowPreflight", () => {
  test("throws M3LCliError coded ERR_CLI_FLOW_PREFLIGHT_FAILED", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "flag", secret: false }],
      },
    ];

    expect(captureRejectFlowPreflight("demo", missing).code).toBe(
      "ERR_CLI_FLOW_PREFLIGHT_FAILED",
    );
  });

  test("carries no suggestions", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "one",
        script: "s",
        parameters: [{ name: "flag", secret: false }],
      },
    ];

    expect(captureRejectFlowPreflight("demo", missing).suggestions).toEqual([]);
  });

  test("renders the exact aggregated message for a single step missing two parameters", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "dump",
        script: "sqs-etl",
        parameters: [
          { name: "queueUrl", secret: false },
          { name: "output", secret: false },
        ],
      },
    ];

    const error = captureRejectFlowPreflight("dlq-reconcile", missing);

    expect(error.message).toBe(
      expectedPreflightMessage("dlq-reconcile", missing),
    );
    expect(error.message).toContain("1 step(s)");
  });

  test("renders two separate step lines, in the same order as `missing`, for a two-step aggregation", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "dump",
        script: "sqs-etl",
        parameters: [{ name: "queueUrl", secret: false }],
      },
      {
        stepId: "load",
        script: "json-etl",
        parameters: [{ name: "input", secret: false }],
      },
    ];

    const error = captureRejectFlowPreflight("dlq-reconcile", missing);

    expect(error.message).toBe(
      expectedPreflightMessage("dlq-reconcile", missing),
    );
    expect(error.message).toContain("2 step(s)");
    const lines = error.message.split("\n");
    expect(lines[1]).toContain("dump");
    expect(lines[2]).toContain("load");
  });

  test("annotates a parameter required for an operation with [required for operation '<op>']", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "dump",
        script: "sqs-etl",
        parameters: [
          { name: "queueUrl", secret: false, requiredForOperation: "dump" },
        ],
      },
    ];

    const error = captureRejectFlowPreflight("dlq-reconcile", missing);

    expect(error.message).toBe(
      expectedPreflightMessage("dlq-reconcile", missing),
    );
    expect(error.message).toContain("[required for operation 'dump']");
  });

  test("annotates a secret parameter with the derived env var name and ADR-0085", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "dump",
        script: "json-etl",
        parameters: [{ name: "api-token", secret: true }],
      },
    ];

    const error = captureRejectFlowPreflight("dlq-reconcile", missing);

    expect(error.message).toBe(
      expectedPreflightMessage("dlq-reconcile", missing),
    );
    expect(error.message).toContain(
      `[secret — set ${Core.deriveEnvVarName("api-token")} in the environment, ADR-0085]`,
    );
  });

  test("the secret annotation takes precedence over the operation annotation when both apply", () => {
    const missing: readonly M3LCliFlowPreflightMissingStep[] = [
      {
        stepId: "dump",
        script: "json-etl",
        parameters: [
          {
            name: "api-token",
            secret: true,
            requiredForOperation: "dump",
          },
        ],
      },
    ];

    const error = captureRejectFlowPreflight("dlq-reconcile", missing);

    expect(error.message).toBe(
      expectedPreflightMessage("dlq-reconcile", missing),
    );
    expect(error.message).toContain(
      `[secret — set ${Core.deriveEnvVarName("api-token")} in the environment, ADR-0085]`,
    );
    expect(error.message).not.toContain("[required for operation");
  });
});

describe("resolveEnvFileReach", () => {
  const createdRoots: string[] = [];

  afterEach(() => {
    while (createdRoots.length > 0) {
      const root = createdRoots.pop();
      if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  /** Creates a fresh temp sandbox root, registered for cleanup. */
  function sandbox(): string {
    const root = mkdtempSync(join(tmpdir(), "m3l-flow-preflight-"));
    createdRoots.push(root);
    return root;
  }

  test("envFile disabled maps every candidate to false", () => {
    const envFile: M3LCliEnvFileSetting = { kind: "disabled" };
    const candidates: readonly M3LCliFlowPreflightScriptLocation[] = [
      { name: "a", directory: "/does/not/matter" },
      { name: "b", directory: "/also/does/not/matter" },
    ];

    const reach = resolveEnvFileReach(candidates, envFile);

    expect(reach.get("a")).toBe(false);
    expect(reach.get("b")).toBe(false);
  });

  test("envFile path maps every candidate to the SAME existsSync(path) result — file exists", () => {
    const root = sandbox();
    const filePath = join(root, "shared.env");
    writeFileSync(filePath, "X=1", "utf8");
    const envFile: M3LCliEnvFileSetting = { kind: "path", path: filePath };
    const candidates: readonly M3LCliFlowPreflightScriptLocation[] = [
      { name: "a", directory: join(root, "a") },
      { name: "b", directory: join(root, "b") },
    ];

    const reach = resolveEnvFileReach(candidates, envFile);

    expect(reach.get("a")).toBe(true);
    expect(reach.get("b")).toBe(true);
  });

  test("envFile path maps every candidate to the SAME existsSync(path) result — file absent", () => {
    const root = sandbox();
    const filePath = join(root, "never-created.env");
    const envFile: M3LCliEnvFileSetting = { kind: "path", path: filePath };
    const candidates: readonly M3LCliFlowPreflightScriptLocation[] = [
      { name: "a", directory: join(root, "a") },
      { name: "b", directory: join(root, "b") },
    ];

    const reach = resolveEnvFileReach(candidates, envFile);

    expect(reach.get("a")).toBe(false);
    expect(reach.get("b")).toBe(false);
  });

  test("envFile auto checks <directory>/.env PER SCRIPT, independently, in the same call", () => {
    const root = sandbox();
    const withEnv = join(root, "with-env");
    const withoutEnv = join(root, "without-env");
    mkdirSync(withEnv, { recursive: true });
    mkdirSync(withoutEnv, { recursive: true });
    writeFileSync(join(withEnv, ".env"), "X=1", "utf8");
    const envFile: M3LCliEnvFileSetting = { kind: "auto" };
    const candidates: readonly M3LCliFlowPreflightScriptLocation[] = [
      { name: "has-env", directory: withEnv },
      { name: "no-env", directory: withoutEnv },
    ];

    const reach = resolveEnvFileReach(candidates, envFile);

    expect(reach.get("has-env")).toBe(true);
    expect(reach.get("no-env")).toBe(false);
  });
});
