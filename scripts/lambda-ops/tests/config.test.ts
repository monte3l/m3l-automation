import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, LAMBDA_OPERATIONS } from "../src/config.js";

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

  it("declares exactly the eight parameters named in the contract table", () => {
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
});
