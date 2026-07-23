/**
 * `core/logging/M3LLogEventCategory` — the ten documented log event
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
  /**
   * The library's own diagnostic events — breadcrumbs, timings — emitted by
   * {@link M3LLogger.time} and other internal instrumentation (ADR-0035
   * phase 3). Ranked below every other category by
   * `src/internal/logging/levels.ts`'s severity floor, so a `minLevel` above
   * `DEBUG` suppresses it by default.
   */
  DEBUG: "debug",
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

/**
 * The subset of {@link M3LLogEventCategory} that may be spelled as a
 * `minLevel` severity floor (review fix round).
 *
 * The categories are presentational groupings, not a severity ladder in
 * their own right — `text`/`step`/`info`/`section`/`header` are all ranked
 * `1` by `src/internal/logging/levels.ts`'s severity table. Allowing all four
 * tied spellings as a *floor* value bought nothing (they behave identically)
 * while inviting inconsistency across call sites (`minLevel: HEADER` vs.
 * `minLevel: TEXT` reading as different intents for an identical effect).
 * This type exposes exactly one canonical spelling per rank — `info` stands
 * in for the whole rank-1 tie — while the runtime tie itself is unchanged:
 * an `INFO` floor still admits `text`/`step`/`section`/`header` *events*,
 * since `passesFloor` still compares by rank, not by exact category.
 *
 * @example
 * ```ts
 * import type { M3LLogLevelFloor } from "@m3l-automation/m3l-common/core";
 * import { M3LLogEventCategory, M3LLogger } from "@m3l-automation/m3l-common/core";
 *
 * const floor: M3LLogLevelFloor = M3LLogEventCategory.WARNING;
 * const logger = new M3LLogger([], { minLevel: floor });
 * ```
 */
export type M3LLogLevelFloor = Exclude<
  M3LLogEventCategory,
  "text" | "step" | "section" | "header"
>;
