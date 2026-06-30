/**
 * `core/utils/M3LConcurrencyPool` — bounded concurrent task execution.
 *
 * Provides a concurrency-limited executor that processes an item list with at
 * most N tasks running in parallel, preserving input order in results.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Executes a list of items through a worker function with a bounded number of
 * concurrent tasks. Results are returned in input order, not completion order.
 *
 * Memory usage scales with `concurrency`, not `items.length` — tasks are
 * dispatched on demand as slots free up (demand-driven FIFO dispatch).
 *
 * Fail-fast semantics: if any worker rejects, the returned promise rejects
 * with that error (same behavior as `Promise.all`).
 *
 * @example
 * ```typescript
 * import { M3LConcurrencyPool } from "@m3l-automation/m3l-common/core";
 * const pool = new M3LConcurrencyPool(4);
 * const results = await pool.runEach(
 *   ["a", "b", "c"],
 *   async (item) => item.toUpperCase(),
 * );
 * // results === ["A", "B", "C"]
 * ```
 */
export class M3LConcurrencyPool {
  /** Maximum number of tasks that may run simultaneously. */
  private readonly concurrency: number;

  /**
   * Creates a new concurrency pool.
   *
   * @param concurrency - Maximum number of tasks that may run at any time.
   *   Must be a positive integer.
   */
  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new M3LError(
        `M3LConcurrencyPool: concurrency must be a positive integer, got ${String(concurrency)}`,
        { code: "ERR_INVALID_ARGUMENT" },
      );
    }
    this.concurrency = concurrency;
  }

  /**
   * Runs `worker` for each item in `items`, with at most `concurrency` tasks
   * in flight simultaneously. Results are returned in input order.
   *
   * @param items - The input items to process.
   * @param worker - An async function to execute for each item.
   * @returns A promise that resolves to an array of results in input order,
   *   or rejects on the first worker rejection.
   *
   * @example
   * ```typescript
   * import { M3LConcurrencyPool } from "@m3l-automation/m3l-common/core";
   * const pool = new M3LConcurrencyPool(4);
   * const doubled = await pool.runEach([1, 2, 3], async (n) => n * 2);
   * // doubled === [2, 4, 6]
   * ```
   */
  async runEach<T, R>(
    items: readonly T[],
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length) as R[];
    let nextIndex = 0;

    const runOne = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        // items[i] is safe: i < items.length is guaranteed by the while guard
        results[i] = await worker(items[i] as T);
      }
    };

    const runnerCount = Math.min(this.concurrency, items.length);
    const runners = Array.from({ length: runnerCount }, runOne);
    await Promise.all(runners);
    return results;
  }
}
