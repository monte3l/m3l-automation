import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, SQS_ETL_COMMANDS } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md "Configuration schema" table +
 * `src/config.ts`. 12 declared parameters: aws.profile, command, queueUrl,
 * dlqUrl, input, output, batchSize, visibilityTimeoutSeconds,
 * deleteAfterDump, yes, fields, filters. This file asserts the DECLARED
 * shape only — names, uniqueness, instance types, and each parameter's own
 * validator/default — never the library's own provider-resolution order.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "command",
  "queueUrl",
  "dlqUrl",
  "input",
  "output",
  "batchSize",
  "visibilityTimeoutSeconds",
  "deleteAfterDump",
  "yes",
  "fields",
  "filters",
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

describe("sqs-etl config declaration", () => {
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

  it("declares exactly the 12 documented parameters, in order", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(names).toEqual(EXPECTED_NAMES);
  });

  it("exports SQS_ETL_COMMANDS with the 6 documented command modes", () => {
    expect(SQS_ETL_COMMANDS).toEqual([
      "dump",
      "send",
      "redrive",
      "delete",
      "purge",
      "transform",
    ]);
  });

  describe("'command' — required, oneOf(SQS_ETL_COMMANDS)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("command"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(SQS_ETL_COMMANDS)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("command"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("command"), "list"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'queueUrl'/'dlqUrl'/'input'/'output' — optional, nonEmpty when set", () => {
    it.each(["queueUrl", "dlqUrl", "input", "output"] as const)(
      "'%s' has no default (unset)",
      async (name) => {
        await expect(resolveDefault(paramNamed(name))).resolves.toBeUndefined();
      },
    );

    it.each(["queueUrl", "dlqUrl", "input", "output"] as const)(
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

  describe("'batchSize' — INT, range(1, 10_000), default 100", () => {
    it("defaults to 100", async () => {
      await expect(resolveDefault(paramNamed("batchSize"))).resolves.toBe(100);
    });

    it("accepts the boundary values 1 and 10_000", async () => {
      await expect(resolveWith(paramNamed("batchSize"), "1")).resolves.toBe(1);
      await expect(resolveWith(paramNamed("batchSize"), "10000")).resolves.toBe(
        10_000,
      );
    });

    it("rejects 0 and 10_001", async () => {
      await expect(
        resolveWith(paramNamed("batchSize"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("batchSize"), "10001"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'visibilityTimeoutSeconds' — INT, range(0, 43_200), optional", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("visibilityTimeoutSeconds")),
      ).resolves.toBeUndefined();
    });

    it("accepts the boundary values 0 and 43_200", async () => {
      await expect(
        resolveWith(paramNamed("visibilityTimeoutSeconds"), "0"),
      ).resolves.toBe(0);
      await expect(
        resolveWith(paramNamed("visibilityTimeoutSeconds"), "43200"),
      ).resolves.toBe(43_200);
    });

    it("rejects a negative value and a value above the cap", async () => {
      await expect(
        resolveWith(paramNamed("visibilityTimeoutSeconds"), "-1"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("visibilityTimeoutSeconds"), "43201"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'deleteAfterDump'/'yes' — BOOL, default false", () => {
    it.each(["deleteAfterDump", "yes"] as const)(
      "'%s' defaults to false",
      async (name) => {
        await expect(resolveDefault(paramNamed(name))).resolves.toBe(false);
      },
    );

    it.each(["deleteAfterDump", "yes"] as const)(
      "'%s' accepts an explicit true",
      async (name) => {
        await expect(resolveWith(paramNamed(name), "true")).resolves.toBe(true);
      },
    );
  });

  describe("'fields'/'filters' — STRING_ARRAY, default []", () => {
    it.each(["fields", "filters"] as const)(
      "'%s' defaults to []",
      async (name) => {
        await expect(resolveDefault(paramNamed(name))).resolves.toEqual([]);
      },
    );

    it("'fields' accepts a populated list", async () => {
      await expect(resolveWith(paramNamed("fields"), "id=id")).resolves.toEqual(
        ["id=id"],
      );
    });

    it("'filters' accepts a populated list", async () => {
      await expect(
        resolveWith(paramNamed("filters"), "status eq active"),
      ).resolves.toEqual(["status eq active"]);
    });
  });

  describe(`'${Core.AWS_PROFILE_PARAM_NAME}' — required`, () => {
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
});
