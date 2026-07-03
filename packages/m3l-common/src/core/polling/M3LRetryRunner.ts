/**
 * `core/polling/M3LRetryRunner` — re-executes a failing operation until it
 * succeeds or retries are exhausted, deciding each thrown error through a
 * {@link M3LRetryClassifier}.
 *
 * @packageDocumentation
 */

import { delay } from "../../internal/polling/delay.js";
import {
  assertPositive,
  assertPositiveInteger,
} from "../../internal/polling/guards.js";
import type { M3LBackoffStrategy } from "../../internal/polling/strategy.js";

import { M3LBackoff } from "./M3LBackoff.js";

/**
 * The verdict a {@link M3LRetryClassifier} reaches for a thrown error.
 *
 * - `retriable` — retry after backoff.
 * - `fatal` — stop and propagate the error.
 * - `unknown` — the classifier has no opinion; resolution is deferred to the
 *   runner's `unknownDecision`.
 */
export type M3LRetryDecision = "retriable" | "fatal" | "unknown";

/**
 * A richer classifier verdict. Modelled as a discriminated union so a
 * server-driven `delayMs` override can only accompany a `retriable` decision —
 * `delayMs` on a `fatal`/`unknown` verdict is meaningless and unrepresentable.
 * When present, `delayMs` overrides the configured backoff for that one attempt
 * (for example honoring a `Retry-After` header).
 */
export type M3LRetryAdvice =
  | {
      /** Retry this error after the delay below (or the configured backoff). */
      readonly decision: "retriable";
      /**
       * Optional server-driven delay in milliseconds. When present it overrides
       * the configured backoff for that one attempt only.
       */
      readonly delayMs?: number;
    }
  | {
      /** Stop and propagate (`fatal`) or defer to `unknownDecision` (`unknown`). */
      readonly decision: "fatal" | "unknown";
    };

/**
 * A pure function that inspects a thrown error and decides how to react. Input
 * is `unknown` — any thrown value may be caught — and the function must never
 * throw on a foreign value.
 */
export type M3LRetryClassifier = (
  err: unknown,
) => M3LRetryDecision | M3LRetryAdvice;

/** How the runner resolves an `unknown` classifier verdict. */
export type M3LUnknownDecision = "retriable" | "fatal";

/** Constructor options for {@link M3LRetryRunner}. */
export interface M3LRetryRunnerOptions {
  /** Decides retriable vs. fatal for each thrown error. */
  readonly classifier: M3LRetryClassifier;
  /**
   * Delay strategy between retries. Build one with {@link M3LBackoff}. Defaults
   * to `M3LBackoff.exponentialJittered(200, 5_000)`.
   */
  readonly backoff?: M3LBackoffStrategy;
  /**
   * How to resolve an `unknown` verdict. Defaults to `"fatal"`.
   */
  readonly unknownDecision?: M3LUnknownDecision;
  /**
   * Maximum number of attempts before the last error propagates. Must be a
   * finite integer greater than 0. Defaults to
   * {@link DEFAULT_RETRY_MAX_ATTEMPTS}.
   */
  readonly maxAttempts?: number;
}

/** Default retry attempt bound when `maxAttempts` is omitted. */
const DEFAULT_RETRY_MAX_ATTEMPTS = 10;

/** Default backoff start delay in milliseconds. */
const DEFAULT_START_MS = 200;

/** Default backoff cap delay in milliseconds. */
const DEFAULT_CAP_MS = 5_000;

/** Normalise a classifier return value to a {@link M3LRetryAdvice}. */
function toAdvice(result: M3LRetryDecision | M3LRetryAdvice): M3LRetryAdvice {
  return typeof result === "string" ? { decision: result } : result;
}

/**
 * Re-executes an operation until it succeeds or retries are exhausted.
 *
 * Attempt and backoff state live inside each {@link M3LRetryRunner.run} call
 * frame, never on the instance, so concurrent runs on one instance are isolated.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const runner = new Core.M3LRetryRunner({
 *   classifier: Core.awsThrottlingClassifier,
 *   backoff: Core.M3LBackoff.exponentialJittered(200, 5_000),
 *   unknownDecision: "fatal",
 * });
 *
 * const data = await runner.run(async () => callThrottledApi());
 * ```
 */
export class M3LRetryRunner {
  readonly #classifier: M3LRetryClassifier;
  readonly #backoff: M3LBackoffStrategy;
  readonly #unknownDecision: M3LUnknownDecision;
  readonly #maxAttempts: number;

  /**
   * @param options - The classifier plus optional backoff, unknown-resolution,
   *   and attempt bound.
   * @throws When `maxAttempts` is provided but is not a finite positive integer.
   */
  constructor(options: M3LRetryRunnerOptions) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    assertPositiveInteger(maxAttempts, "maxAttempts");
    this.#classifier = options.classifier;
    this.#backoff =
      options.backoff ??
      M3LBackoff.exponentialJittered(DEFAULT_START_MS, DEFAULT_CAP_MS);
    this.#unknownDecision = options.unknownDecision ?? "fatal";
    this.#maxAttempts = maxAttempts;
  }

  /**
   * Run `op`, retrying transient failures per the classifier.
   *
   * @typeParam T - The operation's resolved value type.
   * @param op - The operation to execute; may reject on failure.
   * @returns The operation's resolved value.
   * @throws The last thrown error (unchanged) on a fatal verdict, an unresolved
   *   `unknown` verdict, or retry exhaustion.
   */
  async run<T>(op: () => Promise<T>): Promise<T> {
    let prevDelay: number | undefined;
    const lastAttempt = this.#maxAttempts - 1;

    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const advice = toAdvice(this.#classifier(error));
        const decision =
          advice.decision === "unknown"
            ? this.#unknownDecision
            : advice.decision;

        // Fatal (or unknown resolved to fatal) — or the last attempt exhausted
        // while retriable — propagates the original error unchanged.
        if (decision === "fatal" || attempt >= lastAttempt) throw error;

        // A server-driven delayMs (only expressible on a `retriable` advice)
        // overrides the configured backoff for THIS attempt only, so it must
        // not seed the jittered backoff progression: leave prevDelay untouched.
        if (advice.decision === "retriable" && advice.delayMs !== undefined) {
          assertPositive(advice.delayMs, "advice.delayMs");
          await delay(advice.delayMs);
        } else {
          const waitMs = this.#backoff.nextDelay(attempt, prevDelay);
          prevDelay = waitMs;
          await delay(waitMs);
        }
      }
    }
  }
}
