/**
 * Lightweight `Result` monad for explicit success/failure modelling without
 * throwing exceptions across every call boundary.
 *
 * A `M3LResult<T, E>` is either an `M3LResultOk<T>` (discriminant `ok: true`)
 * or an `M3LResultErr<E>` (discriminant `ok: false`). The union is sealed by
 * the discriminant so TypeScript can narrow it with a simple `if (r.ok)` check
 * or the provided {@link isOk}/{@link isErr} type guards.
 *
 * @packageDocumentation
 */

import { M3LError } from "./M3LError.js";
import { wrapError } from "./M3LErrorUtils.js";

/** Error code thrown when {@link unwrap} is called on an Err result. */
const UNWRAP_ON_ERR_CODE = "RESULT_UNWRAP_ON_ERR";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * The successful variant of {@link M3LResult}.
 *
 * @typeParam T - The value type carried on the happy path.
 */
export type M3LResultOk<T> = {
  readonly ok: true;
  readonly value: T;
};

/**
 * The failure variant of {@link M3LResult}.
 *
 * @typeParam E - The error type carried on the failure path.
 */
export type M3LResultErr<E> = {
  readonly ok: false;
  readonly error: E;
};

/**
 * A discriminated union that is either {@link M3LResultOk} or
 * {@link M3LResultErr}.
 *
 * Use the `ok` discriminant to narrow:
 * ```ts
 * if (r.ok) {
 *   r.value; // T
 * } else {
 *   r.error; // E
 * }
 * ```
 *
 * @typeParam T - Happy-path value type.
 * @typeParam E - Failure-path error type.
 */
export type M3LResult<T, E> = M3LResultOk<T> | M3LResultErr<E>;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Wraps a value in a successful {@link M3LResult}.
 *
 * @param value - The success value.
 * @returns `{ ok: true, value }`.
 *
 * @example
 * ```ts
 * const r = ok(42); // M3LResultOk<number>
 * ```
 */
export function ok<T>(value: T): M3LResultOk<T> {
  return { ok: true, value };
}

/**
 * Wraps an error in a failed {@link M3LResult}.
 *
 * @param error - The failure value.
 * @returns `{ ok: false, error }`.
 *
 * @example
 * ```ts
 * const r = err(new Error("boom")); // M3LResultErr<Error>
 * ```
 */
export function err<E>(error: E): M3LResultErr<E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrows a {@link M3LResult} to {@link M3LResultOk} inside a truthy branch.
 *
 * @param r - Any `M3LResult`.
 * @returns `true` when `r.ok === true`.
 */
export function isOk<T, E>(r: M3LResult<T, E>): r is M3LResultOk<T> {
  return r.ok === true;
}

/**
 * Narrows a {@link M3LResult} to {@link M3LResultErr} inside a truthy branch.
 *
 * @param r - Any `M3LResult`.
 * @returns `true` when `r.ok === false`.
 */
