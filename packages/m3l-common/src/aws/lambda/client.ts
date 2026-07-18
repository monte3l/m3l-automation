/**
 * `aws/lambda/client` — {@link M3LLambdaOperations}, a typed wrapper over a
 * raw `LambdaClient` so callers never import `@aws-sdk/client-lambda`
 * command classes directly. Scoped to control-plane CRUD + invoke only — no
 * deployment-package packaging/build and no event-source-mapping management
 * (see `docs/reference/scripts/lambda-ops.md`).
 *
 * @packageDocumentation
 */

import type {
  FunctionConfiguration,
  LambdaClient,
  Runtime,
} from "@aws-sdk/client-lambda";
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  InvokeCommand,
  ListFunctionsCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";

import { M3LLambdaOperationError } from "./error.js";
import type {
  M3LLambdaCreateFunctionInput,
  M3LLambdaFunctionConfiguration,
  M3LLambdaFunctionSummary,
  M3LLambdaInvokeResult,
  M3LLambdaListFunctionsResult,
  M3LLambdaUpdateFunctionCodeInput,
  M3LLambdaUpdateFunctionConfigurationInput,
} from "./types.js";

/**
 * Translates an SDK `FunctionConfiguration`-shaped object into the plain
 * {@link M3LLambdaFunctionSummary} subset used by
 * {@link M3LLambdaOperations.listFunctions}. `functionName`, `functionArn`,
 * and `lastModified` default to `""` when the SDK omits them; `runtime`/
 * `state` are included only when the SDK response defines them
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param configuration - The SDK's `FunctionConfiguration`-shaped object.
 * @returns The plain, library-owned summary shape.
 */
function mapFunctionSummary(
  configuration: FunctionConfiguration,
): M3LLambdaFunctionSummary {
  return {
    functionName: configuration.FunctionName ?? "",
    functionArn: configuration.FunctionArn ?? "",
    lastModified: configuration.LastModified ?? "",
    ...(configuration.Runtime !== undefined && {
      runtime: configuration.Runtime,
    }),
    ...(configuration.State !== undefined && { state: configuration.State }),
  };
}

/**
 * Translates an SDK `FunctionConfiguration`-shaped object (returned by
 * `GetFunction` under `.Configuration`, and returned flat by
 * `CreateFunction`/`UpdateFunctionCode`/`UpdateFunctionConfiguration`) into
 * the plain {@link M3LLambdaFunctionConfiguration}, extending
 * {@link mapFunctionSummary} with the config-only fields (each included only
 * when the SDK response defines it).
 *
 * @param configuration - The SDK's `FunctionConfiguration`-shaped object.
 * @returns The plain, library-owned configuration shape.
 */
function mapFunctionConfiguration(
  configuration: FunctionConfiguration,
): M3LLambdaFunctionConfiguration {
  const environment = configuration.Environment?.Variables;
  return {
    ...mapFunctionSummary(configuration),
    ...(configuration.Description !== undefined && {
      description: configuration.Description,
    }),
    ...(configuration.Handler !== undefined && {
      handler: configuration.Handler,
    }),
    ...(configuration.Timeout !== undefined && {
      timeout: configuration.Timeout,
    }),
    ...(configuration.MemorySize !== undefined && {
      memorySize: configuration.MemorySize,
    }),
    ...(configuration.Role !== undefined && { role: configuration.Role }),
    ...(environment !== undefined && { environment }),
  };
}

/**
 * The `description`/`timeout`/`memorySize`/`environment` fields shared by
 * {@link M3LLambdaCreateFunctionInput} and
 * {@link M3LLambdaUpdateFunctionConfigurationInput}.
 */
