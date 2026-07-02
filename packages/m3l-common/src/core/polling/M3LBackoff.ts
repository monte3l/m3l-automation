/**
 * `core/polling/M3LBackoff` — factory for the delay strategies consumed by both
 * {@link M3LPoller} and {@link M3LRetryRunner}.
 *
 * @packageDocumentation
 */

import { assertPositive } from "../../internal/polling/guards.js";
import type { M3LBackoffStrategy } from "../../internal/polling/strategy.js";

/** Base of the exponential growth for {@link M3LBackoff.exponential}. */
const EXPONENTIAL_BASE = 2;

/**
 * Multiplier applied to the previous delay when computing the upper bound of
 * the decorrelated-jitter range (AWS canonical algorithm).
 */
const JITTER_GROWTH_FACTOR = 3;

/**
 * Factory for backoff strategies. Each static method returns an opaque strategy
 * object accepted by both {@link M3LPoller} and {@link M3LRetryRunner}; callers
 * never inspect its shape.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const poller = new Core.M3LPoller({
 *   backoff: Core.M3LBackoff.exponentialJittered(500, 10_000),
 * });
 * ```
 */
export class M3LBackoff {
  private constructor() {
    // Static factory only; never instantiated.
  }

  /**
   * Exponential backoff capped at `capMs`: the delay before attempt `n` is
   * `min(capMs, startMs * 2^n)`.
   *
   * @param startMs - Initial delay in milliseconds; must be finite and greater than 0.
   * @param capMs - Maximum delay in milliseconds; must be finite and greater than 0.
   * @returns An opaque backoff strategy.
   * @throws When either argument is not a finite positive number.
   *
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common/core";
   *
   * const backoff = Core.M3LBackoff.exponential(100, 5_000);
   * ```
   */
  static exponential(startMs: number, capMs: number): M3LBackoffStrategy {
    assertPositive(startMs, "startMs");
    assertPositive(capMs, "capMs");
    return {
      nextDelay(attempt: number): number {
        return Math.min(capMs, startMs * EXPONENTIAL_BASE ** attempt);
      },
    };
  }

  /**
   * Exponential backoff with decorrelated jitter (AWS canonical algorithm):
   * the next delay is `min(capMs, random_between(startMs, prev * 3))`, seeded at
   * `startMs`. Preferred under contention because it spreads retries.
   *
   * @param startMs - Initial delay in milliseconds; must be finite and greater than 0.
   * @param capMs - Maximum delay in milliseconds; must be finite and greater than 0.
   * @returns An opaque backoff strategy.
   * @throws When either argument is not a finite positive number.
   *
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common/core";
   *
   * const backoff = Core.M3LBackoff.exponentialJittered(200, 5_000);
   * ```
   */
  static exponentialJittered(
    startMs: number,
    capMs: number,
  ): M3LBackoffStrategy {
    assertPositive(startMs, "startMs");
    assertPositive(capMs, "capMs");
    return {
      nextDelay(_attempt: number, prevMs: number | undefined): number {
        const previous = prevMs ?? startMs;
        const upper = previous * JITTER_GROWTH_FACTOR;
        const span = upper - startMs;
        const candidate = startMs + Math.random() * span;
        return Math.min(capMs, candidate);
      },
    };
  }

  /**
   * A fixed delay between attempts.
   *
   * @param delayMs - Delay in milliseconds; must be finite and greater than 0.
   * @returns An opaque backoff strategy.
   * @throws When `delayMs` is not a finite positive number.
   *
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common/core";
   *
   * const backoff = Core.M3LBackoff.constant(1_000);
   * ```
   */
  static constant(delayMs: number): M3LBackoffStrategy {
    assertPositive(delayMs, "delayMs");
    return {
      nextDelay(): number {
        return delayMs;
      },
    };
  }
}
