/**
 * `core/logging` — structured, multi-handler logging with table rendering
 * and sensitive-value redaction.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * The `M3LLoggerHandler` port (in `M3LLogEvent.ts`) is exported so consumers
 * can implement custom handlers; it is still implemented internally by the
 * three built-in handlers ({@link M3LConsoleLoggerHandler},
 * {@link M3LFileLoggerHandler}, {@link M3LJsonLoggerHandler}).
 *
 * @packageDocumentation
 */

export * from "./M3LConsoleLoggerHandler.js";
export * from "./M3LFileLoggerHandler.js";
export * from "./M3LJsonLoggerHandler.js";
export type { M3LLogEvent, M3LLoggerHandler } from "./M3LLogEvent.js";
export * from "./M3LLogEventCategory.js";
export * from "./M3LLogger.js";
export * from "./M3LTableFormatter.js";
export * from "./redact.js";
