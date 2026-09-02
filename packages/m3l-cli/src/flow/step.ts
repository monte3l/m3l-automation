/**
 * `flow/step` — executing exactly ONE flow step: resolving the declared
 * execution mode to a real mechanism, translating the step's `parameters`
 * into child argv, applying the dry-run floor, and reading the step's outcome
 * back through `run/report-lookup` using that step's OWN observed time
 * window.
 *
 * The per-step window is what makes a correlation id unnecessary: a flow that
 * invokes the same script twice disambiguates the two `run-report.json` files
 * purely by the disjoint intervals the two executions were observed in. That
 * is only true while the clock is read INSIDE this function, once per
 * execution — hoisting it into the run loop would make both lookups carry
 * identical bounds.
 *
 * This module never writes to disk. The run report it reads is the script's
 * own artifact; the engine only observes it.
 *
 * @packageDocumentation
 */

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliEnvFileSetting } from "../cli/flags.js";
import type { M3LCliOutput } from "../cli/output.js";
import { suggestNames } from "../cli/suggest.js";
import { executeScript } from "../run/execute.js";
import type { M3LCliExecuteOptions } from "../run/execute.js";
import { runInProcess } from "../run/in-process.js";
import type { M3LCliInProcessImportOptions } from "../run/in-process.js";
import { locateRunReport } from "../run/report-lookup.js";
import type {
  M3LCliRunOutcome,
  M3LCliRunReportLookup,
  M3LCliRunReportUnavailableReason,
} from "../run/envelope.js";
import type { M3LCliFlowStep } from "./types.js";

/**
 * The subset of a command context one flow step execution reads: the writer
 * facade to hand the mechanism, the managed output directory to scan for the
 * step's run report, the resolved script directories to dispatch into, and the
 * base environment plus env-file decision the spawn path hands the child
 * (ADR-0085).
 *
 * Structural rather than an import of `commands/context.js`, for the same
 * layering reason `run/execute.ts`'s own `M3LCliExecuteContext` is: `flow/`
 * must not depend on `commands/`.
 *
 * `env`/`envFile` are REQUIRED rather than optional-with-a-default: a step's
 * child process must inherit the same environment and load the same env file a
 * hand-typed `m3l <script>` invocation would, and defaulting a forgotten field
 * here would silently spawn steps with an empty environment (or load a `.env`
 * the operator passed `--no-env-file` to suppress) with nothing to catch it.
 *
 * @example
 * ```ts
 * const context: M3LCliFlowStepContext = {
 *   output,
 *   outputDirPath: "/repo/data/output",
 *   scriptDirectories: new Map([["sqs-etl", "/repo/scripts/sqs-etl"]]),
 *   env: process.env,
 *   envFile: { kind: "auto" },
 * };
 * ```
 */
export interface M3LCliFlowStepContext {
  /** The writer facade forwarded to whichever mechanism runs the step. */
  readonly output: M3LCliOutput;
  /** The managed output directory scanned for the step's `run-report.json`. */
  readonly outputDirPath: string;
  /** Resolved script directory by script name. */
  readonly scriptDirectories: ReadonlyMap<string, string>;
  /**
   * The base environment a spawned step's child inherits (ADR-0085) — the
   * environment the CLI itself was invoked with, forwarded verbatim.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The resolved `--env-file`/`--no-env-file` decision (ADR-0085), forwarded
   * verbatim so a step's child loads exactly the env file a hand-typed
   * `m3l <script>` invocation would.
   */
  readonly envFile: M3LCliEnvFileSetting;
}

/**
 * Injectable seams {@link executeFlowStep} threads through to the mechanism
 * it dispatches into, plus a `now` override for deterministic timing.
 *
 * @example
 * ```ts
 * const options: M3LCliFlowStepOptions = { now: () => new Date(0) };
 * ```
 */
