/**
 * `core/polling/M3LPoller` — repeatedly checks external state until it reaches a
 * terminal condition, waiting a backoff delay between checks.
 *
 * @packageDocumentation
 */

import { delay } from "../../internal/polling/delay.js";
import { assertPositiveInteger } from "../../internal/polling/guards.js";
import {
  M3LPollExhaustedError,
  M3LPollFailureError,
} from "../../internal/polling/errors.js";
import type { M3LBackoffStrategy } from "../../internal/polling/strategy.js";
import { M3LEventEmitterBase } from "../events/index.js";

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
}

/** Default attempt bound when `maxAttempts` is omitted. */
const DEFAULT_POLL_MAX_ATTEMPTS = 30;

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

  /**
   * @param options - The backoff strategy and optional attempt bound.
   * @throws When `maxAttempts` is provided but is not a finite positive integer.
   */
  constructor(options: M3LPollerOptions) {
    super();
    const maxAttempts = options.maxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    assertPositiveInteger(maxAttempts, "maxAttempts");
    this.#backoff = options.backoff;
    this.#maxAttempts = maxAttempts;
  }

  /**
   * Poll `check` until it returns a terminal decision or the attempt bound is
   * exhausted.
   *
   * @typeParam T - The success value type.
   * @param check - The per-attempt check function (sync or async).
   * @returns The resolved success value.
   * @throws An internal `M3LError` (code `ERR_POLL_FAILURE`) on a `failure`
   *   decision, or (code `ERR_POLL_EXHAUSTED`) when `maxAttempts` is reached
   *   while still `continue`.
   */
  async poll<T>(check: M3LPollCheckFn<T>): Promise<T> {
    let prevDelay: number | undefined;

    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
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
          throw new M3LPollFailureError(
            "poll check returned a terminal failure decision",
          );
        case "continue": {
          if (attempt < this.#maxAttempts - 1) {
            const nextDelay = this.#backoff.nextDelay(attempt, prevDelay);
            prevDelay = nextDelay;
            this.emit("poll:wait", {
              attempt: attempt + 1,
              delayMs: nextDelay,
            });
            await delay(nextDelay);
          }
          break;
        }
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
}
