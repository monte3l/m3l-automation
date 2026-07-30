import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  CLOUDFORMATION_STACKS_OPERATIONS,
  configParameters,
  configValidators,
  YES_DEFAULT,
} from "../src/config.js";

/**
 * Contract: docs/reference/scripts/cloudformation-stacks.md "Configuration
 * schema" table + `src/config.ts`. 12 declared parameters: aws.profile,
 * operation, stackName, input, template, stackStatusFilter, retainResources,
 * roleArn, nextToken, maxWaitTime, output, yes. This file asserts the
 * DECLARED shape only — names, uniqueness, instance types, and each
 * parameter's own validator/default — never the per-operation
 * cross-parameter requirements (guard-checked at run start instead — see
 * `tests/run-cloudformation-stacks.test.ts`).
 *
 * `CLOUDFORMATION_STACKS_OPERATIONS` is declared as a bare `as const` array
 * (the same "bare `as const` + derived union" idiom `ECS_OPERATIONS`/
 * `LAMBDA_OPERATIONS`/`DYNAMO_OPERATIONS` use) so the closed set is
 * independently assertable without exercising config resolution.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "stackName",
  "input",
  "template",
  "stackStatusFilter",
  "retainResources",
  "roleArn",
  "nextToken",
  "maxWaitTime",
  "output",
  "yes",
] as const;

const EXPECTED_OPERATIONS = [
  "list-stacks",
  "describe-stack",
  "describe-stack-events",
  "create-stack",
  "update-stack",
  "delete-stack",
  "wait-stack-create-complete",
  "wait-stack-update-complete",
  "wait-stack-delete-complete",
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

describe("cloudformation-stacks CLOUDFORMATION_STACKS_OPERATIONS", () => {
  it("declares exactly the 9 documented operation strings, in order", () => {
    expect(CLOUDFORMATION_STACKS_OPERATIONS).toEqual(EXPECTED_OPERATIONS);
  });
});

describe("cloudformation-stacks YES_DEFAULT", () => {
  it("is false", () => {
    expect(YES_DEFAULT).toBe(false);
  });
});

describe("cloudformation-stacks config declaration", () => {
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

  it("declares exactly the 12 documented parameters, in order", () => {
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

    it("rejects an empty string", async () => {
      await expect(
        resolveWith(paramNamed(Core.AWS_PROFILE_PARAM_NAME), ""),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'operation' — required, oneOf(9 declared operations)", () => {
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

  describe("'stackName'/'input'/'template'/'stackStatusFilter'/'retainResources'/'roleArn'/'nextToken'/'output' — optional, nonEmpty when set", () => {
    const optionalStringNames = [
      "stackName",
      "input",
      "template",
      "stackStatusFilter",
      "retainResources",
      "roleArn",
      "nextToken",
      "output",
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

  describe("'maxWaitTime' — INT, range(1, 3600), optional, no default", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("maxWaitTime")),
      ).resolves.toBeUndefined();
    });

    it("accepts the boundary values 1 and 3600", async () => {
      await expect(resolveWith(paramNamed("maxWaitTime"), "1")).resolves.toBe(
        1,
      );
      await expect(
        resolveWith(paramNamed("maxWaitTime"), "3600"),
      ).resolves.toBe(3600);
    });

    it("rejects 0 and 3601", async () => {
      await expect(
        resolveWith(paramNamed("maxWaitTime"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("maxWaitTime"), "3601"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'yes' — BOOL, default false", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("yes"))).resolves.toBe(false);
    });

    it("accepts an explicit true", async () => {
      await expect(resolveWith(paramNamed("yes"), "true")).resolves.toBe(true);
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
 * F1b — cross-parameter validation, per
 * docs/reference/scripts/cloudformation-stacks.md's "Configuration schema"
 * section: per-operation requiredness (the "Required for" column) is
 * guard-checked at run start today (`run-cloudformation-stacks.ts`'s
 * `accessor.requiredFor(...)` calls) pending this script's fleet retrofit
 * onto `configValidators`. Each rule below is verified against both the doc
 * table and the guard code:
 *
 * - `stackName` — required for `describe-stack`, `delete-stack`,
 *   `describe-stack-events`, and the three `wait-stack-*-complete`
 *   operations — i.e. every operation except `list-stacks`, `create-stack`,
 *   `update-stack` (verified: `dispatchReadStacks`'s `describe-stack`
 *   branch, `planWriteDispatch`'s `delete-stack` branch,
 *   `dispatchReadStackEvents`, `dispatchWait`, each calling
 *   `accessor.requiredFor(raw.stackName, "stackName", operation)`).
 * - `input` — required for `create-stack`/`update-stack` (verified:
 *   `planCreateOrUpdate`'s `accessor.requiredFor(raw.input, "input",
 *   operation)`).
 *
 * The `template`-vs-`templateBody`/`templateUrl` conflict check
 * (`resolveTemplateText`) is deliberately **not** retrofitted here — it
 * compares a config parameter against a parsed `input` file's contents read
 * from disk, which `configValidators` (a config-only seam with no
 * filesystem access) structurally cannot express; it stays a run-start-only
 * guard per the doc's "Configuration schema" section and
 * `docs/plans/IMPLEMENTATION.md`'s F1b row.
 *
 * Each validator's failure reason names the fixed set of operations the
 * constraint applies to — never a caller-supplied value — matching the
 * contract in `docs/reference/core/config.md`'s "Cross-parameter
 * validation" section.
 */
describe("configValidators (F1b — cross-parameter validation)", () => {
  describe("'stackName' — required for every operation except list-stacks/create-stack/update-stack", () => {
    const stackNameRequiredOperations = [
      "describe-stack",
      "delete-stack",
      "describe-stack-events",
      "wait-stack-create-complete",
      "wait-stack-update-complete",
      "wait-stack-delete-complete",
    ] as const;

    it.each(stackNameRequiredOperations)(
      "returns the documented failure reason when 'stackName' is missing for '%s'",
      (operation) => {
        const config = buildConfig({
          [Core.AWS_PROFILE_PARAM_NAME]: "default",
          operation,
        });

        expect(firstFailure(config)).toBe(
          "'stackName' is required for every operation except 'list-stacks', 'create-stack', and 'update-stack'",
        );
      },
    );

    it.each(stackNameRequiredOperations)(
      "passes when 'stackName' is set for '%s'",
      (operation) => {
        const config = buildConfig({
          [Core.AWS_PROFILE_PARAM_NAME]: "default",
          operation,
          stackName: "my-stack",
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes when 'stackName' is unset but the operation is 'list-stacks' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "list-stacks",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("does not embed a received/rejected value in the failure reason", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-stack",
      });

      const result = firstFailure(config);
      expect(result).toMatch(/'stackName'/);
      expect(result).not.toContain("delete-stack");
    });
  });

  describe("'input' — required for create-stack/update-stack", () => {
    it("returns the documented failure reason when 'input' is missing for 'create-stack'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "create-stack",
      });

      expect(firstFailure(config)).toBe(
        "'input' is required for 'create-stack' and 'update-stack'",
      );
    });

    it("passes when 'input' is set for 'update-stack'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "update-stack",
        input: "stack-input.json",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'input' is unset but the operation is 'list-stacks' (does not require it)", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "list-stacks",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });
});
