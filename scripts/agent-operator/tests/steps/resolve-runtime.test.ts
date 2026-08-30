/**
 * Tests for `steps/resolve-runtime` — the pure function narrowing a resolved
 * `Core.M3LConfig` (plus the validated policy and the paths port) into
 * `agent-operator`'s typed runtime settings (PR 1).
 *
 * Contract pins for this RED phase (test-author decision, since the PR 1
 * spec leaves the exact export name open): the step is named
 * `resolveAgentOperatorRuntime`, returning an `AgentOperatorRuntimeSettings`.
 * The implementer must match these names exactly — see the accompanying
 * report for the naming rationale.
 *
 * Every `Core.M3LConfigAccessor` failure and the `maxIterations` vs.
 * `policy.budgets.loopIterations` cross-check throw `Core.M3LError`/
 * `M3LAgentOperatorCliError` coded `ERR_AGENT_OPERATOR_CONFIG`. The
 * `cliEntrypoint` default additionally throws
 * `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` when `M3LPaths.getProjectRoot()` is
 * unavailable (standalone mode) and no explicit `cliEntrypoint` was set.
 */

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { resolveAgentOperatorRuntime } from "../../src/steps/resolve-runtime.js";
import { minimalPolicy } from "../support/policyFixtures.js";

/** A policy declaring `budgets.loopIterations`, so the cross-check has a ceiling to compare against. */
function policyWithLoopIterationsBudget(
  loopIterations: number,
): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: [{ script: "agent-operator", allOperations: true }],
    budgets: { loopIterations },
  });
}

function buildConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Core.M3LConfig {
  const config = new Core.M3LConfig();
  config.set(Core.AWS_PROFILE_PARAM_NAME, "sandbox");
  config.set("command", "explain-policy");
  config.set("modelId", "anthropic.claude-3-5-sonnet-20241022-v2:0");
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

beforeEach(() => {
  // `M3LExecutionEnvironment.detect()` (invoked by `new Core.M3LPaths()`) is
  // memoized at module scope — without this reset, whichever test in this
  // file constructs an `M3LPaths` first permanently caches that test's
  // deployment mode, and every later `vi.stubEnv("M3L_DEPLOYMENT_MODE", …)`
  // becomes a no-op.
  Core.M3LExecutionEnvironment.resetForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentOperatorRuntime — model rate parsing", () => {
  it("parses '<modelId>=<inputPer1k>,<outputPer1k>' entries into a ReadonlyMap", () => {
    const config = buildConfig({
      modelRates: [
        "anthropic.claude-3-5-sonnet-20241022-v2:0=3,15",
        "anthropic.claude-3-haiku-20240307-v1:0=0.25,1.25",
      ],
    });

    const settings = resolveAgentOperatorRuntime({
      config,
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expect(
      settings.modelRates.get("anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toEqual({ inputPer1kTokens: 3, outputPer1kTokens: 15 });
    expect(
      settings.modelRates.get("anthropic.claude-3-haiku-20240307-v1:0"),
    ).toEqual({ inputPer1kTokens: 0.25, outputPer1kTokens: 1.25 });
  });

  it("defaults to an empty rate map when 'modelRates' is unset", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig(),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });
    expect(settings.modelRates.size).toBe(0);
  });

  it.each([
    ["missing '='", "anthropic.claude-3-5-sonnet-20241022-v2:0:3,15"],
    ["missing the output rate", "anthropic.claude-3-5-sonnet-20241022-v2:0=3"],
    [
      "a non-numeric input rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=abc,15",
    ],
    [
      "a negative output rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=3,-15",
    ],
    [
      "a non-finite input rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=Infinity,15",
    ],
    [
      "a NaN-producing input rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=NaN,15",
    ],
  ])("rejects a modelRates entry with %s", (_label, entry) => {
    const config = buildConfig({ modelRates: [entry] });
    expect(() =>
      resolveAgentOperatorRuntime({
        config,
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      }),
    ).toThrowError(M3LAgentOperatorCliError);
    let thrown: unknown;
    try {
      resolveAgentOperatorRuntime({
        config,
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  // Regression for the trim bug the claude-pr-review bot found on PR #763:
  // `parseModelRates` used to validate `modelId.trim() === ""` but key the
  // map with the UNTRIMMED capture, so `" my-model =3,15"` was stored under
  // `" my-model "` and every `rates.get("my-model")` missed — silently
  // making cost unobservable. The chosen fix rejects a padded id outright
  // rather than trimming it, since this repo fails loud at the config
  // boundary rather than silently coercing caller/config input.
  it.each([
    ["a leading space", " my-model=3,15"],
    ["a trailing space", "my-model =3,15"],
    ["a tab", "my-model\t=3,15"],
  ])(
    "[regression] rejects a modelRates entry whose model id has %s, rather than silently keying the map under the padded id",
    (_label, entry) => {
      const config = buildConfig({ modelRates: [entry] });

      expect(() =>
        resolveAgentOperatorRuntime({
          config,
          policy: minimalPolicy(),
          paths: new Core.M3LPaths(),
        }),
      ).toThrowError(M3LAgentOperatorCliError);

      let thrown: unknown;
      try {
        resolveAgentOperatorRuntime({
          config,
          policy: minimalPolicy(),
          paths: new Core.M3LPaths(),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_CONFIG",
      );
      // The file's convention: never echo the offending entry back in the
      // thrown message.
      expect((thrown as M3LAgentOperatorCliError).message).not.toContain(
        "my-model",
      );
    },
  );
});

describe("resolveAgentOperatorRuntime — maxIterations vs. policy.budgets.loopIterations", () => {
  it("passes when maxIterations equals the declared loopIterations ceiling", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ maxIterations: 8 }),
      policy: policyWithLoopIterationsBudget(8),
      paths: new Core.M3LPaths(),
    });
    expect(settings.maxIterations).toBe(8);
  });

  it("throws ERR_AGENT_OPERATOR_CONFIG when maxIterations exceeds the declared loopIterations ceiling", () => {
    let thrown: unknown;
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig({ maxIterations: 9 }),
        policy: policyWithLoopIterationsBudget(8),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("skips the cross-check entirely when the policy declares no loopIterations budget", () => {
    // A ceiling this high would fail the cross-check if a budget were
    // declared — this proves absence genuinely skips the check rather than
    // comparing against an implicit ceiling.
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ maxIterations: 1000 }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });
    expect(settings.maxIterations).toBe(1000);
  });
});

describe("resolveAgentOperatorRuntime — cliEntrypoint default", () => {
  it("defaults to <projectRoot>/packages/m3l-cli/bin/m3l.mjs when unset", () => {
    const paths = new Core.M3LPaths();
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig(),
      policy: minimalPolicy(),
      paths,
    });
    expect(settings.cliEntrypoint).toBe(
      path.join(
        paths.getProjectRoot(),
        "packages",
        "m3l-cli",
        "bin",
        "m3l.mjs",
      ),
    );
  });

  it("uses the explicit cliEntrypoint when set, never touching getProjectRoot()", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ cliEntrypoint: "/opt/custom/m3l.mjs" }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });
    expect(settings.cliEntrypoint).toBe("/opt/custom/m3l.mjs");
  });

  it("throws ERR_AGENT_OPERATOR_CLI_ENTRYPOINT, not a raw M3LPathResolutionError, when getProjectRoot() is unavailable in standalone mode", () => {
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    vi.stubEnv("M3L_BASE_DIR", "/tmp");
    const paths = new Core.M3LPaths();

    // Sanity: this really is the standalone-mode throw the step must catch.
    expect(() => paths.getProjectRoot()).toThrowError(
      Core.M3LPathResolutionError,
    );

    let thrown: unknown;
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig(),
        policy: minimalPolicy(),
        paths,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect(thrown).not.toBeInstanceOf(Core.M3LPathResolutionError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT",
    );
  });
});
