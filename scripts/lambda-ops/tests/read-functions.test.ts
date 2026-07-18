import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { readFunctions } from "../src/steps/read-functions.js";
import { createFakeLambdaOperations } from "./support/lambdaFakes.js";

/**
 * Contract: docs/reference/scripts/lambda-ops.md `read-functions` row —
 * `list` (`listFunctions({ marker })`) and `describe` (`getFunction(functionName)`),
 * never gated (no `prompt`/`destructive-gate` dependency at all — the deps
 * shape below structurally cannot reach either). Deps arrive already
 * guard-checked/resolved by `run-lambda-ops` — this step takes no raw
 * `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readFunctions — list", () => {
  test("calls operations.listFunctions({ marker }) and returns the result unchanged", async () => {
    const result: AWS.M3LLambdaListFunctionsResult = {
      functions: [
        {
          functionName: "fn-a",
          functionArn: "arn:aws:lambda:us-east-1:123:function:fn-a",
          lastModified: "2026-01-01T00:00:00Z",
        },
      ],
      nextMarker: "next-token",
    };
    const listFunctions = vi.fn().mockResolvedValue(result);
    const operations = createFakeLambdaOperations({ listFunctions });

    const returned = await readFunctions({
      operations,
      operation: "list",
      marker: "prev-token",
      functionName: undefined,
    });

    expect(listFunctions).toHaveBeenCalledTimes(1);
    const call = listFunctions.mock.calls[0] as [{ marker?: string }?];
    expect(call[0]?.marker).toBe("prev-token");
    expect(returned).toEqual(result);
  });

  test("omits marker from the call when unset", async () => {
    const listFunctions = vi.fn().mockResolvedValue({ functions: [] });
    const operations = createFakeLambdaOperations({ listFunctions });

    await readFunctions({
      operations,
      operation: "list",
      marker: undefined,
      functionName: undefined,
    });

    const call = listFunctions.mock.calls[0] as [{ marker?: string }?];
    expect(call[0]?.marker).toBeUndefined();
  });
});

describe("readFunctions — describe", () => {
  test("calls operations.getFunction(functionName) and returns the configuration unchanged", async () => {
    const configuration: AWS.M3LLambdaFunctionConfiguration = {
      functionName: "my-function",
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-01T00:00:00Z",
      runtime: "nodejs20.x",
      handler: "index.handler",
    };
    const getFunction = vi.fn().mockResolvedValue(configuration);
    const operations = createFakeLambdaOperations({ getFunction });

    const returned = await readFunctions({
      operations,
      operation: "describe",
      marker: undefined,
      functionName: "my-function",
    });

    expect(getFunction).toHaveBeenCalledWith("my-function");
    expect(returned).toEqual(configuration);
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when functionName is undefined, never calling getFunction", async () => {
    const getFunction = vi.fn();
    const operations = createFakeLambdaOperations({ getFunction });

    await expect(
      readFunctions({
        operations,
        operation: "describe",
        marker: undefined,
        functionName: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_LAMBDA_OPS_CONFIG" });
    expect(getFunction).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("readFunctions resolves the list-or-describe result union", () => {
    expectTypeOf(readFunctions).returns.resolves.toEqualTypeOf<
      AWS.M3LLambdaListFunctionsResult | AWS.M3LLambdaFunctionConfiguration
    >();
  });

  test("readFunctions's deps shape is exactly operations/operation/marker/functionName — no prompt/confirm field, it never gates", () => {
    expectTypeOf<Parameters<typeof readFunctions>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LLambdaOperations;
      readonly operation: "list" | "describe";
      readonly marker: string | undefined;
      readonly functionName: string | undefined;
    }>();
  });
});
