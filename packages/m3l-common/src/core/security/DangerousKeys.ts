/**
 * Prototype-pollution guard utilities for safe key inspection.
 *
 * These utilities help prevent prototype-pollution attacks by identifying
 * keys that, when used as property names on an object, can silently corrupt
 * the JavaScript prototype chain. Always check keys from untrusted sources
 * (e.g. parsed JSON, user input, external APIs) before using them in
 * property assignment.
 */

/**
 * The set of keys that are dangerous to use as property names because they
 * target JavaScript's prototype chain.
 *
 * Kept private to this module — callers should use {@link isDangerousKey}
 * rather than reference this set directly, so the exact membership can evolve
 * without a breaking change to the public API.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Returns `true` when `key` is one of the known prototype-pollution vectors:
 * `'__proto__'`, `'constructor'`, or `'prototype'`.
 *
 * The check is a case-sensitive exact match — no trimming or normalization is
 * applied. This is intentional: an attacker who can influence a key value
 * can trivially change its casing, so a lenient check would provide a false
 * sense of safety while also flagging legitimate keys like `'Constructor'`.
 *
 * @param key - The property name to test.
 * @returns `true` if `key` is a prototype-pollution vector; `false` otherwise.
 * @remarks Never throws for any string input.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 * if (isDangerousKey(key)) {
 *   throw new M3LError(formatUnsafeKeyLocation(key), { code: "ERR_UNSAFE_KEY" });
 * }
 * ```
 */
export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Formats a human-readable location string that includes the unsafe key
 * value, suitable for use in an error message or log line.
 *
 * The exact wording is an implementation detail and may change in a patch
 * release — callers should treat the output as an opaque human-readable
 * string and must not parse it programmatically. The only guarantee is that
 * the returned string is non-empty and contains the key value verbatim.
 *
 * @param key - The property name that triggered the safety check.
 * @returns A non-empty human-readable string that includes `key`.
 * @remarks Never throws for any string input. The returned string embeds the
 *   key verbatim and may contain arbitrary Unicode. Sanitize before placing in
 *   structured logs.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 * if (isDangerousKey(key)) {
 *   throw new M3LError(formatUnsafeKeyLocation(key), { code: "ERR_UNSAFE_KEY" });
 * }
 * ```
 */
export function formatUnsafeKeyLocation(key: string): string {
  return `Unsafe key detected: "${key}"`;
}
