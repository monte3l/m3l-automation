/**
 * `internal/polling/guards` — numeric validation helpers shared by the polling
 * primitives and backoff factories. Reject non-finite / out-of-range values at
 * the public boundary with a typed M3LError subclass.
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

import { M3LPollingInvalidOptionError } from "./errors.js";

/**
 * Assert that `value` is a finite number strictly greater than zero.
 *
 * @param value - The candidate number.
 * @param label - Human-readable option name for the error message.
 * @throws {@link M3LPollingInvalidOptionError} when `value` is not a finite
 *   positive number.
 */
export function assertPositive(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new M3LPollingInvalidOptionError(
      `${label} must be a finite number greater than 0 (received ${String(value)})`,
    );
  }
}

/**
 * Assert that `value` is a finite integer strictly greater than zero.
 *
 * @param value - The candidate number.
 * @param label - Human-readable option name for the error message.
 * @throws {@link M3LPollingInvalidOptionError} when `value` is not a finite
 *   positive integer.
 */
export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new M3LPollingInvalidOptionError(
      `${label} must be a finite integer greater than 0 (received ${String(value)})`,
    );
  }
}
