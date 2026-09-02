/**
 * `flow/run` — the step loop. Executes from the first declared step (or an
 * injected resume-from step id), follows each step's classified branch,
 * enforces the cumulative step-execution guard, and reports the deciding
 * step's exit code unchanged.
 *
 * Performs NO I/O of its own: it returns data, and `flow/record` is what
 * builds and persists a run record from it. That split is what lets the whole
 * branching algebra be tested without a filesystem.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import { suggestNames } from "../cli/suggest.js";
import { classifyStepBranch } from "./classify.js";
import { executeFlowStep } from "./step.js";
import type {
  M3LCliFlowStepContext,
  M3LCliFlowStepOptions,
  M3LCliFlowStepResult,
} from "./step.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowDefinition,
  M3LCliFlowRunStatus,
  M3LCliFlowStep,
  M3LCliFlowStepOutcome,
} from "./types.js";

/**
 * Injectable seams and run-level switches {@link runFlow} accepts.
 *
 * `resumeFromStepId` and `stepExecutionCount` are the resume ports. U10 ships
 * no `--resume` flag — U11 does — but the engine is built with the seam so
 * resume is a wiring change rather than a redesign of the loop.
 *
 * @example
 * ```ts
 * const options: M3LCliFlowRunOptions = { dryRun: true };
 * ```
 */
export interface M3LCliFlowRunOptions {
  /** Overrides the wall-clock read bounding the RUN's window; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** The flow-level dry-run flag, forwarded to every step as its floor; defaults to `false`. */
  readonly dryRun?: boolean;
  /** The step id to start at instead of the first declared step. */
  readonly resumeFromStepId?: string;
  /** The step-execution count already spent by earlier runs, seeding the guard. */
  readonly stepExecutionCount?: number;
  /** Forwarded to every step's own `spawnImpl` seam. */
  readonly spawnImpl?: M3LCliFlowStepOptions["spawnImpl"];
  /** Forwarded to every step's own `stderrStream` seam. */
  readonly stderrStream?: M3LCliFlowStepOptions["stderrStream"];
  /** Forwarded to every step's own `importModule` seam. */
  readonly importModule?: M3LCliFlowStepOptions["importModule"];
}

/**
 * What a flow run produced: how it ended, with which exit code, and the
 * per-execution trail behind that verdict.
 *
 * `stepExecutionCount` is CUMULATIVE (it includes any seeded count from an
 * earlier run) while `stepExecutions` holds only THIS run's executions —
 * that asymmetry is deliberate and is what stops a resume from silently
 * resetting the loop guard.
 *
 * @example
 * ```ts
 * function shouldRetry(result: M3LCliFlowRunResult): boolean {
 *   return result.resumeStepId !== null;
 * }
 * ```
 */
export interface M3LCliFlowRunResult {
  /** The flow's name. */
  readonly flowName: string;
  /** How the run ended. */
  readonly status: M3LCliFlowRunStatus;
  /** The deciding step's exit code, verbatim — or `CONFIG_USAGE` on a guard trip. */
  readonly exitCode: number;
  /** When the run was observed to start. */
  readonly startedAt: Date;
  /** When the run was observed to finish. */
  readonly finishedAt: Date;
  /** Cumulative step executions, including any seeded count. */
  readonly stepExecutionCount: number;
  /** The step the run ended at, or `null` when no step was reached at all. */
  readonly haltingStepId: string | null;
  /** Where a follow-up run should resume, or `null` when there is nothing to resume. */
  readonly resumeStepId: string | null;
  /**
   * This run's own executions, in order — the RICH in-memory shape, carrying
   * each step's own observed window. `flow/record` projects these down to the
   * JSON-safe persisted shape; `flow/envelope` needs the windows intact to
   * compose one nested run envelope per step.
   */
  readonly stepExecutions: readonly M3LCliFlowStepOutcome[];
}

/**
 * Resolves the index into `definition.steps` the run starts at.
 *
 * @param definition - The flow definition.
 * @param resumeFromStepId - The requested resume-from step id, if any.
 * @returns The starting index, or `-1` when the definition declares no steps.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_FLOW_STEP` when
 *   `resumeFromStepId` names no declared step, carrying near-miss
 *   `suggestions` from the ids that exist.
 */
