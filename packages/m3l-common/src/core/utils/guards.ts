/**
 * `core/utils/guards` — runtime type-narrowing predicates.
 *
 * All guards follow the signature `(v: unknown): v is T`.
 * They are pure functions with no side effects. They do not throw for any
 * ordinary value, but a hostile `Proxy` whose
 * `has`/`getPrototypeOf`/`getOwnPropertyDescriptor` trap throws will
 * propagate that — a guard cannot be more total than the operators it is
 * built from.
 *
 * @packageDocumentation
 */

/**
 * Returns `true` when `v` is `null` or `undefined`.
 *
 * @example
 * ```typescript
 * import { isNullish } from "@monte3l/m3l-common/core";
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
 * import { isPrimitive } from "@monte3l/m3l-common/core";
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
 * import { isError } from "@monte3l/m3l-common/core";
 * if (isError(caught)) {
 *   console.error(caught.message);
 * }
 * ```
 */
export function isError(v: unknown): v is Error {
  return v instanceof Error;
}

/**
 * Returns the `errno` code an `Error` carries as its OWN property, or
 * `undefined` for anything else. {@link isNodeError} and
 * {@link isEnoentError} are the narrowing boolean forms built on top of
 * this — call them when you only need a `v is T` guard, and call this
 * directly when you need the code string itself (e.g. to switch on it).
 *
 * OWNERSHIP IS PART OF THE CHECK. A caller's tolerate/rethrow decision is
 * driven by this code, so honouring an INHERITED `code` would make that
 * decision forgeable at a distance — one `Error.prototype.code = "ENOENT"`
 * anywhere in the process, or a `get code()` on a thrown subclass's
 * prototype, and every unrelated failure would present as the tolerated
 * one. Node's own errno errors always set `code` as an own property, so
 * requiring ownership costs no real `node:fs` call site anything.
 *
 * Reads `.code` ONCE into a local and narrows the local, never the property
 * expression: an accessor may answer differently on each read, so a
 * validate-then-compare chain over `v.code` is two reads of a value only
 * one of them checked. `Object.hasOwn` tests for the property without
 * reading it, so the ownership guard adds no second read.
 *
 * `packages/m3l-console-server/src/errors/errno.ts` currently carries an
 * independent, byte-for-byte mirror of this same algorithm under the same
 * name (`errnoCodeOf`) — it predates this export and cannot yet depend on it
 * without crossing the console's own zone-import boundary in a way not yet
 * wired up. A follow-up collapses that copy into a re-export of this symbol.
 *
 * @param v - The value to inspect.
 * @returns The own `code` string, or `undefined` when `v` is not an `Error`
 * or carries no own string `code`.
 * @example
 * ```typescript
 * import { errnoCodeOf } from "@monte3l/m3l-common/core";
 * const code = errnoCodeOf(caught);
 * if (code === "ENOENT") {
 *   // file not found
 * }
 * ```
 */
export function errnoCodeOf(v: unknown): string | undefined {
  if (!isError(v) || !Object.hasOwn(v, "code")) {
    return undefined;
  }
  const code: unknown = (v as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Returns `true` when `v` is a Node.js `ErrnoException` — an `Error`
 * subclass carrying a string `code` as its OWN property.
 *
 * Ownership is part of the guarantee, not an implementation detail: an
 * `Error` whose only `code` comes from `Error.prototype` (or a subclass
 * prototype getter) is NOT a node error here, because the caller's
 * tolerate/rethrow decision must not be settable by anything other than
 * the throw itself. Node's own errno errors always set `code` as an own
 * property, so no real `node:fs` failure is affected.
 *
 * Contrast {@link hasProperty}/{@link hasMessage}, which are `in`-based by
 * documented contract — they answer "can this property be read", not "did
 * this value carry it". Do not unify the two.
 *
 * Semver: this narrowed from an `in`-based check to this own-property check
 * in a patch release. Every caller in this repository passes a real
 * `node:fs`/libuv errno, which always sets `code` as an own property, so no
 * in-repo caller is affected. A caller passing a custom `Error` subclass
 * that intentionally exposes `code` only via a prototype getter would see
 * this guard start returning `false` for it — treated as a patch because
 * that shape was never a documented, supported use of this guard: the
 * ownership guarantee stated above has always been this guard's contract,
 * and the previous `in`-based implementation that let a prototype `code`
 * satisfy it was the bug, not a feature being removed.
 *
 * @example
 * ```typescript
 * import { isNodeError } from "@monte3l/m3l-common/core";
 * if (isNodeError(err)) {
 *   console.error(err.code);
 * }
 * ```
 */
export function isNodeError(v: unknown): v is NodeJS.ErrnoException {
  return errnoCodeOf(v) !== undefined;
}

/**
 * Returns `true` when `v` is a Node.js `ErrnoException` whose own `code` is
 * exactly `"ENOENT"`.
 *
 * Carries {@link isNodeError}'s ownership guarantee, and reads `code`
 * exactly ONCE — it does not type-check the property and then re-read it to
 * compare, so a non-idempotent own getter cannot make the value compared
 * differ from the value validated.
 *
 * @example
 * ```typescript
 * import { isEnoentError } from "@monte3l/m3l-common/core";
 * if (isEnoentError(err)) {
 *   // file not found
 * }
 * ```
 */
export function isEnoentError(
  v: unknown,
): v is NodeJS.ErrnoException & { code: "ENOENT" } {
  return errnoCodeOf(v) === "ENOENT";
}

/**
 * Returns `true` when `v` is a plain object (created via object literal or
 * `Object.create(null)` / `Object.create(Object.prototype)`). Returns `false`
 * for arrays, `Date`, `Map`, `Set`, and other class instances.
 *
 * @example
 * ```typescript
 * import { isPlainObject } from "@monte3l/m3l-common/core";
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
 * import { isObject } from "@monte3l/m3l-common/core";
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
 * import { isArray } from "@monte3l/m3l-common/core";
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
 * import { isString } from "@monte3l/m3l-common/core";
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
 * import { isNumber } from "@monte3l/m3l-common/core";
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
 * import { isBoolean } from "@monte3l/m3l-common/core";
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
 * import { isFunction } from "@monte3l/m3l-common/core";
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
 * import { isDate } from "@monte3l/m3l-common/core";
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
 * import { isValidDate } from "@monte3l/m3l-common/core";
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
 * import { isBuffer } from "@monte3l/m3l-common/core";
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
 * import { isMap } from "@monte3l/m3l-common/core";
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
 * import { isSet } from "@monte3l/m3l-common/core";
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
 * import { isRegExp } from "@monte3l/m3l-common/core";
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
 * import { isSymbol } from "@monte3l/m3l-common/core";
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
 * import { isBigInt } from "@monte3l/m3l-common/core";
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
 * import { isPromise } from "@monte3l/m3l-common/core";
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
 * import { isNonEmptyString } from "@monte3l/m3l-common/core";
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
 * import { isNonEmptyArray } from "@monte3l/m3l-common/core";
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
 * import { hasProperty } from "@monte3l/m3l-common/core";
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
 * import { hasMessage } from "@monte3l/m3l-common/core";
 * if (hasMessage(caught)) {
 *   console.error(String(caught.message));
 * }
 * ```
 */
export function hasMessage(v: unknown): v is { message: unknown } {
  return hasProperty(v, "message");
}
