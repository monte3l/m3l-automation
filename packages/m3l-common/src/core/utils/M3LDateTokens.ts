/**
 * `core/utils/M3LDateTokens` — date token expansion for template strings.
 *
 * Expands `{YYYY}`, `{MM}`, and `{DD}` tokens using the current local date.
 * No external dependencies; uses native `Date`.
 *
 * @packageDocumentation
 */

/** Minimum character width for zero-padded date components (day, month). */
const DATE_PAD_WIDTH = 2;

/**
 * Pads a number to a minimum of two digits with a leading zero if needed.
 */
function pad2(n: number): string {
  return n.toString().padStart(DATE_PAD_WIDTH, "0");
}

/**
 * Provides static date-token expansion for template strings.
 *
 * Recognized tokens:
 * - `{YYYY}` — 4-digit full year
 * - `{MM}` — zero-padded 2-digit month (01–12)
 * - `{DD}` — zero-padded 2-digit day (01–31)
 *
 * Unknown tokens (e.g. `{HH}`) pass through unchanged.
 *
 * @example
 * ```typescript
 * import { M3LDateTokens } from "@m3l-automation/m3l-common/core";
 * const path = M3LDateTokens.expand("outputs/{YYYY}-{MM}-{DD}");
 * // returns e.g. "outputs/2026-06-27"
 * ```
 */
export class M3LDateTokens {
  /**
   * Expands date tokens in a template string using the current date.
   *
   * @param template - A string optionally containing `{YYYY}`, `{MM}`,
   *   and/or `{DD}` tokens.
   * @returns The template with recognized tokens replaced by their
   *   current-date values.
   *
   * @example
   * ```typescript
   * import { M3LDateTokens } from "@m3l-automation/m3l-common/core";
   * const path = M3LDateTokens.expand("outputs/{YYYY}-{MM}-{DD}");
   * // returns e.g. "outputs/2026-06-27"
   * ```
   */
  static expand(template: string): string {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = pad2(now.getMonth() + 1);
    const dd = pad2(now.getDate());

    return template
      .replace(/\{YYYY\}/g, yyyy)
      .replace(/\{MM\}/g, mm)
      .replace(/\{DD\}/g, dd);
  }
}
