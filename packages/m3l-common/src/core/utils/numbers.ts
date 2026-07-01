/**
 * `core/utils/numbers` — locale-tolerant numeric string parsing.
 *
 * @packageDocumentation
 */

/**
 * Parses a string into a number, tolerating a comma decimal separator.
 *
 * Only comma-or-dot decimal notation is recognized — there is no thousands
 * grouping support. A string containing a single comma and no dot is treated
 * as using the comma as its decimal separator (so `"1,000"` parses to `1`,
 * not `1000`); any other input is handed to `Number()` as-is. This function
 * never throws — unparsable input (including the empty string) resolves to
 * `NaN`, matching `Number()`'s own total behavior.
 *
 * @param value - The string to parse. Leading/trailing whitespace is trimmed
 *   before parsing.
 * @returns The parsed number, or `NaN` if `value` cannot be parsed.
 *
 * @example
 * ```typescript
 * import { parseLocaleNumber } from "@m3l-automation/m3l-common/core";
 * parseLocaleNumber("1.5");   // 1.5
 * parseLocaleNumber("1,5");   // 1.5 — comma as decimal separator
 * parseLocaleNumber("1,000"); // 1 — NOT 1000; no thousands grouping
 * parseLocaleNumber("abc");   // NaN
 * ```
 */
export function parseLocaleNumber(value: string): number {
  const trimmed = value.trim();
  const hasComma = trimmed.includes(",");
  const hasDot = trimmed.includes(".");

  const normalized = hasComma && !hasDot ? trimmed.replace(",", ".") : trimmed;

  if (normalized === "") return NaN;
  return Number(normalized);
}
