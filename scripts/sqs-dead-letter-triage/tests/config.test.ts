import { describe, expect, it, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  MAX_MESSAGES_DEFAULT,
  RUNBOOK_DIR_DEFAULT,
  TRIAGE_OPERATION_DECLARATIONS,
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

  it("declares exactly the thirteen parameters named in the contract table (PR 3b adds four — 'nonSensitiveAccounts' was removed: review round 2, MUST-FIX 7, since the library never populates M3LDestructiveTarget.accountId, so an account-keyed allow-list could never fire)", () => {
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
        "sourceQueueUrl",
        "apply",
        "yes",
        "yesSensitive",
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

  it("declares exactly validate, explain, convert, triage and execute as the operations", () => {
    expect([...TRIAGE_OPERATIONS]).toEqual([
      "validate",
      "explain",
      "convert",
      "triage",
      "execute",
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

  // PR 3b's five new parameters (spec STEP 3). `sourceQueueUrl` is guarded at
  // run time only when the plan contains a 'reinsert' (decision 1) — never
  // declared `required: true` here, and never named in
  // `REQUIRED_BY_OPERATION.execute`.
  it("declares sourceQueueUrl as a bare-optional, non-empty string, with no default", () => {
    const sourceQueueUrl = configParameters.find(
      (parameter) => parameter.getName() === "sourceQueueUrl",
    );
    expect(sourceQueueUrl).toBeDefined();
    expect(sourceQueueUrl?.getDefaultValue()).toBeUndefined();
    expect(sourceQueueUrl?.isRequired()).toBe(false);
  });

  test.each(["apply", "yes", "yesSensitive"] as const)(
    "declares '%s' as a BOOL parameter defaulting to false",
    (name) => {
      const parameter = configParameters.find((p) => p.getName() === name);
      expect(parameter).toBeDefined();
      expect(parameter?.getType()).toBe(Core.M3LConfigParameterType.BOOL);
      expect(parameter?.getDefaultValue()).toBe(false);
      expect(parameter?.isRequired()).toBe(false);
    },
  );
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

  // PR 3b (this slice) lands `execute` — applying the remediation a verdict
  // implies, behind the graded destructive gate.
  test.each(["validate", "explain", "convert", "triage", "execute"])(
    "accepts '%s' as a declared operation",
    async (value) => {
      await expect(resolveOperation(value)).resolves.toBe(value);
    },
  );

  it("rejects an arbitrary unknown value", async () => {
    await expect(resolveOperation("bogus")).rejects.toThrow(
      Core.M3LConfigValidationError,
    );
  });

  /**
   * Hand-authored — deliberately NOT re-derived from
   * `TRIAGE_OPERATION_DECLARATIONS` (the src export under test), so a typo
   * in that export's `requiredParameters` is caught rather than compared
   * against itself.
   */
  const EXPECTED_REQUIRED_PARAMETERS: ReadonlyArray<
    readonly [string, readonly string[]]
  > = [
    ["validate", []],
    ["explain", ["queue"]],
    ["convert", ["source"]],
    ["triage", ["queue", "queueUrl"]],
    ["execute", ["queue", "queueUrl"]],
  ];

  function expectedRequiredParametersFor(name: string): readonly string[] {
    const found = EXPECTED_REQUIRED_PARAMETERS.find(
      ([opName]) => opName === name,
    );
    if (found === undefined) {
      throw new Error(
        `test fixture error: no hand-authored requirement table entry for '${name}'`,
      );
    }
    return found[1];
  }

  it("equals TRIAGE_OPERATION_DECLARATIONS by content — a fresh projection, not the same array (toEqual, not toBe)", () => {
    const operations = operation?.getOperations();
    expect(operations).toEqual(TRIAGE_OPERATION_DECLARATIONS);
    expect(operations).not.toBe(TRIAGE_OPERATION_DECLARATIONS);
  });

  it("round-trips getOperations() against the hand-authored requirement table", () => {
    expect(operation).toBeDefined();
    const operations = operation?.getOperations();
    expect(operations).toBeDefined();
    if (operations === undefined) return;

    expect(operations.map((op) => op.name)).toEqual([...TRIAGE_OPERATIONS]);

    for (const op of operations) {
      expect(op.description.trim().length).toBeGreaterThan(0);
      expect(op.requiredParameters ?? []).toEqual(
        expectedRequiredParametersFor(op.name),
      );
    }
  });

  it("names only declared parameters in every operation's requiredParameters", () => {
    const operations = operation?.getOperations();
    expect(operations).toBeDefined();
    if (operations === undefined) return;

    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    for (const op of operations) {
      for (const required of op.requiredParameters ?? []) {
        expect(declaredNames.has(required)).toBe(true);
      }
    }
  });

  it("'validate' declares no required parameters, so it passes every validator (vacuous pass)", () => {
    const operations = operation?.getOperations();
    const validate = operations?.find((op) => op.name === "validate");
    expect(validate?.requiredParameters ?? []).toEqual([]);
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

  // Each derived validator guards exactly one canonical parameter and the
  // schema runs them fail-fast (first non-true result wins) — unlike the
  // prior hand-written check, which reported every missing "Required for"
  // parameter in one combined message. 'queue' is derived ahead of
  // 'queueUrl' (first-encountered via 'explain', which precedes 'triage' in
  // TRIAGE_OPERATION_DECLARATIONS), so with both missing only the 'queue'
  // message surfaces; 'queueUrl' only appears once 'queue' is supplied.
  it("requires 'queue' first (fail-fast) for triage; 'queueUrl' surfaces once 'queue' is supplied, and 'sourceQueueUrl' is never mentioned", () => {
    const missingBoth = firstFailure(buildConfig({ operation: "triage" }));
    expect(missingBoth).toContain("'queue'");
    expect(missingBoth).not.toContain("sourceQueueUrl");

    const missingQueueUrl = firstFailure(
      buildConfig({ operation: "triage", queue: "orders-dlq" }),
    );
    expect(missingQueueUrl).toContain("'queueUrl'");
    expect(missingQueueUrl).not.toContain("sourceQueueUrl");

    const missingQueue = firstFailure(
      buildConfig({
        operation: "triage",
        queueUrl: "https://sqs.example/orders-dlq",
      }),
    );
    expect(missingQueue).toContain("'queue'");
    expect(missingQueue).not.toContain("sourceQueueUrl");
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

  // `execute` needs exactly `queue`/`queueUrl` here (spec decision 1):
  // `sourceQueueUrl` is guarded at RUN time, only when the built plan
  // actually contains a 'reinsert' — an operator triaging a queue that
  // yields no reinserts must never be forced to supply it up front.
  it("requires 'queue' first (fail-fast) for execute; 'queueUrl' surfaces once 'queue' is supplied, and 'sourceQueueUrl' is never mentioned", () => {
    const missingBoth = firstFailure(buildConfig({ operation: "execute" }));
    expect(missingBoth).toContain("'queue'");
    expect(missingBoth).not.toContain("sourceQueueUrl");

    const missingQueueUrl = firstFailure(
      buildConfig({ operation: "execute", queue: "orders-dlq" }),
    );
    expect(missingQueueUrl).toContain("'queueUrl'");
    expect(missingQueueUrl).not.toContain("sourceQueueUrl");

    expect(
      firstFailure(
        buildConfig({
          operation: "execute",
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
