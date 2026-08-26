import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/s3-objects.md "Configuration schema"
 * table + `src/config.ts`. 13 declared parameters: aws.profile, operation,
 * bucket, key, prefix, pageSize, sourceBucket, sourceKey, contentType,
 * input, output, yes, yesSensitive (ADR-0048 fleet retrofit — F2b, issue
 * #483). This file asserts the DECLARED shape only — names, uniqueness,
 * instance types, and each parameter's own validator/default — never the
 * library's own provider-resolution order. The per-operation cross-parameter
 * requirements (e.g. `key` required for `describe`) are NOT expressible by a
 * single parameter's validator and are guard-checked at run start instead
 * (see `tests/steps/run-s3-objects.test.ts`). The `yesSensitive` -> `yes`
 * cross-parameter constraint IS expressible at the schema level and is
 * covered by the `configValidators` describe block below.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "bucket",
  "key",
  "prefix",
  "pageSize",
  "sourceBucket",
  "sourceKey",
  "contentType",
  "input",
  "output",
  "yes",
  "yesSensitive",
] as const;

const S3_OBJECTS_OPERATIONS = [
  "list",
  "describe",
  "get",
  "put",
  "copy",
  "delete",
  "delete-batch",
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

describe("s3-objects config declaration", () => {
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
  });

  describe("'operation' — required, oneOf(list, describe, get, put, copy, delete, delete-batch)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("operation"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(S3_OBJECTS_OPERATIONS)("accepts '%s'", async (value) => {
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

  describe("'bucket' — required, nonEmpty", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("bucket"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it("rejects an empty string and accepts a non-empty one", async () => {
      const parameter = paramNamed("bucket");
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(resolveWith(parameter, "reports")).resolves.toBe("reports");
    });
  });

  describe("'key'/'prefix'/'sourceBucket'/'sourceKey'/'contentType'/'input'/'output' — optional, nonEmpty when set", () => {
    const optionalStringNames = [
      "key",
      "prefix",
      "sourceBucket",
      "sourceKey",
      "contentType",
      "input",
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

  describe("'pageSize' — INT, range(1, 1_000), optional", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("pageSize")),
      ).resolves.toBeUndefined();
    });

    it("accepts the boundary values 1 and 1_000", async () => {
      await expect(resolveWith(paramNamed("pageSize"), "1")).resolves.toBe(1);
      await expect(resolveWith(paramNamed("pageSize"), "1000")).resolves.toBe(
        1_000,
      );
    });

    it("rejects 0 and 1_001", async () => {
      await expect(
        resolveWith(paramNamed("pageSize"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("pageSize"), "1001"),
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

  describe("'yesSensitive' — BOOL, default false (ADR-0048)", () => {
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
 * F2b (ADR-0048 fleet retrofit, issue #483) — `yesSensitive` is only a
 * meaningful bypass companion to `yes` (see `Core.confirmDestructive`'s
 * state 3: both must be `true` together to bypass a sensitive target's
 * escalated confirmation). A `yesSensitive: true` without `yes` resolving to
 * `true` is pointless-to-dangerous config drift the schema should reject
 * outright rather than silently falling through to the still-escalated
 * state 4.
 *
 * `configValidators` enforces this with a value-based inline predicate
 * (`scripts/s3-objects/src/config.ts`), not
 * `Core.M3LConfigSchemaValidators.requires`: both `yes` and `yesSensitive`
 * carry declared defaults, so `config.get()` never returns `undefined` for
 * either and a presence-based `requires` check would never fire. The
 * predicate instead compares resolved values — `yesSensitive: true` requires
 * `yes` to actually resolve to `true`, not merely be set to some value.
 */
describe("configValidators — yesSensitive requires yes (ADR-0048)", () => {
  it("fails with the documented reason when 'yesSensitive' is true and 'yes' is unset", () => {
    const config = buildConfig({
      [Core.AWS_PROFILE_PARAM_NAME]: "default",
      operation: "delete",
      yesSensitive: true,
    });

    expect(firstFailure(config)).toBe(
      "'yesSensitive' requires 'yes' to be set",
    );
  });

  it("passes when 'yesSensitive' is true and 'yes' is explicitly true", () => {
    const config = buildConfig({
      [Core.AWS_PROFILE_PARAM_NAME]: "default",
      operation: "delete",
      yesSensitive: true,
      yes: true,
    });

    expect(firstFailure(config)).toBeUndefined();
  });

  it("fails when 'yesSensitive' is true and 'yes' is explicitly false", () => {
    const config = buildConfig({
      [Core.AWS_PROFILE_PARAM_NAME]: "default",
      operation: "delete",
      yesSensitive: true,
      yes: false,
    });

    expect(firstFailure(config)).toBe(
      "'yesSensitive' requires 'yes' to be set",
    );
  });

  it("passes when 'yesSensitive' is unset regardless of 'yes'", () => {
    const config = buildConfig({
      [Core.AWS_PROFILE_PARAM_NAME]: "default",
      operation: "delete",
    });

    expect(firstFailure(config)).toBeUndefined();
  });
});

/**
 * Hand-authored per the task spec, NOT re-derived from
 * `S3_OBJECTS_OPERATION_DECLARATIONS` — the point of this table is to catch
 * a `src/config.ts` typo, not to restate whatever `src` currently says.
 */
const S3_OBJECTS_OPERATION_REQUIRED_PARAMETERS: Readonly<
  Record<(typeof S3_OBJECTS_OPERATIONS)[number], readonly string[]>
> = {
  list: ["output"],
  describe: ["key", "output"],
  get: ["key", "output"],
  put: ["key", "input"],
  copy: ["key", "sourceBucket", "sourceKey"],
  delete: ["key"],
  "delete-batch": ["input"],
};

describe("'operation' declared operations (getOperations() round-trip, ADR-0055)", () => {
  it("declares an operations list on the 'operation' parameter", () => {
    const operations = paramNamed("operation").getOperations();
    expect(operations).toBeDefined();
  });

  it("declares operation names, in order, matching S3_OBJECTS_OPERATIONS", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    expect(operations.map((operation) => operation.name)).toEqual(
      S3_OBJECTS_OPERATIONS,
    );
  });

  it("gives every operation a non-blank description", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      expect(operation.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("declares the documented requiredParameters for every operation (frozen projection — toEqual, not toBe)", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      expect(operation.requiredParameters).toEqual(
        S3_OBJECTS_OPERATION_REQUIRED_PARAMETERS[
          operation.name as (typeof S3_OBJECTS_OPERATIONS)[number]
        ],
      );
    }
  });

  it("names only declared config parameters in every operation's requiredParameters (subset check)", () => {
    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      for (const requiredName of operation.requiredParameters ?? []) {
        expect(declaredNames.has(requiredName)).toBe(true);
      }
    }
  });
});

/**
 * ADR-0055's opt-in clause: declaring `requiredParameters` on an operation
 * is metadata for CLI introspection ONLY — it does not, by itself, derive
 * any enforcement. `s3-objects` never opted in (`configValidators` contains
 * only the `yesSensitive` ⇒ `yes` guard above; `Core.deriveOperationValidators`
 * is not spread into it), so presence enforcement for e.g.
 * `key`/`sourceBucket`/`sourceKey` on `copy` stays exactly where it was
 * before this retrofit: the run-start guard in `steps/run-s3-objects.ts`
 * (`Core.M3LOperationPipeline`'s `requiredFields` option). This test pins
 * that intent — it is not documenting an oversight, and should keep passing
 * unchanged even as `S3_OBJECTS_OPERATION_DECLARATIONS` grows new
 * operations/fields.
 */
describe("ADR-0055 opt-in clause — requiredParameters is declarative metadata only", () => {
  it("declares exactly one configValidators entry (the yesSensitive => yes guard)", () => {
    expect(configValidators.length).toBe(1);
  });

  it("does not enforce a declared operation's requiredParameters at config-load time ('copy' requires key/sourceBucket/sourceKey, all left unset)", () => {
    const config = buildConfig({
      [Core.AWS_PROFILE_PARAM_NAME]: "default",
      operation: "copy",
      bucket: "reports",
      // Deliberately omit key/sourceBucket/sourceKey — 'copy's declared
      // requiredParameters — to prove config-load validation does not
      // enforce them; enforcement lives in the run-start guard instead.
    });

    expect(firstFailure(config)).toBeUndefined();
  });
});
