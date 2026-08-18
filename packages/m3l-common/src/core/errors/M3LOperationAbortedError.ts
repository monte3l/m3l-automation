/**
 * `core/errors/M3LOperationAbortedError` — typed error for a
 * caller-initiated cooperative abort of a poll, retry, or AWS waiter.
 *
 * @packageDocumentation
 */

import { M3LError } from "./M3LError.js";

/**
 * Thrown when a caller-supplied `AbortSignal` aborts a cooperative wait —
 * a {@link https://m3l-automation.github.io/docs/reference/core/polling.md | core/polling}
 * poll or retry loop, or one of the `aws/**` waiters and query polls.
 *
 * Its code is `ERR_OPERATION_ABORTED`, classified `origin: "caller"`,
 * `retryable: false`.
 *
 * @remarks
 * The `retryable: false` classification is load-bearing. `M3LRetryRunner`
 * checks the signal **before** consulting its classifier (ADR-0049), so no
 * classifier can reclassify this code as retriable. A retriable abort would
 * cause the runner to retry the very operation the operator just cancelled.
 *
 * This error deliberately does **not** accept a `cause` parameter. `@smithy/core`
 * builds its `AbortError` message by serializing the whole waiter result, which
 * can embed the last observed response body. Accepting a `cause` would make
 * chaining that SDK error structurally possible, carrying sensitive payload
 * content into every log line and run report. Omitting the parameter makes the
 * leak structurally impossible rather than merely discouraged.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const controller = new AbortController();
 *
 * const poller = new Core.M3LPoller({
 *   backoff: Core.M3LBackoff.constant(500),
 *   signal: controller.signal,
 * });
 *
 * controller.abort(); // cancel before polling starts
 *
 * try {
 *   await poller.poll(checkJob);
 * } catch (e) {
 *   if (e instanceof Core.M3LOperationAbortedError) {
 *     // Run was cancelled by operator — outcome is "interrupted", not "failure".
 *     console.log("poll aborted:", e.code); // "ERR_OPERATION_ABORTED"
 *   }
 * }
 * ```
 */
export class M3LOperationAbortedError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_OPERATION_ABORTED"`. */
  override readonly code: "ERR_OPERATION_ABORTED";

  /**
   * Creates a new `M3LOperationAbortedError`.
   *
   * @param message - Optional human-readable description of the abort.
   *   Defaults to a fixed library-controlled string. The default message is
   *   intentionally static — it does not derive from any external payload such
   *   as an SDK `AbortError`, which can embed observed response bodies.
   */
  constructor(message?: string) {
    const msg =
      message ?? "the operation was aborted by a caller-supplied AbortSignal";
    super(msg, { code: "ERR_OPERATION_ABORTED" });
    this.code = "ERR_OPERATION_ABORTED";
  }
}
