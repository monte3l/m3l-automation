/**
 * `core/utils/formatting` — human-readable display helpers.
 *
 * Provides formatting utilities for byte counts, string truncation, path
 * elision, and config display without any external dependencies.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/** Binary threshold between size units (1 KiB = 1024 bytes). */
const BYTES_PER_UNIT = 1024;

/** Maximum decimal places shown for non-byte byte-size units. */
const BYTES_DECIMAL_PLACES = 2;

/** Minimum characters to keep from the tail (filename) when eliding a path. */
const PATH_TAIL_FALLBACK_LEN = 4;

/** Binary size units for {@link formatBytes}. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Converts a raw byte count to a human-readable size string.
 *
 * Examples: `0` → `"0 B"`, `1024` → `"1 KB"`, `1536` → `"1.5 KB"`.
 *
 * @param bytes - The byte count to format (non-negative integer).
 * @returns A human-readable size string with unit suffix.
 *
 * @example
 * ```typescript
 * import { formatBytes } from "@m3l-automation/m3l-common/core";
 * formatBytes(0);       // "0 B"
 * formatBytes(1024);    // "1 KB"
 * formatBytes(1048576); // "1 MB"
 * ```
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new M3LError(
      `formatBytes: bytes must be a non-negative finite number, got ${String(bytes)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
  if (bytes === 0) return "0 B";

  let value = bytes;
  let unitIndex = 0;

  while (value >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex++;
  }

  const unit = BYTE_UNITS[unitIndex];
  // Use no decimals for raw bytes; up to 2 significant fractional digits otherwise
  const formatted =
    unitIndex === 0
      ? value.toString()
      : parseFloat(value.toFixed(BYTES_DECIMAL_PLACES)).toString();

  return `${formatted} ${unit}`;
}

/**
 * Truncates a string to `maxLength` characters, appending an ellipsis (`…`)
 * if the string was shortened. Strings at or below `maxLength` are returned
 * unchanged.
 *
 * @param value - The string to truncate.
 * @param maxLength - Maximum allowed character length (inclusive).
 * @returns The original string or a truncated version ending with `…`.
 *
 * @example
 * ```typescript
 * import { smartTruncate } from "@m3l-automation/m3l-common/core";
 * smartTruncate("hello world", 5); // "hell…"
 * smartTruncate("hi", 10);         // "hi"
 * ```
 */
export function smartTruncate(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new M3LError(
      `smartTruncate: maxLength must be a positive integer, got ${String(maxLength)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1) + "…";
}

/**
 * Truncates a filesystem path to `maxLength` characters. If truncation is
 * needed, the middle of the path is elided with `"..."` to preserve both the
 * root and the filename. If the path is already within the limit, it is
 * returned unchanged.
 *
 * @param path - The filesystem path to truncate.
 * @param maxLength - Maximum allowed character length (inclusive).
 * @returns The original path or a truncated version with `"..."` in the middle.
 *
 * @example
 * ```typescript
 * import { truncatePath } from "@m3l-automation/m3l-common/core";
 * truncatePath("/very/long/path/to/file.txt", 20); // e.g. "/very/.../file.txt"
 * ```
 */
export function truncatePath(path: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new M3LError(
      `truncatePath: maxLength must be a positive integer, got ${String(maxLength)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
  if (path.length <= maxLength) return path;

  const ellipsis = "...";
  const ellipsisLen = ellipsis.length;

  // We want to keep the start and end of the path.
  // Budget for the ellipsis separator and at least one char on each side.
  const budget = maxLength - ellipsisLen;
  if (budget <= 0) {
    // Not enough room for both content and ellipsis — just hard-truncate
    return path.slice(0, maxLength);
  }

  // Split at the last path separator to find the filename
  const lastSlash = path.lastIndexOf("/");
  let tail =
    lastSlash !== -1
      ? path.slice(lastSlash + 1)
      : path.slice(path.length - PATH_TAIL_FALLBACK_LEN);
  const headBudget = budget - tail.length;

  if (headBudget <= 0) {
    // Tail alone is too long — truncate the tail
    tail = tail.slice(0, budget);
    return ellipsis + tail;
  }

  const head = path.slice(0, headBudget);
  return head + ellipsis + tail;
}

/**
 * Truncates a text string to `maxLength` characters. If the text is longer
 * than `maxLength`, returns the first `maxLength - 1` characters followed by
 * an ellipsis (`…`). Strings at or below `maxLength` are returned unchanged.
 *
 * @param text - The text to truncate.
 * @param maxLength - Maximum allowed character length (inclusive).
 * @returns The original text or a truncated version ending with `…`.
 *
 * @example
 * ```typescript
 * import { truncateText } from "@m3l-automation/m3l-common/core";
 * truncateText("hello world", 8); // "hello w…"
 * ```
 */
export function truncateText(text: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new M3LError(
      `truncateText: maxLength must be a positive integer, got ${String(maxLength)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

/**
 * Returns `true` when the string looks like a filesystem path. Recognizes:
 * - Absolute Unix paths (`/`)
 * - Relative paths (`./`, `../`)
 * - Home-relative paths (`~/`)
 * - Windows-style paths (`C:\`, `C:/`)
 *
 * @param value - The string to test.
 * @returns `true` if the string appears to be a path.
 *
 * @example
 * ```typescript
 * import { isPath } from "@m3l-automation/m3l-common/core";
 * isPath("/home/user/file.txt"); // true
 * isPath("hello");               // false
 * ```
 */
export function isPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[/\\]/.test(value)
  );
}

/**
 * Formats a configuration value for human-readable display.
 *
 * - Strings → wrapped in double-quotes: `'"value"'`
 * - `null` / `undefined` → `"(none)"`
 * - Booleans → `"true"` or `"false"`
 * - Numbers → their string representation
 * - Objects/arrays → `JSON.stringify` with a `String(v)` fallback
 * - Other types (Symbol, BigInt, Function) → `String(v)`
 *
 * This function never throws.
 *
 * @param value - Any configuration value.
 * @returns A display-ready string.
 *
 * @example
 * ```typescript
 * import { formatConfigValueDisplay } from "@m3l-automation/m3l-common/core";
 * formatConfigValueDisplay("hello");       // '"hello"'
 * formatConfigValueDisplay(null);          // "(none)"
 * formatConfigValueDisplay(true);          // "true"
 * ```
 */
/**
 * Serializes an object/array value to JSON, embedding the failure reason when
 * `JSON.stringify` throws (e.g. circular references). Extracted to keep
 * {@link formatConfigValueDisplay} within the cyclomatic-complexity limit.
 */
function jsonOrFallback(value: object): string {
  try {
    return JSON.stringify(value);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `[unserializable: ${reason}]`;
  }
}

export function formatConfigValueDisplay(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return String(value);
  return jsonOrFallback(value);
}

/**
 * Formats a configuration source label for human-readable display.
 *
 * - `undefined` → `"(unknown)"`
 * - Any string → returned as-is
 *
 * @param source - The source label, or `undefined` if the source is unknown.
 * @returns A display-ready string.
 *
 * @example
 * ```typescript
 * import { formatConfigSourceDisplay } from "@m3l-automation/m3l-common/core";
 * formatConfigSourceDisplay("cli");       // "cli"
 * formatConfigSourceDisplay(undefined);   // "(unknown)"
 * ```
 */
export function formatConfigSourceDisplay(source: string | undefined): string {
  if (source === undefined) return "(unknown)";
  return source;
}
