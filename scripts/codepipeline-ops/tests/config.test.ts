import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  ABANDON_DEFAULT,
  CODEPIPELINE_OPS_OPERATIONS,
  configParameters,
  configValidators,
  STAGE_TRANSITION_TYPES,
  WAIT_INTERVAL_SECONDS_DEFAULT,
  WAIT_MAX_ATTEMPTS_DEFAULT,
  YES_DEFAULT,
} from "../src/config.js";

/**
 * Contract: docs/reference/scripts/codepipeline-ops.md "Configuration
 * schema" table + `src/config.ts`. 16 declared parameters: aws.profile,
 * operation, pipeline, executionId, stage, transitionType, reason, input,
 * output, version, maxResults, clientRequestToken, abandon, yes,
 * waitMaxAttempts, waitIntervalSeconds. This file asserts the DECLARED shape
 * only — names, uniqueness, instance types, and each parameter's own
 * validator/default — never the library's own provider-resolution order or
 * the per-operation cross-parameter requirements (guard-checked at run start
 * instead — see `tests/run-codepipeline-ops.test.ts`).
 *
 * `CODEPIPELINE_OPS_OPERATIONS` is declared as a bare `as const` array (the
 * same "bare `as const` + derived union" idiom `ECS_OPERATIONS`/
 * `LAMBDA_OPERATIONS` use) so the closed set is independently assertable
 * without exercising config resolution.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "pipeline",
  "executionId",
  "stage",
  "transitionType",
  "reason",
  "input",
  "output",
  "version",
  "maxResults",
  "clientRequestToken",
  "abandon",
  "yes",
  "waitMaxAttempts",
  "waitIntervalSeconds",
] as const;

const EXPECTED_OPERATIONS = [
  "list-pipelines",
  "describe-pipeline",
  "get-pipeline-state",
  "list-executions",
  "describe-execution",
  "create-pipeline",
  "update-pipeline",
  "delete-pipeline",
  "start-execution",
  "stop-execution",
  "enable-stage-transition",
  "disable-stage-transition",
  "watch-execution",
] as const;

/** Resolves `parameter` against a single in-memory raw value, nothing else. */
async function resolveWith(
  parameter: Core.M3LConfigParameter,
  raw: unknown,
): Promise<unknown> {
  const reader = new Core.M3LConfigReader([
    new Core.M3LInMemoryConfigProvider({ [parameter.getName()]: raw }),
  ]);
  return parameter.getValueAsync(reader);
}

/** Resolves `parameter` with no provider at all (falls through to its default). */
async function resolveDefault(
  parameter: Core.M3LConfigParameter,
): Promise<unknown> {
  const reader = new Core.M3LConfigReader([]);
  return parameter.getValueAsync(reader);
}

function paramNamed(name: string): Core.M3LConfigParameter {
  const found = configParameters.find(
    (parameter) => parameter.getName() === name,
  );
  if (found === undefined) {
    throw new Error(
      `test fixture error: no declared parameter named '${name}'`,
    );
  }
  return found;
}

describe("codepipeline-ops CODEPIPELINE_OPS_OPERATIONS", () => {
  it("declares exactly the 13 documented operation strings, in order", () => {
    expect(CODEPIPELINE_OPS_OPERATIONS).toEqual(EXPECTED_OPERATIONS);
  });
});

describe("codepipeline-ops STAGE_TRANSITION_TYPES", () => {
  it("declares exactly the two documented transition-type strings", () => {
    expect(STAGE_TRANSITION_TYPES).toEqual(["Inbound", "Outbound"]);
  });
});

