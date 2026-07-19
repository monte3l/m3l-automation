import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/athena-query.md "Configuration schema"
 * table. 10 declared parameters: aws.profile, queryString, database, catalog,
 * outputLocation, workGroup, executionParameters, format, output, resume.
 *
 * This file asserts the DECLARED shape — names, uniqueness, instance types,
 * and each parameter's own type/default/validator — never the library's own
 * 8-level provider-resolution order (that's the library's own suite's job).
 * `M3LConfigParameter` exposes no public getter for its declared `type` or
 * `defaultValue` (only `getName`/`getAliases`), so the only way to observe
 * them is through `getValueAsync` against a minimal, single-value reader (or
 * no reader at all, for the default) — matching the established pattern in
 * `scripts/cloudwatch-logs-insights/tests/config.test.ts`.
 */

const EXPECTED_NAMES = [
  "aws.profile",
  "queryString",
  "database",
  "catalog",
  "outputLocation",
  "workGroup",
  "executionParameters",
  "format",
  "output",
  "resume",
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

describe("athena-query config declaration", () => {
  it("declares exactly the 10 documented parameters, in order", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(names).toEqual(EXPECTED_NAMES);
  });

  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  describe("required, non-empty string parameters (aws.profile, queryString, output)", () => {
    it.each(["aws.profile", "queryString", "output"] as const)(
      "'%s' rejects an empty string and accepts a non-empty one (declared STRING)",
      async (name) => {
        const parameter = paramNamed(name);
        await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
          Core.M3LConfigValidationError,
        );
        await expect(resolveWith(parameter, "value")).resolves.toBe("value");
      },
    );

    it.each(["aws.profile", "queryString", "output"] as const)(
      "'%s' rejects a MISSING value (no provider, no default) with M3LConfigMissingError",
      async (name) => {
        const parameter = paramNamed(name);
        let thrown: unknown;
        try {
          await resolveDefault(parameter);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
        expect((thrown as Core.M3LConfigMissingError).code).toBe(
          "ERR_CONFIG_MISSING",
        );
      },
    );
  });

  describe("optional, unvalidated STRING parameters (database, catalog, outputLocation, workGroup)", () => {
    it.each(["database", "catalog", "outputLocation", "workGroup"] as const)(
      "'%s' has no default (unset) and passes a provided string through unchanged",
      async (name) => {
        const parameter = paramNamed(name);
        await expect(resolveDefault(parameter)).resolves.toBeUndefined();
        await expect(resolveWith(parameter, "value")).resolves.toBe("value");
      },
    );
  });

  describe("'executionParameters' — optional STRING_ARRAY, no default", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("executionParameters")),
      ).resolves.toBeUndefined();
    });

    it("coerces a comma-separated string into an array (declared STRING_ARRAY)", async () => {
      await expect(
        resolveWith(paramNamed("executionParameters"), "a,b"),
      ).resolves.toEqual(["a", "b"]);
    });
  });

  describe("'format' — oneOf(json, csv), default 'json'", () => {
    it("defaults to 'json'", async () => {
      await expect(resolveDefault(paramNamed("format"))).resolves.toBe("json");
    });

    it.each(["json", "csv"] as const)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("format"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("format"), "xml"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'resume' — BOOL, default false", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("resume"))).resolves.toBe(false);
    });

    it("coerces 'true'/'false' tokens to booleans (declared BOOL)", async () => {
      await expect(resolveWith(paramNamed("resume"), "true")).resolves.toBe(
        true,
      );
      await expect(resolveWith(paramNamed("resume"), "false")).resolves.toBe(
        false,
      );
    });
  });
});
