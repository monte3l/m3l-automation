/**
 * `core/logging/M3LLogEvent` — the per-message event object fanned out to
 * every configured handler, plus the internal handler port.
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
}

/**
 * Internal handler port consumed by {@link M3LLogger}. Not part of the
 * public API — implementations ({@link M3LConsoleLoggerHandler},
 * {@link M3LFileLoggerHandler}, {@link M3LJsonLoggerHandler}) are exported
 * individually; this shape exists so `M3LLogger` can depend on a minimal
 * structural contract instead of a concrete handler class.
 */
export interface M3LLoggerHandler {
  /** Renders or routes a single log event. */
  handle(event: M3LLogEvent): void;
  /** Resets any handler-internal state (semantics are handler-specific). */
  reset(): void;
}