export interface M3LCliFlowStepOptions {
  /** Overrides the wall-clock read bounding the step's observed window; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Forwarded to {@link executeScript}'s own `spawnImpl` override. */
  readonly spawnImpl?: M3LCliExecuteOptions["spawnImpl"];
  /** Forwarded to {@link executeScript}'s own `stderrStream` override. */
  readonly stderrStream?: M3LCliExecuteOptions["stderrStream"];
  /** Forwarded to {@link runInProcess}'s own `importModule` override. */
  readonly importModule?: M3LCliInProcessImportOptions["importModule"];
}

/**
 * What one step execution produced: the resolved mechanism, the effective
 * dry-run flag, the observed window, the exit code, and whatever the step's
 * run report could be made to say.
 *
 * @example
 * ```ts
 * function halted(result: M3LCliFlowStepResult): boolean {
 *   return result.exitCode !== 0;
 * }
 * ```
 */
export interface M3LCliFlowStepResult {
  /** The executed step's id. */
  readonly stepId: string;
  /** The script the step ran. */
  readonly script: string;
  /** The mechanism actually used — `"auto"` has been resolved away. */
  readonly execution: "in-process" | "spawn";
  /** The effective dry-run flag after the floor was applied. */
  readonly dryRun: boolean;
  /** When the execution was observed to start. */
  readonly startedAt: Date;
  /** When the execution was observed to finish. */
  readonly finishedAt: Date;
  /** The exit code the mechanism resolved, verbatim. */
  readonly exitCode: number;
  /** The located report's outcome, or `null` when no report was located (or it declared none). */
  readonly outcome: M3LCliRunOutcome | null;
  /** The located report's path, or `null` when none was located. */
  readonly reportPath: string | null;
  /** Why no report was located, or `null` when one was. */
  readonly reportUnavailable: M3LCliRunReportUnavailableReason | null;
}

/**
 * The `--dry-run` token every fleet script accepts (ADR-0022), appended when
 * the effective dry-run flag is set.
 */
const DRY_RUN_FLAG = "--dry-run";

/**
 * Renders one opaque parameter value as a single argv token's value.
 *
 * A string passes through RAW — quoting it would break the equals-joined form
 * `pushTranslatedArg` emits (`--fields=body=body`, not `--fields="body=body"`).
 * Everything else goes through `JSON.stringify`, which renders a number or a
 * boolean exactly as `String` would.
 *
 * The one place this deliberately diverges from `String(value)` is a nested
 * YAML mapping or sequence-of-mappings: `String` would emit the useless
 * `"[object Object]"`. That divergence cannot desync the two emitters, because
 * `pushTranslatedArg`'s own value type (`string | boolean | string[]`) can
 * never carry such a value in the first place.
 *
 * @param value - The opaque value from a step's `parameters`.
 * @returns The token value to interpolate.
 */
function stringifyParameterValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/**
 * Pushes one parameter's argv tokens onto `argv`.
 *
 * Byte-compatible with `commands/dynamic-argv.ts`'s `pushTranslatedArg` — the
 * translation a hand-typed `m3l <script>` invocation goes through — so a flow
 * step and an equivalent manual invocation produce IDENTICAL child argv:
 * `--name=value` equals-joined (never a two-token `--name value` pair), a
 * bare `--name` for `true`, one repeated `--name=item` per array element.
 *
 * Deliberately a separate implementation rather than a call into
 * `translateArgv`: that function needs `M3LCliParameterDescriptor[]` for its
 * per-parameter `type`/`aliases`, and a flow step carries only names and
 * opaque values. The divergence is therefore a recorded decision — keep the
 * two emitters byte-identical if either changes.
 *
 * `false`, `null` and `undefined` contribute NOTHING. A YAML key written with
 * no value parses to `null`, and it must never reach the child as the literal
 * string `"null"`.
 *
 * @param argv - The token list being built; appended to in place.
 * @param name - The parameter's declared name.
 * @param value - The parameter's opaque value from the flow definition.
 */
