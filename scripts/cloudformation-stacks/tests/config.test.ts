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
 * schema" table + `src/config.ts`. 13 declared parameters: aws.profile,
 * operation, stackName, input, template, stackStatusFilter, retainResources,
 * roleArn, nextToken, maxWaitTime, output, yes, yesSensitive (the ADR-0048
 * fleet retrofit's sensitive-target bypass flag — issue #483 / A2b). This
 * file asserts the DECLARED shape only — names, uniqueness, instance types,
 * and each parameter's own validator/default — never the per-operation
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
  "yesSensitive",
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

  it("declares exactly the 13 documented parameters, in order", () => {
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

  describe("'yesSensitive' — BOOL, default false (ADR-0048 fleet retrofit)", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("yesSensitive"))).resolves.toBe(
        false,
      );
    });

    it("accepts an explicit true", async () => {
      await expect(
        resolveWith(paramNamed("yesSensitive"), "true"),
      ).resolves.toBe(true);
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
 * DERIVED (ADR-0055, U5) from
 * `CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS`' `requiredParameters` by
 * `Core.deriveOperationValidators`, run once by
 * `Core.M3LConfigSchema.validate` after every declared parameter has
 * resolved. This SUPPLEMENTS, rather than replaces, the existing run-start
 * `accessor.requiredFor(...)` guards in `steps/run-cloudformation-stacks.ts`,
 * which also narrow `string | undefined` into `string` for typed downstream
 * use.
 *
 * - `stackName` — required for `describe-stack`, `describe-stack-events`,
 *   `delete-stack`, and the three `wait-stack-*-complete` operations.
 * - `input` — required for `create-stack`/`update-stack`.
 *
 * The `template`-vs-`templateBody`/`templateUrl` conflict check
 * (`resolveTemplateText`) is deliberately **not** retrofitted here — it
 * compares a config parameter against a parsed `input` file's contents read
 * from disk, which `configValidators` (a config-only seam with no
 * filesystem access) structurally cannot express; it stays a run-start-only
 * guard per the doc's "Configuration schema" section and
 * `docs/plans/IMPLEMENTATION.md`'s F1b row.
 *
 * Each derived validator's failure reason names the fixed set of operations
 * the constraint applies to — never a caller-supplied value — matching the
 * contract in `docs/reference/core/config.md`'s "Cross-parameter
 * validation" section.
 */
describe("configValidators (F1b — cross-parameter validation)", () => {
  describe("'stackName' — required for describe-stack/describe-stack-events/delete-stack/wait-stack-*-complete", () => {
    const stackNameRequiredOperations = [
      "describe-stack",
      "describe-stack-events",
      "delete-stack",
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
          "'stackName' is required for operation(s): describe-stack, describe-stack-events, delete-stack, wait-stack-create-complete, wait-stack-update-complete, wait-stack-delete-complete",
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

    /**
     * Re-expresses the pre-retrofit "does not embed a received/rejected
     * value" intent: the derived message is now a FIXED constraint
     * description that necessarily names every requiring operation
     * (including whichever one triggered the failure), so
     * `.not.toContain(operation)` is no longer a meaningful assertion — see
     * the hub's brief. What the message still never does is interpolate the
     * config's actual *received* value: running the identical validator
     * against two different triggering operations produces a byte-identical
     * string, proving nothing operation-specific beyond the fixed set was
     * substituted in.
     */
    it("produces a byte-identical failure reason regardless of which requiring operation triggers it", () => {
      const deleteStackConfig = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-stack",
      });
      const waitDeleteConfig = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "wait-stack-delete-complete",
      });

      const deleteStackResult = firstFailure(deleteStackConfig);
      const waitDeleteResult = firstFailure(waitDeleteConfig);

      expect(deleteStackResult).toMatch(/'stackName'/);
      expect(deleteStackResult).toBe(waitDeleteResult);
    });
  });

  describe("'input' — required for create-stack/update-stack", () => {
    it("returns the documented failure reason when 'input' is missing for 'create-stack'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "create-stack",
      });

      expect(firstFailure(config)).toBe(
        "'input' is required for operation(s): create-stack, update-stack",
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

  /**
   * ADR-0048 fleet retrofit (issue #483 / A2b): `yesSensitive` is the
   * sensitive-target bypass flag threaded into the pipeline's `destructive`
   * gate options. `Core.M3LConfigSchemaValidators.requires("yesSensitive",
   * "yes")` enforces that it can never be set without the plain `yes` bypass
   * also being set — mirroring `M3LConfigSchemaValidator`'s documented
   * `requires()` factory example.
   */
  describe("'yesSensitive' requires 'yes' to be set", () => {
    it("returns the documented failure reason when 'yesSensitive' is set but 'yes' is unset", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-stack",
        stackName: "my-stack",
        yesSensitive: true,
      });

      expect(firstFailure(config)).toBe(
        "'yesSensitive' requires 'yes' to be set",
      );
    });

    it("passes when both 'yesSensitive' and 'yes' are set", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-stack",
        stackName: "my-stack",
        yes: true,
        yesSensitive: true,
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'yesSensitive' is unset regardless of 'yes'", () => {
      const config = buildConfig({
        [Core.AWS_PROFILE_PARAM_NAME]: "default",
        operation: "delete-stack",
        stackName: "my-stack",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  it("passes every validator for 'list-stacks' with nothing else set (vacuous pass)", () => {
    const config = buildConfig({
      [Core.AWS_PROFILE_PARAM_NAME]: "default",
      operation: "list-stacks",
    });

    expect(firstFailure(config)).toBeUndefined();
  });
});

/**
 * Hand-authored (not re-derived from `src/config.ts`) so a src typo in
 * `requiredParameters` is actually caught rather than trivially agreeing
 * with itself. Mirrors the hub brief's table verbatim.
 */
const REQUIRED_PARAMETERS_BY_OPERATION: Readonly<
  Record<string, readonly string[]>
> = {
  "list-stacks": [],
  "describe-stack": ["stackName"],
  "describe-stack-events": ["stackName"],
  "create-stack": ["input"],
  "update-stack": ["input"],
  "delete-stack": ["stackName"],
  "wait-stack-create-complete": ["stackName"],
  "wait-stack-update-complete": ["stackName"],
  "wait-stack-delete-complete": ["stackName"],
};

describe("'operation' parameter's declared operations (ADR-0055 introspection)", () => {
  it("getOperations() round-trips names, in order, non-blank descriptions, and requiredParameters", () => {
    const operations = paramNamed("operation").getOperations();

    expect(operations).toBeDefined();
    const names = (operations ?? []).map((operation) => operation.name);
    expect(names).toEqual(EXPECTED_OPERATIONS);

    for (const operation of operations ?? []) {
      expect(operation.description.trim().length).toBeGreaterThan(0);
      expect(operation.requiredParameters ?? []).toEqual(
        REQUIRED_PARAMETERS_BY_OPERATION[operation.name],
      );
    }
  });

  it("returns a frozen projection — never the same reference twice, but always structurally equal", () => {
    const first = paramNamed("operation").getOperations();
    const second = paramNamed("operation").getOperations();

    expect(first).toEqual(second);
  });

  it("every requiredParameters entry names a declared configParameters entry (subset check)", () => {
    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    const operations = paramNamed("operation").getOperations() ?? [];

    for (const operation of operations) {
      for (const entry of operation.requiredParameters ?? []) {
        expect(declaredNames.has(entry)).toBe(true);
      }
    }
  });
});
