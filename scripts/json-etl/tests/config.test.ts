import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/json-etl.md "Configuration schema" table.
 * 8 declared parameters: input, fields, filters, format, output, limit, sort,
 * multiValue. This file asserts the DECLARED shape only — names, uniqueness,
 * instance types, and each parameter's own validator/default — never the
 * library's 8-level provider-resolution order (that's the library's own
 * test suite's job).
 *
 * F1b: cross-parameter constraints ("sort requires limit", "sort's name must
 * be one of fields' output columns") are declared as `configValidators`
 * (`Core.M3LConfigSchemaValidator[]`) instead of hand-rolled run-start guards
 * in `steps/run-json-etl.ts`. Per docs/reference/core/config.md's "Cross-parameter
 * validation" section, each validator is `(config: Core.M3LConfig) => true | string`
 * and is run fail-fast, in declaration order, by `Core.M3LConfigSchema.validate`.
 */

const EXPECTED_NAMES = [
  "input",
  "fields",
  "filters",
  "format",
  "output",
  "limit",
  "sort",
  "multiValue",
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

describe("json-etl config declaration", () => {
  it("declares exactly the 8 documented parameters, in order", () => {
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

  describe("required non-empty parameters (input, fields, output)", () => {
    it.each(["input", "output"] as const)(
      "'%s' rejects an empty string and accepts a non-empty one",
      async (name) => {
        const parameter = paramNamed(name);
        await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
          Core.M3LConfigValidationError,
        );
        await expect(resolveWith(parameter, "value.json")).resolves.toBe(
          "value.json",
        );
      },
    );

    it("'fields' rejects an empty list and accepts a non-empty one", async () => {
      const parameter = paramNamed("fields");
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(resolveWith(parameter, "id=id")).resolves.toEqual(["id=id"]);
    });

    it.each(["input", "fields", "output"] as const)(
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

  describe("'filters' — defaults to an empty list", () => {
    it("defaults to []", async () => {
      const parameter = paramNamed("filters");
      await expect(resolveDefault(parameter)).resolves.toEqual([]);
    });
  });

  describe("'format' — oneOf(json, jsonl, csv, html), default 'json'", () => {
    it("defaults to 'json'", async () => {
      await expect(resolveDefault(paramNamed("format"))).resolves.toBe("json");
    });

    it.each(["json", "jsonl", "csv", "html"] as const)(
      "accepts '%s'",
      async (value) => {
        await expect(resolveWith(paramNamed("format"), value)).resolves.toBe(
          value,
        );
      },
    );

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("format"), "xml"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'multiValue' — oneOf(join, explode), default 'join'", () => {
    it("defaults to 'join'", async () => {
      await expect(resolveDefault(paramNamed("multiValue"))).resolves.toBe(
        "join",
      );
    });

    it.each(["join", "explode"] as const)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("multiValue"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("multiValue"), "scatter"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'limit' — range(1, Number.MAX_SAFE_INTEGER), optional", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("limit")),
      ).resolves.toBeUndefined();
    });

    it("accepts 1 and rejects 0", async () => {
      await expect(resolveWith(paramNamed("limit"), "1")).resolves.toBe(1);
      await expect(
        resolveWith(paramNamed("limit"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'sort' — regex ^[^:]+:(asc|desc)$, optional", () => {
    it("has no default (unset)", async () => {
      await expect(resolveDefault(paramNamed("sort"))).resolves.toBeUndefined();
    });

    it.each(["name:asc", "name:desc"] as const)(
      "accepts '%s'",
      async (value) => {
        await expect(resolveWith(paramNamed("sort"), value)).resolves.toBe(
          value,
        );
      },
    );

    it("rejects a value with no ':asc'/':desc' suffix", async () => {
      await expect(
        resolveWith(paramNamed("sort"), "name"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });
});

describe("configValidators (F1b — cross-parameter validation)", () => {
  describe("'sort' requires 'limit'", () => {
    it("returns the documented failure reason when 'sort' is set without 'limit'", () => {
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id"],
        output: "out.jsonl",
        sort: "id:asc",
      });

      expect(firstFailure(config)).toBe("'sort' requires 'limit' to be set");
    });

    it("passes every validator when both 'sort' and 'limit' are set", () => {
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id"],
        output: "out.jsonl",
        sort: "id:asc",
        limit: 2,
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when neither 'sort' nor 'limit' is set", () => {
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id"],
        output: "out.jsonl",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'sort' name must be one of 'fields' output columns", () => {
    it("returns a failure reason describing the constraint WITHOUT embedding the received 'sort' value", () => {
      // `M3LConfigSchemaValidator`'s TSDoc and docs/reference/core/config.md's
      // "Cross-parameter validation" section both require a validator's
      // reason to describe the CONSTRAINT, never the received value — mirroring
      // the stock `M3LConfigValidators` factories (range/regex/oneOf/minLength),
      // none of which embed the operator-supplied value in their message.
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id", "name=metadata.name"],
        output: "out.jsonl",
        sort: "unknownfield:asc",
        limit: 2,
      });

      const result = firstFailure(config);
      expect(result).not.toContain("unknownfield");
      expect(result).toMatch(/'sort'/);
      expect(result).toContain("fields");
    });

    it("passes every validator when the sort name is a declared output column", () => {
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id"],
        output: "out.jsonl",
        sort: "id:desc",
        limit: 2,
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when 'sort' is unset, regardless of 'fields'", () => {
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id"],
        output: "out.jsonl",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("accepts the column name before '=' for a 'name=path' extraction-spec field", () => {
      const config = buildConfig({
        input: "in.jsonl",
        fields: ["id=id", "tags=items.*.tag"],
        output: "out.jsonl",
        sort: "tags:asc",
        limit: 2,
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });
});
