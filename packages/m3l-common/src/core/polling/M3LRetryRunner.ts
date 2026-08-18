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
import { M3LEventEmitterBase } from "../events/index.js";
import { M3LOperationAbortedError } from "../errors/index.js";

import { M3LBackoff } from "./M3LBackoff.js";
import type { M3LRetryEventMap } from "./events.js";

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
  /**
   * Optional `AbortSignal` for cooperative cancellation (ADR-0049).
   *
   * When supplied, the signal is checked at the start of each attempt
   * (before invoking the operation) and as the **first** action inside the
   * `catch` block — before the classifier runs. This ordering is the entire
   * point: a classifier that judged the abort "retriable" would otherwise
   * cause the runner to retry the very operation the operator just cancelled.
   *
   * An abort during a backoff delay rejects promptly without sleeping out the
   * remaining delay. The thrown error is always {@link M3LOperationAbortedError}
   * (`ERR_OPERATION_ABORTED`, `origin: "caller"`, `retryable: false`), never
   * routed through the classifier.
   *
   * Omitting this option leaves behaviour exactly as it was before the option
   * existed — no signal is registered, no listener overhead is incurred.
   */
  readonly signal?: AbortSignal;
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
 * Returns `true` when `signal` is defined and has fired.
 *
 * A module-level function rather than an inline `this.#signal?.aborted === true`
 * check: TypeScript's control-flow narrowing tracks the truthiness of
 * `optional?.property` across the `try`/`catch` boundary within a single loop
 * iteration, which would make the second check in the `catch` block a TS2367
 * false-alarm ("types 'false | undefined' and 'true' have no overlap"). A call
 * site returns a plain `boolean` that TypeScript cannot narrow away.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * The runner's reaction to one failed attempt, pairing what to DO with the
 * RAW classifier verdict every `retry:*` payload must report.
 *
 * Carrying both in one discriminated value is what removes the two narrowing
 * `as` casts the loop body used to need: each arm's `classification` is
 * already typed to exactly the subset its event payload accepts, so the
 * relationship is proven by the type rather than by branch ordering plus a
 * comment.
 *
 * Module-private: never re-exported through `core/polling/index.ts`.
 */
type ResolvedRetryAction =
  | {
      /** Stop retrying and propagate the original error unchanged. */
      readonly action: "stop";
      readonly classification: "fatal" | "unknown";
    }
  | {
      /** Schedule another attempt. */
      readonly action: "retry";
      readonly classification: "retriable" | "unknown";
      /**
       * Server-driven override for THIS attempt only, or `undefined` to use
       * the configured backoff. Declared as `number | undefined` rather than
       * an optional property so it can be assigned unconditionally under
       * `exactOptionalPropertyTypes`.
       */
      readonly delayMs: number | undefined;
    };

/**
 * Resolve one classifier verdict into the runner's reaction, applying
 * `unknownDecision` to an `unknown` verdict while preserving the raw verdict
 * for telemetry.
 */
function resolveAction(
  advice: M3LRetryAdvice,
  unknownDecision: M3LUnknownDecision,
): ResolvedRetryAction {
  if (advice.decision === "retriable") {
    return {
      action: "retry",
      classification: "retriable",
      delayMs: advice.delayMs,
    };
  }
  if (advice.decision === "fatal") {
    return { action: "stop", classification: "fatal" };
  }
  if (advice.decision === "unknown") {
    return unknownDecision === "fatal"
      ? { action: "stop", classification: advice.decision }
      : {
          action: "retry",
          classification: advice.decision,
          delayMs: undefined,
        };
  }
  // Unreachable through the public resolveAction() path — M3LRetryAdvice's
  // decision only ever carries "retriable" | "fatal" | "unknown". Kept only
  // so adding a new M3LRetryDecision value fails to *compile* here. An
  // off-vocabulary decision from an untyped JS caller degrades through
  // unknownDecision at runtime — stricter than the pre-refactor code, which
  // could leak the raw out-of-vocabulary string into a retry:scheduled
  // payload's classification field instead.
  const _exhaustive: never = advice.decision;
  return unknownDecision === "fatal"
    ? { action: "stop", classification: "unknown" }
    : { action: "retry", classification: "unknown", delayMs: undefined };
}

/**
 * The per-`run()` backoff progression. Owns the `prevDelay` seed the
 * decorrelated-jitter strategies feed on, so the load-bearing rule — a
 * server-driven `delayMs` override applies to ONE attempt and must never
 * seed the progression — lives in exactly one place instead of being split
 * across two branches of the retry loop.
 *
 * Instantiated inside each `run()` call frame, never on the instance, which
 * is what keeps concurrent runs on one runner isolated.
 *
 * Module-private: never re-exported through `core/polling/index.ts`.
 */
