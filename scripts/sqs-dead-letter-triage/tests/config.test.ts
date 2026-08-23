import { describe, expect, it, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  MAX_MESSAGES_DEFAULT,
  RUNBOOK_DIR_DEFAULT,
  TRIAGE_OPERATIONS,
  VISIBILITY_TIMEOUT_DEFAULT,
} from "../src/config.js";

// The mandatory config-declaration smoke test (ADR-0022 §8). Importing the
// schema is itself an assertion: M3LConfigParameter validates a declared
// defaultValue eagerly in its constructor, so a default that violates its own
// validator fails this file at import time.
describe("sqs-dead-letter-triage config declaration", () => {
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

  it("declares exactly the nine parameters named in the contract table", () => {
    expect(new Set(configParameters.map((p) => p.getName()))).toEqual(
      new Set([
        "operation",
        "runbookDir",
        "queue",
        "source",
        "output",
        "queueUrl",
        "maxMessages",
        "visibilityTimeout",
        Core.AWS_PROFILE_PARAM_NAME,
      ]),
    );
  });

  // `triage` reaches AWS, so this slice now DOES declare the profile
  // parameter — declaring it is what makes `M3LScript` provision
  // `script.aws` at all. It must not be `required: true`, though: `validate`,
  // `explain` and `convert` must stay runnable with no credentials, which is
  // what keeps `validate` viable as a CI gate.
  it("declares Core.AWS_PROFILE_PARAM_NAME but not as required", () => {
    const awsProfile = configParameters.find(
      (parameter) => parameter.getName() === Core.AWS_PROFILE_PARAM_NAME,
    );
    expect(awsProfile).toBeDefined();
    expect(awsProfile?.isRequired()).toBe(false);
  });

  it("declares exactly validate, explain, convert and triage as the operations", () => {
    expect([...TRIAGE_OPERATIONS]).toEqual([
      "validate",
      "explain",
      "convert",
      "triage",
    ]);
  });

  it("defaults runbookDir to the declared constant", () => {
    const runbookDir = configParameters.find(
      (parameter) => parameter.getName() === "runbookDir",
    );
    expect(runbookDir?.getDefaultValue()).toBe(RUNBOOK_DIR_DEFAULT);
  });

  it("defaults maxMessages and visibilityTimeout to the declared constants", () => {
    const maxMessages = configParameters.find(
      (parameter) => parameter.getName() === "maxMessages",
    );
    const visibilityTimeout = configParameters.find(
      (parameter) => parameter.getName() === "visibilityTimeout",
    );
    expect(maxMessages?.getDefaultValue()).toBe(MAX_MESSAGES_DEFAULT);
    expect(visibilityTimeout?.getDefaultValue()).toBe(
      VISIBILITY_TIMEOUT_DEFAULT,
    );
  });

  it("declares queueUrl as a bare-optional string, with no default", () => {
    const queueUrl = configParameters.find(
      (parameter) => parameter.getName() === "queueUrl",
    );
    expect(queueUrl).toBeDefined();
    expect(queueUrl?.getDefaultValue()).toBeUndefined();
    expect(queueUrl?.isRequired()).toBe(false);
  });
});

describe("maxMessages / visibilityTimeout — declared ranges", () => {
  /** Resolves a single INT parameter against one raw value, via an in-memory provider. */
  async function resolveInt(
    name: string,
    raw: number,
  ): Promise<number | undefined> {
    const parameter = configParameters.find((p) => p.getName() === name);
    if (parameter === undefined) {
      throw new Error(`expected '${name}' to be declared`);
    }
    const reader = new Core.M3LConfigReader([
      // Seeded as a string: a real maxMessages/visibilityTimeout value
      // arrives from CLI or env as a string, and INT coercion (not just
      // range validation) is exactly what this helper exercises.
      new Core.M3LInMemoryConfigProvider({ [name]: String(raw) }),
    ]);
    return parameter.getValueAsync(reader) as Promise<number | undefined>;
  }

  test.each([1, 100, 10_000])(
    "accepts maxMessages=%i, within the declared 1-10,000 range",
    async (value) => {
      await expect(resolveInt("maxMessages", value)).resolves.toBe(value);
    },
  );

  test.each([0, 10_001])(
    "rejects maxMessages=%i, outside the declared 1-10,000 range",
    async (value) => {
      await expect(resolveInt("maxMessages", value)).rejects.toThrow(
        Core.M3LConfigValidationError,
      );
    },
  );

  test.each([0, 1800, 43_200])(
    "accepts visibilityTimeout=%i, within the declared 0-43,200 range",
    async (value) => {
      await expect(resolveInt("visibilityTimeout", value)).resolves.toBe(value);
    },
  );

  test.each([-1, 43_201])(
    "rejects visibilityTimeout=%i, outside the declared 0-43,200 range",
    async (value) => {
      await expect(resolveInt("visibilityTimeout", value)).rejects.toThrow(
        Core.M3LConfigValidationError,
      );
    },
  );
});

