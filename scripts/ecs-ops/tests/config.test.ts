import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, ECS_OPERATIONS } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/ecs-ops.md "Configuration schema" table +
 * `src/config.ts`. 11 declared parameters: aws.profile, operation, cluster,
 * service, services, input, nextToken, force, maxWaitTime, output, yes. This
 * file asserts the DECLARED shape only — names, uniqueness, instance types,
 * and each parameter's own validator/default — never the library's own
 * provider-resolution order or the per-operation cross-parameter
 * requirements (guard-checked at run start instead — see
 * `tests/run-ecs-ops.test.ts`).
 *
 * `ECS_OPERATIONS` is declared as a bare `as const` array (the same
 * "bare `as const` + derived union" idiom `LAMBDA_OPERATIONS`/
 * `DYNAMO_OPERATIONS` use) so the closed set is independently assertable
 * without exercising config resolution.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "cluster",
  "service",
  "services",
  "input",
  "nextToken",
  "force",
  "maxWaitTime",
  "output",
  "yes",
] as const;

const EXPECTED_OPERATIONS = [
  "list-services",
  "describe-service",
  "create-service",
  "update-service",
  "delete-service",
  "wait-services-stable",
  "list-clusters",
  "describe-cluster",
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

describe("ecs-ops ECS_OPERATIONS", () => {
  it("declares exactly the 8 documented operation strings, in order", () => {
    expect(ECS_OPERATIONS).toEqual(EXPECTED_OPERATIONS);
  });
});

describe("ecs-ops config declaration", () => {
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

  it("declares exactly the 11 documented parameters, in order", () => {
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

  describe("'operation' — required, oneOf(8 declared operations)", () => {
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

  describe("'cluster'/'service'/'services'/'input'/'nextToken'/'output' — optional, nonEmpty when set", () => {
    const optionalStringNames = [
      "cluster",
      "service",
      "services",
      "input",
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

  describe("'force' — BOOL, default false", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("force"))).resolves.toBe(false);
    });

    it("accepts an explicit true", async () => {
      await expect(resolveWith(paramNamed("force"), "true")).resolves.toBe(
        true,
      );
    });
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
