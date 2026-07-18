import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { writeFunction } from "../src/steps/write-function.js";
import { createFakeLambdaOperations } from "./support/lambdaFakes.js";

/**
 * Contract: docs/reference/scripts/lambda-ops.md `write-function` row.
 * Handles `create`/`update-code`/`update-configuration`/`delete`. Deps arrive
 * already guard-checked/resolved by `run-lambda-ops` (`zipFile` as raw bytes,
 * `input` as already-JSON-parsed fields) — this step takes no raw
 * `Core.M3LConfig` and never touches `destructive-gate`/`prompt` itself
 * (`run-lambda-ops` gates before dispatching here).
 */

const ZIP_BYTES = new Uint8Array([1, 2, 3, 4]);
const FUNCTION_NAME = "my-function";

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeFunction — create", () => {
  test("calls operations.createFunction with functionName + zipFile + the parsed input fields", async () => {
    const configuration: AWS.M3LLambdaFunctionConfiguration = {
      functionName: FUNCTION_NAME,
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-01T00:00:00Z",
    };
    const createFunction = vi.fn().mockResolvedValue(configuration);
    const operations = createFakeLambdaOperations({ createFunction });
    const input = {
      runtime: "nodejs20.x",
      role: "arn:aws:iam::123456789012:role/my-role",
      handler: "index.handler",
      description: "a function",
      timeout: 30,
      memorySize: 256,
      environment: { FOO: "bar" },
    };

    const returned = await writeFunction({
      operations,
      operation: "create",
      functionName: FUNCTION_NAME,
      zipFile: ZIP_BYTES,
      input,
    });

    expect(createFunction).toHaveBeenCalledWith({
      functionName: FUNCTION_NAME,
      zipFile: ZIP_BYTES,
      runtime: "nodejs20.x",
      role: "arn:aws:iam::123456789012:role/my-role",
      handler: "index.handler",
      description: "a function",
      timeout: 30,
      memorySize: 256,
      environment: { FOO: "bar" },
    });
    expect(returned).toEqual(configuration);
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when input is undefined, never calling createFunction", async () => {
    const createFunction = vi.fn();
    const operations = createFakeLambdaOperations({ createFunction });

    let thrown: unknown;
    try {
      await writeFunction({
        operations,
        operation: "create",
        functionName: FUNCTION_NAME,
        zipFile: ZIP_BYTES,
        input: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_LAMBDA_OPS_CONFIG");
    expect(createFunction).not.toHaveBeenCalled();
  });

  test.each(["runtime", "role", "handler"] as const)(
    "throws ERR_LAMBDA_OPS_CONFIG when the parsed input is missing '%s', never calling createFunction",
    async (missing) => {
      const createFunction = vi.fn();
      const operations = createFakeLambdaOperations({ createFunction });
      const input: Record<string, unknown> = {
        runtime: "nodejs20.x",
        role: "arn:aws:iam::123456789012:role/my-role",
        handler: "index.handler",
      };
      delete input[missing];

      let thrown: unknown;
      try {
        await writeFunction({
          operations,
          operation: "create",
          functionName: FUNCTION_NAME,
          zipFile: ZIP_BYTES,
          input,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_LAMBDA_OPS_CONFIG");
      expect(createFunction).not.toHaveBeenCalled();
    },
  );

  test.each(["runtime", "role", "handler"] as const)(
    "throws ERR_LAMBDA_OPS_CONFIG when the parsed input's '%s' is an empty string",
    async (fieldName) => {
      const createFunction = vi.fn();
      const operations = createFakeLambdaOperations({ createFunction });
      const input: Record<string, unknown> = {
        runtime: "nodejs20.x",
        role: "arn:aws:iam::123456789012:role/my-role",
        handler: "index.handler",
        [fieldName]: "",
      };

      await expect(
        writeFunction({
          operations,
          operation: "create",
          functionName: FUNCTION_NAME,
          zipFile: ZIP_BYTES,
          input,
        }),
      ).rejects.toMatchObject({ code: "ERR_LAMBDA_OPS_CONFIG" });
      expect(createFunction).not.toHaveBeenCalled();
    },
  );
});

describe("writeFunction — update-code", () => {
  test("calls operations.updateFunctionCode with functionName + zipFile", async () => {
    const configuration: AWS.M3LLambdaFunctionConfiguration = {
      functionName: FUNCTION_NAME,
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-02T00:00:00Z",
    };
    const updateFunctionCode = vi.fn().mockResolvedValue(configuration);
    const operations = createFakeLambdaOperations({ updateFunctionCode });

    const returned = await writeFunction({
      operations,
      operation: "update-code",
      functionName: FUNCTION_NAME,
      zipFile: ZIP_BYTES,
      input: undefined,
    });

    expect(updateFunctionCode).toHaveBeenCalledWith({
      functionName: FUNCTION_NAME,
      zipFile: ZIP_BYTES,
    });
    expect(returned).toEqual(configuration);
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when zipFile is undefined, never calling updateFunctionCode", async () => {
    const updateFunctionCode = vi.fn();
    const operations = createFakeLambdaOperations({ updateFunctionCode });

    await expect(
      writeFunction({
        operations,
        operation: "update-code",
        functionName: FUNCTION_NAME,
        zipFile: undefined,
        input: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_LAMBDA_OPS_CONFIG" });
    expect(updateFunctionCode).not.toHaveBeenCalled();
  });
});

describe("writeFunction — update-configuration", () => {
  test("calls operations.updateFunctionConfiguration with functionName + the parsed input fields", async () => {
    const configuration: AWS.M3LLambdaFunctionConfiguration = {
      functionName: FUNCTION_NAME,
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-03T00:00:00Z",
    };
    const updateFunctionConfiguration = vi
      .fn()
      .mockResolvedValue(configuration);
    const operations = createFakeLambdaOperations({
      updateFunctionConfiguration,
    });
    const input = {
      description: "updated",
      timeout: 60,
      memorySize: 512,
      handler: "index.handler2",
      environment: { A: "B" },
    };

    const returned = await writeFunction({
      operations,
      operation: "update-configuration",
      functionName: FUNCTION_NAME,
      zipFile: undefined,
      input,
    });

    expect(updateFunctionConfiguration).toHaveBeenCalledWith({
      functionName: FUNCTION_NAME,
      description: "updated",
      timeout: 60,
      memorySize: 512,
      handler: "index.handler2",
      environment: { A: "B" },
    });
    expect(returned).toEqual(configuration);
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when input is undefined, never calling updateFunctionConfiguration", async () => {
    const updateFunctionConfiguration = vi.fn();
    const operations = createFakeLambdaOperations({
      updateFunctionConfiguration,
    });

    await expect(
      writeFunction({
        operations,
        operation: "update-configuration",
        functionName: FUNCTION_NAME,
        zipFile: undefined,
        input: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_LAMBDA_OPS_CONFIG" });
    expect(updateFunctionConfiguration).not.toHaveBeenCalled();
  });
});

describe("writeFunction — delete", () => {
  test("calls operations.deleteFunction(functionName) and resolves undefined (nothing to persist)", async () => {
    const deleteFunction = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeLambdaOperations({ deleteFunction });

    const returned = await writeFunction({
      operations,
      operation: "delete",
      functionName: FUNCTION_NAME,
      zipFile: undefined,
      input: undefined,
    });

    expect(deleteFunction).toHaveBeenCalledWith(FUNCTION_NAME);
    expect(returned).toBeUndefined();
  });
});

describe("type contract", () => {
  test("writeFunction resolves M3LLambdaFunctionConfiguration or undefined (delete)", () => {
    expectTypeOf(writeFunction).returns.resolves.toEqualTypeOf<
      AWS.M3LLambdaFunctionConfiguration | undefined
    >();
  });
});
