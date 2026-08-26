import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  LAMBDA_OPERATION_DECLARATIONS,
  LAMBDA_OPERATIONS,
} from "../src/config.js";

/**
 * Contract: docs/reference/scripts/lambda-ops.md, "Configuration schema"
 * table. Eight declared parameters: `aws.profile`, `operation`,
 * `functionName`, `marker`, `zipFilePath`, `input`, `output`, `yes`. Per-op
 * cross-parameter requiredness is guard-checked at run start
 * (`run-lambda-ops.ts`), never expressed via `M3LConfigParameter({required})`
 * beyond `aws.profile`/`operation` themselves (F1b) — this smoke test asserts
 * the DECLARATION only, never resolution/coercion (the library's own tested
 * pipeline).
 *
 * `LAMBDA_OPERATIONS` is expected to be exported alongside `configParameters`
 * (mirroring `scripts/dynamodb-crud/src/config.ts`'s `DYNAMO_OPERATIONS`) so
 * the `operation` parameter's `oneOf` set is assertable without exercising
 * config resolution — the repo's "bare `as const` + derived union" idiom for
 * a closed set of string literals.
 */

const EXPECTED_OPERATIONS = [
  "list",
  "describe",
  "invoke",
  "create",
  "update-code",
  "update-configuration",
  "delete",
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

describe("lambda-ops config declaration", () => {
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

  it("declares exactly the eight parameters named in the contract table, plus 'yesSensitive' (issue #483 fleet retrofit — docs/reference/scripts/lambda-ops.md pending update)", () => {
    const names = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    expect(names).toEqual(
      new Set([
        Core.AWS_PROFILE_PARAM_NAME,
        "operation",
        "functionName",
        "marker",
        "zipFilePath",
        "input",
        "output",
        "yes",
        "yesSensitive",
      ]),
    );
  });

  it("declares the aws.profile parameter (enables the script.aws provisioning seam)", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(names).toContain(Core.AWS_PROFILE_PARAM_NAME);
  });
});

