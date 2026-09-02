/**
 * `flow/render` — the human (non-`--json`) rendering for
 * `m3l flow run <name>` and `m3l flow list`.
 *
 * Pure by contract: both exports take data and RETURN lines. Nothing here
 * writes, exactly as `cli/table.ts` stays a pure formatter while
 * `commands/*.ts` owns every `context.output` call. That split is what lets
 * the whole rendering be asserted without a writer double.
 *
 * The step table carries no `run-report.json` path on purpose: the path is
 * already in the `--json` envelope and in the persisted run record, and
 * repeating it here would push every row past a terminal width for no
 * operator benefit.
 *
 * @packageDocumentation
 */

import { formatAlignedTable } from "../cli/table.js";
import type { M3LCliFlowRunResult } from "./run.js";
import type { M3LCliFlowBranch, M3LCliFlowStepExecution } from "./types.js";

/**
 * What {@link formatFlowRunLines} needs beyond the run result: the run's id,
 * whether it was a dry run, and the guard value the run was bounded by.
 *
 * `maxStepExecutions` is a NUMBER rather than the whole definition: the
 * rendering reads exactly one field from it, and taking the definition would
 * couple the renderer to a shape it does not otherwise use (and drag
 * `flow/validate`'s whole type into a formatting module).
 *
 * @example
 * ```ts
 * const input: M3LCliFlowRenderInput = {
 *   runId,
 *   dryRun: false,
 *   maxStepExecutions: definition.maxStepExecutions,
 *   result,
 * };
 * ```
 */
export interface M3LCliFlowRenderInput {
  /** The run's own id. */
  readonly runId: string;
  /** Whether the run was a dry run. */
  readonly dryRun: boolean;
  /** The guard the run was bounded by, for the count and guard-trip lines. */
  readonly maxStepExecutions: number;
  /** What `flow/run` reported. */
  readonly result: M3LCliFlowRunResult;
}

/** The step table's column headers; the header line starts with `STEP`. */
const STEP_TABLE_HEADER: readonly string[] = [
  "STEP",
  "SCRIPT",
  "ATTEMPT",
  "EXIT",
  "OUTCOME",
  "BRANCH",
];

/** Stands in for a cell whose value is genuinely absent — never the text `null`. */
const ABSENT_CELL = "-";

/**
 * Renders one resolved branch as a table cell.
 *
 * A `{ goto }` becomes `goto <id>` rather than a bare id so a reader can tell
 * a jump target from the two literal branches at a glance.
 *
 * @param branch - The branch the step's outcome selected.
 * @returns The cell text.
 */
function formatBranchCell(branch: M3LCliFlowBranch): string {
  return typeof branch === "string" ? branch : `goto ${branch.goto}`;
}

/**
 * Renders one step execution as a table row, in {@link STEP_TABLE_HEADER}'s
 * column order.
 *
 * @param execution - One executed step.
 * @returns The row's six cells.
 */
function formatStepRow(execution: M3LCliFlowStepExecution): readonly string[] {
  return [
    execution.stepId,
    execution.script,
    String(execution.attempt),
    String(execution.exitCode),
    execution.outcome ?? ABSENT_CELL,
    formatBranchCell(execution.branch),
  ];
}

/**
 * Renders the run's identity line, carrying the dry-run marker when there is
 * one.
 *
 * The marker is upper-case and bracketed so it cannot be skimmed past — a dry
 * run that reads like a real one is the one rendering mistake that costs an
 * operator real confidence in the output.
 *
 * @param input - The render input.
 * @returns The identity line.
 */
function formatIdentityLine(input: M3LCliFlowRenderInput): string {
  const marker = input.dryRun ? "  [DRY RUN]" : "";
  return `flow ${input.result.flowName}  run ${input.runId}${marker}`;
}

/**
 * Renders the verdict lines: the status and exit code, the observed window,
 * the cumulative count against its guard, and — only when they exist — the
 * halting step, the resume point, and the tripped guard.
 *
 * The status literal is rendered VERBATIM (`loop-guard-exceeded` and all), so
 * the human surface and the `--json` surface name the same four outcomes and
 * an operator reading one can search the other.
 *
 * @param input - The render input.
 * @returns The verdict lines, in order.
 */
function formatVerdictLines(input: M3LCliFlowRenderInput): readonly string[] {
  const { result } = input;
  const lines: string[] = [
    `status ${result.status}  exit ${String(result.exitCode)}`,
    `window ${result.startedAt.toISOString()} -> ${result.finishedAt.toISOString()}  (${String(
      result.finishedAt.getTime() - result.startedAt.getTime(),
    )} ms)`,
    `steps ${String(result.stepExecutionCount)}/${String(
      input.maxStepExecutions,
    )}`,
  ];

  // A clean completion has no halting step worth naming: it ran out of steps
  // rather than stopping AT one.
  if (result.status !== "completed" && result.haltingStepId !== null) {
    lines.push(`halted at step '${result.haltingStepId}'`);
  }
  if (result.status === "loop-guard-exceeded") {
    // Names the knob, not just the symptom, so the line alone tells an
    // operator what to raise.
    lines.push(
      `loop guard: maxStepExecutions ${String(input.maxStepExecutions)} reached before the run finished`,
    );
  }
  if (result.resumeStepId !== null) {
    lines.push(`resume from step '${result.resumeStepId}'`);
  }
  return lines;
}

/**
 * Renders a finished flow run for a human reader.
 *
 * Pure: returns lines and performs no I/O, so `commands/flow.ts` owns every
 * `output` call and this whole rendering is assertable without a writer
 * double.
 *
 * The step table comes LAST and is omitted entirely when nothing ran — an
 * empty table would make a run that never dispatched a step look like one
 * whose steps all vanished.
 *
 * @param input - The run id, dry-run flag, guard value and run result.
 * @returns The lines to emit, each newline-free.
 *
 * @example
 * ```ts
 * for (const line of formatFlowRunLines(input)) {
 *   output.info(line);
 * }
 * ```
 */
export function formatFlowRunLines(
  input: M3LCliFlowRenderInput,
): readonly string[] {
  const lines: string[] = [
    formatIdentityLine(input),
    ...formatVerdictLines(input),
  ];

  if (input.result.stepExecutions.length === 0) {
    lines.push("no step ran");
    return lines;
  }
  lines.push(
    ...formatAlignedTable(
      STEP_TABLE_HEADER,
      input.result.stepExecutions.map(formatStepRow),
    ),
  );
  return lines;
}

/**
 * Renders the available flow names for a human reader, in the order given.
 *
 * Order is preserved rather than sorted here: `flow/load`'s `listFlows`
 * already decides the ordering, and re-sorting would silently override it.
 *
 * @param flowNames - The discovered flow names.
 * @returns One line per name, or a single explanatory line when there are
 *   none.
 *
 * @example
 * ```ts
 * for (const line of formatFlowListLines(listFlows(workspaceRoot))) {
 *   output.info(line);
 * }
 * ```
 */
export function formatFlowListLines(
  flowNames: readonly string[],
): readonly string[] {
  // An empty list says so: returning zero lines would render as silence, which
  // an operator cannot distinguish from a command that failed to run.
  return flowNames.length === 0 ? ["no flows found"] : [...flowNames];
}
