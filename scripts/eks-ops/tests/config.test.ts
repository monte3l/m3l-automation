import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  EKS_OPS_OPERATIONS,
  FORCE_DEFAULT,
  MAX_WAIT_TIME_DEFAULT,
  YES_DEFAULT,
  configParameters,
} from "../src/config.js";

/**
 * Contract: docs/reference/scripts/eks-ops.md "Configuration schema" table +
 * `src/config.ts`. 14 declared parameters: aws.profile, operation, cluster,
 * nodegroup, input, output, kubernetesVersion, releaseVersion, force,
 * maxResults, nextToken, include, maxWaitTime, yes — spanning the 16
 * documented `EKS_OPS_OPERATIONS` values. This file asserts the DECLARED
 * shape only — names, uniqueness, instance types, and each parameter's own
 * validator/default — never the per-operation cross-parameter requirements
 * (guard-checked at run start instead — see `tests/run-eks-ops.test.ts`).
 *
 * `EKS_OPS_OPERATIONS` is declared as a bare `as const` array (the same "bare
 * `as const` + derived union" idiom `CODEPIPELINE_OPS_OPERATIONS`/
 * `ECS_OPERATIONS` use) so the closed set is independently assertable
 * without exercising config resolution.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "cluster",
  "nodegroup",
  "input",
  "output",
  "kubernetesVersion",
  "releaseVersion",
  "force",
  "maxResults",
  "nextToken",
  "include",
  "maxWaitTime",
  "yes",
] as const;

const EXPECTED_OPERATIONS = [
  "list-clusters",
  "describe-cluster",
  "create-cluster",
  "update-cluster-config",
  "update-cluster-version",
  "delete-cluster",
  "wait-cluster-active",
  "wait-cluster-deleted",
  "list-nodegroups",
  "describe-nodegroup",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
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

describe("eks-ops EKS_OPS_OPERATIONS", () => {
  it("declares exactly the 16 documented operation strings, in order", () => {
    expect(EKS_OPS_OPERATIONS).toEqual(EXPECTED_OPERATIONS);
  });
});

describe("eks-ops config declaration", () => {
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

    it("accepts a non-empty profile name", async () => {
      await expect(
        resolveWith(paramNamed(Core.AWS_PROFILE_PARAM_NAME), "default"),
      ).resolves.toBe("default");
    });
  });

  describe("'operation' — required, oneOf(16 declared operations)", () => {
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

  describe("'cluster'/'nodegroup'/'input'/'output'/'kubernetesVersion'/'releaseVersion'/'nextToken' — optional, nonEmpty when set", () => {
    const optionalStringNames = [
      "cluster",
      "nodegroup",
      "input",
      "output",
      "kubernetesVersion",
      "releaseVersion",
      "nextToken",
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

  describe("'include' — STRING_ARRAY, optional, nonEmpty", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("include")),
      ).resolves.toBeUndefined();
    });

    it("accepts a comma-separated list, coerced to a string array", async () => {
      await expect(
        resolveWith(paramNamed("include"), "all,connector"),
      ).resolves.toEqual(["all", "connector"]);
    });

    it("rejects an empty string", async () => {
      await expect(
        resolveWith(paramNamed("include"), ""),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'force' — BOOL, default FORCE_DEFAULT (false)", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("force"))).resolves.toBe(
        FORCE_DEFAULT,
      );
    });

    it("accepts an explicit true", async () => {
      await expect(resolveWith(paramNamed("force"), "true")).resolves.toBe(
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

  describe("'maxResults' — INT, range(1, 100), optional, no default", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("maxResults")),
      ).resolves.toBeUndefined();
    });

    it("accepts the boundary values 1 and 100", async () => {
      await expect(resolveWith(paramNamed("maxResults"), "1")).resolves.toBe(1);
      await expect(resolveWith(paramNamed("maxResults"), "100")).resolves.toBe(
        100,
      );
    });

    it("rejects 0 and 101", async () => {
      await expect(
        resolveWith(paramNamed("maxResults"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("maxResults"), "101"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'maxWaitTime' — INT, default MAX_WAIT_TIME_DEFAULT (1200), range(1, 3600)", () => {
    it("defaults to MAX_WAIT_TIME_DEFAULT (1200)", async () => {
      await expect(resolveDefault(paramNamed("maxWaitTime"))).resolves.toBe(
        MAX_WAIT_TIME_DEFAULT,
      );
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
});
