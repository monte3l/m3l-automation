import { describe, expect, it, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  RUNBOOK_DIR_DEFAULT,
  TRIAGE_OPERATIONS,
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

  it("declares exactly the five parameters named in the contract table", () => {
    expect(new Set(configParameters.map((p) => p.getName()))).toEqual(
      new Set(["operation", "runbookDir", "queue", "source", "output"]),
    );
  });

  // This slice is offline-only (validate/explain/convert); declaring the AWS
  // profile parameter would provision `script.aws` for no reason and defeats
  // `validate`'s job as a credential-free CI gate.
  it("never declares Core.AWS_PROFILE_PARAM_NAME — this slice stays credential-free", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(names).not.toContain(Core.AWS_PROFILE_PARAM_NAME);
  });

  it("declares exactly validate, explain and convert as the offline operations", () => {
    expect([...TRIAGE_OPERATIONS]).toEqual(["validate", "explain", "convert"]);
  });

  it("defaults runbookDir to the declared constant", () => {
    const runbookDir = configParameters.find(
      (parameter) => parameter.getName() === "runbookDir",
    );
    expect(runbookDir?.getDefaultValue()).toBe(RUNBOOK_DIR_DEFAULT);
  });
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

  test.each(["validate", "explain", "convert"])(
    "accepts '%s' as a declared operation",
    async (value) => {
      await expect(resolveOperation(value)).resolves.toBe(value);
    },
  );

  // `triage` and `execute` are the AWS-facing operations deliberately deferred
  // to a later PR (ADR-0072) — pinning their rejection here stops them being
  // half-added (declared as accepted here without their handlers existing).
  test.each(["triage", "execute"])(
    "rejects '%s' — deliberately not in this slice",
    async (value) => {
      await expect(resolveOperation(value)).rejects.toThrow(
        Core.M3LConfigValidationError,
      );
    },
  );

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
