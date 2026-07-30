import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  ECS_OPERATIONS,
} from "../src/config.js";

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

/**
 * F1b: `ecs-ops`'s per-operation "Required for" cross-parameter constraints
 * (docs/reference/scripts/ecs-ops.md § Configuration schema), retrofitted as
 * declarative `configValidators` (`Core.M3LConfigSchemaValidator[]`) instead
 * of `steps/run-ecs-ops.ts`'s hand-rolled `accessor.requiredFor(...)` guards
 * (mirrors the `json-etl`/`cloudwatch-logs-insights` F1b retrofit). Rules
 * verified directly against `run-ecs-ops.ts`'s `accessor.requiredFor(...)`
 * call sites, not just the doc table:
 *
 * - `cluster` — required for `describe-service`, `delete-service`,
 *   `wait-services-stable`, `describe-cluster`.
 * - `service` — required for `describe-service`, `delete-service`.
 * - `services` — required for `wait-services-stable`.
 * - `input` — required for `create-service`, `update-service`.
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

  const CLUSTER_REQUIRING_OPERATIONS = [
    "describe-service",
    "delete-service",
    "wait-services-stable",
    "describe-cluster",
  ] as const;
  const SERVICE_REQUIRING_OPERATIONS = [
    "describe-service",
    "delete-service",
  ] as const;

  /** The non-tested "Required for" params an operation also needs, so a test can isolate a single validator's failure. */
  function otherRequiredFieldsFor(
    operation: (typeof ECS_OPERATIONS)[number],
  ): Record<string, unknown> {
    switch (operation) {
      case "describe-service":
      case "delete-service":
        return { cluster: "my-cluster", service: "my-service" };
      case "wait-services-stable":
        return { cluster: "my-cluster", services: "svc-a,svc-b" };
      case "describe-cluster":
        return { cluster: "my-cluster" };
      case "create-service":
      case "update-service":
        return { input: "payload.json" };
      case "list-services":
      case "list-clusters":
        return {};
    }
  }

  describe("'cluster' — required for describe-service/delete-service/wait-services-stable/describe-cluster", () => {
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

    it("passes every validator when a non-requiring operation ('list-services') is set without 'cluster'", () => {
      const config = buildConfig({ operation: "list-services" });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'service' — required for describe-service/delete-service", () => {
    it.each(SERVICE_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'service' when operation is '%s' and 'service' is unset",
      (operation) => {
        const config = buildConfig({ operation, cluster: "my-cluster" });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'service'");
      },
    );

    it.each(SERVICE_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and both 'cluster'/'service' are set",
      (operation) => {
        const config = buildConfig({
          operation,
          cluster: "my-cluster",
          service: "my-service",
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when a non-requiring operation ('wait-services-stable') is set without 'service'", () => {
      const config = buildConfig({
        operation: "wait-services-stable",
        cluster: "my-cluster",
        services: "svc-a",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'services' — required for wait-services-stable", () => {
    it("returns a failure reason describing 'services' when operation is 'wait-services-stable' and 'services' is unset", () => {
      const config = buildConfig({
        operation: "wait-services-stable",
        cluster: "my-cluster",
      });

      const result = firstFailure(config);
      expect(typeof result).toBe("string");
      expect(result).toContain("'services'");
    });

    it("passes every validator when operation is 'wait-services-stable' and 'cluster'/'services' are both set", () => {
      const config = buildConfig({
        operation: "wait-services-stable",
        cluster: "my-cluster",
        services: "svc-a,svc-b",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when a non-requiring operation ('list-clusters') is set without 'services'", () => {
      const config = buildConfig({ operation: "list-clusters" });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'input' — required for create-service/update-service", () => {
    it.each(["create-service", "update-service"] as const)(
      "returns a failure reason describing 'input' when operation is '%s' and 'input' is unset",
      (operation) => {
        const config = buildConfig({ operation });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'input'");
      },
    );

    it.each(["create-service", "update-service"] as const)(
      "passes every validator when operation is '%s' and 'input' is set",
      (operation) => {
        const config = buildConfig({ operation, input: "payload.json" });

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
});
