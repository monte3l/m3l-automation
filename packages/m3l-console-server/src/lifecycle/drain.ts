/**
 * `lifecycle/drain` — the ADR-0049 cooperative-cancellation drain controller
 * the console server runs at shutdown.
 *
 * A drain has two jobs, run in a fixed order: signal every in-flight
 * consumer that a shutdown is underway (via {@link M3LDrainController.signal}),
 * then wait — up to a bounded timeout — for tracked work to actually finish.
 * `main.ts` wires this to `net`'s server-close sequence; `http/` calls
 * {@link M3LDrainController.track} around each request so an in-flight
 * response is never abandoned mid-write.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";

/** The highest delay Node's `setTimeout` honours (its 32-bit signed timer bound). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The lifecycle of a {@link M3LDrainController}: `"serving"` accepts new
 * tracked work, `"draining"` is shutting down and refuses new work,
 * `"drained"` has settled (gracefully or by timeout).
 *
 * @example
 * ```ts
 * function acceptsWork(state: M3LDrainState): boolean {
 *   return state === "serving";
 * }
 * ```
 */
export type M3LDrainState = "serving" | "draining" | "drained";

/**
 * The result of a completed {@link M3LDrainController.drain} call.
 *
 * @example
 * ```ts
 * function describe(outcome: M3LDrainOutcome): string {
 *   return outcome.graceful
 *     ? `drained cleanly in ${outcome.durationMs}ms`
 *     : `drained after abandoning ${outcome.abandoned} request(s)`;
 * }
 * ```
 */
export interface M3LDrainOutcome {
  /** `true` when every tracked unit of work released before the deadline. */
  readonly graceful: boolean;
  /** The count of tracked work still in flight when the deadline was hit. `0` on a graceful drain. */
  readonly abandoned: number;
  /** Elapsed time, per the injected clock, between `drain()` being called and it settling. */
  readonly durationMs: number;
}

/**
 * Constructor options for {@link createDrainController}.
 *
 * @example
 * ```ts
 * const options: M3LDrainControllerOptions = { timeoutMs: 5_000 };
 * ```
 */
export interface M3LDrainControllerOptions {
  /**
   * The maximum time to wait for in-flight work to release before forcing a
   * drain. Must be a positive integer no greater than `2_147_483_647` — Node
   * coerces a `setTimeout` delay above that bound to fire after 1ms with a
   * `TimeoutOverflowWarning` (measured on Node v26.7.0), so an unbounded or
   * oversized drain timeout would silently become an instant kill, the exact
   * inverse of what the caller asked for. `config/env.ts` bounds the same
   * value for its own env-sourced input, but that bound does not protect a
   * programmatic caller of {@link createDrainController} directly — this
   * constructor-level check is not redundant with it.
   */
  readonly timeoutMs: number;
  /** Injectable clock, for deterministic `durationMs` in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A running drain controller: tracks in-flight work and coordinates an
 * orderly shutdown against a bounded deadline.
 *
 * `state` and `inFlight` are live readings — read them again after any
 * `await`, don't cache the value across one.
 *
 * @example
 * ```ts
 * const controller = createDrainController({ timeoutMs: 5_000 });
 * const release = controller.track();
 * try {
 *   // ... handle one unit of work ...
 * } finally {
 *   release();
 * }
 * const outcome = await controller.drain();
 * ```
 */
export interface M3LDrainController {
  /** Aborted the instant `drain()` is first called — signal in-flight consumers to stop. */
  readonly signal: AbortSignal;
  /** The controller's current lifecycle state (live, not a snapshot). */
  readonly state: M3LDrainState;
  /** The current count of tracked, not-yet-released work (live, not a snapshot). */
  readonly inFlight: number;
  /**
   * Registers one unit of in-flight work. Throws `ERR_CONSOLE_UNAVAILABLE`
   * unless the controller is still `"serving"`.
   *
   * @returns An idempotent release function — call it exactly once per unit
   *   of work; extra calls are no-ops, so a `finally` block can call it
   *   unconditionally without risking a double-decrement.
   */
  track(): () => void;
  /**
   * Begins (or, on a second call, re-returns) the drain: aborts `signal`
   * immediately, then waits for tracked work to release, up to `timeoutMs`.
   * Never rejects — a timeout resolves with `graceful: false` rather than
   * throwing, leaving the fatal/non-fatal call to the caller.
   */
  drain(): Promise<M3LDrainOutcome>;
}

/**
 * Rejects a `timeoutMs` that is not a positive integer within Node's
 * 32-bit signed timer bound. See {@link M3LDrainControllerOptions.timeoutMs}
 * for why this is not redundant with `config/env.ts`'s own bound.
 */
function validateTimeoutMs(timeoutMs: number): void {
  const isValid =
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS;
  if (!isValid) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_CONFIG_INVALID",
      `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS} (Node's max 32-bit signed timer delay); received ${timeoutMs}`,
    );
  }
}

