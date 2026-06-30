/**
 * `core/utils/guards` — runtime type-narrowing predicates.
 *
 * All guards follow the signature `(v: unknown): v is T`.
 * They are pure functions with no side effects and throw nothing.
 *
 * @packageDocumentation
 */

/**
 * Returns `true` when `v` is `null` or `undefined`.
 *
 * @example
 * ```typescript
 * import { isNullish } from "@m3l-automation/m3l-common/core";
 * const v: unknown = null;
 * if (isNullish(v)) {
 *   // v is null | undefined
 * }
 * ```
 */
export function isNullish(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/**
 * Returns `true` when `v` is one of the JS primitive types:
 * `string`, `number`, `boolean`, `bigint`, `symbol`, `null`, or `undefined`.
 *
 * @example
 * ```typescript
 * import { isPrimitive } from "@m3l-automation/m3l-common/core";
 * if (isPrimitive(value)) {
 *   // value is string | number | boolean | bigint | symbol | null | undefined
 * }
 * ```
 */
export function isPrimitive(
  v: unknown,
): v is string | number | boolean | bigint | symbol | null | undefined {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  return (
    t === "string" ||
    t === "number" ||
    t === "boolean" ||
    t === "bigint" ||
    t === "symbol"
  );
}

/**
 * Returns `true` when `v` is an instance of `Error`.
 *
 * @example
 * ```typescript
 * import { isError } from "@m3l-automation/m3l-common/core";
 * if (isError(caught)) {
 *   console.error(caught.message);
 * }
 * ```
 */
export function isError(v: unknown): v is Error {
  return v instanceof Error;
}

/**
 * Returns `true` when `v` is a Node.js `ErrnoException` — an `Error` subclass
 * that carries a string `code` property.
 *
 * @example
 * ```typescript
 * import { isNodeError } from "@m3l-automation/m3l-common/core";
 * if (isNodeError(err)) {
 *   console.error(err.code);
 * }
 * ```
 */
export function isNodeError(v: unknown): v is NodeJS.ErrnoException {
  return (
    isError(v) &&
    "code" in v &&
    typeof (v as NodeJS.ErrnoException).code === "string"
  );
}

/**
 * Returns `true` when `v` is a Node.js `ErrnoException` with `code === "ENOENT"`.
 *
 * @example
 * ```typescript
 * import { isEnoentError } from "@m3l-automation/m3l-common/core";
 * if (isEnoentError(err)) {
 *   // file not found
 * }
 * ```
 */
export function isEnoentError(
  v: unknown,
): v is NodeJS.ErrnoException & { code: "ENOENT" } {
  return isNodeError(v) && v.code === "ENOENT";
}

/**
 * Returns `true` when `v` is a plain object (created via object literal or
 * `Object.create(null)` / `Object.create(Object.prototype)`). Returns `false`
 * for arrays, `Date`, `Map`, `Set`, and other class instances.
 *
 * @example
 * ```typescript
 * import { isPlainObject } from "@m3l-automation/m3l-common/core";
 * if (isPlainObject(data)) {
 *   // data is Record<string, unknown>
 * }
 * ```
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns `true` when `v` is any non-null object (including arrays, `Date`,
 * `Map`, `Set`, and class instances). Use {@link isPlainObject} for stricter
 * plain-object checks.
 *
 * @example
 * ```typescript
 * import { isObject } from "@m3l-automation/m3l-common/core";
 * if (isObject(value)) {
 *   // value is object
 * }
 * ```
 */
export function isObject(v: unknown): v is object {
  return typeof v === "object" && v !== null;
}

/**
 * Returns `true` when `v` is an array (delegates to `Array.isArray`).
 *
 * @example
 * ```typescript
 * import { isArray } from "@m3l-automation/m3l-common/core";
 * if (isArray(value)) {
 *   // value is unknown[]
 * }
 * ```
 */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * Returns `true` when `v` is a string primitive (`typeof v === 'string'`).
 * Boxed `String` objects (via `new String()`) return `false`.
 *
 * @example
 * ```typescript
 * import { isString } from "@m3l-automation/m3l-common/core";
 * if (isString(value)) {
 *   // value is string
 * }
 * ```
 */
export function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Returns `true` when `v` is of type `number` (`typeof v === 'number'`).
 * Note: `NaN` and `Infinity` both satisfy `typeof === 'number'` and thus
 * return `true`.
 *
 * @example
 * ```typescript
 * import { isNumber } from "@m3l-automation/m3l-common/core";
 * if (isNumber(value)) {
 *   // value is number (may be NaN or Infinity)
 * }
 * ```
 */
export function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

/**
 * Returns `true` when `v` is a boolean primitive.
 *
 * @example
 * ```typescript
 * import { isBoolean } from "@m3l-automation/m3l-common/core";
 * if (isBoolean(flag)) {
 *   // flag is boolean
 * }
 * ```
 */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/**
 * Returns `true` when `v` is callable (`typeof v === 'function'`).
 * Matches regular functions, async functions, arrow functions, and class
 * constructors.
 *
 * @example
 * ```typescript
 * import { isFunction } from "@m3l-automation/m3l-common/core";
 * if (isFunction(value)) {
 *   // value is (...args: unknown[]) => unknown
 * }
 * ```
 */
export function isFunction(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === "function";
}

/**
 * Returns `true` when `v` is an instance of `Date`. Does **not** check
 * whether the date value is valid; use {@link isValidDate} for that.
 *
 * @example
 * ```typescript
 * import { isDate } from "@m3l-automation/m3l-common/core";
 * if (isDate(value)) {
 *   // value is Date (may be invalid)
 * }
 * ```
 */
export function isDate(v: unknown): v is Date {
  return v instanceof Date;
}

/**
 * Returns `true` when `v` is a `Date` instance whose value is a valid point
 * in time (i.e. `!isNaN(v.getTime())`).
 *
 * @example
 * ```typescript
 * import { isValidDate } from "@m3l-automation/m3l-common/core";
 * if (isValidDate(value)) {
 *   // value is Date with a valid time
 * }
 * ```
 */
export function isValidDate(v: unknown): v is Date {
  return v instanceof Date && !isNaN(v.getTime());
}

/**
 * Returns `true` when `v` is a Node.js `Buffer` (delegates to
 * `Buffer.isBuffer`).
 *
 * @example
 * ```typescript
 * import { isBuffer } from "@m3l-automation/m3l-common/core";
 * if (isBuffer(value)) {
 *   // value is Buffer
 * }
 * ```
 */
export function isBuffer(v: unknown): v is Buffer {
  return Buffer.isBuffer(v);
}

/**
 * Returns `true` when `v` is an instance of `Map`.
 *
 * @example
 * ```typescript
 * import { isMap } from "@m3l-automation/m3l-common/core";
 * if (isMap(value)) {
 *   // value is Map<unknown, unknown>
 * }
 * ```
 */
export function isMap(v: unknown): v is Map<unknown, unknown> {
  return v instanceof Map;
}

/**
 * Returns `true` when `v` is an instance of `Set`.
 *
 * @example
 * ```typescript
 * import { isSet } from "@m3l-automation/m3l-common/core";
 * if (isSet(value)) {
 *   // value is Set<unknown>
 * }
 * ```
 */
export function isSet(v: unknown): v is Set<unknown> {
  return v instanceof Set;
}

/**
 * Returns `true` when `v` is an instance of `RegExp`.
 *
 * @example
 * ```typescript
 * import { isRegExp } from "@m3l-automation/m3l-common/core";
 * if (isRegExp(value)) {
 *   // value is RegExp
 * }
 * ```
 */
export function isRegExp(v: unknown): v is RegExp {
  return v instanceof RegExp;
}

/**
 * Returns `true` when `v` is a symbol primitive.
 *
 * @example
 * ```typescript
 * import { isSymbol } from "@m3l-automation/m3l-common/core";
 * if (isSymbol(value)) {
 *   // value is symbol
 * }
 * ```
 */
export function isSymbol(v: unknown): v is symbol {
  return typeof v === "symbol";
}

/**
 * Returns `true` when `v` is a bigint primitive.
 *
 * @example
 * ```typescript
 * import { isBigInt } from "@m3l-automation/m3l-common/core";
 * if (isBigInt(value)) {
 *   // value is bigint
 * }
 * ```
 */
export function isBigInt(v: unknown): v is bigint {
  return typeof v === "bigint";
}

/**
 * Returns `true` when `v` duck-types as a `Promise` — it is a non-null object
 * with a `then` function. This intentionally includes non-native thenables
 * (e.g. Bluebird, custom polyfills).
 *
 * @example
 * ```typescript
 * import { isPromise } from "@m3l-automation/m3l-common/core";
 * if (isPromise(value)) {
 *   // value is Promise<unknown>
 * }
 * ```
 */
export function isPromise(v: unknown): v is Promise<unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/**
 * Returns `true` when `v` is a string with at least one character. Note that
 * a string containing only whitespace (e.g. `"   "`) is still non-empty.
 *
 * @example
 * ```typescript
 * import { isNonEmptyString } from "@m3l-automation/m3l-common/core";
 * if (isNonEmptyString(value)) {
 *   // value is a non-empty string
 * }
 * ```
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Returns `true` when `v` is an array containing at least one element.
 *
 * @example
 * ```typescript
 * import { isNonEmptyArray } from "@m3l-automation/m3l-common/core";
 * if (isNonEmptyArray(value)) {
 *   // value is [unknown, ...unknown[]]
 * }
 * ```
 */
export function isNonEmptyArray(v: unknown): v is [unknown, ...unknown[]] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Returns `true` when `v` is a non-null object that contains the given `key`
 * (using the `in` operator, so inherited properties count).
 *
 * @example
 * ```typescript
 * import { hasProperty } from "@m3l-automation/m3l-common/core";
 * if (hasProperty(err, "code")) {
 *   // err is object & Record<"code", unknown>
 * }
 * ```
 */
export function hasProperty<K extends string>(
  v: unknown,
  key: K,
): v is object & Record<K, unknown> {
  if (v === null || typeof v !== "object") return false;
  return key in v;
}

/**
 * Returns `true` when `v` is a non-null object that has a `message` property
 * (using the `in` operator). Shorthand for `hasProperty(v, 'message')`.
 *
 * @example
 * ```typescript
 * import { hasMessage } from "@m3l-automation/m3l-common/core";
 * if (hasMessage(caught)) {
 *   console.error(String(caught.message));
 * }
 * ```
 */
export function hasMessage(v: unknown): v is { message: unknown } {
  return hasProperty(v, "message");
}
