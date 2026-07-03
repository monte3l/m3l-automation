/**
 * `core/logging/M3LConsoleLoggerHandler` — ANSI-aware, TTY-detecting console
 * sink.
 *
 * @packageDocumentation
 */

import { M3LLogEventCategory } from "./M3LLogEventCategory.js";
import type { M3LLogEvent, M3LLoggerHandler } from "./M3LLogEvent.js";

/** ANSI reset sequence. */
const RESET = "\x1b[0m";

/** Per-category ANSI color codes (foreground), keyed by category. */
const CATEGORY_COLOR: Record<M3LLogEventCategory, string> = {
  [M3LLogEventCategory.TEXT]: "\x1b[39m",
  [M3LLogEventCategory.STEP]: "\x1b[36m",
  [M3LLogEventCategory.SUCCESS]: "\x1b[32m",
  [M3LLogEventCategory.ERROR]: "\x1b[31m",
  [M3LLogEventCategory.FATAL]: "\x1b[91m",
  [M3LLogEventCategory.WARNING]: "\x1b[33m",
  [M3LLogEventCategory.HEADER]: "\x1b[1;35m",
  [M3LLogEventCategory.INFO]: "\x1b[34m",
  [M3LLogEventCategory.SECTION]: "\x1b[35m",
};

/** Categories routed to `process.stderr`; every other category uses `process.stdout`. */
const STDERR_CATEGORIES: ReadonlySet<M3LLogEventCategory> = new Set([
  M3LLogEventCategory.ERROR,
  M3LLogEventCategory.FATAL,
]);

/**
 * Writes each {@link M3LLogEvent} to `process.stdout` or `process.stderr`
 * (`ERROR`/`FATAL` go to stderr; every other category goes to stdout), with
 * ANSI coloring and indentation when the destination stream is a TTY. ANSI
 * is automatically disabled for a non-TTY destination (Lambda, CI, a pipe)
 * so redirected logs stay plain and machine-readable.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const handler = new Core.M3LConsoleLoggerHandler();
 * const logger = new Core.M3LLogger([handler]);
 * logger.success("Imported 1200 rows");
 * ```
 */
export class M3LConsoleLoggerHandler implements M3LLoggerHandler {
  /**
   * Renders `event` to the appropriate stream, coloring and indenting the
   * message when that stream is a TTY.
   *
   * @param event - The event to render.
   */
  handle(event: M3LLogEvent): void {
    const stream = STDERR_CATEGORIES.has(event.category)
      ? process.stderr
      : process.stdout;
    const isTTY = stream.isTTY === true;
    // Clamp to a non-negative integer: `"  ".repeat()` throws a RangeError
    // on a negative or non-integer count, which handler-isolation in
    // M3LLogger would otherwise silently swallow, dropping the event.
    const indentLevel = Math.max(0, Math.trunc(event.indent ?? 0));
    const indent = "  ".repeat(indentLevel);
    const line = isTTY
      ? `${indent}${CATEGORY_COLOR[event.category]}${event.message}${RESET}`
      : `${indent}${event.message}`;
    stream.write(`${line}\n`);
  }

  /**
   * No-op: {@link M3LConsoleLoggerHandler} holds no internal state to reset.
   */
  reset(): void {
    // Intentionally empty — this handler is stateless.
  }
}