/**
 * Non-exported {@link M3LDrainController} implementation. A class (mutating
 * `this` in each method) rather than closures over local `let`s, purely to
 * keep every operation its own short, independently readable method instead
 * of one long factory-function body.
 */
class DrainControllerImpl implements M3LDrainController {
  private drainState: M3LDrainState = "serving";
  private inFlightCount = 0;
  private drainPromise: Promise<M3LDrainOutcome> | undefined;
  private resolveDrain: ((outcome: M3LDrainOutcome) => void) | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private readonly abortController = new AbortController();
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(options: M3LDrainControllerOptions) {
    this.clock = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get state(): M3LDrainState {
    return this.drainState;
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  track(): () => void {
    if (this.drainState !== "serving") {
      throw new M3LConsoleError(
        "ERR_CONSOLE_UNAVAILABLE",
        `cannot track new work while the drain controller is "${this.drainState}"`,
      );
    }
    this.inFlightCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightCount -= 1;
      this.maybeFinishGraceful();
    };
  }

  drain(): Promise<M3LDrainOutcome> {
    if (this.drainPromise !== undefined) return this.drainPromise;

    // Abort first: in-flight consumers must observe cancellation before the
    // deadline timer even starts (order pinned by contract, not incidental).
    this.abortController.abort();
    this.drainState = "draining";
    this.startedAt = this.clock();

    this.drainPromise = new Promise<M3LDrainOutcome>((resolve) => {
      this.resolveDrain = resolve;
      if (this.inFlightCount === 0) {
        // Deferred to a microtask (not called synchronously here) so a
        // caller reading `state` right after `drain()` still observes
        // "draining" — the transition to "drained" is always asynchronous.
        queueMicrotask(() => {
          this.finishGraceful();
        });
        return;
      }
      this.deadlineTimer = setTimeout(() => {
        this.finishTimeout();
      }, this.timeoutMs);
    });

    return this.drainPromise;
  }

  /** Settles the pending drain promise exactly once, tearing down the deadline timer. */
  private settle(outcome: M3LDrainOutcome): void {
    this.drainState = "drained";
    if (this.deadlineTimer !== undefined) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer.unref();
      this.deadlineTimer = undefined;
    }
    const resolve = this.resolveDrain;
    this.resolveDrain = undefined;
    resolve?.(outcome);
  }

  private finishGraceful(): void {
    this.settle({
      graceful: true,
      abandoned: 0,
      durationMs: this.clock() - this.startedAt,
    });
  }

  private finishTimeout(): void {
    this.settle({
      graceful: false,
      abandoned: this.inFlightCount,
      durationMs: this.clock() - this.startedAt,
    });
  }

  /** Called after every release — resolves the drain the moment nothing is left in flight. */
  private maybeFinishGraceful(): void {
    if (this.drainState === "draining" && this.inFlightCount === 0) {
      this.finishGraceful();
    }
  }
}

/**
 * Builds a fresh {@link M3LDrainController}, starting `"serving"` with
 * nothing in flight.
 *
 * @param options - See {@link M3LDrainControllerOptions}.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_CONFIG_INVALID` when
 *   `timeoutMs` is not a positive integer within Node's timer bound.
 *
 * @example
 * ```ts
 * const controller = createDrainController({ timeoutMs: 5_000 });
 * const outcome = await controller.drain();
 * if (!outcome.graceful) {
 *   // outcome.abandoned tracked units never released in time
 * }
 * ```
 */
export function createDrainController(
  options: M3LDrainControllerOptions,
): M3LDrainController {
  validateTimeoutMs(options.timeoutMs);
  return new DrainControllerImpl(options);
}