interface OptionalFunctionFieldsInput {
  readonly description?: string;
  readonly timeout?: number;
  readonly memorySize?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

/** The SDK command-input shape produced by {@link buildOptionalFunctionFields}. */
interface OptionalFunctionFields {
  readonly Description?: string;
  readonly Timeout?: number;
  readonly MemorySize?: number;
  readonly Environment?: { Variables: Readonly<Record<string, string>> };
}

/**
 * Builds the `Description`/`Timeout`/`MemorySize`/`Environment` subset shared
 * by `CreateFunctionCommand` and `UpdateFunctionConfigurationCommand` inputs,
 * each included only when the caller supplied the corresponding field
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param input - The caller's {@link M3LLambdaCreateFunctionInput} or
 *   {@link M3LLambdaUpdateFunctionConfigurationInput}.
 * @returns The optional-field subset of the SDK command input.
 */
function buildOptionalFunctionFields(
  input: OptionalFunctionFieldsInput,
): OptionalFunctionFields {
  return {
    ...(input.description !== undefined && {
      Description: input.description,
    }),
    ...(input.timeout !== undefined && { Timeout: input.timeout }),
    ...(input.memorySize !== undefined && {
      MemorySize: input.memorySize,
    }),
    ...(input.environment !== undefined && {
      Environment: { Variables: input.environment },
    }),
  };
}

/**
 * Typed operations wrapper over a raw `LambdaClient`, covering the verb set
 * `scripts/lambda-ops` needs (list/get/invoke/create/update/delete) without
 * any caller ever importing an `@aws-sdk/client-lambda` command class
 * directly (ADR-0029 — scripts depend only on `@m3l-automation/m3l-common`).
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 *
 * const lambdaOperations = new AWS.M3LLambdaOperations(script.aws.clients.lambda);
 * const { functions } = await lambdaOperations.listFunctions();
 * ```
 */
export class M3LLambdaOperations {
  /**
   * Creates a new `M3LLambdaOperations`.
   *
   * @param client - The raw `LambdaClient` this wrapper issues commands
   *   through (e.g. `script.aws.clients.lambda`).
   */
  constructor(private readonly client: LambdaClient) {}

  /**
   * Lists Lambda functions, one page at a time.
   *
   * @param options - `marker` continues a previous page's listing.
   * @throws {@link M3LLambdaOperationError} if the underlying `ListFunctions` call fails.
   */
  async listFunctions(options?: {
    readonly marker?: string;
  }): Promise<M3LLambdaListFunctionsResult> {
    let response;
    try {
      response = await this.client.send(
        new ListFunctionsCommand({
          ...(options?.marker !== undefined && { Marker: options.marker }),
        }),
      );
    } catch (cause) {
      throw new M3LLambdaOperationError(
        "M3LLambdaOperations.listFunctions: ListFunctions failed",
        { cause },
      );
    }

    return {
      functions: (response.Functions ?? []).map(mapFunctionSummary),
      ...(response.NextMarker !== undefined && {
        nextMarker: response.NextMarker,
      }),
    };
  }

  /**
   * Retrieves a single function's configuration.
   *
   * @param functionName - The function name or ARN.
   * @throws {@link M3LLambdaOperationError} if the underlying `GetFunction` call fails.
   */
  async getFunction(
    functionName: string,
  ): Promise<M3LLambdaFunctionConfiguration> {
    let response;
    try {
      response = await this.client.send(
        new GetFunctionCommand({ FunctionName: functionName }),
      );
    } catch (cause) {
      throw new M3LLambdaOperationError(
        `M3LLambdaOperations.getFunction: GetFunction failed for functionName=${functionName}`,
        { cause },
      );
    }

    return mapFunctionConfiguration(response.Configuration ?? {});
  }

  /**
   * Synchronously invokes a function and returns its response.
   *
   * Function-level errors (a handler that throws or times out) are **not**
   * thrown — the underlying `Invoke` call still resolves successfully
   * (`StatusCode: 200`, `FunctionError` set, the error serialized into
   * `Payload`), and this method resolves with `functionError` populated for
   * the caller to inspect. Only a `.send()`-level rejection (throttling,
   * `ResourceNotFoundException`, network failure) throws.
   *
   * @param functionName - The function name or ARN.
   * @param payload - The JSON-serializable request payload, if any.
   * @throws {@link M3LLambdaOperationError} if the underlying `Invoke` call fails.
   */
  async invokeFunction(
    functionName: string,
    payload?: unknown,
  ): Promise<M3LLambdaInvokeResult> {
    // Built outside the try block: a non-serializable payload (circular ref,
    // BigInt) throws from JSON.stringify itself, which is not an SDK-level
    // failure and must not be mislabeled as "Invoke failed".
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      LogType: "Tail",
      ...(payload !== undefined && {
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    });

    let response;
    try {
      response = await this.client.send(command);
    } catch (cause) {
      throw new M3LLambdaOperationError(
        `M3LLambdaOperations.invokeFunction: Invoke failed for functionName=${functionName}`,
        { cause },
      );
    }

    return {
      statusCode: response.StatusCode ?? 0,
      ...(response.Payload !== undefined && {
        payload: new TextDecoder().decode(response.Payload),
      }),
      ...(response.FunctionError !== undefined && {
        functionError: response.FunctionError,
      }),
      ...(response.LogResult !== undefined && {
        logResult: response.LogResult,
      }),
    };
  }

