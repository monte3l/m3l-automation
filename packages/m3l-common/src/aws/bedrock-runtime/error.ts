/**
 * `aws/bedrock-runtime/error` — typed errors for
 * {@link M3LBedrockRuntimeOperations} Converse API failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LBedrockRuntimeOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LBedrockRuntimeOperationErrorOptions {
  /** The underlying cause, when the failure originates from the SDK call itself. */
  readonly cause?: unknown;
  /**
   * Per-instance override for the catalog-derived `origin`. Set to
   * `"caller"` for a request-shape or permission fault (`ValidationException`
   * / `AccessDeniedException` / `ResourceNotFoundException` /
   * `ServiceQuotaExceededException`) that no retry or model fallback can fix.
   */
  readonly origin?: "caller" | "external";
  /** Per-instance override for the catalog-derived `retryable`, paired with `origin`. */
  readonly retryable?: boolean;
}

/**
 * Thrown by {@link M3LBedrockRuntimeOperations.invoke} for a transport/API-call
 * failure: `ValidationException`, `AccessDeniedException`,
 * `ResourceNotFoundException`, `ServiceQuotaExceededException`, any other
 * non-classified `client.send()` rejection, or a malformed-but-successful
 * response (missing `output`/`stopReason`/`usage`, or an `output` not
 * matching the expected message shape). Thrown immediately, with no fallback
 * advance.
 *
 * **Not** thrown for an exhausted `InternalServerException`/
 * `ThrottlingException` retry — exhaustion always advances fallback instead,
 * so the terminal error on full exhaustion is always
 * {@link M3LBedrockRuntimeNoModelError}, never this class.
 *
 * `origin`/`retryable` default to `external`/`true` from the error catalog,
 * but a `ValidationException`/`AccessDeniedException`/
 * `ResourceNotFoundException`/`ServiceQuotaExceededException` cause overrides
 * them per-instance to `caller`/`false`.
 *
 * @example
 * ```ts
 * import { M3LBedrockRuntimeOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await ops.invoke(request);
 * } catch (error) {
 *   if (error instanceof M3LBedrockRuntimeOperationError) {
 *     console.error(error.origin, error.retryable);
 *   }
 * }
 * ```
 */
export class M3LBedrockRuntimeOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_BEDROCK_RUNTIME_OPERATION"`. */
  override readonly code = "ERR_BEDROCK_RUNTIME_OPERATION" as const;

  /**
   * Creates a new `M3LBedrockRuntimeOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional `cause` chaining the underlying SDK failure,
   *   and an optional `origin`/`retryable` per-instance override.
   */
  constructor(
    message: string,
    options?: M3LBedrockRuntimeOperationErrorOptions,
  ) {
    super(message, {
      code: "ERR_BEDROCK_RUNTIME_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
      ...(options?.origin !== undefined && { origin: options.origin }),
      ...(options?.retryable !== undefined && {
        retryable: options.retryable,
      }),
    });
  }
}

/**
 * Constructor options for {@link M3LBedrockRuntimeModelError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it.
 */
interface M3LBedrockRuntimeModelErrorOptions {
  /** Which model in the fallback list faulted. */
  readonly modelId: string;
  /** The underlying `ModelErrorException`/`ModelStreamErrorException`. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LBedrockRuntimeOperations.invoke} for
 * `ModelErrorException` — the model itself faulted while processing this
 * specific input. Not retried and does **not** trigger fallback: a different
 * model may or may not do better on the same malformed/edge-case input, so
 * ADR-0059 treats this as the caller's decision (`origin: external`,
 * `retryable: "situational"`).
 *
 * `modelId` is both an own field (`error.modelId`) and mirrored into
 * `context.modelId` — `context` is what `toJSON()` serializes and what
 * ADR-0035 diagnostics tooling reads.
 *
 * @example
 * ```ts
 * import { M3LBedrockRuntimeModelError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await ops.invoke(request);
 * } catch (error) {
 *   if (error instanceof M3LBedrockRuntimeModelError) {
 *     console.error(error.modelId);
 *   }
 * }
 * ```
 */
export class M3LBedrockRuntimeModelError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_BEDROCK_RUNTIME_MODEL"`. */
  override readonly code = "ERR_BEDROCK_RUNTIME_MODEL" as const;

  /** Which model in the fallback list faulted. */
  readonly modelId: string;

  /**
   * Creates a new `M3LBedrockRuntimeModelError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `modelId` (carried in `context` and exposed directly as
   *   a typed instance property), and an optional `cause` chaining the
   *   underlying SDK failure.
   */
  constructor(message: string, options: M3LBedrockRuntimeModelErrorOptions) {
    super(message, {
      code: "ERR_BEDROCK_RUNTIME_MODEL",
      context: { modelId: options.modelId },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
    this.modelId = options.modelId;
  }
}

/**
 * Constructor options for {@link M3LBedrockRuntimeNoModelError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it.
 */
interface M3LBedrockRuntimeNoModelErrorOptions {
  /** Every model id tried, in order (empty when `models` was empty at construction). */
  readonly attemptedModels: readonly string[];
}

/**
 * Thrown when `models` is empty at construction (`attemptedModels: []`), or
 * by {@link M3LBedrockRuntimeOperations.invoke} when every model in the
 * fallback order has been exhausted by availability faults
 * (`ModelNotReadyException`/`ModelTimeoutException`/
 * `ServiceUnavailableException`, or an exhausted
 * `ThrottlingException`/`InternalServerException` retry).
 * `attemptedModels` lists every model id tried, in order. `origin: caller`,
 * `retryable: false` — the caller's model list is the fault, not AWS.
 *
 * `attemptedModels` is both an own field and mirrored into
 * `context.attemptedModels`, for the same `toJSON()`/diagnostics reason as
 * {@link M3LBedrockRuntimeModelError.modelId}.
 *
 * @example
 * ```ts
 * import { M3LBedrockRuntimeNoModelError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await ops.invoke(request);
 * } catch (error) {
 *   if (error instanceof M3LBedrockRuntimeNoModelError) {
 *     console.error(error.attemptedModels);
 *   }
 * }
 * ```
 */
export class M3LBedrockRuntimeNoModelError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_BEDROCK_RUNTIME_NO_MODEL"`. */
  override readonly code = "ERR_BEDROCK_RUNTIME_NO_MODEL" as const;

  /** Every model id tried, in order. */
  readonly attemptedModels: readonly string[];

  /**
   * Creates a new `M3LBedrockRuntimeNoModelError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `attemptedModels` (carried in `context` and exposed
   *   directly as a typed instance property).
   */
  constructor(message: string, options: M3LBedrockRuntimeNoModelErrorOptions) {
    super(message, {
      code: "ERR_BEDROCK_RUNTIME_NO_MODEL",
      context: { attemptedModels: options.attemptedModels },
    });
    this.attemptedModels = options.attemptedModels;
  }
}
