import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `invokeFunction` needs, already resolved by
 * `run-lambda-ops` — `payload` is the already-JSON-parsed `input` file
 * contents, or `undefined` when `input` is unset (invoke's payload is
 * optional).
 */
interface InvokeFunctionDeps {
  readonly operations: AWS.M3LLambdaOperations;
  readonly functionName: string;
  readonly payload: unknown;
}

/**
 * Synchronously invokes a Lambda function and returns its response
 * unchanged. `run-lambda-ops` always routes `invoke` through
 * `destructive-gate` before dispatching here.
 *
 * This step deliberately does **not** inspect or throw on a populated
 * `functionError` — `operations.invokeFunction` itself never throws for a
 * function-level error (the handler threw or timed out), and turning that
 * into a run failure is `run-lambda-ops`'s decision to make once the result
 * has flowed back to the dispatcher (so it can persist the payload/`logResult`
 * to `output` first, for diagnosis).
 *
 * @param deps - The injected `AWS.M3LLambdaOperations`, the target
 *   `functionName`, and the already-parsed invoke `payload` (or `undefined`).
 * @returns The `M3LLambdaInvokeResult`, unchanged.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { invokeFunction } from "./invoke-function.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LLambdaOperations(script.aws.clients.lambda)`.
 * declare const operations: AWS.M3LLambdaOperations;
 *
 * const result = await invokeFunction({
 *   operations,
 *   functionName: "my-function",
 *   payload: { key: "value" },
 * });
 * ```
 */
export function invokeFunction(
  deps: InvokeFunctionDeps,
): Promise<AWS.M3LLambdaInvokeResult> {
  return deps.operations.invokeFunction(deps.functionName, deps.payload);
}