  /**
   * Creates a new function from a deployment package.
   *
   * @param input - The new function's definition.
   * @throws {@link M3LLambdaOperationError} if the underlying `CreateFunction` call fails.
   */
  async createFunction(
    input: M3LLambdaCreateFunctionInput,
  ): Promise<M3LLambdaFunctionConfiguration> {
    let response;
    try {
      response = await this.client.send(
        new CreateFunctionCommand({
          FunctionName: input.functionName,
          // Trusts the caller's string as-is — this module performs no
          // pre-flight runtime validation (docs/reference/aws/lambda.md);
          // an invalid value surfaces as an SDK-level validation error.
          Runtime: input.runtime as Runtime,
          Role: input.role,
          Handler: input.handler,
          Code: { ZipFile: input.zipFile },
          ...buildOptionalFunctionFields(input),
        }),
      );
    } catch (cause) {
      throw new M3LLambdaOperationError(
        `M3LLambdaOperations.createFunction: CreateFunction failed for functionName=${input.functionName}`,
        { cause },
      );
    }

    return mapFunctionConfiguration(response);
  }

  /**
   * Replaces an existing function's deployment package.
   *
   * @param input - The target function and its replacement code.
   * @throws {@link M3LLambdaOperationError} if the underlying `UpdateFunctionCode` call fails.
   */
  async updateFunctionCode(
    input: M3LLambdaUpdateFunctionCodeInput,
  ): Promise<M3LLambdaFunctionConfiguration> {
    let response;
    try {
      response = await this.client.send(
        new UpdateFunctionCodeCommand({
          FunctionName: input.functionName,
          ZipFile: input.zipFile,
        }),
      );
    } catch (cause) {
      throw new M3LLambdaOperationError(
        `M3LLambdaOperations.updateFunctionCode: UpdateFunctionCode failed for functionName=${input.functionName}`,
        { cause },
      );
    }

    return mapFunctionConfiguration(response);
  }

  /**
   * Updates an existing function's non-code configuration (memory, timeout,
   * handler, environment, etc.).
   *
   * @param input - The target function and the fields to change.
   * @throws {@link M3LLambdaOperationError} if the underlying `UpdateFunctionConfiguration` call fails.
   */
  async updateFunctionConfiguration(
    input: M3LLambdaUpdateFunctionConfigurationInput,
  ): Promise<M3LLambdaFunctionConfiguration> {
    let response;
    try {
      response = await this.client.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: input.functionName,
          ...(input.handler !== undefined && { Handler: input.handler }),
          ...buildOptionalFunctionFields(input),
        }),
      );
    } catch (cause) {
      throw new M3LLambdaOperationError(
        `M3LLambdaOperations.updateFunctionConfiguration: UpdateFunctionConfiguration failed for functionName=${input.functionName}`,
        { cause },
      );
    }

    return mapFunctionConfiguration(response);
  }

  /**
   * Deletes a function.
   *
   * @param functionName - The function name or ARN.
   * @throws {@link M3LLambdaOperationError} if the underlying `DeleteFunction` call fails.
   */
  async deleteFunction(functionName: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteFunctionCommand({ FunctionName: functionName }),
      );
    } catch (cause) {
      throw new M3LLambdaOperationError(
        `M3LLambdaOperations.deleteFunction: DeleteFunction failed for functionName=${functionName}`,
        { cause },
      );
    }
  }
}
