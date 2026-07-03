/**
 * `core/logging` — structured, multi-handler logging with table rendering
 * and sensitive-value redaction.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * The internal `M3LLoggerHandler` port (in `M3LLogEvent.ts`) is
 * intentionally NOT re-exported — it is an implementation detail consumed
 * structurally by {@link M3LLogger} and implemented by the three built-in
 * handlers.
 *
 * @packageDocumentation
 */

export * from "./M3LConsoleLoggerHandler.js";
export * from "./M3LFileLoggerHandler.js";
export * from "./M3LJsonLoggerHandler.js";
export type { M3LLogEvent } from "./M3LLogEvent.js";
export * from "./M3LLogEventCategory.js";
export * from "./M3LLogger.js";
export * from "./M3LTableFormatter.js";
export * from "./redact.js";