describe("codepipeline-ops config declaration", () => {
  it("declares at least one parameter", () => {
    expect(configParameters.length).toBeGreaterThan(0);
  });

  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  it("declares exactly the 16 documented parameters, in order", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(names).toEqual(EXPECTED_NAMES);
  });

  describe(`'${Core.AWS_PROFILE_PARAM_NAME}' — required, nonEmpty`, () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed(Core.AWS_PROFILE_PARAM_NAME));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it("accepts a non-empty profile name", async () => {
      await expect(
        resolveWith(paramNamed(Core.AWS_PROFILE_PARAM_NAME), "default"),
      ).resolves.toBe("default");
    });
  });

  describe("'operation' — required, oneOf(13 declared operations)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("operation"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(EXPECTED_OPERATIONS)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("operation"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("operation"), "frobnicate"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'pipeline'/'executionId'/'stage'/'reason'/'input'/'output'/'clientRequestToken' — optional, nonEmpty when set", () => {
    const optionalStringNames = [
      "pipeline",
      "executionId",
      "stage",
      "reason",
      "input",
      "output",
      "clientRequestToken",
    ] as const;

    it.each(optionalStringNames)(
      "'%s' has no default (unset)",
      async (name) => {
        await expect(resolveDefault(paramNamed(name))).resolves.toBeUndefined();
      },
    );

    it.each(optionalStringNames)(
      "'%s' rejects an empty string and accepts a non-empty one",
      async (name) => {
        const parameter = paramNamed(name);
        await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
          Core.M3LConfigValidationError,
        );
        await expect(resolveWith(parameter, "value")).resolves.toBe("value");
      },
    );
  });

  describe("'transitionType' — optional, oneOf('Inbound', 'Outbound')", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("transitionType")),
      ).resolves.toBeUndefined();
    });

    it.each(STAGE_TRANSITION_TYPES)("accepts '%s'", async (value) => {
      await expect(
        resolveWith(paramNamed("transitionType"), value),
      ).resolves.toBe(value);
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("transitionType"), "Sideways"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'version' — INT, range(1, 1_000_000), optional, no default", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("version")),
      ).resolves.toBeUndefined();
    });

    it("accepts the boundary values 1 and 1_000_000", async () => {
      await expect(resolveWith(paramNamed("version"), "1")).resolves.toBe(1);
      await expect(resolveWith(paramNamed("version"), "1000000")).resolves.toBe(
        1_000_000,
      );
    });

    it("rejects 0 and 1_000_001", async () => {
      await expect(
        resolveWith(paramNamed("version"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("version"), "1000001"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'maxResults' — INT, range(1, 1000), optional, no default", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("maxResults")),
      ).resolves.toBeUndefined();
    });

    it("accepts the boundary values 1 and 1000", async () => {
      await expect(resolveWith(paramNamed("maxResults"), "1")).resolves.toBe(1);
      await expect(resolveWith(paramNamed("maxResults"), "1000")).resolves.toBe(
        1000,
      );
    });

    it("rejects 0 and 1001", async () => {
      await expect(
        resolveWith(paramNamed("maxResults"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("maxResults"), "1001"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'abandon' — BOOL, default ABANDON_DEFAULT (false)", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("abandon"))).resolves.toBe(
        ABANDON_DEFAULT,
      );
    });

    it("accepts an explicit true", async () => {
      await expect(resolveWith(paramNamed("abandon"), "true")).resolves.toBe(
        true,
      );
    });
  });

  describe("'yes' — BOOL, default YES_DEFAULT (false)", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("yes"))).resolves.toBe(
        YES_DEFAULT,
      );
    });

    it("accepts an explicit true", async () => {
      await expect(resolveWith(paramNamed("yes"), "true")).resolves.toBe(true);
    });
  });

  describe("'waitMaxAttempts' — INT, default 60, range(1, 1000)", () => {
    it("defaults to WAIT_MAX_ATTEMPTS_DEFAULT (60)", async () => {
      await expect(resolveDefault(paramNamed("waitMaxAttempts"))).resolves.toBe(
        WAIT_MAX_ATTEMPTS_DEFAULT,
      );
    });

    it("accepts the boundary values 1 and 1000", async () => {
      await expect(
        resolveWith(paramNamed("waitMaxAttempts"), "1"),
      ).resolves.toBe(1);
      await expect(
        resolveWith(paramNamed("waitMaxAttempts"), "1000"),
      ).resolves.toBe(1000);
    });

    it("rejects 0 and 1001", async () => {
      await expect(
        resolveWith(paramNamed("waitMaxAttempts"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("waitMaxAttempts"), "1001"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'waitIntervalSeconds' — INT, default 15, range(1, 300)", () => {
    it("defaults to WAIT_INTERVAL_SECONDS_DEFAULT (15)", async () => {
      await expect(
        resolveDefault(paramNamed("waitIntervalSeconds")),
      ).resolves.toBe(WAIT_INTERVAL_SECONDS_DEFAULT);
    });

    it("accepts the boundary values 1 and 300", async () => {
      await expect(
        resolveWith(paramNamed("waitIntervalSeconds"), "1"),
      ).resolves.toBe(1);
      await expect(
        resolveWith(paramNamed("waitIntervalSeconds"), "300"),
      ).resolves.toBe(300);
    });

    it("rejects 0 and 301", async () => {
      await expect(
        resolveWith(paramNamed("waitIntervalSeconds"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("waitIntervalSeconds"), "301"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });
});

/** Builds a raw `M3LConfig` store directly, one `.set(name, value)` per key. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

/**
 * Runs every declared `configValidators` entry against `config`, in
 * declaration order, mirroring `Core.M3LConfigSchema.validate`'s fail-fast
 * iteration: returns the first non-`true` result, or `undefined` when every
 * validator passes.
 */
function firstFailure(config: Core.M3LConfig): string | undefined {
  for (const validator of configValidators) {
    const result = validator(config);
    if (result !== true) return result;
  }
  return undefined;
}

/**
 * F1b — cross-parameter validation, per docs/reference/scripts/codepipeline-ops.md's
 * "Configuration schema" section: per-operation requiredness (the "Required
 * for" column) is guard-checked at run start today (`run-codepipeline-ops.ts`'s
 * `accessor.requiredFor(...)` calls) pending this script's fleet retrofit
 * onto `configValidators`. Each block below verifies the exact per-parameter
 * rule against the doc table AND the guard code before asserting it as a
 * config-load-time constraint:
 *
 * - `pipeline` — required for every operation except `list-pipelines`,
 *   `create-pipeline`, `update-pipeline` (verified: every `dispatch*`
 *   function but `dispatchReadPipelines`'s `list-pipelines` branch and
 *   `dispatchWritePipeline`'s create/update branch calls
 *   `accessor.requiredFor(raw.pipeline, "pipeline", operation)`).
 * - `executionId` — required for `describe-execution`, `stop-execution`,
 *   `watch-execution` (verified: `dispatchReadExecutions`,
 *   `dispatchExecute`, `dispatchWatch`).
 * - `stage`/`transitionType` — required for `enable-stage-transition` and
 *   `disable-stage-transition` (verified: `dispatchTransitions`).
 * - `reason` — required ONLY for `disable-stage-transition` (verified:
 *   `dispatchTransitions`'s `if (operation === "disable-stage-transition")`
 *   guard); `stop-execution` forwards `reason` but never guard-checks it
 *   (`dispatchExecute` never calls `requiredFor` on `raw.reason`), matching
 *   the doc table's "optional" annotation for that operation.
 * - `input` — required for `create-pipeline`/`update-pipeline` (verified:
 *   `planWriteDispatch`'s non-`delete-pipeline` branch).
 *
 * Each validator's failure reason names the fixed, closed set of
 * operations the constraint applies to (from `CODEPIPELINE_OPS_OPERATIONS`)
 * — never a caller-supplied value — matching the contract in
 * `docs/reference/core/config.md`'s "Cross-parameter validation" section.
 */
describe("configValidators (F1b — cross-parameter validation)", () => {
  describe("'pipeline' — required for every operation except list-pipelines/create-pipeline/update-pipeline", () => {
    it("returns the documented failure reason when 'pipeline' is missing for an operation that requires it", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "get-pipeline-state",
      });

      expect(firstFailure(config)).toBe(
        "'pipeline' is required for every operation except 'list-pipelines', 'create-pipeline', and 'update-pipeline'",
      );
    });

    it("passes when 'pipeline' is set for an operation that requires it", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "get-pipeline-state",
        pipeline: "my-pipeline",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'pipeline' is unset but the operation is 'list-pipelines' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "list-pipelines",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("does not embed a received/rejected value in the failure reason", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-pipeline",
      });

      const result = firstFailure(config);
      expect(result).toMatch(/'pipeline'/);
      expect(result).not.toContain("delete-pipeline");
    });
  });

  describe("'executionId' — required for describe-execution/stop-execution/watch-execution", () => {
    it("returns the documented failure reason when 'executionId' is missing for an operation that requires it", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "describe-execution",
        pipeline: "my-pipeline",
      });

      expect(firstFailure(config)).toBe(
        "'executionId' is required for 'describe-execution', 'stop-execution', and 'watch-execution'",
      );
    });

    it("passes when both 'executionId' and 'pipeline' are set", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "describe-execution",
        pipeline: "my-pipeline",
        executionId: "exec-1",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'executionId' is unset but the operation is 'list-executions' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "list-executions",
        pipeline: "my-pipeline",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'stage' — required for enable-stage-transition/disable-stage-transition", () => {
    it("returns the documented failure reason when 'stage' is missing for 'enable-stage-transition'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "enable-stage-transition",
        pipeline: "my-pipeline",
        transitionType: "Inbound",
      });

      expect(firstFailure(config)).toBe(
        "'stage' is required for 'enable-stage-transition' and 'disable-stage-transition'",
      );
    });

    it("passes when 'stage' is set alongside the other required fields", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "enable-stage-transition",
        pipeline: "my-pipeline",
        transitionType: "Inbound",
        stage: "Prod",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'stage' is unset but the operation is 'get-pipeline-state' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "get-pipeline-state",
        pipeline: "my-pipeline",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'transitionType' — required for enable-stage-transition/disable-stage-transition", () => {
    it("returns the documented failure reason when 'transitionType' is missing for 'enable-stage-transition'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "enable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Prod",
      });

      expect(firstFailure(config)).toBe(
        "'transitionType' is required for 'enable-stage-transition' and 'disable-stage-transition'",
      );
    });

    it("passes when 'transitionType' is set alongside the other required fields", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "enable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Prod",
        transitionType: "Outbound",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'transitionType' is unset but the operation is 'watch-execution' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "watch-execution",
        pipeline: "my-pipeline",
        executionId: "exec-1",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'reason' — required ONLY for disable-stage-transition (stop-execution's 'reason' stays optional)", () => {
    it("returns the documented failure reason when 'reason' is missing for 'disable-stage-transition'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "disable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Prod",
        transitionType: "Inbound",
      });

      expect(firstFailure(config)).toBe(
        "'reason' is required for 'disable-stage-transition'",
      );
    });

    it("passes when 'reason' is set alongside the other required fields", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "disable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Prod",
        transitionType: "Inbound",
        reason: "rollback in progress",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'reason' is unset and the operation is 'enable-stage-transition' (never requires it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "enable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Prod",
        transitionType: "Inbound",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'reason' is unset and the operation is 'stop-execution' (documented optional, not guard-required)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "stop-execution",
        pipeline: "my-pipeline",
        executionId: "exec-1",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'input' — required for create-pipeline/update-pipeline", () => {
    it("returns the documented failure reason when 'input' is missing for 'create-pipeline'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "create-pipeline",
      });

      expect(firstFailure(config)).toBe(
        "'input' is required for 'create-pipeline' and 'update-pipeline'",
      );
    });

    it("passes when 'input' is set for 'update-pipeline'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "update-pipeline",
        input: "declaration.json",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'input' is unset but the operation is 'delete-pipeline' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-pipeline",
        pipeline: "my-pipeline",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });
});