function resolveStartIndex(
  definition: M3LCliFlowDefinition,
  resumeFromStepId: string | undefined,
): number {
  if (resumeFromStepId === undefined) {
    return definition.steps.length > 0 ? 0 : -1;
  }
  const index = definition.steps.findIndex(
    (step) => step.id === resumeFromStepId,
  );
  if (index < 0) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_FLOW_STEP",
      `flow '${definition.name}' declares no step '${resumeFromStepId}'`,
      {
        suggestions: suggestNames(
          resumeFromStepId,
          definition.steps.map((step) => step.id),
        ),
      },
    );
  }
  return index;
}

/**
 * Resolves the index a `{ goto }` branch jumps to.
 *
 * @param definition - The flow definition.
 * @param stepId - The branch's target step id.
 * @param fromStepId - The step whose branch is being followed, for the message.
 * @returns The target's index into `definition.steps`.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_INVALID` when the target is
 *   undeclared. `flow/validate` guarantees every `goto` resolves, but the
 *   DEFINITION TYPE admits a hand-built literal with a dangling target;
 *   halting silently would misreport that as a normal completion.
 */
function resolveGotoIndex(
  definition: M3LCliFlowDefinition,
  stepId: string,
  fromStepId: string,
): number {
  const index = definition.steps.findIndex((step) => step.id === stepId);
  if (index < 0) {
    throw new M3LCliError(
      "ERR_CLI_FLOW_INVALID",
      `flow '${definition.name}' step '${fromStepId}' branches to undeclared step '${stepId}'`,
    );
  }
  return index;
}

/**
 * How the loop below stopped iterating — the input, alongside the deciding
 * exit code, to the run's final {@link M3LCliFlowRunStatus}.
 */
type LoopHalt = "steps-exhausted" | "branch-stop" | "loop-guard";

/**
 * Resolves the run's status from how the loop halted and the deciding step's
 * exit code.
 *
 * A guard trip outranks everything (the run never reached its own verdict). A
 * non-zero deciding exit code is `failed` even when the author's branch said
 * `"stop"` — `stopped` is reserved for a deliberate, clean halt, so it always
 * carries exit code 0.
 *
 * @param halt - How the loop stopped iterating.
 * @param exitCode - The deciding (last executed) step's exit code.
 * @returns The run's status.
 */
function resolveStatus(halt: LoopHalt, exitCode: number): M3LCliFlowRunStatus {
  if (halt === "loop-guard") {
    return "loop-guard-exceeded";
  }
  if (exitCode !== Core.M3L_EXIT_CODES.SUCCESS) {
    return "failed";
  }
  return halt === "branch-stop" ? "stopped" : "completed";
}

/**
 * What the step loop produced, before a status is resolved from it.
 */
interface FlowLoopOutcome {
  /** How the loop stopped iterating. */
  readonly halt: LoopHalt;
  /** The cumulative step-execution count, seeded value included. */
  readonly stepExecutionCount: number;
  /** The step the loop ended at, or `null` when it never reached one. */
  readonly haltingStepId: string | null;
  /** The deciding (last executed) step's exit code. */
  readonly exitCode: number;
  /** This run's own executions, in order, with each step's observed window. */
  readonly stepExecutions: readonly M3LCliFlowStepOutcome[];
}

/**
 * Projects {@link M3LCliFlowRunOptions}' mechanism seams onto the per-step
 * options object, omitting each absent one so `exactOptionalPropertyTypes`
 * stays satisfied and a downstream `in`/`hasOwnProperty` probe cannot see a
 * key that was never supplied.
 *
 * `now` is always present: the loop's resolved clock IS every step's clock, so
 * one scripted clock drives the whole run deterministically.
 *
 * @param options - The run options as given.
 * @param now - The run's resolved clock.
 * @returns The options every step execution is invoked with.
 */
