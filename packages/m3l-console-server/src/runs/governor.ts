/**
 * `runs/governor` — the X4 run-governor's admission-control seam: decides
 * whether a requested run may start immediately, must queue, or must be
 * rejected, against a per-script mutex and a global concurrency/queue
 * capacity.
 *
 * @packageDocumentation
 */

/**
 * Constructor options for {@link createRunGovernor}.
 *
 * @example
 * ```ts
 * const options: M3LRunGovernorOptions = {
 *   maxConcurrency: 4,
 *   maxPerScript: 1,
 *   queueCapacity: 16,
 * };
 * ```
 */
export interface M3LRunGovernorOptions {
  /** The maximum number of runs allowed to execute concurrently, across every script. */
  readonly maxConcurrency: number;
  /** The maximum number of concurrent runs allowed per script. */
  readonly maxPerScript: number;
  /** The maximum number of runs the queue may hold once every slot is busy. */
  readonly queueCapacity: number;
}

/**
 * The outcome of {@link M3LRunGovernor.decide} for one requested run:
 * `"accept"` (a slot is free), `"queue"` (every slot is busy but the queue
 * has room), or `"reject"` (every slot is busy and the queue is full).
 *
 * @example
 * ```ts
 * function describe(decision: M3LRunGovernorDecision): string {
 *   return decision.kind;
 * }
 * ```
 */
export interface M3LRunGovernorDecision {
  /** The admission-control verdict for the requested run. */
  readonly kind: "accept" | "queue" | "reject";
}

/**
 * The X4 run-governor's admission-control port: a per-script mutex layered
 * under a global concurrency cap and a bounded queue.
 *
 * {@link M3LRunGovernor.decide} is deliberately read-only — it never mutates
 * `activeCount`/`queuedCount` by itself. A caller must separately call
 * {@link M3LRunGovernor.accept} or {@link M3LRunGovernor.enqueue} to commit
 * the decision, and {@link M3LRunGovernor.release}/{@link M3LRunGovernor.dequeue}
 * to undo it. This split exists because the caller may need to do fallible
 * work (spawning a process, persisting a queue row) between deciding and
 * committing — a governor that mutated its own counters inside `decide`
 * could never be rolled back cleanly if that intervening work failed.
 *
 * @example
 * ```ts
 * import { createRunGovernor } from "@m3l-automation/m3l-console-server/runs/governor.js";
 *
 * const governor = createRunGovernor({
 *   maxConcurrency: 4,
 *   maxPerScript: 1,
 *   queueCapacity: 16,
 * });
 *
 * const decision = governor.decide("sqs-etl");
 * if (decision.kind === "accept") {
 *   governor.accept("sqs-etl");
 * }
 * ```
 */
export interface M3LRunGovernor {
  /**
   * Returns the admission-control verdict for a run of `scriptName`, without
   * mutating any counter.
   *
   * @param scriptName - The script the caller wants to run.
   * @returns `"accept"` when a global and per-script slot are both free,
   *   `"queue"` when every slot is busy but the queue has room, otherwise
   *   `"reject"`.
   */
  decide(scriptName: string): M3LRunGovernorDecision;
  /**
   * Commits an accepted run of `scriptName`, incrementing both the global
   * and the per-script active counters.
   *
   * @param scriptName - The script that was accepted.
   */
  accept(scriptName: string): void;
  /**
   * Releases a previously accepted run of `scriptName`, decrementing both
   * counters. A safe no-op when `scriptName` has no accepted run.
   *
   * @param scriptName - The script whose run has finished.
   */
  release(scriptName: string): void;
  /** Commits a queued run, incrementing {@link queuedCount}. */
  enqueue(): void;
  /** Releases a queued run, decrementing {@link queuedCount}. */
  dequeue(): void;
  /** The number of runs currently occupying a global concurrency slot. */
  readonly activeCount: number;
  /** The number of runs currently waiting in the queue. */
  readonly queuedCount: number;
}

/**
 * Creates an {@link M3LRunGovernor} enforcing `options`' concurrency and
 * queue limits.
 *
 * @param options - See {@link M3LRunGovernorOptions}.
 * @returns A fresh governor with every counter at zero.
 *
 * @example
 * ```ts
 * import { createRunGovernor } from "@m3l-automation/m3l-console-server/runs/governor.js";
 *
 * const governor = createRunGovernor({
 *   maxConcurrency: 4,
 *   maxPerScript: 1,
 *   queueCapacity: 16,
 * });
 * governor.decide("sqs-etl"); // { kind: "accept" }
 * ```
 */
export function createRunGovernor(
  options: M3LRunGovernorOptions,
): M3LRunGovernor {
  const activeByScript = new Map<string, number>();
  let activeCount = 0;
  let queuedCount = 0;

  return {
    decide(scriptName: string): M3LRunGovernorDecision {
      const scriptActiveCount = activeByScript.get(scriptName) ?? 0;
      if (
        activeCount < options.maxConcurrency &&
        scriptActiveCount < options.maxPerScript
      ) {
        return { kind: "accept" };
      }
      if (queuedCount < options.queueCapacity) {
        return { kind: "queue" };
      }
      return { kind: "reject" };
    },
    accept(scriptName: string): void {
      activeCount += 1;
      activeByScript.set(scriptName, (activeByScript.get(scriptName) ?? 0) + 1);
    },
    release(scriptName: string): void {
      const scriptActiveCount = activeByScript.get(scriptName);
      if (scriptActiveCount === undefined) return;
      activeCount -= 1;
      if (scriptActiveCount <= 1) {
        activeByScript.delete(scriptName);
      } else {
        activeByScript.set(scriptName, scriptActiveCount - 1);
      }
    },
    enqueue(): void {
      queuedCount += 1;
    },
    dequeue(): void {
      queuedCount -= 1;
    },
    get activeCount(): number {
      return activeCount;
    },
    get queuedCount(): number {
      return queuedCount;
    },
  };
}
