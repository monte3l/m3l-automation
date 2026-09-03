/**
 * `core/polling` detailed-result envelope types (ADR-0086) — the per-attempt
 * metadata that `M3LPoller.pollDetailed` and `M3LRetryRunner.runDetailed`
 * return alongside the resolved value, for callers (e.g. a run report) that
 * need attempt/backoff history after the fact rather than subscribing to
 * `poll:*`/`retry:*` events live.
 *
 * @packageDocumentation
 */

/**
 * One waited attempt recorded by `M3LPoller.pollDetailed`.
 *
 * `entries` covers only attempts that were followed by a backoff wait — the
 * attempt that ultimately succeeds never gets an entry, so
 * `entries.length === attempts - 1` on the returned
 * {@link M3LPollDetailedResult} (and `0` on a first-try success). Because
 * every entry that exists was, by construction, followed by a sleep,
 * `delayMs` is a required field rather than optional.
 *
 * @example
 * ```ts
 * import type { M3LPollAttemptEntry } from "@m3l-automation/m3l-common/core";
 *
 * function describe(entry: M3LPollAttemptEntry): string {
 *   return `attempt ${String(entry.attempt)} waited ${String(entry.delayMs)}ms`;
 * }
 * ```
 */
export interface M3LPollAttemptEntry {
  /** The 1-based attempt number that was followed by this wait. */
  readonly attempt: number;
  /** The backoff delay, in milliseconds, slept after this attempt. */
  readonly delayMs: number;
}

/**
 * One waited attempt recorded by `M3LRetryRunner.runDetailed`.
 *
 * Symmetric with {@link M3LPollAttemptEntry}: `entries` covers only attempts
 * that were followed by a backoff wait — the attempt that ultimately
 * succeeds never gets an entry, so `entries.length === attempts - 1` on the
 * returned {@link M3LRetryDetailedResult} (and `0` on a first-try success).
 * `delayMs` is required for the same reason: every entry that exists was, by
 * construction, followed by a sleep.
 *
 * @example
 * ```ts
 * import type { M3LRetryAttemptEntry } from "@m3l-automation/m3l-common/core";
 *
 * function describe(entry: M3LRetryAttemptEntry): string {
 *   return `attempt ${String(entry.attempt)} classified "${entry.classification}", waited ${String(entry.delayMs)}ms`;
 * }
 * ```
 */
export interface M3LRetryAttemptEntry {
  /** The 1-based attempt number that was followed by this wait. */
  readonly attempt: number;
  /**
   * The raw classifier verdict for this attempt's error (e.g. `"retriable"`
   * or `"unknown"` — never the succeeding attempt, which is never
   * classified).
   */
  readonly classification: "retriable" | "unknown";
  /** The backoff delay, in milliseconds, slept after this attempt. */
  readonly delayMs: number;
}

/**
 * The envelope returned by `M3LPoller.pollDetailed`: the resolved
 * value plus the per-attempt wait history that led to it.
 *
 * @typeParam T - The poll check's success value type.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const poller = new Core.M3LPoller({
 *   backoff: Core.M3LBackoff.exponentialJittered(500, 10_000),
 * });
 *
 * const result = await poller.pollDetailed(async () => {
 *   const status = await getJobStatus();
 *   return status.done
 *     ? { type: "success", value: status }
 *     : { type: "continue" };
 * });
 *
 * console.log(result.attempts, result.entries.length);
 * ```
 */
export interface M3LPollDetailedResult<T> {
  /** The check's resolved success value. */
  readonly value: T;
  /** The number of attempts made, the last of which succeeded. */
  readonly attempts: number;
  /**
   * One entry per attempt that was followed by a wait — never the
   * succeeding attempt. See {@link M3LPollAttemptEntry}.
   */
  readonly entries: readonly M3LPollAttemptEntry[];
}

/**
 * The envelope returned by `M3LRetryRunner.runDetailed`: the resolved
 * value plus the per-attempt classification/wait history that led to it.
 *
 * @typeParam T - The retried operation's resolved value type.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const runner = new Core.M3LRetryRunner({
 *   classifier: Core.awsThrottlingClassifier,
 *   backoff: Core.M3LBackoff.exponentialJittered(200, 5_000),
 * });
 *
 * const result = await runner.runDetailed(async () => callThrottledApi());
 *
 * console.log(result.attempts, result.entries.length);
 * ```
 */
export interface M3LRetryDetailedResult<T> {
  /** The operation's resolved success value. */
  readonly value: T;
  /** The number of attempts made, the last of which succeeded. */
  readonly attempts: number;
  /**
   * One entry per attempt that was followed by a wait — never the
   * succeeding attempt. See {@link M3LRetryAttemptEntry}.
   */
  readonly entries: readonly M3LRetryAttemptEntry[];
}