describe("LAMBDA_OPERATIONS — the operation parameter's oneOf set", () => {
  it("is exactly the 7 M3LLambdaOperations verbs the contract table names", () => {
    expect(new Set(LAMBDA_OPERATIONS)).toEqual(
      new Set([
        "list",
        "describe",
        "invoke",
        "create",
        "update-code",
        "update-configuration",
        "delete",
      ]),
    );
  });

  it("has no duplicate entries (Object.keys/length drift guard)", () => {
    expect(new Set(LAMBDA_OPERATIONS).size).toBe(LAMBDA_OPERATIONS.length);
  });

  it("is a closed union of the 7 documented operation literals (type contract)", () => {
    expectTypeOf<(typeof LAMBDA_OPERATIONS)[number]>().toEqualTypeOf<
      | "list"
      | "describe"
      | "invoke"
      | "create"
      | "update-code"
      | "update-configuration"
      | "delete"
    >();
  });

  it("rejects a value outside the declared set with M3LConfigValidationError (membership is derived from the declaration, not a hand-written oneOf)", async () => {
    await expect(
      resolveWith(paramNamed("operation"), "frobnicate"),
    ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
  });
});

/**
 * The per-operation `requiredParameters` table from
 * `docs/reference/scripts/lambda-ops.md` § Configuration schema, re-derived
 * independently of `LAMBDA_OPERATION_DECLARATIONS` so a typo'd
 * `requiredParameters` entry in `src/config.ts` is caught rather than
 * silently agreeing with itself.
 */
const EXPECTED_REQUIRED_PARAMETERS: Record<
  (typeof EXPECTED_OPERATIONS)[number],
  readonly string[]
> = {
  list: [],
  describe: ["functionName"],
  invoke: ["functionName"],
  create: ["functionName", "zipFilePath", "input"],
  "update-code": ["functionName", "zipFilePath"],
  "update-configuration": ["functionName", "input"],
  delete: ["functionName"],
};

describe("lambda-ops 'operation' parameter — getOperations() round-trip (ADR-0055)", () => {
  it("is declared on the 'operation' parameter (not undefined)", () => {
    expect(paramNamed("operation").getOperations()).not.toBeUndefined();
  });

  it("equals LAMBDA_OPERATION_DECLARATIONS by content — a fresh projection, not the same array (toEqual, not toBe)", () => {
    const operations = paramNamed("operation").getOperations();
    expect(operations).toEqual(LAMBDA_OPERATION_DECLARATIONS);
    expect(operations).not.toBe(LAMBDA_OPERATION_DECLARATIONS);
  });

  it("projects the 7 declared operations, in order, by name", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    expect(operations.map((operation) => operation.name)).toEqual(
      EXPECTED_OPERATIONS,
    );
  });

  it("gives every operation a non-blank description", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      expect(operation.description.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(EXPECTED_OPERATIONS)(
    "'%s' projects the documented requiredParameters",
    (operationName) => {
      const operations = paramNamed("operation").getOperations() ?? [];
      const operation = operations.find((op) => op.name === operationName);
      expect(operation?.requiredParameters).toEqual(
        EXPECTED_REQUIRED_PARAMETERS[operationName],
      );
    },
  );

  it("names only declared configParameters in every operation's requiredParameters (catches a typo'd parameter name)", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    const requiredNames = new Set(
      operations.flatMap((operation) => operation.requiredParameters ?? []),
    );
    for (const name of requiredNames) {
      expect(declaredNames.has(name)).toBe(true);
    }
  });
});

/**
 * F1b: `lambda-ops`'s per-operation "Required for" cross-parameter
 * constraints (docs/reference/scripts/lambda-ops.md § Configuration schema),
 * retrofitted as declarative `configValidators`
 * (`Core.M3LConfigSchemaValidator[]`) instead of `steps/run-lambda-ops.ts`'s
 * hand-rolled `accessor.requiredFor(...)` guards (mirrors the
 * `json-etl`/`cloudwatch-logs-insights` F1b retrofit). Rules verified
 * directly against `run-lambda-ops.ts`'s `accessor.requiredFor(...)` call
 * sites, not just the doc table:
 *
 * - `functionName` — required for every operation EXCEPT `list`.
 * - `zipFilePath` — required for `create`, `update-code`.
 * - `input` — required for `create`, `update-configuration` (optional for
 *   `invoke`, per `dispatchInvoke`'s unconditional `raw.input === undefined`
 *   branch rather than a `requiredFor` call).
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

  const FUNCTION_NAME_REQUIRING_OPERATIONS = [
    "describe",
    "invoke",
    "create",
    "update-code",
    "update-configuration",
    "delete",
  ] as const;
  const ZIP_FILE_PATH_REQUIRING_OPERATIONS = ["create", "update-code"] as const;
  const INPUT_REQUIRING_OPERATIONS = [
    "create",
    "update-configuration",
  ] as const;

  /** The non-tested "Required for" params an operation also needs, so a test can isolate a single validator's failure. */
  function otherRequiredFieldsFor(
    operation: (typeof LAMBDA_OPERATIONS)[number],
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (
      (FUNCTION_NAME_REQUIRING_OPERATIONS as readonly string[]).includes(
        operation,
      )
    ) {
      fields["functionName"] = "my-function";
    }
    if (
      (ZIP_FILE_PATH_REQUIRING_OPERATIONS as readonly string[]).includes(
        operation,
      )
    ) {
      fields["zipFilePath"] = "package.zip";
    }
    if ((INPUT_REQUIRING_OPERATIONS as readonly string[]).includes(operation)) {
      fields["input"] = "payload.json";
    }
    return fields;
  }

  describe("'functionName' — required for every operation except list", () => {
    it.each(FUNCTION_NAME_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'functionName' when operation is '%s' and 'functionName' is unset",
      (operation) => {
        const fields = otherRequiredFieldsFor(operation);
        const { functionName: _omitted, ...withoutFunctionName } = fields;
        const config = buildConfig({ operation, ...withoutFunctionName });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'functionName'");
      },
    );

    it.each(FUNCTION_NAME_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and every required field (including 'functionName') is set",
      (operation) => {
        const config = buildConfig({
          operation,
          ...otherRequiredFieldsFor(operation),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when the non-requiring operation ('list') is set without 'functionName'", () => {
      const config = buildConfig({ operation: "list" });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'zipFilePath' — required for create/update-code", () => {
    it.each(ZIP_FILE_PATH_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'zipFilePath' when operation is '%s' and 'zipFilePath' is unset",
      (operation) => {
        const fields = otherRequiredFieldsFor(operation);
        const { zipFilePath: _omitted, ...withoutZipFilePath } = fields;
        const config = buildConfig({ operation, ...withoutZipFilePath });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'zipFilePath'");
      },
    );

    it.each(ZIP_FILE_PATH_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and every required field (including 'zipFilePath') is set",
      (operation) => {
        const config = buildConfig({
          operation,
          ...otherRequiredFieldsFor(operation),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when a non-requiring operation ('describe') is set without 'zipFilePath'", () => {
      const config = buildConfig({
        operation: "describe",
        functionName: "my-function",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("'input' — required for create/update-configuration", () => {
    it.each(INPUT_REQUIRING_OPERATIONS)(
      "returns a failure reason describing 'input' when operation is '%s' and 'input' is unset",
      (operation) => {
        const fields = otherRequiredFieldsFor(operation);
        const { input: _omitted, ...withoutInput } = fields;
        const config = buildConfig({ operation, ...withoutInput });

        const result = firstFailure(config);
        expect(typeof result).toBe("string");
        expect(result).toContain("'input'");
      },
    );

    it.each(INPUT_REQUIRING_OPERATIONS)(
      "passes every validator when operation is '%s' and every required field (including 'input') is set",
      (operation) => {
        const config = buildConfig({
          operation,
          ...otherRequiredFieldsFor(operation),
        });

        expect(firstFailure(config)).toBeUndefined();
      },
    );

    it("passes every validator when 'invoke' is set without 'input' (optional for invoke)", () => {
      const config = buildConfig({
        operation: "invoke",
        functionName: "my-function",
      });

      expect(firstFailure(config)).toBeUndefined();
    });
  });

  /**
   * Issue #483 (A2b) / ADR-0048 fleet retrofit: `yesSensitive` is a
   * sensitive-target bypass co-flag, only meaningful alongside `yes` (see
   * `Core.confirmDestructive`'s state 3). `config.ts` is expected to add a
   * `Core.M3LConfigSchemaValidators.requires("yesSensitive", "yes")` entry to
   * `configValidators` — that library helper already exists and is exercised
   * directly in `packages/m3l-common/tests/config.test.ts`; only its wiring
   * into this script's schema is new here.
   */
  describe("'yesSensitive' requires 'yes' to be set", () => {
    it("returns a failure reason when 'yesSensitive' is true and 'yes' is unset", () => {
      const config = buildConfig({
        operation: "list",
        yesSensitive: true,
      });

      expect(firstFailure(config)).toBe(
        "'yesSensitive' requires 'yes' to be set",
      );
    });

    it("passes every validator when both 'yesSensitive' and 'yes' are set", () => {
      const config = buildConfig({
        operation: "list",
        yes: true,
        yesSensitive: true,
      });

      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes every validator when 'yesSensitive' is unset regardless of 'yes'", () => {
      const config = buildConfig({ operation: "list" });

      expect(firstFailure(config)).toBeUndefined();
    });
  });
});
