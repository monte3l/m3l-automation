import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/json-etl.md "Configuration schema" table.
 * 8 declared parameters: input, fields, filters, format, output, limit, sort,
 * multiValue. This file asserts the DECLARED shape only — names, uniqueness,
 * instance types, and each parameter's own validator/default — never the
 * library's 8-level provider-resolution order (that's the library's own
 * test suite's job).
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
