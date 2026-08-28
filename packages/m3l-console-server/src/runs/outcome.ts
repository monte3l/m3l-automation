/**
 * `runs/outcome` — maps a spawned script's exit info onto
 * `Core.M3LRunOutcome`, the same terminal-outcome vocabulary
 * `core/diagnostics` uses for an in-process run.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

/**
 * The observed outcome of a spawned script process, before it is mapped onto
 * {@link Core.M3LRunOutcome}.
 *
 * @example
 * ```ts
 * const exit: M3LSpawnExitInfo = {
 *   exitCode: 0,
 *   killRequested: false,
 *   dryRun: false,
 * };
 * ```
 */
export interface M3LSpawnExitInfo {
  /** The process's exit code. */
  readonly exitCode: number;
  /** Whether the run governor requested this process be killed. */
  readonly killRequested: boolean;
  /** Whether the run executed in dry-run mode. */
  readonly dryRun: boolean;
  /**
   * The run's terminal outcome, when the executor already knows it directly
   * from the source of truth (e.g. an in-process command's own
   * `M3LCommandOutcome.status`), rather than only through the wire-level
   * facts above. An exit code and a kill flag cannot express every member of
   * {@link Core.M3LRunOutcome} — `"partial"` has no dedicated exit-code
   * convention, and a self-reported `"interrupted"` can arrive without the
   * caller's own signal having been aborted. Set this instead of
   * round-tripping through {@link mapSpawnOutcome}'s exit-code derivation;
   * leave it absent when the executor genuinely has nothing beyond an exit
   * code and a kill signal to report (e.g. a spawned child process).
   */
  readonly outcome?: Core.M3LRunOutcome;
}

/**
 * Maps a spawned script's {@link M3LSpawnExitInfo} onto
 * {@link Core.M3LRunOutcome}.
 *
 * Precedence: when `exit.outcome` is present, it wins outright and none of
 * the derivation rules below run — the executor that set it already knows
 * its own terminal status and there is nothing to re-derive. When it is
 * absent (as it always is for a spawned child process, which communicates
 * only through an exit code and a kill signal — derivation is all it can
 * offer), the existing exit-code rules apply unchanged: `killRequested`
 * takes priority over both `exitCode` and `dryRun` — a run the operator
 * asked to kill is always `"interrupted"`, regardless of what exit code the
 * killed process happened to produce. Absent a kill request, a zero exit
 * code in dry-run mode maps to `"dry-run"`; a zero exit code otherwise maps
 * to `"success"`; any other exit code maps to `"failure"`.
 *
 * @param exit - The spawned process's observed exit info.
 * @returns The mapped {@link Core.M3LRunOutcome}.
 *
 * @example
 * ```ts
 * import { mapSpawnOutcome } from "./runs/outcome.js";
 *
 * mapSpawnOutcome({ exitCode: 0, killRequested: false, dryRun: false });
 * // "success"
 * ```
 */
export function mapSpawnOutcome(exit: M3LSpawnExitInfo): Core.M3LRunOutcome {
  if (exit.outcome !== undefined) return exit.outcome;
  if (exit.killRequested) return "interrupted";
  if (exit.exitCode === 0 && exit.dryRun) return "dry-run";
  if (exit.exitCode === 0) return "success";
  return "failure";
}
