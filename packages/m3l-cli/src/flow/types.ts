/**
 * `flow/types` — the ratified `m3l flow` definition format: the shape a
 * validated `data/config/flows/<name>.yaml` document narrows to, plus the
 * literal constants its rules are expressed in terms of.
 *
 * Types only, no behaviour: `flow/validate` narrows a raw document into these
 * shapes and `flow/load` supplies the document. Keeping the shapes in their
 * own module lets the (pure) validator and the (I/O-bound) loader share them
 * without either importing the other.
 *
 * @packageDocumentation
 */

import type {
  M3LCliRunOutcome,
  M3LCliRunReportUnavailableReason,
} from "../run/envelope.js";

/**
 * How a step's script is executed. `auto` defers the choice to the engine;
 * the validator preserves whichever literal the author wrote, so a run record
 * can report the declared intent rather than the resolved mechanism.
 *
 * @example
 * ```ts
 * const execution: M3LCliFlowExecution = "spawn";
 * ```
 */
export type M3LCliFlowExecution = "auto" | "in-process" | "spawn";

/**
 * Where a flow goes after a step outcome: on to the next declared step
 * (`"continue"`), no further steps (`"stop"`), or to a named step
 * (`{ goto }`). A `goto` may name a later step, an earlier step, or the
 * step's own id — a backward jump is a legitimate retry loop, bounded by
 * {@link M3LCliFlowDefinition.maxStepExecutions} rather than by the format.
 *
 * @example
 * ```ts
 * const onFailure: M3LCliFlowBranch = { goto: "dump" };
 * ```
 */
export type M3LCliFlowBranch = "continue" | "stop" | { readonly goto: string };

/**
 * One validated step of a flow: which script to run, with which parameters,
 * and where each outcome leads. Every optional-in-the-file key has been
 * resolved to a concrete value here, so a consumer never re-applies defaults.
 *
 * @example
 * ```ts
 * const step: M3LCliFlowStep = {
 *   id: "dump",
 *   script: "sqs-etl",
 *   parameters: { command: "dump", output: "data/output/dump.jsonl" },
 *   execution: "spawn",
 *   onSuccess: "continue",
 *   onFailure: "stop",
 *   onPartial: "stop",
 * };
 * ```
 */
export interface M3LCliFlowStep {
  /** The step's flow-unique id, matching {@link FLOW_STEP_ID_RE}. */
  readonly id: string;
  /** The script to run — a name the validating context knows. */
  readonly script: string;
  /**
   * The parameter values to pass, keyed by a name that script declares.
   * Deliberately opaque (`unknown` values): per-parameter type coercion is
   * the script's own schema's job, not the flow format's.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** The declared execution mode; `"auto"` when the file omitted it. */
  readonly execution: M3LCliFlowExecution;
  /** Where a successful step leads; `"continue"` when the file omitted it. */
  readonly onSuccess: M3LCliFlowBranch;
  /** Where a failed step leads; `"stop"` when the file omitted it. */
  readonly onFailure: M3LCliFlowBranch;
  /**
   * Where a partially-successful step leads. Optional in the *type* so a
   * hand-built literal need not spell it out, but the validator always
   * materializes it — to {@link M3LCliFlowStep.onFailure} when the file
   * omitted it, since a partial outcome is a failure the author did not
   * separately account for.
   */
  readonly onPartial?: M3LCliFlowBranch;
  /** Whether to run this step in dry-run mode; absent when undeclared. */
  readonly dryRun?: boolean;
}

/**
 * A validated flow definition: the whole `<name>.yaml` document, narrowed.
 *
 * @example
 * ```ts
 * const definition: M3LCliFlowDefinition = {
 *   name: "dlq-reconcile",
 *   maxStepExecutions: 50,
 *   steps: [],
 * };
 * ```
 */
export interface M3LCliFlowDefinition {
  /** The flow's name; always equal to its file's stem. */
  readonly name: string;
  /** The author's one-line summary; absent when undeclared. */
  readonly description?: string;
  /**
   * The maximum number of individual step executions a run may perform
   * before the engine aborts it. This — not a restriction on `goto` — is what
   * bounds a cyclic flow.
   */
  readonly maxStepExecutions: number;
  /** The declared steps, in file order; never empty. */
  readonly steps: readonly M3LCliFlowStep[];
}

/**
 * How a flow run ended. Four literals, and deliberately not more: `completed`
 * (the step list ran out), `stopped` (a branch said `"stop"` with nothing to
 * report), `failed` (the deciding step exited non-zero), and
 * `loop-guard-exceeded` (the run hit
 * {@link M3LCliFlowDefinition.maxStepExecutions}).
 *
 * `stopped` and `completed` both carry exit code 0 — the distinction is *why*
 * the loop ended, which a run record needs and an exit code cannot express.
 *
 * @example
 * ```ts
 * const status: M3LCliFlowRunStatus = "loop-guard-exceeded";
 * ```
 */
export type M3LCliFlowRunStatus =
  "completed" | "stopped" | "failed" | "loop-guard-exceeded";

