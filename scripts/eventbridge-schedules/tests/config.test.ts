import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "../src/config.js";

/**
 * Contract: spec-conformance-reviewer's `scripts/eventbridge-schedules`
 * contract §1. 14 declared parameters, in order: aws.profile, operation,
 * ruleName, namePrefix, eventBusName, eventPattern, scheduleExpression,
 * state, description, roleArn, targets, force, output, yes. This file
 * asserts the DECLARED shape only — names, uniqueness, instance types, and
 * each parameter's own validator/default — never the library's own
 * provider-resolution order.
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

  it("declares exactly the 14 documented parameters, in order", () => {
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

  describe.each(["force", "yes"] as const)(
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