function buildStepOptions(
  options: M3LCliFlowRunOptions,
  now: () => Date,
): M3LCliFlowStepOptions {
  return {
    now,
    ...(options.spawnImpl !== undefined
      ? { spawnImpl: options.spawnImpl }
      : {}),
    ...(options.stderrStream !== undefined
      ? { stderrStream: options.stderrStream }
      : {}),
    ...(options.importModule !== undefined
      ? { importModule: options.importModule }
      : {}),
  };
}

/**
 * Assembles the loop's per-execution record from the step that ran, the
 * attempt number, what the mechanism reported, and the branch its outcome
 * selected.
 *
 * Extracted purely so {@link runStepLoop} stays readable at a glance: the
 * observed window and the unavailable reason are carried through here rather
 * than at the push site, where they made the loop body's control flow harder
 * to follow than the assembly it interrupted.
 *
 * Every field comes from `stepResult` verbatim — nothing is recomputed, and in
 * particular the window is the one `flow/step` observed for THIS execution,
 * never the run's own.
 *
 * @param step - The step that ran.
 * @param attempt - Which attempt of this step id this was.
 * @param stepResult - What the step execution reported.
 * @param branch - The branch that outcome selected.
 * @returns The execution record to append to the run's trail.
 */
function buildStepOutcome(
  step: M3LCliFlowStep,
  attempt: number,
  stepResult: M3LCliFlowStepResult,
  branch: M3LCliFlowBranch,
): M3LCliFlowStepOutcome {
  return {
    stepId: step.id,
    script: step.script,
    attempt,
    exitCode: stepResult.exitCode,
    outcome: stepResult.outcome,
    reportPath: stepResult.reportPath,
    branch,
    startedAt: stepResult.startedAt,
    finishedAt: stepResult.finishedAt,
    reportUnavailable: stepResult.reportUnavailable,
  };
}

/**
 * Walks the steps from `startIndex`, executing and branching until a step
 * says `"stop"`, the declared list runs out, or the loop guard refuses the
 * next execution.
 *
 * The guard is checked BEFORE dispatch, so the refused step never runs, and
 * against the CUMULATIVE count (`seededStepExecutionCount` included) — that is
 * what stops a resume from silently resetting the bound.
 *
 * @param context - Forwarded to every step unchanged.
 * @param definition - The flow being run.
 * @param startIndex - The index into `definition.steps` to start at; a
 *   negative value executes nothing.
 * @param seededStepExecutionCount - Executions already spent by earlier runs.
 * @param flowDryRun - The flow-level dry-run floor.
 * @param stepOptions - The seams every step execution is invoked with.
 * @returns What the loop produced.
 * @throws Whatever a step execution throws, unchanged; {@link M3LCliError}
 *   coded `ERR_CLI_FLOW_INVALID` on a dangling `{ goto }` target.
 */
async function runStepLoop(
  context: M3LCliFlowStepContext,
  definition: M3LCliFlowDefinition,
  startIndex: number,
  seededStepExecutionCount: number,
  flowDryRun: boolean,
  stepOptions: M3LCliFlowStepOptions,
): Promise<FlowLoopOutcome> {
  const stepExecutions: M3LCliFlowStepOutcome[] = [];
  const attemptsByStepId = new Map<string, number>();
  let index = startIndex;
  let stepExecutionCount = seededStepExecutionCount;
  let haltingStepId: string | null = null;
  let exitCode: number = Core.M3L_EXIT_CODES.SUCCESS;
  let halt: LoopHalt = "steps-exhausted";

  while (index >= 0 && index < definition.steps.length) {
    const step: M3LCliFlowStep | undefined = definition.steps[index];
    /* istanbul ignore next -- unreachable: the loop condition already bounds
       `index` to a real element; this narrows `noUncheckedIndexedAccess`'s
       `undefined` without a non-null assertion. */
    if (step === undefined) {
      break;
    }

    if (stepExecutionCount >= definition.maxStepExecutions) {
      haltingStepId = step.id;
      halt = "loop-guard";
      break;
    }

    const stepResult = await executeFlowStep(
      context,
      step,
      flowDryRun,
      stepOptions,
    );
    stepExecutionCount += 1;
    const attempt = (attemptsByStepId.get(step.id) ?? 0) + 1;
    attemptsByStepId.set(step.id, attempt);

    const branch = classifyStepBranch(step, {
      exitCode: stepResult.exitCode,
      outcome: stepResult.outcome,
    });
    stepExecutions.push(buildStepOutcome(step, attempt, stepResult, branch));
    haltingStepId = step.id;
    exitCode = stepResult.exitCode;

    if (branch === "stop") {
      halt = "branch-stop";
      break;
    }
    index =
      branch === "continue"
        ? index + 1
        : resolveGotoIndex(definition, branch.goto, step.id);
  }

  return { halt, stepExecutionCount, haltingStepId, exitCode, stepExecutions };
}