/**
 * One executed step, as recorded in a run's history: which step ran, on which
 * per-step attempt, how it ended, and which branch its outcome selected.
 *
 * Declared here rather than in `flow/run` or `flow/record` because BOTH of
 * those modules need it — declaring it in either would make the other import
 * it and create a cycle between the loop and its persistence layer.
 *
 * This is the PERSISTED half of a deliberate two-type split; its richer
 * in-memory counterpart is {@link M3LCliFlowStepOutcome}. Both exist because
 * this shape IS the on-disk JSON: a `Date` written through `JSON.stringify`
 * reads back as a `string`, so widening this record to carry the observed
 * `Date` window would make its own round-trip a type lie — the value you
 * write would not match the type you read. Keeping the persisted record
 * JSON-safe by construction, and carrying the `Date`s only in the in-memory
 * outcome, is what keeps that round-trip honest.
 *
 * `branch` holds the RESOLVED {@link M3LCliFlowBranch} value, not the name of
 * the arm it came from: what a resume needs to know is where the flow was
 * headed, and `"stop"` versus `{ goto }` is exactly that. Which arm produced
 * it is recoverable from the definition plus the exit code.
 *
 * @example
 * ```ts
 * const execution: M3LCliFlowStepExecution = {
 *   stepId: "dump",
 *   script: "sqs-etl",
 *   attempt: 1,
 *   exitCode: 0,
 *   outcome: "success",
 *   reportPath: "/repo/data/output/run-1/run-report.json",
 *   branch: "continue",
 * };
 * ```
 */
export interface M3LCliFlowStepExecution {
  /** The executed step's id. */
  readonly stepId: string;
  /** The script that step ran. */
  readonly script: string;
  /** Which attempt of THIS step id this was, 1-based and cumulative across revisits. */
  readonly attempt: number;
  /** The exit code the step resolved, verbatim — never clamped or remapped. */
  readonly exitCode: number;
  /** The outcome its located run report declared, or `null` when no report was found. */
  readonly outcome: M3LCliRunOutcome | null;
  /** The located `run-report.json`'s path, or `null` when none was found. */
  readonly reportPath: string | null;
  /** The branch this step's outcome selected. */
  readonly branch: M3LCliFlowBranch;
}

/**
 * One executed step as the LOOP observed it: every field
 * {@link M3LCliFlowStepExecution} persists, plus the three the run loop used
 * to see and discard — the step's own observed window (`startedAt`,
 * `finishedAt`) and why its run report could not be read
 * (`reportUnavailable`).
 *
 * **Why this exists as a second type.** `M3LCliFlowStepExecution` is the
 * persisted shape: it IS the bytes of `flows/<name>.json`, and a `Date`
 * written to JSON reads back as an ISO string, so widening the persisted
 * record to hold `Date`s would make its round-trip a type lie. Yet the
 * `--json` envelope genuinely needs those `Date`s: `flow/envelope.ts`
 * composes one nested run envelope PER STEP, and without each step's own
 * window every nested envelope would have to report the whole RUN's
 * `durationMs`. So the split is not duplication — it is the difference
 * between what survives serialization and what the composer needs before
 * serialization happens.
 *
 * `startedAt`/`finishedAt` are therefore deliberately NOT pre-stringified
 * here; `buildRunEnvelope` owns the ISO conversion, and pre-converting would
 * duplicate that decision in two places.
 *
 * @example
 * ```ts
 * const outcome: M3LCliFlowStepOutcome = {
 *   stepId: "dump",
 *   script: "sqs-etl",
 *   attempt: 1,
 *   exitCode: 0,
 *   outcome: "success",
 *   reportPath: "/repo/data/output/run-1/run-report.json",
 *   branch: "continue",
 *   startedAt: new Date("2026-09-01T09:00:00.000Z"),
 *   finishedAt: new Date("2026-09-01T09:00:04.000Z"),
 *   reportUnavailable: null,
 * };
 * ```
 */
export interface M3LCliFlowStepOutcome {
  /** The executed step's id. */
  readonly stepId: string;
  /** The script that step ran. */
  readonly script: string;
  /** Which attempt of THIS step id this was, 1-based and cumulative across revisits. */
  readonly attempt: number;
  /** The exit code the step resolved, verbatim — never clamped or remapped. */
  readonly exitCode: number;
  /** The outcome its located run report declared, or `null` when no report was found. */
  readonly outcome: M3LCliRunOutcome | null;
  /** The located `run-report.json`'s path, or `null` when none was found. */
  readonly reportPath: string | null;
  /** The branch this step's outcome selected. */
  readonly branch: M3LCliFlowBranch;
  /** When THIS execution was observed to start — a `Date`, not an ISO string. */
  readonly startedAt: Date;
  /** When THIS execution was observed to finish — a `Date`, not an ISO string. */
  readonly finishedAt: Date;
  /** Why no run report was located, or `null` when one was. */
  readonly reportUnavailable: M3LCliRunReportUnavailableReason | null;
}

/**
 * The default {@link M3LCliFlowDefinition.maxStepExecutions} for a file that
 * declares no guard of its own: high enough that no honest flow trips it,
 * low enough that an accidental `goto` cycle terminates in seconds.
 *
 * @example
 * ```ts
 * const guard = raw.maxStepExecutions ?? DEFAULT_MAX_STEP_EXECUTIONS;
 * ```
 */
export const DEFAULT_MAX_STEP_EXECUTIONS = 50;

/**
 * The accepted shape of a flow name — and therefore of its filename stem:
 * lowercase letters, digits and hyphens. Matches the preset-name and
 * script-name conventions, so a flow name is always safe as a path segment
 * and as a shell argument.
 *
 * @example
 * ```ts
 * FLOW_NAME_RE.test("dlq-reconcile"); // true
 * ```
 */
export const FLOW_NAME_RE: RegExp = /^[a-z0-9-]+$/;

/**
 * The accepted shape of a step id. Spelled as its own literal rather than an
 * alias of {@link FLOW_NAME_RE}: the two constrain independent things (a
 * filename stem versus an in-document label) and may diverge without either
 * rule having to be re-derived from the other.
 *
 * @example
 * ```ts
 * FLOW_STEP_ID_RE.test("republish"); // true
 * ```
 */
export const FLOW_STEP_ID_RE: RegExp = /^[a-z0-9-]+$/;
