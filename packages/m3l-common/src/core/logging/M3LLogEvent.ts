/**
 * `core/logging/M3LLogEvent` — the per-message event object fanned out to
 * every configured handler, plus the handler port third parties implement to
 * write a custom handler.
 *
 * @packageDocumentation
 */

import type { M3LLogEventCategory } from "./M3LLogEventCategory.js";

/**
 * A single log event produced by an {@link M3LLogger} message method and
 * fanned out to every configured handler.
 *
 * @example
 * ```ts
 * import type { M3LLogEvent } from "@m3l-automation/m3l-common/core";
 * import { M3LLogEventCategory } from "@m3l-automation/m3l-common/core";
 *
 * const event: M3LLogEvent = {
 *   category: M3LLogEventCategory.SUCCESS,
 *   message: "Imported 1200 rows",
 *   data: { rows: 1200 },
 * };
 * ```
 */
export interface M3LLogEvent {
  /** The event's category, driving handler routing and rendering. */
  readonly category: M3LLogEventCategory;
  /** The human-readable message text. */
  readonly message: string;
  /** Optional structured data associated with the event. */
  readonly data?: Record<string, unknown>;
  /** Optional indentation level, in handler-defined units. */
  readonly indent?: number;
  /** Optional event timestamp. */
  readonly timestamp?: Date;
  /**
   * Optional per-run trace identifier. When the {@link M3LLogger} that
   * produced this event was constructed with a `correlationId` (see
   * {@link M3LLoggerOptions}), every event it dispatches carries the same
   * id so a downstream aggregator (CloudWatch Insights, etc.) can group all
   * the lines from one script run or Lambda invocation. Not a secret — it is
   * never redacted by {@link redactSensitiveLogValue} / {@link redactSensitiveLogText}.
   */
  readonly correlationId?: string;
}

/**
 * The public contract for a log handler consumed by {@link M3LLogger}. The
 * three built-in handlers ({@link M3LConsoleLoggerHandler},
 * {@link M3LFileLoggerHandler}, {@link M3LJsonLoggerHandler}) implement it,
 * and it is exported so third parties can write their own handler and pass
 * it into `M3LLogger`'s handler list.
 *
 * `handle` must be synchronous: its `void` return type is satisfied by an
 * `async` function under TypeScript's assignability rules, but `M3LLogger`
 * neither awaits nor isolates a returned `Promise` — a rejection from an
 * `async handle` implementation escapes uncaught instead of being caught by
 * `M3LLogger`'s per-handler error isolation.
 */
export interface M3LLoggerHandler {
  /** Renders or routes a single log event. Must be synchronous. */
  handle(event: M3LLogEvent): void;
  /** Resets any handler-internal state (semantics are handler-specific). */
  reset(): void;
}
