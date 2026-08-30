/**
 * `aws/bedrock-runtime/error` — typed errors for
 * {@link M3LBedrockRuntimeOperations} Converse API failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

import { sanitizeForMessage } from "./message-safety.js";
import type { M3LBedrockStopReason, M3LBedrockTokenUsage } from "./types.js";

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
 * `modelId` is both an own field (`error.modelId`, carried verbatim) and
 * mirrored into `context.modelId` (2026-08-29 security pass round 5,
 * Must-fix F4: `context` — unlike `modelId`, unlike `error.modelId` — is
 * what `toJSON()` serializes verbatim and unredacted, so `context.modelId`
 * is rendered through `message-safety.ts`'s `sanitizeForMessage` before
 * storage, capping length and escaping control characters).
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
      context: { modelId: sanitizeForMessage(options.modelId) },
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
  /**
   * The last attempt's fault, chaining the most recent evidence of why the
   * fallback list as a whole failed. Absent when `models` was empty at
   * construction (no attempt was ever made).
   */
  readonly cause?: unknown;
}

/**
 * Thrown when `models` is empty at construction (`attemptedModels: []`, no
 * `cause`), or by {@link M3LBedrockRuntimeOperations.invoke} when every model
 * in the fallback order has been exhausted by availability faults
 * (`ModelNotReadyException`/`ModelTimeoutException`/
 * `ServiceUnavailableException`, or an exhausted
 * `ThrottlingException`/`InternalServerException` retry). `attemptedModels`
 * lists every model id tried, in order, and `cause` chains the **last**
 * attempt's fault — the most recent evidence of why the fallback list as a
 * whole failed, not a synthetic message. `origin: caller`,
 * `retryable: false` — the caller's model list is the fault, not AWS.
 *
 * `attemptedModels` is both an own field (carried verbatim) and mirrored
 * into `context.attemptedModels` (each entry rendered through
 * `sanitizeForMessage`, same F4 rationale as
 * {@link M3LBedrockRuntimeModelError.modelId}). `cause` is the standard
 * `M3LError` chain (not an own field) — without it, a caller whose every
 * model failed for a genuine, diagnosable AWS-side reason would see only a
 * bare `attemptedModels` list with no evidence of _why_.
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
   *   directly as a typed instance property), and an optional `cause`
   *   chaining the last attempt's fault.
   */
  constructor(message: string, options: M3LBedrockRuntimeNoModelErrorOptions) {
    super(message, {
      code: "ERR_BEDROCK_RUNTIME_NO_MODEL",
      context: {
        attemptedModels: options.attemptedModels.map((modelId) =>
          sanitizeForMessage(modelId),
        ),
      },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
    this.attemptedModels = options.attemptedModels;
  }
}

/**
 * Constructor options for {@link M3LBedrockRuntimeStreamError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it.
 */
interface M3LBedrockRuntimeStreamErrorOptions {
  /** The model that was streaming when the fault occurred. */
  readonly modelId: string;
  /** How many {@link M3LBedrockStreamEvent}s the caller already consumed before the fault. */
  readonly eventsEmitted: number;
  /**
   * Whether a caller can safely re-invoke `invokeStream` without risking
   * duplicated output. `true` only for the zero-event clean-drain case
   * (`eventsEmitted === 0` — nothing reached the caller); `false` for every
   * mid-stream fault (`eventsEmitted >= 1` there, by construction).
   */
  readonly retrySafe: boolean;
  /** The underlying cause of the lifecycle fault, when available. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LBedrockRuntimeOperations.invokeStream} for a
 * streaming-lifecycle fault that occurs **after** `invokeStream` has already
 * yielded at least one `M3LBedrockStreamEvent` to the caller — at that
 * point retry and fallback are both unsafe (falling back would re-run the
 * prompt and silently append a second, unrelated continuation to a
 * partially-delivered reply), so this class exists specifically to make
 * "some output was already delivered, a naive retry would produce a second,
 * unrelated continuation" a type-visible, programmatically-checkable
 * distinction from every other error this module throws. Also thrown for a
 * stream that drains cleanly without ever delivering both a `messageStop`
 * and a `metadata` event — a truncated stream is a lifecycle fault, the
 * same tier as any other post-first-byte failure.
 *
 * `modelId`, `eventsEmitted`, and `retrySafe` are all own fields (`modelId`
 * carried verbatim) and mirrored into `context` (`context.modelId` rendered
 * through `sanitizeForMessage`, same F4 rationale as
 * {@link M3LBedrockRuntimeModelError.modelId}). `retrySafe` is the
 * type-visible, programmatically-checkable answer to "did the caller
 * already receive output that a retry would duplicate?" — `true` only for
 * the zero-event clean-drain case, `false` for every mid-stream fault; a
 * caller should branch on `retrySafe` rather than compare `eventsEmitted`
 * itself, since the field exists precisely so that comparison never has to
 * be written at every call site. `origin: external`,
 * `retryable: "situational"` — situational for the same reason `retrySafe`
 * exists: a blanket "retry"/"don't retry" classification would be wrong for
 * one of the two cases this class covers. `cause` is the standard `M3LError`
 * chain (`unknown`, never an own field) — absent for the zero-event
 * clean-drain case, present for every mid-stream fault case.
 *
 * @example
 * ```ts
 * import { M3LBedrockRuntimeStreamError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   for await (const event of ops.invokeStream(request)) {
 *     // consume event
 *   }
 * } catch (error) {
 *   if (error instanceof M3LBedrockRuntimeStreamError) {
 *     console.error(error.modelId, error.eventsEmitted, error.retrySafe);
 *   }
 * }
 * ```
 */
export class M3LBedrockRuntimeStreamError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_BEDROCK_RUNTIME_STREAM"`. */
  override readonly code = "ERR_BEDROCK_RUNTIME_STREAM" as const;

  /** The model that was streaming when the fault occurred. */
  readonly modelId: string;

  /** How many {@link M3LBedrockStreamEvent}s the caller already consumed before the fault. */
  readonly eventsEmitted: number;

  /**
   * Whether a caller can safely re-invoke `invokeStream` without risking
   * duplicated output — `true` only for the zero-event clean-drain case.
   */
  readonly retrySafe: boolean;

  /**
   * Creates a new `M3LBedrockRuntimeStreamError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `modelId`, `eventsEmitted`, and `retrySafe` (all
   *   carried in `context` and exposed directly as typed instance
   *   properties), and an optional `cause` chaining the underlying fault.
   */
  constructor(message: string, options: M3LBedrockRuntimeStreamErrorOptions) {
    super(message, {
      code: "ERR_BEDROCK_RUNTIME_STREAM",
      context: {
        modelId: sanitizeForMessage(options.modelId),
        eventsEmitted: options.eventsEmitted,
        retrySafe: options.retrySafe,
      },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
    this.modelId = options.modelId;
    this.eventsEmitted = options.eventsEmitted;
    this.retrySafe = options.retrySafe;
  }
}

/**
 * Constructor options for {@link M3LBedrockToolLoopError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it
 * (precedent: every options interface in this module stays internal).
 */
interface M3LBedrockToolLoopErrorOptions {
  /** The configured iteration ceiling (`M3LBedrockToolLoopOptions.maxIterations`) that was reached. */
  readonly maxIterations: number;
  /** How many iterations actually completed before the ceiling fired — see {@link M3LBedrockToolLoopError}'s own doc comment for the "completed" convention this shares with `usage`. */
  readonly iterationsCompleted: number;
  /** The `stopReason` from the last completed iteration. */
  readonly lastStopReason: M3LBedrockStopReason;
  /** Cumulative token usage across every completed iteration — see {@link M3LBedrockToolLoopError}'s own doc comment for the "completed" convention this shares with `iterationsCompleted`. */
  readonly usage: M3LBedrockTokenUsage;
  /** The model that served the last completed iteration. */
  readonly modelId: string;
  /** How many `toolUse` blocks from the last turn were never dispatched to a handler. */
  readonly pendingToolCount: number;
  /** How many tool executions, across every iteration, ended in `status: "error"`. */
  readonly toolErrorCount: number;
}

/**
 * Thrown by `runBedrockToolLoop` (`loop.ts`) for exactly two conditions
 * (V5 Slice B contract C5): (a) `maxIterations` is reached while the model is
 * still requesting tools (`stopReason: "tool_use"`), or (b) a single turn's
 * `toolUse` batch exceeds `maxToolsPerTurn`. Every other loop-owned failure —
 * ceiling-*parameter* validation, and a malformed-reply disposition such as a
 * missing/empty `toolUseId`/`name` or a duplicate `toolUseId` — throws
 * {@link M3LBedrockRuntimeOperationError} instead, deliberately, so that this
 * class's `context` can stay a TOTAL nine-key set: every field named below is
 * always available by the time either of these two conditions is reached
 * (there is no "ceiling breached before the first invoke" case here — that
 * one has no `lastStopReason`/`modelId`/usage yet, and routes through
 * `M3LBedrockRuntimeOperationError` for exactly that reason).
 *
 * `origin: "caller"`, `retryable: false` — the caller's `maxIterations`/
 * `maxToolsPerTurn`/registered tools are what need to change, not a retry.
 *
 * `usage` and `modelId` are both own fields (`modelId` carried verbatim) and
 * mirrored into `context` — `usage` FLATTENED into three numeric keys
 * (`inputTokens`/`outputTokens`/`totalTokens`), `modelId` rendered through
 * `sanitizeForMessage` (same F4 rationale as
 * {@link M3LBedrockRuntimeModelError.modelId}: `M3LError.context` is
 * serialized **verbatim** by `toJSON()`, so every string value entering it
 * must be sanitized first). The message template interpolates numbers only —
 * `modelId` never reaches `message`.
 *
 * `iterationsCompleted` and `usage` share ONE convention (S1, 2026-08
 * security-pass follow-up): "completed" means "performed an `invoke()`
 * round-trip", independent of whether the tool dispatch that would have
 * followed it was itself allowed to proceed. For the `maxToolsPerTurn`
 * breach specifically, `loop.ts`'s `enforceToolsPerTurnCeiling` records this
 * iteration's own ledger entry (empty `toolExecutions`, since no handler
 * ever ran) BEFORE throwing, so both fields count it — `usage` always did
 * (it is computed from the already-summed `nextUsage`), and
 * `iterationsCompleted` now matches rather than silently excluding the one
 * invoke that triggered the error.
 *
 * @example
 * ```ts
 * import { M3LBedrockToolLoopError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await runBedrockToolLoop(ops, conversation, { tools });
 * } catch (error) {
 *   if (error instanceof M3LBedrockToolLoopError) {
 *     console.error(error.iterationsCompleted, error.pendingToolCount);
 *   }
 * }
 * ```
 */
export class M3LBedrockToolLoopError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_BEDROCK_RUNTIME_TOOL_LOOP"`. */
  override readonly code = "ERR_BEDROCK_RUNTIME_TOOL_LOOP" as const;

  /**
   * Narrows `cause` to `undefined`: this error never chains an underlying
   * fault, only a ceiling breach. Structurally enforced (mirrors
   * {@link M3LOperationAbortedError}) because the constructor accepts no
   * `cause` parameter at all — see this class's own constructor.
   */
  declare readonly cause: undefined;

  /** The configured iteration ceiling that was reached. */
  readonly maxIterations: number;

  /** How many iterations actually completed before the ceiling fired — see {@link M3LBedrockToolLoopError}'s own doc comment for the "completed" convention this shares with `usage`. */
  readonly iterationsCompleted: number;

  /** The `stopReason` from the last completed iteration. */
  readonly lastStopReason: M3LBedrockStopReason;

  /** Cumulative token usage across every completed iteration — see {@link M3LBedrockToolLoopError}'s own doc comment for the "completed" convention this shares with `iterationsCompleted`. */
  readonly usage: M3LBedrockTokenUsage;

  /** The model that served the last completed iteration. */
  readonly modelId: string;

  /** How many `toolUse` blocks from the last turn were never dispatched to a handler. */
  readonly pendingToolCount: number;

  /** How many tool executions, across every iteration, ended in `status: "error"`. */
  readonly toolErrorCount: number;

  /**
   * Creates a new `M3LBedrockToolLoopError`. Accepts no `cause` parameter —
   * see this class's doc comment.
   *
   * @param message - Human-readable description of the ceiling breach.
   * @param options - The full loop-termination context: iteration/tool
   *   counters, the last stop reason, cumulative usage, and the serving
   *   model id.
   */
  constructor(message: string, options: M3LBedrockToolLoopErrorOptions) {
    super(message, {
      code: "ERR_BEDROCK_RUNTIME_TOOL_LOOP",
      context: {
        maxIterations: options.maxIterations,
        iterationsCompleted: options.iterationsCompleted,
        lastStopReason: options.lastStopReason,
        inputTokens: options.usage.inputTokens,
        outputTokens: options.usage.outputTokens,
        totalTokens: options.usage.totalTokens,
        modelId: sanitizeForMessage(options.modelId),
        pendingToolCount: options.pendingToolCount,
        toolErrorCount: options.toolErrorCount,
      },
    });
    this.maxIterations = options.maxIterations;
    this.iterationsCompleted = options.iterationsCompleted;
    this.lastStopReason = options.lastStopReason;
    this.usage = options.usage;
    this.modelId = options.modelId;
    this.pendingToolCount = options.pendingToolCount;
    this.toolErrorCount = options.toolErrorCount;
  }
}
