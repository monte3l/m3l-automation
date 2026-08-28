/**
 * `runs/registry` — `M3LRunRegistry`, the narrow run-persistence surface
 * `runs/orchestrator.ts` depends on.
 *
 * Declared here as a hand-written interface rather than importing
 * `M3LConsoleRunsRepository` wholesale (or `Pick`ing from it), so `runs/`
 * states its own requirement independently of the store's shape. The
 * repository additionally exposes `countByStatus`, `close()`, and
 * `transaction()` — none of which the orchestrator's launch/start/pump/cancel
 * logic ever needs — and a `Pick<M3LConsoleRunsRepository, ...>` alias would
 * still couple this module's compiled type to every future change of that
 * repository interface, even an addition the orchestrator never touches.
 * `M3LConsoleRunsRepository` structurally satisfies this port (proven by
 * `tests/runs-registry.test.ts`'s `expectTypeOf` conformance check), and the
 * real wiring in `main.ts` passing `store.runs` here is the compiler-checked
 * proof — exactly the way `buildDispatchRouter` proves `M3LConsoleStoreLifecycle`
 * conforms to `http/routes/health.ts`'s `M3LReadinessProbe`.
 *
 * @packageDocumentation
 */

import type {
  M3LRunFinish,
  M3LRunInsert,
  M3LRunListQuery,
  M3LRunRecord,
} from "../store/runs-repository.js";

/**
 * The narrow run-persistence port `runs/orchestrator.ts` depends on: enough
 * of `M3LConsoleRunsRepository` to insert, transition, read, and reconcile
 * runs, and nothing else.
 *
 * @example
 * ```ts
 * function isBusy(registry: M3LRunRegistry, script: string): boolean {
 *   return registry.countRunningForScript(script) > 0;
 * }
 * ```
 */
export interface M3LRunRegistry {
  /** Inserts a new `'queued'` run. */
  insertQueued(input: M3LRunInsert): void;
  /**
   * Guarded `queued` to `running` transition.
   *
   * @returns `true` when this call's own write applied (the run was
   *   `queued`); `false` when it was not (already running, already
   *   terminal, or unknown id) — a lost race reports `false`, never throws.
   */
  claimForStart(id: string, startedAtMs: number): boolean;
  /**
   * Guarded `running` to terminal transition.
   *
   * @returns `true` when this call's own write applied (the run was
   *   `running`); `false` when it was not (still queued, already terminal,
   *   or unknown id).
   */
  finish(id: string, result: M3LRunFinish): boolean;
  /** Reads one run by id, or `undefined` when no such row exists. */
  get(id: string): M3LRunRecord | undefined;
  /** Lists runs matching `query`, oldest-queued-first, up to `query.limit`. */
  list(query: M3LRunListQuery): readonly M3LRunRecord[];
  /** Counts currently-`running` rows for `script`. */
  countRunningForScript(script: string): number;
  /**
   * Transitions every `queued` and `running` row to `interrupted`.
   *
   * @returns The number of rows changed.
   */
  reconcileOrphaned(endedAtMs: number): number;
  /**
   * Guarded `queued` to `interrupted` transition, for a run that timed out
   * while still waiting in the queue — it never started, so `started_at_ms`
   * is deliberately left `NULL` rather than fabricated (see
   * `store/runs-repository.ts`'s own TSDoc for the full rationale).
   *
   * @returns `true` when this call's own write applied (the run was still
   *   `queued`); `false` when it was not (already started, already
   *   terminal, or unknown id) — a lost race reports `false`, never throws.
   */
  abandonQueued(id: string, endedAtMs: number): boolean;
}