function pushFlowParameterArg(
  argv: string[],
  name: string,
  value: unknown,
): void {
  if (value === true) {
    argv.push(`--${name}`);
    return;
  }
  if (value === false || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      argv.push(`--${name}=${stringifyParameterValue(item)}`);
    }
    return;
  }
  argv.push(`--${name}=${stringifyParameterValue(value)}`);
}

/**
 * Translates a step's `parameters` (plus the effective dry-run flag) into the
 * child argv the spawn path forwards, in the record's own key order.
 *
 * @param parameters - The step's declared parameter values.
 * @param dryRun - The effective dry-run flag.
 * @returns The translated argv tokens.
 */
function buildStepArgv(
  parameters: Readonly<Record<string, unknown>>,
  dryRun: boolean,
): readonly string[] {
  const argv: string[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    pushFlowParameterArg(argv, name, value);
  }
  if (dryRun) {
    argv.push(DRY_RUN_FLAG);
  }
  return argv;
}

/**
 * Resolves the script directory `step` dispatches into.
 *
 * @param context - The step context carrying the resolved script directories.
 * @param step - The step being executed.
 * @returns The script's resolved directory.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` when the step
 *   names a script this workspace does not have, carrying near-miss
 *   `suggestions` from the ones it does.
 */
function resolveScriptDirectory(
  context: M3LCliFlowStepContext,
  step: M3LCliFlowStep,
): string {
  const scriptDirectory = context.scriptDirectories.get(step.script);
  if (scriptDirectory === undefined) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_SCRIPT",
      `flow step '${step.id}' names unknown script '${step.script}'`,
      {
        suggestions: suggestNames(step.script, [
          ...context.scriptDirectories.keys(),
        ]),
      },
    );
  }
  return scriptDirectory;
}

/**
 * The already-resolved facts about one step execution, settled before any
 * mechanism is dispatched into.
 */
interface ResolvedStepDispatch {
  /** The script's resolved directory. */
  readonly scriptDirectory: string;
  /** The mechanism to use — `"auto"` has been resolved away. */
  readonly execution: "in-process" | "spawn";
  /** The effective dry-run flag after the floor was applied. */
  readonly dryRun: boolean;
}

/**
 * Dispatches one step into its resolved mechanism and resolves its exit code.
 *
 * The spawn path is always handed `jsonOutput: false`: with `true`,
 * {@link executeScript} emits its own per-run JSON envelope line on stdout,
 * which would corrupt the single flow-level envelope the `m3l flow` command
 * emits. For the same reason `now` is NOT forwarded to it — with
 * `jsonOutput: false` it never uses its own timing, and forwarding would make
 * a scripted test clock order-dependent across two modules.
 *
 * The spawn path is handed `context.env` and `context.envFile` verbatim, so a
 * step's child inherits the same environment and loads the same env file a
 * hand-typed `m3l <script>` invocation would (ADR-0085). The in-process path
 * takes neither: it never spawns, so there is no child environment to populate.
 *
 * Each seam is spread in only when supplied, so `exactOptionalPropertyTypes`
 * stays satisfied and no downstream key exists that the caller never set.
 *
 * @param context - The writer facade, output directory, and the base
 *   environment plus env-file decision the spawn path forwards.
 * @param step - The step to dispatch.
 * @param resolved - The resolved directory, mechanism and dry-run flag.
 * @param options - The injectable mechanism seams.
 * @returns The mechanism's resolved exit code.
 * @throws Whatever the dispatched mechanism throws, unchanged.
 */
function dispatchStep(
  context: M3LCliFlowStepContext,
  step: M3LCliFlowStep,
  resolved: ResolvedStepDispatch,
  options: M3LCliFlowStepOptions,
): Promise<number> {
  if (resolved.execution === "spawn") {
    return executeScript(
      {
        output: context.output,
        jsonOutput: false,
        outputDirPath: context.outputDirPath,
        env: context.env,
        envFile: context.envFile,
      },
      step.script,
      resolved.scriptDirectory,
      buildStepArgv(step.parameters, resolved.dryRun),
      {
        ...(options.spawnImpl !== undefined
          ? { spawnImpl: options.spawnImpl }
          : {}),
        ...(options.stderrStream !== undefined
          ? { stderrStream: options.stderrStream }
          : {}),
      },
    );
  }
  return runInProcess(
    resolved.scriptDirectory,
    {
      output: context.output,
      parameterValues: step.parameters,
      dryRun: resolved.dryRun,
    },
    {
      ...(options.importModule !== undefined
        ? { importModule: options.importModule }
        : {}),
    },
  );
}