class DelayProgression {
  readonly #backoff: M3LBackoffStrategy;
  #prevDelay: number | undefined;

  constructor(backoff: M3LBackoffStrategy) {
    this.#backoff = backoff;
  }

  /**
   * @param attempt - The 0-based index of the attempt that just failed.
   * @param override - A server-driven delay for this attempt, or `undefined`
   *   to advance the configured backoff.
   * @returns The delay, in milliseconds, to sleep before the next attempt.
   * @throws When `override` is present but not a finite positive number.
   */
  next(attempt: number, override: number | undefined): number {
    if (override !== undefined) {
      assertPositive(override, "advice.delayMs");
      // Deliberately does NOT assign #prevDelay: a one-off server delay must
      // not perturb the jittered progression.
      return override;
    }
    const nextDelay = this.#backoff.nextDelay(attempt, this.#prevDelay);
    this.#prevDelay = nextDelay;
    return nextDelay;
  }
}

/**
 * Re-executes an operation until it succeeds or retries are exhausted.
 *
 * Attempt and backoff state live inside each {@link M3LRetryRunner.run} call
 * frame, never on the instance, so concurrent runs on one instance are isolated.
 *
 * Extends {@link M3LEventEmitterBase} to surface opt-in `retry:*` telemetry
 * events (see {@link M3LRetryEventMap}); subscribing never alters the
 * resolved value or thrown error of `run()`.
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
export class M3LRetryRunner extends M3LEventEmitterBase<M3LRetryEventMap> {
  readonly #classifier: M3LRetryClassifier;
  readonly #backoff: M3LBackoffStrategy;
  readonly #unknownDecision: M3LUnknownDecision;
  readonly #maxAttempts: number;
  readonly #signal: AbortSignal | undefined;

  /**
   * @param options - The classifier plus optional backoff, unknown-resolution,
   *   attempt bound, and cancellation signal.
   * @throws When `maxAttempts` is provided but is not a finite positive integer.
   */
  constructor(options: M3LRetryRunnerOptions) {
    super();
    const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    assertPositiveInteger(maxAttempts, "maxAttempts");
    this.#classifier = options.classifier;
    this.#backoff =
      options.backoff ??
      M3LBackoff.exponentialJittered(DEFAULT_START_MS, DEFAULT_CAP_MS);
    this.#unknownDecision = options.unknownDecision ?? "fatal";
    this.#maxAttempts = maxAttempts;
    this.#signal = options.signal;
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
    const progression = new DelayProgression(this.#backoff);
    const lastAttempt = this.#maxAttempts - 1;

    for (let attempt = 0; ; attempt++) {
      // Check signal before invoking op() — an already-aborted signal
      // must reject without calling the operation at all.
      if (isAborted(this.#signal)) {
        throw new M3LOperationAbortedError();
      }

      this.emit("retry:attempt", {
        attempt: attempt + 1,
        maxAttempts: this.#maxAttempts,
      });
      try {
        const result = await op();
        this.emit("retry:success", { attempt: attempt + 1 });
        return result;
      } catch (error) {
        // Signal checked FIRST — before the classifier — so no classifier
        // can reclassify the abort as retriable and cause the runner to retry
        // the very operation the operator just cancelled (ADR-0049).
        if (isAborted(this.#signal)) {
          throw new M3LOperationAbortedError();
        }

        const resolved = resolveAction(
          toAdvice(this.#classifier(error)),
          this.#unknownDecision,
        );

        // Fatal (or unknown resolved to fatal) propagates the original error
        // unchanged — checked FIRST so an unknown-resolved-to-fatal verdict
        // on the last attempt reports as retry:fatal, not retry:exhausted.
        if (resolved.action === "stop") {
          this.emit("retry:fatal", {
            attempt: attempt + 1,
            classification: resolved.classification,
          });
          throw error;
        }
        // Retriable, but the last attempt is exhausted — propagates unchanged.
        if (attempt >= lastAttempt) {
          this.emit("retry:exhausted", { attempts: this.#maxAttempts });
          throw error;
        }

        const delayMs = progression.next(attempt, resolved.delayMs);
        this.emit("retry:scheduled", {
          attempt: attempt + 1,
          delayMs,
          classification: resolved.classification,
        });
        // Pass signal so an abort during the backoff abandons it immediately.
        await delay(delayMs, this.#signal);
      }
    }
  }
}
