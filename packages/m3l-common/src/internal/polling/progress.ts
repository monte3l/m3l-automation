/**
 * `internal/polling/progress` — the shared stall tracker consumed by both
 * {@link M3LPoller} and {@link M3LRetryRunner} for the optional `progress`
 * no-progress guard. Extracted into one module so the counting semantics
 * exist in exactly one place rather than being duplicated across the two
 * primitives.
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

import { assertPositiveInteger } from "./guards.js";
import { M3LPollingInvalidOptionError } from "./errors.js";

/**
 * A cheap, comparable sample of external progress.
 *
 * Must be **cheap** (sampled once per continuing attempt, so any real cost
 * multiplies across the whole run) and **side-effect-free** (it exists to
 * observe progress, not to cause it). Must return a primitive — an object
 * witness would compare unequal on every call (each invocation returns a
 * fresh reference), so the guard would silently never fire.
 *
 * The library treats the witness as untrusted caller code: a throw is
 * wrapped in {@link M3LPollingInvalidOptionError} (never left to propagate
 * raw, and never allowed to replace an in-flight operation error), and a
 * non-primitive result (reachable when the witness is typed `any`, since the
 * declared return type cannot be enforced at runtime) is rejected the same
 * way instead of being silently compared.
 */
export type M3LProgressWitness = () => string | number | bigint | boolean;

/** Configuration for the shared no-progress guard. */
export interface ProgressWitnessConfig {
  /**
   * Sampled once per attempt that is about to continue. Must be cheap and
   * side-effect-free — see {@link M3LProgressWitness}. A throwing witness is
   * wrapped in {@link M3LPollingInvalidOptionError}; a non-primitive result
   * is rejected the same way rather than silently disabling the guard.
   */
  readonly witness: M3LProgressWitness;
  /**
   * Number of consecutive unchanged samples (after the baseline) that trip
   * the guard. Must be a finite integer greater than 0.
   */
  readonly maxStalledAttempts: number;
}

/**
 * Validate `progress` and capture it by value into a fresh object, isolated
 * from the caller's object.
 *
 * Each property is read off `progress` **exactly once** — into a local
 * `const` — and that same local is both what gets validated and what goes
 * into the returned copy. `progress` can be a getter- or Proxy-backed
 * object under caller control, and a getter/trap is free to return a
 * different value on every access; validating one read and then capturing a
 * second, separate read reproduces the exact "two observations of a mutable
 * caller graph" defect this helper exists to eliminate, just one level down.
 * `M3LPoller` and `M3LRetryRunner` each call this exactly once, at
 * construction, and store only the returned copy — never `options.progress`
 * itself — so mutating the caller's original object after construction
 * cannot change how a later call behaves.
 *
 * @param progress - The caller-supplied `progress` option, or `undefined`.
 * @returns A fresh, validated copy, or `undefined` when `progress` is
 *   `undefined`.
 * @throws {@link M3LPollingInvalidOptionError} when `maxStalledAttempts` is
 *   not a finite positive integer, or when `witness` is not a function.
 */
export function captureProgressConfig(
  progress: ProgressWitnessConfig | undefined,
): ProgressWitnessConfig | undefined {
  if (progress === undefined) {
    return undefined;
  }
  const maxStalledAttempts = progress.maxStalledAttempts;
  const witness = progress.witness;
  assertPositiveInteger(maxStalledAttempts, "maxStalledAttempts");
  if (typeof witness !== "function") {
    throw new M3LPollingInvalidOptionError(
      "progress.witness must be a function",
    );
  }
  return { witness, maxStalledAttempts };
}

/**
 * Per-call stall tracker. Instantiate one fresh instance inside each
 * `poll()`/`run()` call frame — never store it on the instance — so
 * concurrent calls on one {@link M3LPoller}/{@link M3LRetryRunner} track
 * progress independently.
 *
 * Owns both the witness and the threshold captured at construction, so
 * {@link record} takes no argument: a call site cannot accidentally sample a
 * different witness than the one this tracker's counter was seeded from.
 *
 * The first sample recorded establishes a baseline and never trips the
 * guard. Each later sample is compared against the previous one with
 * `Object.is`: an unchanged sample increments the internal stall counter, a
 * changed one resets it to `0`. The guard trips — {@link record} returns
 * `true` — the moment the counter reaches `maxStalledAttempts`, i.e. after
 * `maxStalledAttempts + 1` total samples.
 *
 * @example
 * ```ts
 * const tracker = new ProgressTracker({
 *   witness: () => pageToken ?? "",
 *   maxStalledAttempts: 3,
 * });
 * if (tracker.record()) {
 *   // guard tripped — reject with M3LNoProgressError
 * }
 * ```
 */
export class ProgressTracker {
  readonly #witness: M3LProgressWitness;
  readonly #maxStalledAttempts: number;
  #hasBaseline = false;
  #previous: unknown;
  #stalledAttempts = 0;

  constructor(config: ProgressWitnessConfig) {
    this.#witness = config.witness;
    this.#maxStalledAttempts = config.maxStalledAttempts;
  }

  /**
   * Sample the witness once and update the tracker.
   *
   * @returns `true` when the sample is the `maxStalledAttempts`-th
   *   consecutive unchanged observation (guard trips), `false` otherwise
   *   (including the baseline sample).
   * @throws {@link M3LPollingInvalidOptionError} when the witness throws (the
   *   thrown value is chained as `cause`), or when it returns a
   *   non-primitive value.
   */
  record(): boolean {
    const sample = this.#sample();

    if (!this.#hasBaseline) {
      this.#hasBaseline = true;
      this.#previous = sample;
      return false;
    }

    if (Object.is(sample, this.#previous)) {
      this.#stalledAttempts += 1;
    } else {
      this.#stalledAttempts = 0;
    }
    this.#previous = sample;

    return this.#stalledAttempts >= this.#maxStalledAttempts;
  }

  /** The number of consecutive unchanged samples observed so far. */
  get stalledAttempts(): number {
    return this.#stalledAttempts;
  }

  /**
   * Invoke the witness, treating it as untrusted caller code: a throw is
   * wrapped rather than left to propagate raw, and a non-primitive result is
   * rejected rather than silently compared (an object/function sample would
   * compare unequal — via `Object.is` — on every attempt, since each
   * invocation returns a fresh reference, so the guard would never fire).
   */
  #sample(): unknown {
    let sample: unknown;
    try {
      sample = this.#witness();
    } catch (cause) {
      throw new M3LPollingInvalidOptionError(
        "progress witness threw while sampling",
        { cause },
      );
    }
    // typeof null === "object", but null is caught by the same check and
    // rejected — it is not one of the documented primitive return types.
    if (typeof sample === "object" || typeof sample === "function") {
      throw new M3LPollingInvalidOptionError(
        "progress witness must return a primitive value (string, number, bigint, or boolean)",
      );
    }
    return sample;
  }
}
