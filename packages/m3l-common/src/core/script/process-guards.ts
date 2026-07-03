/**
 * `core/script/process-guards` — process-global fault guards and the
 * error-serialization helper they (and `M3LScript`) rely on.
 *
 * @packageDocumentation
 */

import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";
import { M3LError } from "../errors/index.js";
import { safeJsonStringify } from "../utils/index.js";

/** Process-global flag guarding {@link installProcessGuards} idempotency. */
let guardsInstalled = false;

/** The current Lambda request ID, if any, attached to guard diagnostics. */
let currentRequestId: string | undefined;

/** A plain, JSON-serializable representation of an arbitrary caught value. */
interface SerializedError {
  /** The human-readable error message. */
  readonly message: string;
  /** The machine-readable error code, present only for {@link M3LError} instances. */
  readonly code?: string;
  /** The error's `name` property, when the input was an `Error`. */
  readonly name?: string;
  /** The error's stack trace, when available. */
  readonly stack?: string;
  /** Structured diagnostic context, present only for {@link M3LError} instances. */
  readonly context?: Record<string, unknown>;
  /** The Lambda request ID active when this error was serialized, if any. */
  readonly requestId?: string;
}

/**
 * Produces a plain, JSON-serializable representation of any caught value —
 * an `Error`, an {@link M3LError}, a bare string, `undefined`, or anything
 * else (including a circular object). Never throws.
 *
 * Used by {@link installProcessGuards}'s handlers to safely log
 * process-fault diagnostics (`unhandledRejection`, `uncaughtException`)
 * without risking a secondary crash from an unserializable error.
 *
 * @param error - Any caught value.
 * @returns A plain record safe to pass to `JSON.stringify`.
 *
 * @example
 * ```ts
 * import { serializeError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   throw new Error("boom");
 * } catch (e) {
 *   console.log(JSON.stringify(serializeError(e)));
 * }
 * ```
 */
export function serializeError(error: unknown): SerializedError {
  const base: SerializedError =
    error instanceof M3LError
      ? {
          message: error.message,
          code: error.code,
          name: error.name,
          // context/cause may contain non-serializable values (circular
          // references, functions); round-trip through safeJsonStringify so
          // the field is always safe to embed in the final JSON output.
          context: JSON.parse(safeJsonStringify(error.context)) as Record<
            string,
            unknown
          >,
          ...(error.stack !== undefined && { stack: error.stack }),
        }
      : error instanceof Error
        ? {
            message: error.message,
            name: error.name,
            ...(error.stack !== undefined && { stack: error.stack }),
          }
        : { message: describeNonError(error) };

  return currentRequestId === undefined
    ? base
    : { ...base, requestId: currentRequestId };
}

/** Renders a human-readable message for a caught value that is not an `Error`. */
function describeNonError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  return safeJsonStringify(error);
}

/**
 * Installs the process-global fault-guard handlers exactly once per process:
 * `unhandledRejection`, `uncaughtException`, `warning`, and `beforeExit`.
 * Each writes a best-effort, JSON-serialized diagnostic to `process.stderr`
 * via {@link serializeError} — the guards observe and report faults, they do
 * not change process exit behavior themselves.
 *
 * Calling this function more than once is a no-op after the first call
 * (idempotent process-global singleton), so it is safe to call from every
 * {@link M3LScript} constructor without accumulating duplicate handlers.
 *
 * @example
 * ```ts
 * import { installProcessGuards } from "@m3l-automation/m3l-common/core";
 *
 * installProcessGuards();
 * ```
 */
export function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  process.on("unhandledRejection", (reason: unknown) => {
    logBestEffortDiagnostic("unhandledRejection", serializeError(reason));
  });
  process.on("uncaughtException", (error: unknown) => {
    logBestEffortDiagnostic("uncaughtException", serializeError(error));
  });
  process.on("warning", (warning: unknown) => {
    logBestEffortDiagnostic("warning", serializeError(warning));
  });
  process.on("beforeExit", () => {
    // No fault to report — presence confirms the guard layer observes
    // normal process shutdown too, per the documented contract.
  });
}

/**
 * Sets the Lambda request ID attached to every subsequent
 * {@link serializeError} result, so guard-caught errors during a Lambda
 * invocation can be correlated back to that invocation in logs.
 *
 * @param requestId - The current invocation's request ID.
 *
 * @example
 * ```ts
 * import { setProcessGuardRequestId } from "@m3l-automation/m3l-common/core";
 *
 * export const handler = async (event: unknown, context: { awsRequestId: string }) => {
 *   setProcessGuardRequestId(context.awsRequestId);
 *   // ...
 * };
 * ```
 */
export function setProcessGuardRequestId(requestId: string): void {
  currentRequestId = requestId;
}
