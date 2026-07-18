/**
 * `aws/lambda` — typed Lambda operations wrapper over the raw
 * `@aws-sdk/client-lambda` `LambdaClient`, so callers never import SDK
 * command classes directly. Control-plane CRUD + invoke only.
 *
 * @packageDocumentation
 */

export { M3LLambdaOperations } from "./client.js";
export { M3LLambdaOperationError } from "./error.js";
export type {
  M3LLambdaCreateFunctionInput,
  M3LLambdaFunctionConfiguration,
  M3LLambdaFunctionSummary,
  M3LLambdaInvokeResult,
  M3LLambdaListFunctionsResult,
  M3LLambdaUpdateFunctionCodeInput,
  M3LLambdaUpdateFunctionConfigurationInput,
} from "./types.js";
