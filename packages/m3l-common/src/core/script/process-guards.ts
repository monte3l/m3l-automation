/**
 * `core/script/process-guards` — process-global fault guards and the
 * error-serialization helper they (and `M3LScript`) rely on.
 *
 * @packageDocumentation
 */

import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";
import { M3LError } from "../errors/index.js";
import type { M3LSecretNamesPort } from "../logging/redact.js";
import { safeJsonStringify } from "../utils/index.js";

/** Process-global flag guarding {@link installProcessGuards} idempotency. */
let guardsInstalled = false;

/** The current Lambda request ID, if any, attached to guard diagnostics. */
let currentRequestId: string | undefined;

/**
 * Every secret name ever registered via {@link addProcessGuardSecretNames},
 * across every `runScript()` call in this process — a monotonic union,
 * never cleared or narrowed. See {@link addProcessGuardSecretNames} for why
 * this shape (append-only, not a replaceable single slot) is required.
 */
const secretNameUnion = new Set<string>();

/**
 * The `secrets` port consulted by the fault-guard handlers
 * (`unhandledRejection`, `uncaughtException`, `warning`) — a stable object
 * backed by {@link secretNameUnion}, constructed once at module load.
 */
const currentSecrets: M3LSecretNamesPort = {
  isSecret: (name) => secretNameUnion.has(name),
};

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
    logBestEffortDiagnostic("unhandledRejection", serializeError(reason), {
      secrets: currentSecrets,
    });
  });
  process.on("uncaughtException", (error: unknown) => {
    logBestEffortDiagnostic("uncaughtException", serializeError(error), {
      secrets: currentSecrets,
    });
  });
  process.on("warning", (warning: unknown) => {
    logBestEffortDiagnostic("warning", serializeError(warning), {
      secrets: currentSecrets,
    });
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

/**
 * Registers every name in `names` as secret for every subsequent guard-caught
 * fault diagnostic (`unhandledRejection`, `uncaughtException`, `warning`),
 * for the remainder of this process — so a declared secret is redacted
 * wherever it surfaces through one of these process-global fault paths as a
 * recognizable `key=value`/`key: value` pair, subject to
 * `redactSensitiveLogText`'s own key-charset limits (`[A-Za-z0-9_-]` — see
 * that function's docs) and to whatever Node's own default event listeners
 * print independently of this library (e.g. Node's default `warning` handler
 * is not suppressed by adding another `process.on("warning")` listener),
 * even long after (or well before, in an overlapping call) the
 * `runScript()` invocation that declared it.
 *
 * Not re-exported through the `core/script` barrel — consumed only from
 * within `core/script` itself: `run-script.ts`'s `runScript()` calls it once
 * per run, right after deriving its own `secrets` specifier from the
 * script's config schema; `M3LScript`'s constructor also calls it
 * unconditionally, right after deriving `this.secrets`, so a script driven
 * via `createLambdaHandler()` or a bare `script.run()` (neither of which
 * goes through `runScript()`) still widens the union with its own
 * schema-derived names.
 *
 * **Deliberately append-only — there is no corresponding "unregister" or
 * "clear" function, and this is not an oversight.** This redaction port only
 * ever *widens* what gets redacted (the built-in key-name heuristic in
 * `redactSensitiveLogText`/`redactSensitiveLogValue` always still applies
 * underneath, regardless of this set's contents), so once a name has been
 * seen as secret, treating it as secret for the rest of the process is
 * always the safe direction — there is no scenario where retaining a name
 * here causes harm, only one where removing it prematurely does. Two
 * earlier designs both tried a replaceable single-slot value (set on entry,
 * cleared on exit, or set on entry only) and a security review proved both
 * leak: a nested or still-in-flight `runScript()` call, or a background task
 * rejecting after its `runScript()` call already returned, would have its
 * registered names evicted by an unrelated later or earlier call. A
 * monotonic union has no eviction path by construction.
 *
 * @param names - The secret names to register (e.g. an
 *   `M3LSecretsSpecifier.secretNames` snapshot). Duplicate names across
 *   calls are harmless (`Set` semantics).
 *
 * @example
 * ```ts
 * import { addProcessGuardSecretNames } from "./process-guards.js";
 *
 * addProcessGuardSecretNames(["tenantRef", "api-key"]);
 * ```
 */
export function addProcessGuardSecretNames(names: Iterable<string>): void {
  for (const name of names) {
    secretNameUnion.add(name);
  }
}
