/**
 * `http/stream-options` — validates the streaming knobs
 * (`retryMs`/`heartbeatMs`/`maxPendingBytes`) `createConsoleRequestListener`
 * accepts, at that public construction boundary (PR #718 review, defect 1).
 *
 * Without this, an invalid value flows unvalidated all the way down to
 * `stream-writer.ts`'s `writeStream` (via `stream-dispatch.ts`), where an
 * invalid `retryMs` throws `ERR_CONSOLE_INTERNAL` out of a function
 * documented as "never throws and never rejects" — and only after the
 * stream head has already been written, so a fallback error response can no
 * longer be sent either. Rejecting synchronously at construction, before any
 * request is ever accepted, is the "validate external input at the public
 * API boundary" rule applied to this seam.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";

/** The error code every rejection raised by {@link validateStreamOptions} carries. */
const CONFIG_INVALID_CODE = "ERR_CONSOLE_CONFIG_INVALID";

/**
 * The subset of `CreateConsoleRequestListenerOptions` this module validates.
 * Every field is optional: `http/handler.ts`'s options bag leaves each one
 * unset when the caller relies on `stream-dispatch.ts`'s own default, and an
 * absent value is never validated — only a value the caller actually supplied.
 *
 * @example
 * ```ts
 * const values: StreamOptionValues = { retryMs: 2_000, heartbeatMs: 30_000 };
 * ```
 */
export interface StreamOptionValues {
  /** The SSE `retry:` interval (ms), when supplied. */
  readonly retryMs?: number;
  /** The heartbeat interval (ms), when supplied. */
  readonly heartbeatMs?: number;
  /** The unflushed-backlog ceiling (bytes), when supplied. */
  readonly maxPendingBytes?: number;
}

/**
 * Throws unless `value` is a non-negative integer, naming `key` — never the
 * value itself is withheld, since none of these three knobs are secrets, but
 * naming the offending key is what lets an operator fix their own
 * configuration without guessing which of the three was wrong.
 */
function assertNonNegativeInteger(key: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `${key} must be a non-negative integer, got ${String(value)}`,
      { context: { key } },
    );
  }
}

/**
 * Validates every supplied streaming knob in `values`, throwing on the first
 * invalid one.
 *
 * @param values - The streaming knobs to validate (see {@link StreamOptionValues}).
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"` when
 *   any supplied value is not a non-negative integer.
 *
 * @example
 * ```ts
 * import { validateStreamOptions } from "@m3l-automation/m3l-console-server/http/stream-options.js";
 *
 * validateStreamOptions({ retryMs: 2_000, heartbeatMs: 30_000, maxPendingBytes: 1_000_000 });
 * ```
 */
export function validateStreamOptions(values: StreamOptionValues): void {
  if (values.retryMs !== undefined) {
    assertNonNegativeInteger("retryMs", values.retryMs);
  }
  if (values.heartbeatMs !== undefined) {
    assertNonNegativeInteger("heartbeatMs", values.heartbeatMs);
  }
  if (values.maxPendingBytes !== undefined) {
    assertNonNegativeInteger("maxPendingBytes", values.maxPendingBytes);
  }
}
