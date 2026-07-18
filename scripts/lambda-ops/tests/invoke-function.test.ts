import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { invokeFunction } from "../src/steps/invoke-function.js";
import { createFakeLambdaOperations } from "./support/lambdaFakes.js";

/**
 * Contract: docs/reference/scripts/lambda-ops.md `invoke-function` row.
 * Calls `operations.invokeFunction(functionName, payload)` and returns the
 * `M3LLambdaInvokeResult` unchanged — it does NOT itself inspect or throw on
 * `functionError`; that is `run-lambda-ops`'s decision once the result flows
 * back to the dispatcher. Deps arrive already resolved by `run-lambda-ops`
 * (`payload` is the already-JSON-parsed `input` file contents, or `undefined`
 * when `input` is unset for `invoke`).
 */

const FUNCTION_NAME = "my-function";

afterEach(() => {
  vi.clearAllMocks();
});

describe("invokeFunction", () => {
  test("calls operations.invokeFunction(functionName, payload) and returns the result unchanged", async () => {
    const result: AWS.M3LLambdaInvokeResult = {
      statusCode: 200,
      payload: '{"ok":true}',
      logResult: "base64-log-tail",
    };
    const invokeFunctionMock = vi.fn().mockResolvedValue(result);
    const operations = createFakeLambdaOperations({
      invokeFunction: invokeFunctionMock,
    });
    const payload = { input: "value" };

    const returned = await invokeFunction({
      operations,
      functionName: FUNCTION_NAME,
      payload,
    });

    expect(invokeFunctionMock).toHaveBeenCalledWith(FUNCTION_NAME, payload);
    expect(returned).toEqual(result);
  });

  test("omits/passes undefined payload when input was unset", async () => {
    const invokeFunctionMock = vi.fn().mockResolvedValue({ statusCode: 200 });
    const operations = createFakeLambdaOperations({
      invokeFunction: invokeFunctionMock,
    });

    await invokeFunction({
      operations,
      functionName: FUNCTION_NAME,
      payload: undefined,
    });

    expect(invokeFunctionMock).toHaveBeenCalledWith(FUNCTION_NAME, undefined);
  });

  test("resolves normally (never throws) even when the result has a populated functionError", async () => {
    const result: AWS.M3LLambdaInvokeResult = {
      statusCode: 200,
      functionError: "Unhandled",
      payload: '{"errorMessage":"boom"}',
      logResult: "base64-log-tail",
    };
    const invokeFunctionMock = vi.fn().mockResolvedValue(result);
    const operations = createFakeLambdaOperations({
      invokeFunction: invokeFunctionMock,
    });

    await expect(
      invokeFunction({
        operations,
        functionName: FUNCTION_NAME,
        payload: undefined,
      }),
    ).resolves.toEqual(result);
  });
});

describe("type contract", () => {
  test("invokeFunction resolves M3LLambdaInvokeResult", () => {
    expectTypeOf(
      invokeFunction,
    ).returns.resolves.toEqualTypeOf<AWS.M3LLambdaInvokeResult>();
  });
});
