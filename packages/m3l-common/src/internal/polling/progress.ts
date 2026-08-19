/**
 * `internal/polling/progress` — the shared stall tracker consumed by both
 * {@link M3LPoller} and {@link M3LRetryRunner} for the optional `progress`
 * no-progress guard. Extracted into one module so the counting semantics
 * exist in exactly one place rather than being duplicated across the two
 * primitives.
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

/**
 * A cheap, comparable sample of external progress. Must return a primitive —
 * an object witness would compare unequal on every call (each invocation
 * returns a fresh reference), so the guard would silently never fire.
 */
export type M3LProgressWitness = () => string | number | bigint | boolean;

/** Configuration for the shared no-progress guard. */
export interface ProgressWitnessConfig {
  /** Sampled once per attempt that is about to continue. */
  readonly witness: M3LProgressWitness;
  /**
   * Number of consecutive unchanged samples (after the baseline) that trip
   * the guard. Must be a finite integer greater than 0.
   */
  readonly maxStalledAttempts: number;
}

/**
 * Per-call stall tracker. Instantiate one fresh instance inside each
 * `poll()`/`run()` call frame — never store it on the instance — so
 * concurrent calls on one {@link M3LPoller}/{@link M3LRetryRunner} track
 * progress independently.
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
 * if (tracker.record(witness)) {
 *   // guard tripped — reject with M3LNoProgressError
 * }
 * ```
 */
export class ProgressTracker {
  readonly #maxStalledAttempts: number;
  #hasBaseline = false;
  #previous: string | number | bigint | boolean | undefined;
  #stalledAttempts = 0;

  constructor(config: ProgressWitnessConfig) {
    this.#maxStalledAttempts = config.maxStalledAttempts;
  }

  /**
   * Sample `witness` once and update the tracker.
   *
   * @param witness - The progress witness to sample.
   * @returns `true` when the sample is the `maxStalledAttempts`-th
   *   consecutive unchanged observation (guard trips), `false` otherwise
   *   (including the baseline sample).
   */
  record(witness: M3LProgressWitness): boolean {
    const sample = witness();

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
}
