/**
 * `core/agent/ledger-types` — the caller-owned run ledger `evaluateAgentAction`
 * reads for budgets (step 3) and dry-run-first (step 6), and its structural
 * ceiling (ADR-0060, slice 2).
 *
 * @packageDocumentation
 */

/**
 * The observed state of the current run, handed to `evaluateAgentAction` so
 * step 3 can compare a declared budget's ceiling against what has already
 * happened, and step 6 can tell whether an action's shape has already been
 * dry-run.
 *
 * @remarks
 * Caller-owned and immutable: `evaluateAgentAction` reads it, never writes
 * it, and holds nothing between calls — advancing it after an approved
 * action is the caller's job, and passing a fresh object each time is what
 * keeps two concurrent runs from sharing a budget.
 *
 * `invocationsPerDay` needs all three of `invocationsToday`, `todayCountedAt`,
 * and `now` present together: the evaluator reads no clock itself, so the
 * caller samples `now` once and reports when `invocationsToday` was counted.
 * When the two timestamps fall in different UTC days, `invocationsToday` is
 * read as `0` — the window has rolled. See
 * docs/reference/core/agent.md § The per-day window for the full rule.
 *
 * Every numeric field must be a non-negative number (the integer fields —
 * everything but `costThisRun` — must additionally be safe integers), and
 * `dryRunCompletedShapes` must be a bounded, duplicate-free list of non-blank
 * strings; see {@link M3L_AGENT_MAX_DRY_RUN_SHAPES}.
 *
 * @example
 * ```ts
 * import type { M3LAgentRunLedger } from "@m3l-automation/m3l-common/core";
 *
 * const run: M3LAgentRunLedger = {
 *   invocationsThisRun: 3,
 *   dryRunCompletedShapes: [],
 *   now: Date.now(), // sampled by the CALLER, once
 * };
 * ```
 */
export interface M3LAgentRunLedger {
  /** Invocations already made in this run. */
  readonly invocationsThisRun?: number;
  /** Invocations already made today, as of {@link todayCountedAt}. */
  readonly invocationsToday?: number;
  /** The epoch-millisecond instant {@link invocationsToday} was counted at. */
  readonly todayCountedAt?: number;
  /** The current instant, sampled once by the caller for this evaluation. */
  readonly now?: number;
  /** Tokens already spent in this run. */
  readonly tokensThisRun?: number;
  /** Cost already spent in this run, in the deployment's own unit. */
  readonly costThisRun?: number;
  /** Loop iterations already performed in this run. */
  readonly loopIterations?: number;
  /** The dry-run shape keys already exercised in this run. */
  readonly dryRunCompletedShapes?: readonly string[];
}

/**
 * The ceiling on {@link M3LAgentRunLedger.dryRunCompletedShapes}.
 *
 * A **reject-above** bound, like every other structural ceiling on this
 * module: `length > 256` throws `M3LAgentActionValidationError`,
 * `length === 256` is accepted. The list is never truncated — silently
 * dropping a completed shape would silently reintroduce the dry-run-first
 * requirement for a shape the caller already cleared.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_MAX_DRY_RUN_SHAPES } from "@m3l-automation/m3l-common/core";
 *
 * const withinBound = (shapes: readonly string[]): boolean =>
 *   shapes.length <= M3L_AGENT_MAX_DRY_RUN_SHAPES;
 * ```
 */
export const M3L_AGENT_MAX_DRY_RUN_SHAPES = 256;
