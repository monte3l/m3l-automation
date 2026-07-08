/**
 * `core/polling/events` — typed telemetry event maps for {@link M3LPoller}
 * and {@link M3LRetryRunner}.
 *
 * These events are opt-in, read-only observation hooks: emitting them never
 * alters a poll/retry outcome, and no payload carries an `Error`, a message,
 * or any other caller-supplied string — only numbers and a `classification`
 * field narrowed to the subset of the classifier's verdict each event can
 * ever observe. This is a deliberate divergence from the exporters'
 * `error`-in-payload precedent (`M3LListExporterErrorPayload`): a poll/retry
 * failure is always represented at the call site by the rejected
 * `poll()`/`run()` promise, so the event stream carries no caller data that
 * would need redaction downstream.
 *
 * @packageDocumentation
 */

/**
 * Payload carried by the `poll:attempt` event, fired once per check
 * invocation before the check runs.
 *
 * @example
 * ```typescript
 * import type { M3LPollAttemptPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LPollAttemptPayload = { attempt: 1, maxAttempts: 30 };
 * ```
 */
export interface M3LPollAttemptPayload {
  /** The 1-based attempt number about to run. */
  readonly attempt: number;
  /** The configured attempt bound for this `poll()` call. */
  readonly maxAttempts: number;
}

/**
 * Payload carried by the `poll:wait` event, fired after the backoff delay for
 * a `continue` decision has been computed and before it is slept.
 *
 * Fired only for a **non-final** `continue` — i.e. when another attempt will
 * follow. The final attempt of an exhausting poll never sleeps and never
 * emits `poll:wait`.
 *
 * @example
 * ```typescript
 * import type { M3LPollWaitPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LPollWaitPayload = { attempt: 1, delayMs: 500 };
 * ```
 */
export interface M3LPollWaitPayload {
  /** The 1-based attempt number that produced the `continue` decision. */
  readonly attempt: number;
  /** The computed backoff delay, in milliseconds, about to be slept. */
  readonly delayMs: number;
}

/**
 * Payload carried by the `poll:success` event, fired when a check resolves
 * with a terminal `success` decision.
 *
 * No error/message field: a success carries no failure detail to redact.
 *
 * @example
 * ```typescript
 * import type { M3LPollSuccessPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LPollSuccessPayload = { attempt: 3 };
 * ```
 */
export interface M3LPollSuccessPayload {
  /** The 1-based attempt number on which the poll succeeded. */
  readonly attempt: number;
}

/**
 * Payload carried by the `poll:exhausted` event, fired when `maxAttempts` is
 * reached while the check is still returning `continue`.
 *
 * No error/message field: the caller already gets the thrown
 * `M3LError` from the rejected `poll()` promise; this event is a read-only
 * telemetry echo of the same terminal condition, not a substitute channel
 * for the error itself.
 *
 * @example
 * ```typescript
 * import type { M3LPollExhaustedPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LPollExhaustedPayload = { attempts: 30 };
 * ```
 */
export interface M3LPollExhaustedPayload {
  /** The configured attempt bound that was exhausted. */
  readonly attempts: number;
}

/**
 * Event map for {@link M3LPoller}. Subscribe with `poller.on(event, handler)`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const poller = new Core.M3LPoller({ backoff: Core.M3LBackoff.constant(500) });
 * poller.on("poll:wait", (payload) => {
 *   console.log(`waiting ${String(payload.delayMs)}ms after attempt ${String(payload.attempt)}`);
 * });
 * ```
 */
export interface M3LPollerEventMap {
  /** Fired once per attempt, before the check function runs. */
  readonly "poll:attempt": M3LPollAttemptPayload;
  /**
   * Fired after a `continue` decision's backoff delay is computed, before it
   * is slept — only for a non-final `continue`; the final attempt never
   * sleeps and never emits this event.
   */
  readonly "poll:wait": M3LPollWaitPayload;
  /** Fired when a check resolves with a terminal `success` decision. */
  readonly "poll:success": M3LPollSuccessPayload;
  /** Fired when `maxAttempts` is reached while still `continue`. */
  readonly "poll:exhausted": M3LPollExhaustedPayload;
}

/**
 * Payload carried by the `retry:attempt` event, fired once per attempt before
 * the operation runs.
 *
 * @example
 * ```typescript
 * import type { M3LRetryAttemptPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LRetryAttemptPayload = { attempt: 1, maxAttempts: 10 };
 * ```
 */
export interface M3LRetryAttemptPayload {
  /** The 1-based attempt number about to run. */
  readonly attempt: number;
  /** The configured attempt bound for this `run()` call. */
  readonly maxAttempts: number;
}

