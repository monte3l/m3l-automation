/**
 * Tests for aws/lambda submodule.
 *
 * Contract source: docs/reference/aws/lambda.md.
 *
 * Exports under test (from `../src/aws/lambda/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   M3LLambdaOperations, M3LLambdaOperationError, and the M3LLambda* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-lambda` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/sqs.test.ts`), with a `.send()` spy dispatching by command class.
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LLambdaOperations`'s
 * methods currently throw `M3LLambdaOperationError("... not yet implemented")`
 * (see src/aws/lambda/client.ts). `implementing-submodules` turns them GREEN.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class ListFunctionsCommand {
    constructor(readonly input: unknown) {}
  }
  class GetFunctionCommand {
    constructor(readonly input: unknown) {}
  }
  class InvokeCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateFunctionCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateFunctionCodeCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateFunctionConfigurationCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteFunctionCommand {
    constructor(readonly input: unknown) {}
  }
  class LambdaClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    LambdaClient,
    ListFunctionsCommand,
    GetFunctionCommand,
    InvokeCommand,
    CreateFunctionCommand,
    UpdateFunctionCodeCommand,
    UpdateFunctionConfigurationCommand,
    DeleteFunctionCommand,
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: h.LambdaClient,
  ListFunctionsCommand: h.ListFunctionsCommand,
  GetFunctionCommand: h.GetFunctionCommand,
  InvokeCommand: h.InvokeCommand,
  CreateFunctionCommand: h.CreateFunctionCommand,
  UpdateFunctionCodeCommand: h.UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand: h.UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand: h.DeleteFunctionCommand,
}));

import type {
  M3LLambdaCreateFunctionInput,
  M3LLambdaFunctionConfiguration,
  M3LLambdaInvokeResult,
  M3LLambdaListFunctionsResult,
  M3LLambdaUpdateFunctionCodeInput,
  M3LLambdaUpdateFunctionConfigurationInput,
} from "../src/aws/lambda/index.js";
import {
  M3LLambdaOperationError,
  M3LLambdaOperations,
} from "../src/aws/lambda/index.js";

import type { LambdaClient } from "@aws-sdk/client-lambda";

const FUNCTION_NAME = "test-function";

/** Casts the hoisted fake `LambdaClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): LambdaClient {
  return new h.LambdaClient() as unknown as LambdaClient;
}

describe("M3LLambdaOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  test("listFunctions() resolves with plain M3LLambdaFunctionSummary[] on a successful ListFunctions call", async () => {
    h.send.mockResolvedValueOnce({
      Functions: [
        {
          FunctionName: FUNCTION_NAME,
          FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
          Runtime: "nodejs24.x",
          LastModified: "2026-07-18T00:00:00.000+0000",
        },
      ],
    });

    const operations = new M3LLambdaOperations(fakeClient());

    const result = await operations.listFunctions();

    expect(result).toEqual<M3LLambdaListFunctionsResult>({
      functions: [
        expect.objectContaining({
          functionName: FUNCTION_NAME,
          runtime: "nodejs24.x",
        }),
      ],
    });
  });

  test("listFunctions() forwards a marker onto the ListFunctions command input", async () => {
    h.send.mockResolvedValueOnce({ Functions: [] });

    const operations = new M3LLambdaOperations(fakeClient());
    await operations.listFunctions({ marker: "page-2" });

    const [command] = h.send.mock.calls[0] as [{ input: { Marker?: string } }];
    expect(command.input.Marker).toBe("page-2");
  });

  test("listFunctions() includes nextMarker in the resolved result when the SDK returns NextMarker", async () => {
    h.send.mockResolvedValueOnce({ Functions: [], NextMarker: "page-3" });

    const operations = new M3LLambdaOperations(fakeClient());
    const result = await operations.listFunctions();

    expect(result.nextMarker).toBe("page-3");
  });

  test("listFunctions() omits runtime and state from a summary entry when the SDK response doesn't include them", async () => {
    h.send.mockResolvedValueOnce({
      Functions: [
        {
          FunctionName: FUNCTION_NAME,
          FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
          LastModified: "2026-07-18T00:00:00.000+0000",
        },
      ],
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const result = await operations.listFunctions();

    const [summary] = result.functions;
    if (summary === undefined) {
      throw new Error("expected listFunctions() to resolve one summary");
    }
    expect(summary).not.toHaveProperty("runtime");
    expect(summary).not.toHaveProperty("state");
  });

  test("getFunction() resolves with a plain M3LLambdaFunctionConfiguration", async () => {
    h.send.mockResolvedValueOnce({
      Configuration: {
        FunctionName: FUNCTION_NAME,
        FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
        Runtime: "nodejs24.x",
        LastModified: "2026-07-18T00:00:00.000+0000",
        Handler: "index.handler",
        Timeout: 30,
        MemorySize: 128,
      },
    });

    const operations = new M3LLambdaOperations(fakeClient());

    await expect(operations.getFunction(FUNCTION_NAME)).resolves.toEqual(
      expect.objectContaining({
        functionName: FUNCTION_NAME,
        handler: "index.handler",
        timeout: 30,
        memorySize: 128,
      }),
    );
  });

  test("getFunction() rejects with M3LLambdaOperationError, chaining the SDK rejection as cause", async () => {
    const sdkError = new Error("ResourceNotFoundException");
    h.send.mockRejectedValueOnce(sdkError);

    const operations = new M3LLambdaOperations(fakeClient());

    await expect(operations.getFunction(FUNCTION_NAME)).rejects.toMatchObject({
      constructor: M3LLambdaOperationError,
      cause: sdkError,
    });
  });

  test("getFunction() omits runtime and state from the result when the SDK response doesn't include them", async () => {
    h.send.mockResolvedValueOnce({
      Configuration: {
        FunctionName: FUNCTION_NAME,
        FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
        LastModified: "2026-07-18T00:00:00.000+0000",
      },
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const result = await operations.getFunction(FUNCTION_NAME);

    expect(result).not.toHaveProperty("runtime");
    expect(result).not.toHaveProperty("state");
  });

  test("getFunction() reads environment back from Configuration.Environment.Variables", async () => {
    h.send.mockResolvedValueOnce({
      Configuration: {
        FunctionName: FUNCTION_NAME,
        FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
        LastModified: "2026-07-18T00:00:00.000+0000",
        Environment: { Variables: { FOO: "bar" } },
      },
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const result = await operations.getFunction(FUNCTION_NAME);

    expect(result.environment).toEqual({ FOO: "bar" });
  });

  test("invokeFunction() resolves with a plain M3LLambdaInvokeResult, decoding Payload as UTF-8", async () => {
    h.send.mockResolvedValueOnce({
      StatusCode: 200,
      Payload: new TextEncoder().encode('{"ok":true}'),
    });

    const operations = new M3LLambdaOperations(fakeClient());

    const expected: M3LLambdaInvokeResult = {
      statusCode: 200,
      payload: '{"ok":true}',
    };
    await expect(
      operations.invokeFunction(FUNCTION_NAME, { hello: "world" }),
    ).resolves.toEqual(expected);
  });

  test("invokeFunction() resolves (not rejects) with functionError populated when the function itself errors", async () => {
    h.send.mockResolvedValueOnce({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: new TextEncoder().encode(
        '{"errorMessage":"boom","errorType":"Error"}',
      ),
    });

    const operations = new M3LLambdaOperations(fakeClient());

    await expect(operations.invokeFunction(FUNCTION_NAME)).resolves.toEqual(
      expect.objectContaining({
        statusCode: 200,
        functionError: "Unhandled",
      }),
    );
  });

  test("invokeFunction() always sets InvocationType RequestResponse and LogType Tail, and encodes Payload as UTF-8 JSON", async () => {
    h.send.mockResolvedValueOnce({ StatusCode: 200 });

    const operations = new M3LLambdaOperations(fakeClient());
    await operations.invokeFunction(FUNCTION_NAME, { hello: "world" });

    const [command] = h.send.mock.calls[0] as [
      {
        input: {
          InvocationType?: string;
          LogType?: string;
          Payload?: Uint8Array;
        };
      },
    ];
    expect(command.input.InvocationType).toBe("RequestResponse");
    expect(command.input.LogType).toBe("Tail");
    expect(command.input.Payload).toEqual(
      new TextEncoder().encode(JSON.stringify({ hello: "world" })),
    );
  });

  test("invokeFunction() omits Payload from the command input entirely when called without a payload", async () => {
    h.send.mockResolvedValueOnce({ StatusCode: 200 });

    const operations = new M3LLambdaOperations(fakeClient());
    await operations.invokeFunction(FUNCTION_NAME);

    const [command] = h.send.mock.calls[0] as [{ input: object }];
    expect(command.input).not.toHaveProperty("Payload");
  });

  test("createFunction() resolves with the created function's M3LLambdaFunctionConfiguration", async () => {
    h.send.mockResolvedValueOnce({
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
      Runtime: "nodejs24.x",
      LastModified: "2026-07-18T00:00:00.000+0000",
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const input: M3LLambdaCreateFunctionInput = {
      functionName: FUNCTION_NAME,
      runtime: "nodejs24.x",
      role: "arn:aws:iam::123456789012:role/lambda-role",
      handler: "index.handler",
      zipFile: new Uint8Array([1, 2, 3]),
    };

    await expect(operations.createFunction(input)).resolves.toEqual(
      expect.objectContaining({ functionName: FUNCTION_NAME }),
    );
  });

  test("createFunction() nests zipFile under Code.ZipFile on the command input (not top-level)", async () => {
    h.send.mockResolvedValueOnce({
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
      LastModified: "2026-07-18T00:00:00.000+0000",
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const zipFile = new Uint8Array([1, 2, 3]);
    const input: M3LLambdaCreateFunctionInput = {
      functionName: FUNCTION_NAME,
      runtime: "nodejs24.x",
      role: "arn:aws:iam::123456789012:role/lambda-role",
      handler: "index.handler",
      zipFile,
    };
    await operations.createFunction(input);

    const [command] = h.send.mock.calls[0] as [
      { input: { Code?: { ZipFile?: Uint8Array }; ZipFile?: Uint8Array } },
    ];
    expect(command.input.Code).toEqual({ ZipFile: zipFile });
    expect(command.input.ZipFile).toBeUndefined();
  });

  test("createFunction() nests environment onto the command input as Environment.Variables", async () => {
    h.send.mockResolvedValueOnce({
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
      LastModified: "2026-07-18T00:00:00.000+0000",
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const input: M3LLambdaCreateFunctionInput = {
      functionName: FUNCTION_NAME,
      runtime: "nodejs24.x",
      role: "arn:aws:iam::123456789012:role/lambda-role",
      handler: "index.handler",
      zipFile: new Uint8Array([1, 2, 3]),
      environment: { FOO: "bar" },
    };
    await operations.createFunction(input);

    const [command] = h.send.mock.calls[0] as [
      { input: { Environment?: { Variables?: Record<string, string> } } },
    ];
    expect(command.input.Environment).toEqual({ Variables: { FOO: "bar" } });
  });

  test("updateFunctionCode() resolves with the updated function's M3LLambdaFunctionConfiguration", async () => {
    h.send.mockResolvedValueOnce({
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
      LastModified: "2026-07-18T00:00:00.000+0000",
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const input: M3LLambdaUpdateFunctionCodeInput = {
      functionName: FUNCTION_NAME,
      zipFile: new Uint8Array([1, 2, 3]),
    };

    await expect(operations.updateFunctionCode(input)).resolves.toEqual(
      expect.objectContaining({ functionName: FUNCTION_NAME }),
    );
  });

  test("updateFunctionCode() puts zipFile at the TOP LEVEL as ZipFile, not nested under Code", async () => {
    h.send.mockResolvedValueOnce({
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
      LastModified: "2026-07-18T00:00:00.000+0000",
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const zipFile = new Uint8Array([4, 5, 6]);
    const input: M3LLambdaUpdateFunctionCodeInput = {
      functionName: FUNCTION_NAME,
      zipFile,
    };
    await operations.updateFunctionCode(input);

    const [command] = h.send.mock.calls[0] as [
      { input: { ZipFile?: Uint8Array; Code?: unknown } },
    ];
    expect(command.input.ZipFile).toEqual(zipFile);
    expect(command.input.Code).toBeUndefined();
  });

  test("updateFunctionConfiguration() resolves with the updated function's M3LLambdaFunctionConfiguration", async () => {
    h.send.mockResolvedValueOnce({
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:eu-south-1:123456789012:function:${FUNCTION_NAME}`,
      LastModified: "2026-07-18T00:00:00.000+0000",
      Timeout: 60,
    });

    const operations = new M3LLambdaOperations(fakeClient());
    const input: M3LLambdaUpdateFunctionConfigurationInput = {
      functionName: FUNCTION_NAME,
      timeout: 60,
    };

    await expect(
      operations.updateFunctionConfiguration(input),
    ).resolves.toEqual(
      expect.objectContaining({ functionName: FUNCTION_NAME, timeout: 60 }),
    );
  });

  test("deleteFunction() resolves void and puts FunctionName on the command input", async () => {
    h.send.mockResolvedValueOnce({});

    const operations = new M3LLambdaOperations(fakeClient());
    await operations.deleteFunction(FUNCTION_NAME);

    const [command] = h.send.mock.calls[0] as [
      { input: { FunctionName?: string } },
    ];
    expect(command.input.FunctionName).toBe(FUNCTION_NAME);
  });

  test.each<[string, (operations: M3LLambdaOperations) => Promise<unknown>]>([
    ["listFunctions", (operations) => operations.listFunctions()],
    [
      "invokeFunction",
      (operations) => operations.invokeFunction(FUNCTION_NAME),
    ],
    [
      "createFunction",
      (operations) =>
        operations.createFunction({
          functionName: FUNCTION_NAME,
          runtime: "nodejs24.x",
          role: "arn:aws:iam::123456789012:role/lambda-role",
          handler: "index.handler",
          zipFile: new Uint8Array([1, 2, 3]),
        }),
    ],
    [
      "updateFunctionCode",
      (operations) =>
        operations.updateFunctionCode({
          functionName: FUNCTION_NAME,
          zipFile: new Uint8Array([1, 2, 3]),
        }),
    ],
    [
      "updateFunctionConfiguration",
      (operations) =>
        operations.updateFunctionConfiguration({
          functionName: FUNCTION_NAME,
          timeout: 60,
        }),
    ],
    [
      "deleteFunction",
      (operations) => operations.deleteFunction(FUNCTION_NAME),
    ],
  ])(
    "%s() rejects with M3LLambdaOperationError, chaining the SDK rejection as cause",
    async (_name, invoke) => {
      const sdkError = new Error("ServiceException");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LLambdaOperations(fakeClient());

      await expect(invoke(operations)).rejects.toMatchObject({
        constructor: M3LLambdaOperationError,
        cause: sdkError,
      });
    },
  );

  test("every method's return type matches its documented plain shape", () => {
    const operations = new M3LLambdaOperations(fakeClient());

    h.send.mockResolvedValueOnce({ Functions: [] });
    expectTypeOf(
      operations.listFunctions(),
    ).resolves.toEqualTypeOf<M3LLambdaListFunctionsResult>();

    h.send.mockResolvedValueOnce({ Configuration: {} });
    expectTypeOf(
      operations.getFunction(FUNCTION_NAME),
    ).resolves.toEqualTypeOf<M3LLambdaFunctionConfiguration>();

    expectTypeOf(operations.deleteFunction(FUNCTION_NAME)).resolves.toBeVoid();
  });
});
