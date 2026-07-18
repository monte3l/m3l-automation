/**
 * `aws/lambda/types` — plain, library-owned shapes {@link M3LLambdaOperations}
 * returns and accepts, translated from the raw `@aws-sdk/client-lambda`
 * request/response shapes so callers never see SDK types directly.
 *
 * @packageDocumentation
 */

/**
 * A single function entry as returned by {@link M3LLambdaOperations.listFunctions}.
 */
export interface M3LLambdaFunctionSummary {
  readonly functionName: string;
  readonly functionArn: string;
  readonly runtime?: string;
  readonly lastModified: string;
  readonly state?: string;
}

/**
 * One page of {@link M3LLambdaOperations.listFunctions} results.
 */
export interface M3LLambdaListFunctionsResult {
  readonly functions: readonly M3LLambdaFunctionSummary[];
  /** Present when another page is available; pass back as `marker` to continue. */
  readonly nextMarker?: string;
}

/**
 * The full function configuration returned by
 * {@link M3LLambdaOperations.getFunction}, `createFunction`,
 * `updateFunctionCode`, and `updateFunctionConfiguration`.
 */
export interface M3LLambdaFunctionConfiguration extends M3LLambdaFunctionSummary {
  readonly description?: string;
  readonly handler?: string;
  readonly timeout?: number;
  readonly memorySize?: number;
  readonly role?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

/** Result of {@link M3LLambdaOperations.invokeFunction}. */
export interface M3LLambdaInvokeResult {
  readonly statusCode: number;
  /** The response payload, decoded as a UTF-8 string, when the function returned one. */
  readonly payload?: string;
  /** Present when the function itself errored (as opposed to the invoke call failing). */
  readonly functionError?: string;
  /**
   * Base64 tail of the execution log. `invokeFunction` always requests it
   * (`LogType: "Tail"`); present only when the SDK response includes one.
   */
  readonly logResult?: string;
}

/** Input to {@link M3LLambdaOperations.createFunction}. */
export interface M3LLambdaCreateFunctionInput {
  readonly functionName: string;
  readonly runtime: string;
  readonly role: string;
  readonly handler: string;
  /** Deployment package bytes (zip). */
  readonly zipFile: Uint8Array;
  readonly description?: string;
  readonly timeout?: number;
  readonly memorySize?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

/** Input to {@link M3LLambdaOperations.updateFunctionCode}. */
export interface M3LLambdaUpdateFunctionCodeInput {
  readonly functionName: string;
  /** Replacement deployment package bytes (zip). */
  readonly zipFile: Uint8Array;
}

/** Input to {@link M3LLambdaOperations.updateFunctionConfiguration}. */
export interface M3LLambdaUpdateFunctionConfigurationInput {
  readonly functionName: string;
  readonly description?: string;
  readonly timeout?: number;
  readonly memorySize?: number;
  readonly handler?: string;
  readonly environment?: Readonly<Record<string, string>>;
}
