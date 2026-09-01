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