/**
 * Executes one flow step and reports what it produced.
 *
 * The declared `execution` resolves to exactly two mechanisms: `"in-process"`
 * dispatches to {@link runInProcess}, while BOTH `"spawn"` and `"auto"`
 * dispatch to {@link executeScript}. `auto` is not a third path — only the
 * spawn path runs a script's real `main.ts`, which is what writes the
 * `run-report.json` this engine reads back, so deferring the choice means
 * choosing spawn.
 *
 * The spawn path is always handed `jsonOutput: false`. With `true`,
 * {@link executeScript} emits its own per-run JSON envelope line on stdout,
 * which would corrupt the single flow-level envelope the `m3l flow` command
 * emits. For the same reason `now` is NOT forwarded to it: with
 * `jsonOutput: false` it never uses its own timing, and forwarding would make
 * a scripted test clock order-dependent across two modules.
 *
 * Dry-run is a FLOOR, never a ceiling: the effective flag is
 * `flowDryRun || step.dryRun`, so a step declaring `dryRun: false` is still
 * forced dry by a flow-level `--dry-run`.
 *
 * The report lookup runs on BOTH paths and is the only source of `outcome`.
 * {@link runInProcess} resolves a bare number, so the in-process path has no
 * authoritative outcome of its own either — and the lookup is the only source
 * of `reportPath` on both.
 *
 * A mechanism's rejection propagates UNCHANGED (it is already a typed
 * {@link M3LCliError} from `run/`): re-wrapping it here would bury the code
 * `main.ts` maps to an exit code, and the report lookup is deliberately
 * skipped in that case since there is no completed execution to observe.
 *
 * @param context - The writer facade, output directory, resolved script
 *   directories, and the environment plus env-file decision the spawn path
 *   hands the child.
 * @param step - The validated step to execute.
 * @param flowDryRun - The flow-level dry-run flag — the floor.
 * @param options - Optional `now`, `spawnImpl`, `stderrStream` and
 *   `importModule` seams.
 * @returns What the execution produced.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` when the step's
 *   script has no resolved directory; whatever the dispatched mechanism
 *   throws, unchanged.
 *
 * @example
 * ```ts
 * const result = await executeFlowStep(context, step, false);
 * // { stepId: "dump", execution: "spawn", exitCode: 0, outcome: "success", … }
 * ```
 */
export async function executeFlowStep(
  context: M3LCliFlowStepContext,
  step: M3LCliFlowStep,
  flowDryRun: boolean,
  options: M3LCliFlowStepOptions = {},
): Promise<M3LCliFlowStepResult> {
  const scriptDirectory = resolveScriptDirectory(context, step);
  const execution = step.execution === "in-process" ? "in-process" : "spawn";
  const dryRun = flowDryRun || step.dryRun === true;
  const now = options.now ?? ((): Date => new Date());

  const startedAt = now();
  const exitCode = await dispatchStep(
    context,
    step,
    { scriptDirectory, execution, dryRun },
    options,
  );
  const finishedAt = now();

  const lookup: M3LCliRunReportLookup = locateRunReport({
    outputDirPath: context.outputDirPath,
    scriptName: step.script,
    startedAt,
    finishedAt,
  });

  return {
    stepId: step.id,
    script: step.script,
    execution,
    dryRun,
    startedAt,
    finishedAt,
    exitCode,
    outcome: lookup.status === "found" ? lookup.summary.outcome : null,
    reportPath: lookup.status === "found" ? lookup.reportPath : null,
    reportUnavailable: lookup.status === "found" ? null : lookup.reason,
  };
}
