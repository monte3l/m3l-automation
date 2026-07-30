import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  SQS_ETL_COMMANDS,
} from "../src/config.js";

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

/**
 * F1b: `sqs-etl`'s per-command "Required for" cross-parameter constraints
 * (docs/reference/scripts/sqs-etl.md § Configuration schema), retrofitted as
 * declarative `configValidators` (`Core.M3LConfigSchemaValidator[]`) instead
 * of each command's own step module (`steps/dump-queue.ts`,
 * `steps/send-batch.ts`, `steps/redrive-queue.ts`, `steps/delete-messages.ts`,
 * `steps/purge-queue.ts`, `steps/transform-records.ts`) hand-rolling its own
 * `accessor.requiredString(name, command)` guard (mirrors the
 * `json-etl`/`cloudwatch-logs-insights` F1b retrofit). Unlike the other
 * three fleet scripts, `sqs-etl` has no central dispatcher — the guard for
 * each command lives inside that command's own step module. Rules verified
 * directly against all six step modules' `accessor.requiredString(...)` call
 * sites, not just the doc table:
 *
 * - `queueUrl` — required for `dump`, `send`, `redrive`, `delete`, `purge`
 *   (NOT `transform`, which never touches SQS).
 * - `dlqUrl` — required for `redrive` only.
 * - `input` — required for `send`, `delete`, `transform`.
 * - `output` — required for `dump`, `transform`.
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

  const QUEUE_URL_REQUIRING_COMMANDS = [
    "dump",
    "send",
    "redrive",
    "delete",
    "purge",
  ] as const;
  const INPUT_REQUIRING_COMMANDS = ["send", "delete", "transform"] as const;
  const OUTPUT_REQUIRING_COMMANDS = ["dump", "transform"] as const;

  /** The non-tested "Required for" params a command also needs, so a test can isolate a single validator's failure. */
  function otherRequiredFieldsFor(
    command: (typeof SQS_ETL_COMMANDS)[number],
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if ((QUEUE_URL_REQUIRING_COMMANDS as readonly string[]).includes(command)) {
      fields["queueUrl"] = "https://sqs.example/queue";
    }
    if (command === "redrive") {
      fields["dlqUrl"] = "https://sqs.example/dlq";
    }
    if ((INPUT_REQUIRING_COMMANDS as readonly string[]).includes(command)) {
      fields["input"] = "records.jsonl";
    }
    if ((OUTPUT_REQUIRING_COMMANDS as readonly string[]).includes(command)) {
      fields["output"] = "records-out.jsonl";
    }
    return fields;
  }

  describe("'queueUrl' — required for dump/send/redrive/delete/purge", () => {
    it.each(QUEUE_URL_REQUIRING_COMMANDS)(
      "returns a failure reason describing 'queueUrl' when command is '%s' and 'queueUrl' is unset",
      (command) => {
        const fields = otherRequiredFieldsFor(command);
        const { queueUrl: _omitted, ...withoutQueueUrl } = fields;
        const config = buildConfig({ command, ...withoutQueueUrl });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'queueUrl'");
      },
    );

    it.each(QUEUE_URL_REQUIRING_COMMANDS)(
      "passes every validator when command is '%s' and every required field (including 'queueUrl') is set",
      (command) => {
        const config = buildConfig({
          command,
          ...otherRequiredFieldsFor(command),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when the non-requiring command ('transform') is set without 'queueUrl'", () => {
      const config = buildConfig({
        command: "transform",
        input: "records.jsonl",
        output: "records-out.jsonl",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'dlqUrl' — required for redrive", () => {
    it("returns a failure reason describing 'dlqUrl' when command is 'redrive' and 'dlqUrl' is unset", () => {
      const config = buildConfig({
        command: "redrive",
        queueUrl: "https://sqs.example/queue",
      });

      const result = firstFailure(config);
      expect(typeof result).toBe("string");
      expect(result).toContain("'dlqUrl'");
    });

    it("passes every validator when command is 'redrive' and both 'queueUrl'/'dlqUrl' are set", () => {
      const config = buildConfig({
        command: "redrive",
        queueUrl: "https://sqs.example/queue",
        dlqUrl: "https://sqs.example/dlq",
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when a non-requiring command ('dump') is set without 'dlqUrl'", () => {
      const config = buildConfig({
        command: "dump",
        queueUrl: "https://sqs.example/queue",
        output: "records-out.jsonl",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'input' — required for send/delete/transform", () => {
    it.each(INPUT_REQUIRING_COMMANDS)(
      "returns a failure reason describing 'input' when command is '%s' and 'input' is unset",
      (command) => {
        const fields = otherRequiredFieldsFor(command);
        const { input: _omitted, ...withoutInput } = fields;
        const config = buildConfig({ command, ...withoutInput });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'input'");
      },
    );

    it.each(INPUT_REQUIRING_COMMANDS)(
      "passes every validator when command is '%s' and every required field (including 'input') is set",
      (command) => {
        const config = buildConfig({
          command,
          ...otherRequiredFieldsFor(command),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when a non-requiring command ('purge') is set without 'input'", () => {
      const config = buildConfig({
        command: "purge",
        queueUrl: "https://sqs.example/queue",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'output' — required for dump/transform", () => {
    it.each(OUTPUT_REQUIRING_COMMANDS)(
      "returns a failure reason describing 'output' when command is '%s' and 'output' is unset",
      (command) => {
        const fields = otherRequiredFieldsFor(command);
        const { output: _omitted, ...withoutOutput } = fields;
        const config = buildConfig({ command, ...withoutOutput });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'output'");
      },
    );

    it.each(OUTPUT_REQUIRING_COMMANDS)(
      "passes every validator when command is '%s' and every required field (including 'output') is set",
      (command) => {
        const config = buildConfig({
          command,
          ...otherRequiredFieldsFor(command),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when a non-requiring command ('send') is set without 'output'", () => {
      const config = buildConfig({
        command: "send",
        queueUrl: "https://sqs.example/queue",
        input: "records.jsonl",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });
});
