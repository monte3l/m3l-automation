import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The four mutating operations `writeFunction` dispatches. */
type WriteOperation =
  "create" | "update-code" | "update-configuration" | "delete";

/**
 * The dependencies `writeFunction` needs, already resolved and guard-checked
 * by `run-lambda-ops` — `zipFile` arrives as raw bytes (already read from
 * `zipFilePath`) and `input` as already-JSON-parsed fields. This step takes
 * no raw `Core.M3LConfig` and never touches `destructive-gate`/`prompt`
 * itself (`run-lambda-ops` gates before ever dispatching here).
 */
interface WriteFunctionDeps {
  readonly operations: AWS.M3LLambdaOperations;
  readonly operation: WriteOperation;
  readonly functionName: string;
  readonly zipFile: Uint8Array | undefined;
  readonly input: Record<string, unknown> | undefined;
}

/** The `create`-only fields guard-checked present as non-empty strings. */
const CREATE_REQUIRED_FIELDS = ["runtime", "role", "handler"] as const;

/**
 * Reads a required, non-empty string field off an already-parsed `input`
 * object, for `create`'s `runtime`/`role`/`handler` fields — the only parts
 * of `input` this module validates; every other field is trusted as-is,
 * matching `M3LLambdaOperations`'s own no-pre-flight-validation stance.
 */
function readRequiredStringField(
  input: Record<string, unknown>,
  fieldName: (typeof CREATE_REQUIRED_FIELDS)[number],
): string {
  const value = input[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(
      `writeFunction: 'input.${fieldName}' must be a non-empty string for 'create'`,
      { code: "ERR_LAMBDA_OPS_CONFIG" },
    );
  }
  return value;
}

/** The `description`/`timeout`/`memorySize`/`environment` subset shared by `create` and `update-configuration`. */
interface OptionalFunctionFields {
  readonly description?: string;
  readonly timeout?: number;
  readonly memorySize?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

/**
 * Builds the `description`/`timeout`/`memorySize`/`environment` subset from
 * an already-parsed `input` object, trusting each field's shape as-is
 * (`exactOptionalPropertyTypes`-safe: a field is included only when the
 * caller's `input` supplied a plausibly-typed value).
 */
function readOptionalFunctionFields(
  input: Record<string, unknown>,
): OptionalFunctionFields {
  const description = input["description"];
  const timeout = input["timeout"];
  const memorySize = input["memorySize"];
  const environment = input["environment"];
  return {
    ...(typeof description === "string" && { description }),
    ...(typeof timeout === "number" && { timeout }),
    ...(typeof memorySize === "number" && { memorySize }),
    ...(environment !== null &&
      typeof environment === "object" &&
      !Array.isArray(environment) && {
        environment: environment as Readonly<Record<string, string>>,
      }),
  };
}

/** Reads an optional string field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalStringField(
  input: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const value = input[fieldName];
  return typeof value === "string" ? value : undefined;
}

/** Guard-checks `zipFile` present, for `create`/`update-code`. */
function requireZipFile(
  zipFile: Uint8Array | undefined,
  operation: WriteOperation,
): Uint8Array {
  if (zipFile === undefined) {
    throw new Core.M3LError(
      `writeFunction: 'zipFile' is required for '${operation}'`,
      { code: "ERR_LAMBDA_OPS_CONFIG" },
    );
  }
  return zipFile;
}

/** Guard-checks `input` present, for `create`/`update-configuration`. */
function requireInput(
  input: Record<string, unknown> | undefined,
  operation: WriteOperation,
): Record<string, unknown> {
  if (input === undefined) {
    throw new Core.M3LError(
      `writeFunction: 'input' is required for '${operation}'`,
      { code: "ERR_LAMBDA_OPS_CONFIG" },
    );
  }
  return input;
}

/**
 * Reads and guard-checks `create`'s `runtime`/`role`/`handler` fields off an
 * already-parsed `input` object, destructuring {@link CREATE_REQUIRED_FIELDS}
 * so the declared tuple is the single source of truth for both the field
 * names and this function's return shape.
 */
function readCreateFields(input: Record<string, unknown>): {
  readonly runtime: string;
  readonly role: string;
  readonly handler: string;
} {
  const [runtimeField, roleField, handlerField] = CREATE_REQUIRED_FIELDS;
  return {
    runtime: readRequiredStringField(input, runtimeField),
    role: readRequiredStringField(input, roleField),
    handler: readRequiredStringField(input, handlerField),
  };
}

/**
 * Runs `lambda-ops`'s four mutating function operations: `create`
 * (`operations.createFunction`), `update-code` (`operations.updateFunctionCode`),
 * `update-configuration` (`operations.updateFunctionConfiguration`), and
 * `delete` (`operations.deleteFunction`, returning nothing to persist).
 * `run-lambda-ops` always routes through `destructive-gate` before
 * dispatching here — this step performs no confirmation of its own.
 *
 * @param deps - The injected `AWS.M3LLambdaOperations`, which mutating
 *   operation to run, the target `functionName`, and the (per-operation)
 *   already-read `zipFile` bytes / already-parsed `input` fields.
 * @returns The updated `M3LLambdaFunctionConfiguration` for
 *   `create`/`update-code`/`update-configuration`, or `undefined` for
 *   `delete` (nothing to persist).
 * @throws {@link Core.M3LError} coded `"ERR_LAMBDA_OPS_CONFIG"` when a
 *   required field for the requested operation is missing: `zipFile` for
 *   `create`/`update-code`; `input` for `create`/`update-configuration`; or,
 *   for `create`, a missing/empty `runtime`/`role`/`handler` field within the
 *   parsed `input`.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { writeFunction } from "./write-function.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LLambdaOperations(script.aws.clients.lambda)`.
 * declare const operations: AWS.M3LLambdaOperations;
 *
 * await writeFunction({
 *   operations,
 *   operation: "delete",
 *   functionName: "my-function",
 *   zipFile: undefined,
 *   input: undefined,
 * });
 * ```
 */
export async function writeFunction(
  deps: WriteFunctionDeps,
): Promise<AWS.M3LLambdaFunctionConfiguration | undefined> {
  switch (deps.operation) {
    case "create": {
      const zipFile = requireZipFile(deps.zipFile, deps.operation);
      const input = requireInput(deps.input, deps.operation);
      const { runtime, role, handler } = readCreateFields(input);
      return deps.operations.createFunction({
        functionName: deps.functionName,
        zipFile,
        runtime,
        role,
        handler,
        ...readOptionalFunctionFields(input),
      });
    }
    case "update-code": {
      const zipFile = requireZipFile(deps.zipFile, deps.operation);
      return deps.operations.updateFunctionCode({
        functionName: deps.functionName,
        zipFile,
      });
    }
    case "update-configuration": {
      const input = requireInput(deps.input, deps.operation);
      const handler = readOptionalStringField(input, "handler");
      return deps.operations.updateFunctionConfiguration({
        functionName: deps.functionName,
        ...(handler !== undefined && { handler }),
        ...readOptionalFunctionFields(input),
      });
    }
    case "delete":
      await deps.operations.deleteFunction(deps.functionName);
      return undefined;
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_LAMBDA_OPS_CONFIG",
      });
    }
  }
}
