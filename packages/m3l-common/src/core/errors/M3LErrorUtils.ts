/**
 * Utility functions for safe error inspection and wrapping.
 *
 * These helpers operate on `unknown` values — the actual type of anything you
 * catch — so they work correctly whether a collaborator threw an `Error`, a
 * string, a number, or any other value.
 *
 * All functions are pure and never throw.
 *
 * @packageDocumentation
 */

import { M3LError } from "./M3LError.js";
import type { M3LErrorOptions } from "./M3LError.js";

/** Default error code used by {@link wrapError} when no code is supplied. */
const DEFAULT_WRAP_ERROR_CODE = "WRAPPED_ERROR";

/**
 * Extracts a human-readable message from an arbitrary caught value.
 *
 * - `Error` instance → `.message`
 * - `string` → the string itself
 * - anything else → `String(value)`
 *
 * Never throws.
 *
 * @param error - Any caught value.
 * @returns A non-empty string describing the error.
 *
 * @example
 * ```ts
 * try {
 *   riskyOp();
 * } catch (e) {
 *   console.error(getErrorMessage(e)); // always a string
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

/**
 * Coerces any caught value into a standard `Error` instance.
 *
 * - `Error` instances are returned as-is (no wrapping).
 * - All other values are wrapped in a `new Error` whose message is produced
 *   by {@link getErrorMessage}.
 *
 * Never throws.
 *
 * @param error - Any caught value.
 * @returns An `Error` instance.
 *
 * @example
 * ```ts
 * const e = toError(caught); // safe regardless of what was thrown
 * logger.error(e.message);
 * ```
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(getErrorMessage(error));
}

/**
 * Wraps any caught value in an {@link M3LError}, chaining the original as the
 * `cause` so the full error context is preserved.
 *
 * Use this at process-boundary catch sites where you need to surface a typed,
 * structured error while retaining the underlying failure for debugging.
 *
 * @param cause - The original caught value (any type).
 * @param message - Human-readable description of the higher-level failure.
 * @param options - Optional enrichment. If `code` is omitted it defaults to
 *   `"WRAPPED_ERROR"`.
 * @returns A new {@link M3LError} with `cause` set to the original value.
 *
 * @example
 * ```ts
 * try {
 *   await fetchData();
 * } catch (e) {
 *   throw wrapError(e, "failed to fetch data", { code: "ERR_FETCH" });
 * }
 * ```
 */
export function wrapError(
  cause: unknown,
  message: string,
  options?: Omit<M3LErrorOptions, "cause">,
): M3LError {
  const code = options?.code ?? DEFAULT_WRAP_ERROR_CODE;
  // Omit the `context` key entirely when absent so `exactOptionalPropertyTypes`
  // is satisfied — passing `context: undefined` would be a type error.
  if (options?.context !== undefined) {
    return new M3LError(message, { code, context: options.context, cause });
  }
  return new M3LError(message, { code, cause });
}

/**
 * Safely retrieves the `.stack` property from any value.
 *
 * Returns `undefined` when the value is not an `Error`, when it lacks a
 * `.stack` property, or when `.stack` is not a string.
 *
 * Never throws.
 *
 * @param error - Any value.
 * @returns The stack trace string, or `undefined`.
 *
 * @example
 * ```ts
 * const stack = getErrorStack(caught);
 * if (stack !== undefined) logger.debug(stack);
 * ```
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && typeof error.stack === "string") {
    return error.stack;
  }
  return undefined;
}

/**
 * Returns `true` when the value has a `name` property strictly equal to the
 * given string.
 *
 * Safe for any input: non-objects, `null`, `undefined`, and missing `.name`
 * all return `false`.
 *
 * Never throws.
 *
 * @param error - Any value.
 * @param name - The name to match against `error.name`.
 * @returns `true` iff `error.name === name`.
 *
 * @example
 * ```ts
 * if (hasErrorName(caught, "AbortError")) { ... }
 * ```
 */
export function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}

/**
 * Returns `true` when the message derived from `error` contains `substring`.
 *
 * Delegates to {@link getErrorMessage} so the check is consistent with how the
 * library extracts messages from arbitrary caught values.
 *
 * Never throws.
 *
 * @param error - Any value.
 * @param substring - The substring to search for.
 * @returns `true` iff the error message includes `substring`.
 *
 * @example
 * ```ts
 * if (errorMessageContains(e, "ENOENT")) {
 *   // file not found case
 * }
 * ```
 */
export function errorMessageContains(
  error: unknown,
  substring: string,
): boolean {
  return getErrorMessage(error).includes(substring);
}
