/**
 * `core/logging/M3LLogEventCategory` — the nine documented log event
 * categories.
 *
 * @packageDocumentation
 */

/**
 * The category of a single {@link M3LLogEvent}. Implemented as a `const`
 * object (not a TS `enum`) so members are accessible as plain string values
 * (`M3LLogEventCategory.SUCCESS === "success"`) while still narrowing to a
 * literal union at the type level — a serialized category round-trips
 * through JSON without a cast, which a numeric or opaque `enum` member would
 * not. Each {@link M3LLogger} message method maps to exactly one category,
 * and each handler may render (or route) a category differently — for
 * example {@link M3LConsoleLoggerHandler} routes `ERROR` and `FATAL` to
 * `process.stderr` and everything else to `process.stdout`.
 *
 * @example
 * ```ts
 * import { M3LLogEventCategory } from "@m3l-automation/m3l-common/core";
 *
 * const category: M3LLogEventCategory = M3LLogEventCategory.SUCCESS;
 * ```
 */
export const M3LLogEventCategory = {
  /** Plain, uncategorized text — also used for spacer/table events. */
  TEXT: "text",
  /** A discrete step within a multi-step operation. */
  STEP: "step",
  /** A successful outcome. */
  SUCCESS: "success",
  /** A recoverable error. */
  ERROR: "error",
  /** An unrecoverable error that halts the operation. */
  FATAL: "fatal",
  /** A non-fatal condition worth flagging. */
  WARNING: "warning",
  /** A prominent section header. */
  HEADER: "header",
  /** Informational message. */
  INFO: "info",
  /** A section divider or grouping label. */
  SECTION: "section",
} as const;

/**
 * The literal union of all {@link M3LLogEventCategory} member values.
 *
 * @example
 * ```ts
 * import type { M3LLogEventCategory } from "@m3l-automation/m3l-common/core";
 *
 * function describe(category: M3LLogEventCategory): string {
 *   return `event category: ${category}`;
 * }
 * ```
 */
export type M3LLogEventCategory =
  (typeof M3LLogEventCategory)[keyof typeof M3LLogEventCategory];
