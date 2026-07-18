import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readFunctions` needs, already resolved and guard-checked
 * by `run-lambda-ops` — this step takes no raw `Core.M3LConfig` and never
 * gates (no `prompt`/`confirm` field at all; `list`/`describe` are never
 * destructive).
 */
interface ReadFunctionsDeps {
  readonly operations: AWS.M3LLambdaOperations;
  readonly operation: "list" | "describe";
  readonly marker: string | undefined;
  readonly functionName: string | undefined;
}

/**
 * Runs `lambda-ops`'s two read-only operations: `list`
 * (`operations.listFunctions({ marker })`) and `describe`
 * (`operations.getFunction(functionName)`).
 *
 * @param deps - The injected `AWS.M3LLambdaOperations`, which of the two
 *   read-only operations to run, and the (per-operation, possibly-unset)
 *   `marker`/`functionName` values.
 * @returns The raw `M3LLambdaListFunctionsResult` (`list`) or
 *   `M3LLambdaFunctionConfiguration` (`describe`), unchanged.
 * @throws {@link Core.M3LError} coded `"ERR_LAMBDA_OPS_CONFIG"` when
 *   `operation` is `"describe"` and `functionName` is `undefined` — guarded
 *   defensively; `run-lambda-ops` already guard-checks this before dispatch.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readFunctions } from "./read-functions.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LLambdaOperations(script.aws.clients.lambda)`.
 * declare const operations: AWS.M3LLambdaOperations;
 *
 * const result = await readFunctions({
 *   operations,
 *   operation: "list",
 *   marker: undefined,
 *   functionName: undefined,
 * });
 * ```
 */
export async function readFunctions(
  deps: ReadFunctionsDeps,
): Promise<
  AWS.M3LLambdaListFunctionsResult | AWS.M3LLambdaFunctionConfiguration
> {
  switch (deps.operation) {
    case "list":
      return deps.operations.listFunctions({
        ...(deps.marker !== undefined && { marker: deps.marker }),
      });
    case "describe": {
      if (deps.functionName === undefined) {
        throw new Core.M3LError(
          "readFunctions: 'functionName' is required for the 'describe' operation",
          { code: "ERR_LAMBDA_OPS_CONFIG" },
        );
      }
      return deps.operations.getFunction(deps.functionName);
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_LAMBDA_OPS_CONFIG",
      });
    }
  }
}