/**
 * Runs `definition`'s steps to a verdict.
 *
 * **Ordering.** Execution starts at the first declared step (or
 * `options.resumeFromStepId`) and follows each step's classified branch:
 * `"continue"` advances to the next DECLARED step (falling off the end is a
 * normal completion, not an error), `"stop"` halts, and `{ goto }` jumps —
 * forward, backward, or to the step itself. A backward jump is a legitimate
 * retry loop; nothing but the guard bounds it.
 *
 * **The guard.** The run admits exactly `definition.maxStepExecutions`
 * executions and refuses the one that would be #(max + 1), checked BEFORE
 * dispatch so the refused step never runs. That halts the run with
 * `CONFIG_USAGE` (2) and status `loop-guard-exceeded`. A resume SEEDS the
 * count from `options.stepExecutionCount`, so re-entering the engine cannot
 * silently reset the bound.
 *
 * **The exit code.** The deciding step is the LAST EXECUTED step, and it owns
 * the flow's exit code — propagated unclamped and unremapped (4 stays 4, 137
 * stays 137). So a step exiting 3 whose `onFailure` is `"continue"`, followed
 * by a step exiting 0, yields exit 0 and status `completed`: the author
 * deliberately absorbed that failure.
 *
 * A step's rejection propagates UNCHANGED and aborts the loop — it is already
 * a typed {@link M3LCliError}, and no partial run result can honestly describe
 * an execution that never completed.
 *
 * @param context - Forwarded to every step unchanged.
 * @param definition - The validated flow to run.
 * @param options - Optional dry-run flag, resume ports, clock and mechanism
 *   seams.
 * @returns The run's verdict and per-execution trail.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_FLOW_STEP` when
 *   `options.resumeFromStepId` names no declared step; coded
 *   `ERR_CLI_FLOW_INVALID` when a `{ goto }` names no declared step;
 *   whatever a step execution throws, unchanged.
 *
 * @example
 * ```ts
 * const result = await runFlow(context, definition, { dryRun: true });
 * // { status: "completed", exitCode: 0, stepExecutionCount: 3, … }
 * ```
 */
export async function runFlow(
  context: M3LCliFlowStepContext,
  definition: M3LCliFlowDefinition,
  options: M3LCliFlowRunOptions = {},
): Promise<M3LCliFlowRunResult> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const outcome = await runStepLoop(
    context,
    definition,
    resolveStartIndex(definition, options.resumeFromStepId),
    options.stepExecutionCount ?? 0,
    options.dryRun ?? false,
    buildStepOptions(options, now),
  );

  const status = resolveStatus(outcome.halt, outcome.exitCode);
  return {
    flowName: definition.name,
    status,
    // A guard trip is the engine's own verdict, not the step's: the refused
    // execution never ran, so there is no step exit code to propagate.
    exitCode:
      status === "loop-guard-exceeded"
        ? Core.M3L_EXIT_CODES.CONFIG_USAGE
        : outcome.exitCode,
    startedAt,
    finishedAt: now(),
    stepExecutionCount: outcome.stepExecutionCount,
    haltingStepId: outcome.haltingStepId,
    // Only a run that did not reach a clean end has somewhere to resume from.
    resumeStepId:
      status === "failed" || status === "loop-guard-exceeded"
        ? outcome.haltingStepId
        : null,
    stepExecutions: outcome.stepExecutions,
  };
}
