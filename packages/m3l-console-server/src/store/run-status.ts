/**
 * `store/run-status` — the closed run-status vocabulary the `console_runs`
 * table's `status TEXT NOT NULL CHECK (status IN (...))` constraint is built
 * from (X4 run-registry, slice 3).
 *
 * This lives in `store/` rather than a later `runs/` module because
 * persistence owns the `CHECK` constraint that enforces this vocabulary —
 * the vocabulary belongs next to the constraint it drives, and a later
 * `runs/` repository slice imports it from here rather than the other way
 * round.
 *
 * The single most important guarantee here: {@link M3LRunTerminalStatus} is
 * deliberately **identity-mapped** to `Core.M3LRunOutcome`
 * (`core/diagnostics/run-report.ts`), not a hand-copied console-local union.
 * The library's run reporter, the CLI, and this console registry all share
 * one outcome vocabulary specifically so there is no translation table
 * between them to drift out of sync. A type-level test asserts this identity
 * — so if the library ever widens `M3LRunOutcome`, that assertion breaks
 * loudly at compile time here, instead of silently leaving this table's
 * `CHECK` constraint blind to a new value the library now emits.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

/**
 * A run that has not yet reached a terminal outcome: queued for execution,
 * or actively running.
 *
 * @example
 * ```ts
 * const status: M3LRunPendingStatus = "queued";
 * ```
 */
export type M3LRunPendingStatus = "queued" | "running";

/**
 * A run's terminal outcome. Identity-mapped to `Core.M3LRunOutcome` — see
 * this module's own `@packageDocumentation` block for why this is not a
 * console-local copy.
 *
 * @example
 * ```ts
 * const status: M3LRunTerminalStatus = "success";
 * ```
 */
export type M3LRunTerminalStatus = Core.M3LRunOutcome;

/**
 * The full run-status vocabulary: every {@link M3LRunPendingStatus} plus
 * every {@link M3LRunTerminalStatus}. Exactly what `console_runs.status`'s
 * `CHECK` constraint allows.
 *
 * @example
 * ```ts
 * const status: M3LRunStatus = "running";
 * ```
 */
export type M3LRunStatus = M3LRunPendingStatus | M3LRunTerminalStatus;

/**
 * Every {@link M3LRunPendingStatus} member, in a fixed, documented order.
 * This order (not object-key iteration) is what {@link RUN_STATUSES} and
 * {@link runStatusCheckList} derive from, so the migration's digested SQL
 * stays byte-identical across runs.
 *
 * @example
 * ```ts
 * for (const status of RUN_PENDING_STATUSES) {
 *   console.log(status);
 * }
 * ```
 */
export const RUN_PENDING_STATUSES: readonly M3LRunPendingStatus[] = [
  "queued",
  "running",
];

/**
 * Every {@link M3LRunTerminalStatus} member — i.e. every `Core.M3LRunOutcome`
 * member — in a fixed, documented order matching `run-report.ts`'s own
 * declaration order.
 *
 * @example
 * ```ts
 * for (const status of RUN_TERMINAL_STATUSES) {
 *   console.log(status);
 * }
 * ```
 */
export const RUN_TERMINAL_STATUSES: readonly M3LRunTerminalStatus[] = [
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
];

/**
 * Every {@link M3LRunStatus} member: {@link RUN_PENDING_STATUSES} followed by
 * {@link RUN_TERMINAL_STATUSES}, in that fixed order. Never built by
 * iterating an object's keys — object key order is not a contract this
 * vocabulary can safely depend on, whereas concatenating these two arrays is
 * stable and explicit.
 *
 * @example
 * ```ts
 * RUN_STATUSES.length; // 7
 * ```
 */
export const RUN_STATUSES: readonly M3LRunStatus[] = [
  ...RUN_PENDING_STATUSES,
  ...RUN_TERMINAL_STATUSES,
];

/** The set backing {@link isRunStatus}'s O(1) membership check. */
const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

/** The set backing {@link isTerminalRunStatus}'s O(1) membership check. */
const RUN_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(
  RUN_TERMINAL_STATUSES,
);

/**
 * Type guard — narrows an unknown value to {@link M3LRunStatus}.
 *
 * @param value - Any value to check.
 * @returns `true` when `value` is a string matching one of
 *   {@link RUN_STATUSES}' members.
 *
 * @example
 * ```ts
 * isRunStatus("queued"); // true
 * isRunStatus("done"); // false
 * ```
 */
export function isRunStatus(value: unknown): value is M3LRunStatus {
  return typeof value === "string" && RUN_STATUS_SET.has(value);
}

/**
 * Type guard — narrows an unknown value to {@link M3LRunTerminalStatus}.
 *
 * @param value - Any value to check.
 * @returns `true` when `value` is a string matching one of
 *   {@link RUN_TERMINAL_STATUSES}' members. Returns `false` for a valid
 *   pending status (`"queued"` / `"running"`), which is a member of
 *   {@link M3LRunStatus} but never of {@link M3LRunTerminalStatus}.
 *
 * @example
 * ```ts
 * isTerminalRunStatus("success"); // true
 * isTerminalRunStatus("queued"); // false
 * ```
 */
export function isTerminalRunStatus(
  value: unknown,
): value is M3LRunTerminalStatus {
  return typeof value === "string" && RUN_TERMINAL_STATUS_SET.has(value);
}

/**
 * Builds the `status IN (...)` SQL fragment for `console_runs`' `CHECK`
 * constraint, derived from {@link RUN_STATUSES} rather than a hand-typed
 * literal list — so the vocabulary is declared exactly once.
 *
 * **Deterministic by construction, and this determinism is load-bearing.**
 * The returned fragment is embedded verbatim in `store/migrations/registry.ts`'s
 * v3 `statements`, which `store/migrations/runner.ts` digests for drift
 * detection at every store open. This function derives its output solely
 * from {@link RUN_STATUSES} (a plain array in a fixed, documented order),
 * never from `Object.keys`/`for...in` over a plain object — object key
 * iteration order is not part of this vocabulary's contract, and a
 * non-deterministic fragment would change the migration's digest between
 * runs, tripping a false `ERR_CONSOLE_STORE_SCHEMA_DRIFT` at boot on every
 * already-migrated deployment.
 *
 * @returns The literal string `status IN ('queued', 'running', ...)`,
 *   byte-identical across every call.
 *
 * @example
 * ```ts
 * runStatusCheckList();
 * // "status IN ('queued', 'running', 'success', 'failure', 'dry-run', 'interrupted', 'partial')"
 * ```
 */
export function runStatusCheckList(): string {
  return `status IN (${RUN_STATUSES.map((status) => `'${status}'`).join(", ")})`;
}