/**
 * Payload carried by the `retry:scheduled` event, fired after a retriable
 * classification's delay has been resolved (server-driven `delayMs` advice or
 * the configured backoff) and before it is slept.
 *
 * `classification` carries the classifier's RAW verdict (which may be
 * `"unknown"`) rather than the runner's resolved `unknownDecision` — the raw
 * advice is what a consumer needs to audit why a given error was scheduled
 * for retry, independent of how this runner instance happens to be
 * configured to resolve ambiguity.
 *
 * @example
 * ```typescript
 * import type { M3LRetryScheduledPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LRetryScheduledPayload = {
 *   attempt: 1,
 *   delayMs: 200,
 *   classification: "retriable",
 * };
 * ```
 */
export interface M3LRetryScheduledPayload {
  /** The 1-based attempt number that produced the retriable classification. */
  readonly attempt: number;
  /** The delay, in milliseconds, about to be slept before the next attempt. */
  readonly delayMs: number;
  /**
   * The classifier's raw verdict (before `unknownDecision` resolution),
   * narrowed to `"retriable" | "unknown"` — a raw `"fatal"` verdict never
   * reaches this event because the fatal path already throws before a
   * retry is scheduled.
   */
  readonly classification: "retriable" | "unknown";
}

/**
 * Payload carried by the `retry:success` event, fired when the operation
 * resolves — the happy-path terminal mirroring {@link M3LPollSuccessPayload}.
 *
 * No error/message field: a success carries no failure detail to redact.
 *
 * @example
 * ```typescript
 * import type { M3LRetrySuccessPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LRetrySuccessPayload = { attempt: 3 };
 * ```
 */
export interface M3LRetrySuccessPayload {
  /** The 1-based attempt number on which the operation resolved. */
  readonly attempt: number;
}

/**
 * Payload carried by the `retry:fatal` event, fired when a classification
 * (raw `"fatal"`, or `"unknown"` resolved to `"fatal"`) stops retrying and
 * the original error is about to propagate.
 *
 * No error/message field: the caller already gets the original thrown error
 * unchanged from the rejected `run()` promise; comment the WHY, not the
 * error's contents — this event exists to observe the classification
 * decision that terminated the retry loop, not to duplicate the error.
 *
 * @example
 * ```typescript
 * import type { M3LRetryFatalPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LRetryFatalPayload = { attempt: 2, classification: "fatal" };
 * ```
 */
export interface M3LRetryFatalPayload {
  /** The 1-based attempt number on which the fatal classification landed. */
  readonly attempt: number;
  /**
   * The classifier's raw verdict (before `unknownDecision` resolution),
   * narrowed to `"fatal" | "unknown"` — a raw `"retriable"` verdict never
   * reaches this event because a retriable verdict is scheduled for retry,
   * not treated as fatal.
   */
  readonly classification: "fatal" | "unknown";
}

/**
 * Payload carried by the `retry:exhausted` event, fired when `maxAttempts` is
 * reached on a retriable classification and the last error is about to
 * propagate.
 *
 * @example
 * ```typescript
 * import type { M3LRetryExhaustedPayload } from "@m3l-automation/m3l-common/core";
 * const payload: M3LRetryExhaustedPayload = { attempts: 10 };
 * ```
 */
export interface M3LRetryExhaustedPayload {
  /** The configured attempt bound that was exhausted. */
  readonly attempts: number;
}

/**
 * Event map for {@link M3LRetryRunner}. Subscribe with
 * `runner.on(event, handler)`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const runner = new Core.M3LRetryRunner({ classifier: Core.awsThrottlingClassifier });
 * runner.on("retry:scheduled", (payload) => {
 *   console.log(`retry ${String(payload.attempt)} scheduled after ${String(payload.delayMs)}ms`);
 * });
 * ```
 */
export interface M3LRetryEventMap {
  /** Fired once per attempt, before the operation runs. */
  readonly "retry:attempt": M3LRetryAttemptPayload;
  /** Fired after a retriable classification's delay is resolved, before it is slept. */
  readonly "retry:scheduled": M3LRetryScheduledPayload;
  /** Fired when the operation resolves. */
  readonly "retry:success": M3LRetrySuccessPayload;
  /** Fired when a fatal classification stops the retry loop. */
  readonly "retry:fatal": M3LRetryFatalPayload;
  /** Fired when `maxAttempts` is reached on a retriable classification. */
  readonly "retry:exhausted": M3LRetryExhaustedPayload;
}
