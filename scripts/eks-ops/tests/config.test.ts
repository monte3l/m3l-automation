import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  EKS_OPS_OPERATIONS,
  FORCE_DEFAULT,
  MAX_WAIT_TIME_DEFAULT,
  YES_DEFAULT,
  configParameters,
  configValidators,
} from "../src/config.js";

/**
 * Contract: docs/reference/scripts/eks-ops.md "Configuration schema" table +
 * `src/config.ts`. 15 declared parameters: aws.profile, operation, cluster,
 * nodegroup, input, output, kubernetesVersion, releaseVersion, force,
 * maxResults, nextToken, include, maxWaitTime, yes, yesSensitive — spanning
 * the 16 documented `EKS_OPS_OPERATIONS` values. `yesSensitive` is the
 * ADR-0048 target-graded destructive-confirmation bypass companion to `yes`
 * (see `Core.confirmDestructive`'s TSDoc for the deliberately asymmetric
 * polarity between the two flags) — its own cross-parameter constraint
 * (`yesSensitive` requires `yes`) is asserted in the `configValidators`
 * describe block below, not here. This file asserts the DECLARED
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
  "yesSensitive",
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

  describe("'yesSensitive' — BOOL, default false (ADR-0048 sensitive-target bypass companion to 'yes')", () => {
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

/**
 * F1b: `eks-ops`'s per-operation "Required for" cross-parameter constraints
 * (docs/reference/scripts/eks-ops.md § Configuration schema), retrofitted as
 * declarative `configValidators` (`Core.M3LConfigSchemaValidator[]`) instead
 * of `steps/run-eks-ops.ts`'s hand-rolled `accessor.requiredFor(...)` guards
 * (mirrors the `json-etl`/`cloudwatch-logs-insights` F1b retrofit). Rules
 * verified directly against `run-eks-ops.ts`'s `accessor.requiredFor(...)`
 * call sites, not just the doc table:
 *
 * - `cluster` — required for every operation EXCEPT `list-clusters`.
 * - `nodegroup` — required for `describe-nodegroup`, `create-nodegroup`,
 *   `update-nodegroup-config`, `update-nodegroup-version`, `delete-nodegroup`,
 *   `wait-nodegroup-active`, `wait-nodegroup-deleted`.
 * - `input` — required for `create-cluster`, `update-cluster-config`,
 *   `create-nodegroup`, `update-nodegroup-config`.
 * - `kubernetesVersion` — required for `update-cluster-version` (optional
 *   for every other operation, including `update-nodegroup-version`, per
 *   `run-eks-ops.ts:239-240`'s `accessor.requiredFor(...)` call, only
 *   reached when `operation === "update-cluster-version"`).
 */
