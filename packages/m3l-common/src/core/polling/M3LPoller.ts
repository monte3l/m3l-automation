/**
 * `core/polling/M3LPoller` — repeatedly checks external state until it reaches a
 * terminal condition, waiting a backoff delay between checks.
 *
 * @packageDocumentation
 */

import { delay } from "../../internal/polling/delay.js";
import { assertPositiveInteger } from "../../internal/polling/guards.js";
import {
  M3LNoProgressError,
  M3LPollExhaustedError,
  M3LPollFailureError,
} from "../../internal/polling/errors.js";
import {
  ProgressTracker,
  type M3LProgressWitness,
  type ProgressWitnessConfig,
} from "../../internal/polling/progress.js";
import type { M3LBackoffStrategy } from "../../internal/polling/strategy.js";
import { M3LEventEmitterBase } from "../events/index.js";
import { M3LOperationAbortedError } from "../errors/index.js";

import type { M3LPollerEventMap } from "./events.js";

/**
 * The outcome of a single poll check.
 *
 * - `success` — a terminal success carrying the resolved value.
 * - `failure` — a terminal failure; the poll rejects.
 * - `continue` — not yet terminal; poll again after the next backoff delay.
 */
export type M3LPollDecision<T> =
  { type: "success"; value: T } | { type: "failure" } | { type: "continue" };

/**
 * A poll check. Invoked once per attempt; may be synchronous or asynchronous.
 * Returns a {@link M3LPollDecision} describing whether polling is done.
 */
export type M3LPollCheckFn<T> = () =>
  M3LPollDecision<T> | Promise<M3LPollDecision<T>>;

/** Constructor options for {@link M3LPoller}. */
export interface M3LPollerOptions {
  /** Delay strategy between checks. Build one with {@link M3LBackoff}. */
  readonly backoff: M3LBackoffStrategy;
  /**
   * Maximum number of checks before the poll rejects while the check is still
   * returning `continue`. Must be a finite integer greater than 0. Defaults to
   * {@link DEFAULT_POLL_MAX_ATTEMPTS}.
   */
  readonly maxAttempts?: number;
  /**
   * Optional `AbortSignal` for cooperative cancellation (ADR-0049).
   *
   * When supplied, the signal is checked at the start of each attempt
   * (before invoking `check`) and during every backoff delay. If the signal
   * aborts, `poll()` rejects with {@link M3LOperationAbortedError}
   * (`ERR_OPERATION_ABORTED`, `origin: "caller"`, `retryable: false`) —
   * a pending backoff is abandoned immediately rather than slept out.
   *
   * Omitting this option leaves behaviour exactly as it was before the option
   * existed — no signal is registered, no listener overhead is incurred.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional no-progress guard (see `docs/reference/core/polling.md`,
   * "No-progress detection").
   *
   * When supplied, `witness` is sampled once per attempt that is about to
   * continue (never on `success`, never on a terminal `failure`, and never
   * on the attempt that exhausts `maxAttempts`). The first sample is a
   * baseline; each later sample equal to the previous one (`Object.is`)
   * increments a stall counter, and any change resets it to `0`. Once the
   * counter reaches `maxStalledAttempts`, `poll()` rejects with an internal
   * `M3LError` (code `ERR_NO_PROGRESS`, `origin: "external"`,
   * `retryable: false`) before the backoff delay for that attempt is slept,
   * so a stalled loop surfaces in seconds instead of after the full ceiling
   * of remote calls. An abort observed on the same attempt always wins over
   * this guard.
   *
   * Omitting this option leaves behaviour exactly as it was before the option
   * existed — no witness is called, no counter is kept.
   */
  readonly progress?: ProgressWitnessConfig;
}

/** Default attempt bound when `maxAttempts` is omitted. */
const DEFAULT_POLL_MAX_ATTEMPTS = 30;

/**
 * Returns `true` when `signal` is defined and has fired.
 *
 * A module-level function rather than an inline `signal?.aborted === true`
 * check so TypeScript's control-flow narrowing cannot cause a TS2367
 * false-alarm on a second check that appears later in the same control-flow
 * path (e.g. inside a `catch` block following a top-of-loop guard).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Polls external state until a terminal decision or attempt exhaustion.
 *
 * Attempt and backoff state live inside each {@link M3LPoller.poll} call frame,
 * never on the instance, so concurrent polls on one instance are isolated.
 *
 * Extends {@link M3LEventEmitterBase} to surface opt-in `poll:*` telemetry
 * events (see {@link M3LPollerEventMap}); subscribing never alters the
 * resolved value or thrown error of `poll()`.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const poller = new Core.M3LPoller({
 *   backoff: Core.M3LBackoff.exponentialJittered(500, 10_000),
 *   maxAttempts: 60,
 * });
 *
 * const job = await poller.poll(async () => {
 *   const status = await getJobStatus(jobId);
 *   if (status.state === "SUCCEEDED") return { type: "success", value: status };
 *   if (status.state === "FAILED") return { type: "failure" };
 *   return { type: "continue" };
 * });
 * ```
 */
export class M3LPoller extends M3LEventEmitterBase<M3LPollerEventMap> {
  readonly #backoff: M3LBackoffStrategy;
  readonly #maxAttempts: number;
  readonly #signal: AbortSignal | undefined;
  readonly #progress: ProgressWitnessConfig | undefined;