describe("operation parameter — default and allowed values", () => {
  const operation = configParameters.find(
    (parameter) => parameter.getName() === "operation",
  );

  /** Resolves `operation` against a single raw value, via an in-memory provider. */
  async function resolveOperation(raw: string): Promise<string | undefined> {
    const reader = new Core.M3LConfigReader([
      new Core.M3LInMemoryConfigProvider({ operation: raw }),
    ]);
    if (operation === undefined) {
      throw new Error("expected the 'operation' parameter to be declared");
    }
    return operation.getValueAsync(reader) as Promise<string | undefined>;
  }

  it("defaults to 'validate', not the AWS-facing 'triage'", () => {
    expect(operation?.getDefaultValue()).toBe("validate");
  });

  test.each(["validate", "explain", "convert", "triage"])(
    "accepts '%s' as a declared operation",
    async (value) => {
      await expect(resolveOperation(value)).resolves.toBe(value);
    },
  );

  // `execute` — applying the remediation a verdict implies, behind the graded
  // destructive gate — is deliberately deferred to a later PR (ADR-0072).
  // Pinning its rejection here stops it being half-added (declared as
  // accepted here without a handler existing).
  it("rejects 'execute' — deliberately not in this slice", async () => {
    await expect(resolveOperation("execute")).rejects.toThrow(
      Core.M3LConfigValidationError,
    );
  });

  it("rejects an arbitrary unknown value", async () => {
    await expect(resolveOperation("bogus")).rejects.toThrow(
      Core.M3LConfigValidationError,
    );
  });
});

describe("configValidators — per-operation requiredness", () => {
  /** Builds a raw `Core.M3LConfig` store directly, bypassing provider resolution. */
  function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
    const config = new Core.M3LConfig();
    for (const [key, value] of Object.entries(values)) config.set(key, value);
    return config;
  }

  /** Runs every declared validator, returning the first failure message. */
  function firstFailure(config: Core.M3LConfig): string | undefined {
    for (const validator of configValidators) {
      const result = validator(config);
      if (result !== true) return result;
    }
    return undefined;
  }

  it("needs neither queue nor source for validate", () => {
    expect(
      firstFailure(buildConfig({ operation: "validate" })),
    ).toBeUndefined();
  });

  it("requires queue for explain, naming the missing field", () => {
    const message = firstFailure(buildConfig({ operation: "explain" }));
    expect(message).toContain("queue");
  });

  it("accepts an explain run with queue supplied", () => {
    expect(
      firstFailure(buildConfig({ operation: "explain", queue: "orders-dlq" })),
    ).toBeUndefined();
  });

  it("requires source for convert, naming the missing field", () => {
    const message = firstFailure(buildConfig({ operation: "convert" }));
    expect(message).toContain("source");
  });

  it("accepts a convert run with source supplied", () => {
    expect(
      firstFailure(
        buildConfig({ operation: "convert", source: "orders-dlq.md" }),
      ),
    ).toBeUndefined();
  });

  it("treats an absent operation as validate, the declared default", () => {
    expect(firstFailure(buildConfig({}))).toBeUndefined();
  });

  it("requires both queue and queueUrl for triage, naming whichever is missing", () => {
    const missingBoth = firstFailure(buildConfig({ operation: "triage" }));
    expect(missingBoth).toContain("queue");
    expect(missingBoth).toContain("queueUrl");

    const missingQueueUrl = firstFailure(
      buildConfig({ operation: "triage", queue: "orders-dlq" }),
    );
    expect(missingQueueUrl).toContain("queueUrl");

    const missingQueue = firstFailure(
      buildConfig({
        operation: "triage",
        queueUrl: "https://sqs.example/orders-dlq",
      }),
    );
    expect(missingQueue).toContain("queue");
  });

  it("accepts a triage run with both queue and queueUrl supplied", () => {
    expect(
      firstFailure(
        buildConfig({
          operation: "triage",
          queue: "orders-dlq",
          queueUrl: "https://sqs.example/orders-dlq",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("configValidators — queue traversal guard", () => {
  function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
    const config = new Core.M3LConfig();
    for (const [key, value] of Object.entries(values)) config.set(key, value);
    return config;
  }

  function firstFailure(config: Core.M3LConfig): string | undefined {
    for (const validator of configValidators) {
      const result = validator(config);
      if (result !== true) return result;
    }
    return undefined;
  }

  test.each(["../etc/passwd", "a/b", ".."])(
    "rejects a queue value of '%s'",
    (queue) => {
      const message = firstFailure(
        buildConfig({ operation: "explain", queue }),
      );
      expect(message).toBeDefined();
      expect(message).toContain("queue");
      // The message must name the offending parameter and the reason without
      // ever resolving (and echoing) an absolute filesystem path.
      expect(message).not.toContain(process.cwd());
      expect(message?.startsWith("/")).toBe(false);
    },
  );

  it("accepts a plain queue name with no separators", () => {
    expect(
      firstFailure(buildConfig({ operation: "explain", queue: "orders-dlq" })),
    ).toBeUndefined();
  });
});