describe("configValidators (F1b — cross-parameter validation)", () => {
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

  const NODEGROUP_REQUIRING_OPERATIONS = [
    "describe-nodegroup",
    "create-nodegroup",
    "update-nodegroup-config",
    "update-nodegroup-version",
    "delete-nodegroup",
    "wait-nodegroup-active",
    "wait-nodegroup-deleted",
  ] as const;
  const INPUT_REQUIRING_OPERATIONS = [
    "create-cluster",
    "update-cluster-config",
    "create-nodegroup",
    "update-nodegroup-config",
  ] as const;
  const CLUSTER_REQUIRING_OPERATIONS = EKS_OPS_OPERATIONS.filter(
    (operation) => operation !== "list-clusters",
  );

  /** The non-tested "Required for" params an operation also needs, so a test can isolate a single validator's failure. */
  function otherRequiredFieldsFor(
    operation: (typeof EKS_OPS_OPERATIONS)[number],
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (operation !== "list-clusters") {
      fields["cluster"] = "my-cluster";
    }
    if (
      (NODEGROUP_REQUIRING_OPERATIONS as readonly string[]).includes(operation)
    ) {
      fields["nodegroup"] = "my-nodegroup";
    }
    if ((INPUT_REQUIRING_OPERATIONS as readonly string[]).includes(operation)) {
      fields["input"] = "payload.json";
    }
    if (operation === "update-cluster-version") {
      fields["kubernetesVersion"] = "1.30";
    }
    return fields;
  }

  describe("'cluster' — required for every operation except list-clusters", () => {
    it.each(CLUSTER_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'cluster' when operation is '%s' and 'cluster' is unset",
      (operation) => {
        const fields = otherRequiredFieldsFor(operation);
        const { cluster: _omitted, ...withoutCluster } = fields;
        const config = buildConfig({ operation, ...withoutCluster });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'cluster'");
      },
    );

    it.each(CLUSTER_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and every required field (including 'cluster') is set",
      (operation) => {
        const config = buildConfig({
          operation,
          ...otherRequiredFieldsFor(operation),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when the non-requiring operation ('list-clusters') is set without 'cluster'", () => {
      const config = buildConfig({ operation: "list-clusters" });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'nodegroup' — required for the seven nodegroup-scoped operations", () => {
    it.each(NODEGROUP_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'nodegroup' when operation is '%s' and 'nodegroup' is unset",
      (operation) => {
        const fields = otherRequiredFieldsFor(operation);
        const { nodegroup: _omitted, ...withoutNodegroup } = fields;
        const config = buildConfig({ operation, ...withoutNodegroup });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'nodegroup'");
      },
    );

    it.each(NODEGROUP_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and every required field (including 'nodegroup') is set",
      (operation) => {
        const config = buildConfig({
          operation,
          ...otherRequiredFieldsFor(operation),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when a non-requiring operation ('list-nodegroups') is set without 'nodegroup'", () => {
      const config = buildConfig({
        operation: "list-nodegroups",
        cluster: "my-cluster",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'input' — required for create-cluster/update-cluster-config/create-nodegroup/update-nodegroup-config", () => {
    it.each(INPUT_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'input' when operation is '%s' and 'input' is unset",
      (operation) => {
        const fields = otherRequiredFieldsFor(operation);
        const { input: _omitted, ...withoutInput } = fields;
        const config = buildConfig({ operation, ...withoutInput });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'input'");
      },
    );

    it.each(INPUT_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and every required field (including 'input') is set",
      (operation) => {
        const config = buildConfig({
          operation,
          ...otherRequiredFieldsFor(operation),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when a non-requiring operation ('describe-cluster') is set without 'input'", () => {
      const config = buildConfig({
        operation: "describe-cluster",
        cluster: "my-cluster",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'kubernetesVersion' — required for update-cluster-version", () => {
    it("returns a failure reason describing 'kubernetesVersion' when operation is 'update-cluster-version' and 'kubernetesVersion' is unset", () => {
      const config = buildConfig({
        operation: "update-cluster-version",
        cluster: "my-cluster",
      });

      const result = firstFailure(config);
      expect(typeof result).toBe("string");
      expect(result).toContain("'kubernetesVersion'");
    });

    it("passes every validator when operation is 'update-cluster-version' and every required field (including 'kubernetesVersion') is set", () => {
      const config = buildConfig({
        operation: "update-cluster-version",
        cluster: "my-cluster",
        kubernetesVersion: "1.30",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when a non-requiring operation ('update-nodegroup-version') is set without 'kubernetesVersion'", () => {
      const config = buildConfig({
        operation: "update-nodegroup-version",
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'yesSensitive' — requires 'yes' to also be set (Core.M3LConfigSchemaValidators.requires)", () => {
    it("returns \"'yesSensitive' requires 'yes' to be set\" when 'yesSensitive' is true and 'yes' is unset", () => {
      const config = buildConfig({
        operation: "list-clusters",
        yesSensitive: true,
      });

      expect(firstFailure(config)).toBe(
        "'yesSensitive' requires 'yes' to be set",
      );
    });

    it("passes every validator when both 'yesSensitive' and 'yes' are set", () => {
      const config = buildConfig({
        operation: "list-clusters",
        yesSensitive: true,
        yes: true,
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when 'yesSensitive' is unset, regardless of 'yes'", () => {
      const config = buildConfig({ operation: "list-clusters" });

      expect(firstFailure(config)).toBeUndefined();
    });
  });
});