export function isErr<T, E>(r: M3LResult<T, E>): r is M3LResultErr<E> {
  return r.ok === false;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extracts the value from an ok result, or throws an {@link M3LError} if the
 * result is an error.
 *
 * The thrown error chains the original err value as its `cause`.
 *
 * @param r - The result to unwrap.
 * @returns The inner value when `r` is ok.
 * @throws {@link M3LError} when `r` is an error result.
 *
 * @example
 * ```ts
 * const value = unwrap(ok(42)); // 42
 * unwrap(err("fail"));           // throws M3LError
 * ```
 */
export function unwrap<T, E>(r: M3LResult<T, E>): T {
  if (r.ok) {
    return r.value;
  }
  throw new M3LError("Called unwrap on an Err result", {
    code: UNWRAP_ON_ERR_CODE,
    context: { error: r.error },
    cause: r.error,
  });
}

/**
 * Extracts the value from an ok result, returning `fallback` for an error.
 *
 * @param r - The result to unwrap.
 * @param fallback - Value returned when `r` is an error result.
 * @returns The inner value or `fallback`.
 *
 * @example
 * ```ts
 * unwrapOr(err(new Error()), 0); // 0
 * ```
 */
export function unwrapOr<T, E>(r: M3LResult<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

/**
 * Applies `fn` to the value of an ok result and returns a new ok result.
 * Passes an error result through unchanged without invoking `fn`.
 *
 * Overloads preserve the narrower return type when the input is already a
 * specific variant, avoiding phantom `never` type parameters that TypeScript
 * 6.x union-reduction rules might otherwise collapse unexpectedly.
 *
 * @param r - The source result.
 * @param fn - Transformation function applied to the value.
 * @returns A new `M3LResult` with the mapped value, or the original error.
 *
 * @example
 * ```ts
 * map(ok(3), (n) => n * 2); // ok(6)
 * map(err("x"), (n) => n);  // err("x"), fn never called
 * ```
 */
export function map<T, U>(
  r: M3LResultOk<T>,
  fn: (value: T) => U,
): M3LResultOk<U>;
export function map<T, U, E>(
  r: M3LResultErr<E>,
  /** fn is never invoked on the err path. */
  fn: (value: T) => U,
): M3LResultErr<E>;
export function map<T, U, E>(
  r: M3LResult<T, E>,
  fn: (value: T) => U,
): M3LResult<U, E>;
export function map<T, U, E>(
  r: M3LResult<T, E>,
  fn: (value: T) => U,
): M3LResult<U, E> {
  if (r.ok) {
    return ok(fn(r.value));
  }
  return r;
}

/**
 * Applies `fn` to the error of an err result and returns a new err result.
 * Passes an ok result through unchanged without invoking `fn`.
 *
 * Overloads preserve the narrower return type when the input is already a
 * specific variant.
 *
 * @param r - The source result.
 * @param fn - Transformation function applied to the error.
 * @returns A new `M3LResult` with the mapped error, or the original ok.
 *
 * @example
 * ```ts
 * mapErr(err(42), (n) => String(n)); // err("42")
 * mapErr(ok(1), (e) => e);           // ok(1), fn never called
 * ```
 */
export function mapErr<T, E, F>(
  r: M3LResultOk<T>,
  /** fn is never invoked on the ok path. */
  fn: (error: E) => F,
): M3LResultOk<T>;
export function mapErr<E, F>(
  r: M3LResultErr<E>,
  fn: (error: E) => F,
): M3LResultErr<F>;
export function mapErr<T, E, F>(
  r: M3LResult<T, E>,
  fn: (error: E) => F,
): M3LResult<T, F>;
export function mapErr<T, E, F>(
  r: M3LResult<T, E>,
  fn: (error: E) => F,
): M3LResult<T, F> {
  if (!r.ok) {
    return err(fn(r.error));
  }
  return r;
}

/**
 * Flat-maps an ok result through `fn`, which itself returns a `M3LResult`.
 * Passes an error result through unchanged without invoking `fn`.
 *
 * This is the `flatMap` / `bind` operation for the `Result` monad — it avoids
 * double-wrapping when chaining operations that each return a `M3LResult`.
 *
 * @param r - The source result.
 * @param fn - A function from `T` to `M3LResult<U, E>`.
 * @returns `fn(r.value)` when `r` is ok, else the original error result.
 *
 * @example
 * ```ts
 * andThen(ok(4), (n) => ok(n + 1)); // ok(5)
 * andThen(ok(0), () => err("nope")); // err("nope")
 * andThen(err("up"), () => ok(1));   // err("up"), fn never called
 * ```
 */
export function andThen<T, U, E>(
  r: M3LResult<T, E>,
  fn: (value: T) => M3LResult<U, E>,
): M3LResult<U, E> {
  if (r.ok) {
    return fn(r.value);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Converts a `Promise<T>` to a `Promise<M3LResult<T, M3LError>>`.
 *
 * The returned promise itself never rejects — a rejection is caught and
 * converted to an `err(M3LError)` so callers can handle errors uniformly
 * without `try/catch` at every call site.
 *
 * Rejections that are not already `M3LError` instances are normalized via
 * `wrapError`.
 *
 * @param p - The promise to convert.
 * @returns A promise resolving to an ok or err result.
 *
 * @example
 * ```ts
 * const r = await fromPromise(fetchUser(id));
 * if (isOk(r)) r.value; // User
 * else r.error;          // M3LError
 * ```
 */
export async function fromPromise<T>(
  p: Promise<T>,
): Promise<M3LResult<T, M3LError>> {
  try {
    const value = await p;
    return ok(value);
  } catch (cause: unknown) {
    if (cause instanceof M3LError) {
      return err(cause);
    }
    return err(
      wrapError(cause, "Promise rejected", { code: "PROMISE_REJECTED" }),
    );
  }
}

/**
 * Executes a synchronous function and wraps its result in a `M3LResult`.
 *
 * Unlike {@link fromPromise}, the error channel is typed `unknown` — the
 * thrown value is captured as-is without normalization, preserving the exact
 * thrown value for the caller to inspect.
 *
 * @param fn - A synchronous function to execute.
 * @returns `ok(return value)` or `err(thrown value)`.
 *
 * @example
 * ```ts
 * const r = tryCatch(() => JSON.parse(raw));
 * if (isErr(r)) {
 *   // r.error is unknown — narrow before use
 * }
 * ```
 */
export function tryCatch<T>(fn: () => T): M3LResult<T, unknown> {
  try {
    return ok(fn());
  } catch (e: unknown) {
    return err(e);
  }
}
