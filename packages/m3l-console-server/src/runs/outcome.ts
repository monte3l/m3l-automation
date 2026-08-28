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
}

/**
 * Maps a spawned script's {@link M3LSpawnExitInfo} onto
 * {@link Core.M3LRunOutcome}. `killRequested` takes priority over both
 * `exitCode` and `dryRun` — a run the operator asked to kill is always
 * `"interrupted"`, regardless of what exit code the killed process happened
 * to produce. Absent a kill request, a zero exit code in dry-run mode maps
 * to `"dry-run"`; a zero exit code otherwise maps to `"success"`; any other
 * exit code maps to `"failure"`.
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
  if (exit.killRequested) return "interrupted";
  if (exit.exitCode === 0 && exit.dryRun) return "dry-run";
  if (exit.exitCode === 0) return "success";
  return "failure";
}