  /**
   * @param options - The backoff strategy and optional attempt bound.
   * @throws When `maxAttempts` is provided but is not a finite positive
   *   integer, or when `options.progress.maxStalledAttempts` is provided but
   *   is not a finite positive integer.
   */
  constructor(options: M3LPollerOptions) {
    super();
    const maxAttempts = options.maxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    assertPositiveInteger(maxAttempts, "maxAttempts");
    if (options.progress !== undefined) {
      assertPositiveInteger(
        options.progress.maxStalledAttempts,
        "maxStalledAttempts",
      );
    }
    this.#backoff = options.backoff;
    this.#maxAttempts = maxAttempts;
    this.#signal = options.signal;
    this.#progress = options.progress;
  }

  /**
   * Poll `check` until it returns a terminal decision or the attempt bound is
   * exhausted.
   *
   * @typeParam T - The success value type.
   * @param check - The per-attempt check function (sync or async).
   * @returns The resolved success value.
   * @throws {@link M3LOperationAbortedError} (code `ERR_OPERATION_ABORTED`) when
   *   the signal aborts — either before the first check or during a backoff delay.
   * @throws An internal `M3LError` (code `ERR_POLL_FAILURE`) on a `failure`
   *   decision, (code `ERR_POLL_EXHAUSTED`) when `maxAttempts` is reached
   *   while still `continue`, or (code `ERR_NO_PROGRESS`) when a configured
   *   `progress` witness stays unchanged for `maxStalledAttempts` consecutive
   *   attempts.
   */
  async poll<T>(check: M3LPollCheckFn<T>): Promise<T> {
    let prevDelay: number | undefined;
    const tracker =
      this.#progress !== undefined
        ? new ProgressTracker(this.#progress)
        : undefined;

    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      // Check signal before invoking check() — an already-aborted signal
      // must reject without calling the check function at all.
      if (isAborted(this.#signal)) {
        throw new M3LOperationAbortedError();
      }

      this.emit("poll:attempt", {
        attempt: attempt + 1,
        maxAttempts: this.#maxAttempts,
      });
      const decision = await check();

      switch (decision.type) {
        case "success":
          this.emit("poll:success", { attempt: attempt + 1 });
          return decision.value;
        case "failure":
          // `attempt` is carried as `context.attempt` (mirroring the sibling
          // `M3LPollExhaustedError`'s `context.attempts`) so a terminal
          // failure can be traced back to the attempt it failed on.
          throw new M3LPollFailureError(
            "poll check returned a terminal failure decision",
            { attempt: attempt + 1 },
          );
        case "continue":
          prevDelay = await this.#continueAttempt(attempt, prevDelay, tracker);
          break;
        default: {
          const exhaustive: never = decision;
          throw new M3LPollFailureError(
            `unhandled poll decision: ${String(exhaustive)}`,
          );
        }
      }
    }

    this.emit("poll:exhausted", { attempts: this.#maxAttempts });
    throw new M3LPollExhaustedError(
      `poll exhausted after ${String(this.#maxAttempts)} attempts while still 'continue'`,
      { attempts: this.#maxAttempts },
    );
  }

  /**
   * Handle a non-final `continue` decision: consult the no-progress guard (if
   * configured) and, absent a trip, compute, emit, and sleep the backoff
   * delay for the next attempt. Extracted from {@link poll}'s loop body to
   * keep both under the complexity/depth/length lint ceilings.
   *
   * @param attempt - The 0-based index of the attempt that just returned
   *   `continue`.
   * @param prevDelay - The previous backoff delay, seeding the progression.
   * @param tracker - This call's stall tracker, or `undefined` when no
   *   `progress` option was configured.
   * @returns The delay just slept (the next `prevDelay` seed), or the
   *   unchanged `prevDelay` when `attempt` is the ceiling-exhausting attempt
   *   (no delay is slept for it).
   * @throws {@link M3LOperationAbortedError} when the signal aborted on this
   *   attempt (abort always wins over a no-progress trip).
   * @throws An internal `M3LError` (code `ERR_NO_PROGRESS`) when the guard trips.
   */
  async #continueAttempt(
    attempt: number,
    prevDelay: number | undefined,
    tracker: ProgressTracker | undefined,
  ): Promise<number | undefined> {
    if (attempt >= this.#maxAttempts - 1) {
      return prevDelay;
    }
    if (tracker !== undefined && this.#progress !== undefined) {
      this.#checkProgress(tracker, this.#progress.witness, attempt);
    }
    const nextDelay = this.#backoff.nextDelay(attempt, prevDelay);
    this.emit("poll:wait", { attempt: attempt + 1, delayMs: nextDelay });
    // Pass signal so an abort during the backoff abandons it immediately.
    await delay(nextDelay, this.#signal);
    return nextDelay;
  }

  /**
   * Sample `witness` through `tracker` and, when the guard trips, emit
   * `poll:no-progress` and throw. Abort always wins: re-checked here before
   * reporting no-progress, since a stalled attempt can also be the one that
   * observed the abort.
   *
   * @param tracker - This call's stall tracker.
   * @param witness - The configured progress witness.
   * @param attempt - The 0-based index of the stalled attempt.
   * @throws {@link M3LOperationAbortedError} when the signal has aborted.
   * @throws An internal `M3LError` (code `ERR_NO_PROGRESS`) when the guard trips.
   */
  #checkProgress(
    tracker: ProgressTracker,
    witness: M3LProgressWitness,
    attempt: number,
  ): void {
    if (!tracker.record(witness)) {
      return;
    }
    if (isAborted(this.#signal)) {
      throw new M3LOperationAbortedError();
    }
    const stalledAttempts = tracker.stalledAttempts;
    this.emit("poll:no-progress", { attempt: attempt + 1, stalledAttempts });
    throw new M3LNoProgressError(
      `poll made no progress for ${String(stalledAttempts)} consecutive attempts`,
      { attempts: attempt + 1, stalledAttempts },
    );
  }
}
