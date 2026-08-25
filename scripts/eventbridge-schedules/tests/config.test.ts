import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "../src/config.js";

/**
 * Contract: spec-conformance-reviewer's `scripts/eventbridge-schedules`
 * contract §1, widened by ADR-0048 (Issue #483, A2b). 15 declared
 * parameters, in order: aws.profile, operation, ruleName, namePrefix,
 * eventBusName, eventPattern, scheduleExpression, state, description,
 * roleArn, targets, force, output, yes, yesSensitive. `yesSensitive` is the
 * target-graded destructive-confirmation bypass companion to `yes` (see
 * `Core.confirmDestructive`'s TSDoc for the deliberately asymmetric polarity
 * between the two flags) — its own cross-parameter constraint (`yesSensitive`
 * requires `yes`) is asserted in the `configValidators` describe block below,
 * not here. This file asserts the DECLARED shape only — names, uniqueness,
 * instance types, and each parameter's own validator/default — never the
 * library's own provider-resolution order.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "ruleName",
  "namePrefix",
  "eventBusName",
  "eventPattern",
  "scheduleExpression",
  "state",
  "description",
  "roleArn",
  "targets",
  "force",
  "output",
  "yes",
  "yesSensitive",
] as const;

const OPERATIONS = [
  "list",
  "describe",
  "create",
  "update",
  "delete",
  "enable",
  "disable",
] as const;

const STATES = [
  "ENABLED",
  "DISABLED",
  "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS",
] as const;

/** Resolves `parameter` against a single in-memory raw value keyed by its canonical name. */
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

describe("eventbridge-schedules config declaration", () => {
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

  it("declares exactly the 15 documented parameters, in order", () => {
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

    it("rejects an empty string and accepts a non-empty one", async () => {
      const parameter = paramNamed(Core.AWS_PROFILE_PARAM_NAME);
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(resolveWith(parameter, "default")).resolves.toBe("default");
    });
  });

  describe("'operation' — required, oneOf(list, describe, create, update, delete, enable, disable)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("operation"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(OPERATIONS)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("operation"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("operation"), "purge"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe.each([
    "ruleName",
    "namePrefix",
    "eventBusName",
    "eventPattern",
    "scheduleExpression",
    "roleArn",
    "targets",
  ] as const)("'%s' — optional, nonEmpty", (name) => {
    it("has no default (unset)", async () => {
      await expect(resolveDefault(paramNamed(name))).resolves.toBeUndefined();
    });

    it("rejects an empty string and accepts a non-empty one", async () => {
      const parameter = paramNamed(name);
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(resolveWith(parameter, "value")).resolves.toBe("value");
    });
  });

  describe(
    "'state' — optional, oneOf(ENABLED, DISABLED, " +
      "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS)",
    () => {
      it("has no default (unset)", async () => {
        await expect(
          resolveDefault(paramNamed("state")),
        ).resolves.toBeUndefined();
      });

      it.each(STATES)("accepts '%s'", async (value) => {
        await expect(resolveWith(paramNamed("state"), value)).resolves.toBe(
          value,
        );
      });

      it("rejects a value outside the declared set", async () => {
        await expect(
          resolveWith(paramNamed("state"), "PAUSED"),
        ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      });
    },
  );

  describe("'description' — optional, no validator", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("description")),
      ).resolves.toBeUndefined();
    });

    it("accepts an arbitrary string, including an empty one", async () => {
      await expect(resolveWith(paramNamed("description"), "")).resolves.toBe(
        "",
      );
      await expect(
        resolveWith(paramNamed("description"), "nightly cleanup rule"),
      ).resolves.toBe("nightly cleanup rule");
    });
  });

  describe("'output' — optional, nonEmpty", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("output")),
      ).resolves.toBeUndefined();
    });

    it("rejects an empty string and accepts a non-empty one", async () => {
      const parameter = paramNamed("output");
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(resolveWith(parameter, "out.json")).resolves.toBe(
        "out.json",
      );
    });
  });

  describe.each(["force", "yes", "yesSensitive"] as const)(
    "'%s' — BOOL, default false",
    (name) => {
      it("defaults to false", async () => {
        await expect(resolveDefault(paramNamed(name))).resolves.toBe(false);
      });

      it("accepts an explicit true", async () => {
        await expect(resolveWith(paramNamed(name), "true")).resolves.toBe(true);
      });
    },
  );
});

/**
 * ADR-0048 (Issue #483, A2b): `yesSensitive`'s cross-parameter constraint —
 * `yesSensitive` requires `yes` to also be set — is declared as a brand-new
 * `configValidators` export (this script had none before this retrofit),
 * containing exactly `Core.M3LConfigSchemaValidators.requires("yesSensitive",
 * "yes")`. Mirrors `eks-ops/tests/config.test.ts`'s equivalent describe block.
 */
describe("configValidators — yesSensitive requires yes", () => {
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

  it("returns \"'yesSensitive' requires 'yes' to be set\" when 'yesSensitive' is true and 'yes' is unset", () => {
    const config = buildConfig({
      operation: "list",
      yesSensitive: true,
    });

    expect(firstFailure(config)).toBe(
      "'yesSensitive' requires 'yes' to be set",
    );
  });

  it("passes every validator when both 'yesSensitive' and 'yes' are set", () => {
    const config = buildConfig({
      operation: "list",
      yesSensitive: true,
      yes: true,
    });

    expect(firstFailure(config)).toBeUndefined();
  });

  it("passes every validator when 'yesSensitive' is unset, regardless of 'yes'", () => {
    const config = buildConfig({ operation: "list" });

    expect(firstFailure(config)).toBeUndefined();
  });
});
