/**
 * `sessions/reference` — thin adapter over the promoted
 * `Core.orchestration` step-reference grammar (X6 workbench-sessions module,
 * slice 2, ADR-0068).
 *
 * The parsing/formatting/resolving logic now lives in
 * `@m3l-automation/m3l-common`'s `core/orchestration` submodule; this file
 * exists only to keep the console server's own error hierarchy intact — a
 * caught `Core.M3LStepReferenceError` is re-thrown as an `M3LConsoleError`
 * with the console's own `ERR_CONSOLE_SESSION_REFERENCE_INVALID` code, so
 * `http/envelope.ts` keeps classifying this failure as a 400/caller/
 * non-retryable, not a 500.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

export type { M3LStepReference } from "@m3l-automation/m3l-common/core";

/** Re-throws a caught `Core.M3LStepReferenceError` as the console's own error type; rethrows anything else untouched. */
function rethrowAsConsoleError(cause: unknown): never {
  if (cause instanceof Core.M3LStepReferenceError) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
      cause.message,
      { cause },
    );
  }
  throw cause;
}

/** Adapter over `Core.parseStepReference` — see that function's docs for the grammar. */
export function parseStepReference(text: string): Core.M3LStepReference {
  try {
    return Core.parseStepReference(text);
  } catch (cause) {
    return rethrowAsConsoleError(cause);
  }
}

/** Adapter over `Core.formatStepReference` — the exact inverse of {@link parseStepReference}. */
export function formatStepReference(reference: Core.M3LStepReference): string {
  try {
    return Core.formatStepReference(reference);
  } catch (cause) {
    return rethrowAsConsoleError(cause);
  }
}

/** Adapter over `Core.resolveStepReference` — walks `source` through `reference.segments`. */
export function resolveStepReference(
  reference: Core.M3LStepReference,
  source: unknown,
): unknown {
  try {
    return Core.resolveStepReference(reference, source);
  } catch (cause) {
    return rethrowAsConsoleError(cause);
  }
}
