/**
 * `flow/preflight` — the pre-flight PARAMETER-RESOLUTION check `m3l flow run`
 * performs once, before step 1 ever executes (issue #883).
 *
 * `flow/validate.ts` checks the SHAPE of a flow definition and is
 * deliberately fail-CLOSED: any ambiguity is rejected, because a definition
 * file is committed and every author-visible mistake in it should be caught
 * at load time. This module checks something validate.ts cannot — whether a
 * step's target script would actually RECEIVE its required parameters at run
 * time — and is deliberately the INVERSE posture: fail-OPEN. A step's own
 * `parameters` is only one of several places a required value can come from
 * (the process environment, a script's own `.env` file, and a descriptor's
 * declared default all count too), and this module cannot see everything a
 * running script eventually would — most importantly, it cannot read a
 * `.env` file it has not been told exists, and it cannot know what a step's
 * own selector value will resolve to when the step never gave one. It
 * therefore refuses a run only for what is PROVABLY unsatisfiable
 * (`report.missing`); anything it cannot resolve with certainty is reported
 * as an advisory warning (`report.unverified`) and the run proceeds anyway.
 * A reviewer used to `flow/validate.ts`'s fail-closed posture should read
 * this asymmetry as the point, not as a bug: a false-positive refusal here
 * would block a flow that would have run perfectly well off an ambient
 * `AWS_PROFILE` or a script-local `.env` file this module cannot see.
 *
 * Pure by design, like `flow/validate.ts`: every fact the checks need about
 * the workspace arrives as injected data on
 * {@link M3LCliFlowPreflightContext}, so the whole check is exercisable as a
 * plain function call — no filesystem, no discovery, no process state.
 * {@link resolveEnvFileReach} is the one exception, and it is a separate,
 * narrowly-scoped function: the module's only filesystem touch, used to
 * build part of that injected context ahead of the pure check itself.
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliEnvFileSetting } from "../cli/flags.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";
import {
  resolveConditionalRequirements,
  resolveReachableStepIds,
  wouldEnvironmentSupply,
  wouldStepParametersSupply,
} from "./preflight-supply.js";
import type { M3LCliFlowDefinition, M3LCliFlowStep } from "./types.js";

/**
 * One required parameter a step's target script would not receive at run
 * time, resolved as PROVABLY unsatisfiable.
 *
 * @example
 * ```ts
 * const parameter: M3LCliFlowPreflightMissingParameter = {
 *   name: "queueUrl",
 *   secret: false,
 *   requiredForOperation: "dump",
 * };
 * ```
 */
export interface M3LCliFlowPreflightMissingParameter {
  /** The parameter's declared canonical name. */
  readonly name: string;
  /** Whether the script declared the parameter secret (ADR-0085). */
  readonly secret: boolean;
  /**
   * The operation whose ADR-0055 conditional requirement made this
   * parameter required, when it was not already unconditionally required by
   * its own descriptor. Absent for an unconditionally-required parameter.
   */
  readonly requiredForOperation?: string;
}

/**
 * One reachable step that would not receive at least one required
 * parameter, aggregating every such parameter for that step in one entry.
 *
 * @example
 * ```ts
 * const missingStep: M3LCliFlowPreflightMissingStep = {
 *   stepId: "dump",
 *   script: "sqs-etl",
 *   parameters: [{ name: "queueUrl", secret: false }],
 * };
 * ```
 */
export interface M3LCliFlowPreflightMissingStep {
  /** The step's id. */
  readonly stepId: string;
  /** The step's target script. */
  readonly script: string;
  /** Every required parameter this step would not receive, aggregated. */
  readonly parameters: readonly M3LCliFlowPreflightMissingParameter[];
}

/**
 * One reachable step the pre-flight could not fully resolve — a warning,
 * never a reason to refuse the run.
 *
 * @example
 * ```ts
 * const unverifiedStep: M3LCliFlowPreflightUnverifiedStep = {
 *   stepId: "dump",
 *   script: "sqs-etl",
 *   reason: "parameter(s) apiToken may be supplied by a .env file this pre-flight cannot read",
 * };
 * ```
 */
interface M3LCliFlowPreflightUnverifiedStep {
  /** The step's id. */
  readonly stepId: string;
  /** The step's target script. */
  readonly script: string;
  /** Human-readable description of what could not be resolved, and why. */
  readonly reason: string;
}

/**
 * The full result of one {@link checkFlowPreflight} call: every provably
 * unsatisfiable step (`missing`) and every step the check could not fully
 * resolve (`unverified`). `missing` is what {@link rejectFlowPreflight}
 * acts on; `unverified` is advisory only.
 *
 * @example
 * ```ts
 * const clean: M3LCliFlowPreflightReport = { missing: [], unverified: [] };
 * ```
 */
export interface M3LCliFlowPreflightReport {
  /** Every reachable step provably missing at least one required parameter. */
  readonly missing: readonly M3LCliFlowPreflightMissingStep[];
  /** Every reachable step the check could not fully resolve. */
  readonly unverified: readonly M3LCliFlowPreflightUnverifiedStep[];
}

/**
 * Everything {@link checkFlowPreflight} needs, injected: the declared
 * parameters of every script a step might target, the environment to probe,
 * whether each script's directory has a reachable env file, and an optional
 * resume point.
 *
 * @example
 * ```ts
 * const context: M3LCliFlowPreflightContext = {
 *   parametersByScript: new Map([
 *     ["sqs-etl", [{
 *       name: "queueUrl",
 *       aliases: [],
 *       type: "STRING",
 *       required: true,
 *       defaultValue: undefined,
 *       description: "",
 *       secret: false,
 *       operations: [],
 *     }]],
 *   ]),
 *   env: process.env,
 *   envFileReachByScript: new Map([["sqs-etl", true]]),
 * };
 * ```
 */
export interface M3LCliFlowPreflightContext {
  /** Every known script name, mapped to the parameters it declares. */
  readonly parametersByScript: ReadonlyMap<
    string,
    readonly M3LCliParameterDescriptor[]
  >;
  /** The environment to probe for a value the step's own `parameters` omit. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Whether each target script's directory has a reachable env file
   * (see {@link resolveEnvFileReach}) — the blind spot this module cannot
   * read directly.
   */
  readonly envFileReachByScript: ReadonlyMap<string, boolean>;
  /**
   * The step id a resumed run would start from, mirroring `runFlow`'s own
   * `resolveStartIndex`. Absent starts at the first declared step; a value
   * naming no declared step treats every step as reachable, exactly like a
   * resumed run that can no longer find its resume point falls back to
   * running the whole flow.
   */
  readonly startStepId?: string;
}

/**
 * Builds the combined `reason` text for one step's unverified findings,
 * merging a selector-with-no-value warning and an env-file-blind-spot
 * warning into a single entry when both apply to the same step.
 *
 * @param selectorWarnings - Selectors the step gave no own value for.
 * @param envFileBlindSpotNames - Required parameters neither the step's own
 *   `parameters` nor the environment supplied, but that MIGHT be supplied by
 *   an env file this module cannot read.
 * @param unresolvableRequirements - Malformed `requiredParameters` entries
 *   this step's selectors resolved to no declared parameter.
 * @returns The combined reason text, or `""` when none of the three lists
 *   has entries.
 */
function buildUnverifiedReason(
  selectorWarnings: readonly string[],
  envFileBlindSpotNames: readonly string[],
  unresolvableRequirements: readonly string[],
): string {
  const parts: string[] = [];
  if (selectorWarnings.length > 0) {
    parts.push(
      `selector(s) ${selectorWarnings.join(", ")} have no value in this step's parameters, so their per-operation requirements (ADR-0055) could not be checked`,
    );
  }
  if (envFileBlindSpotNames.length > 0) {
    parts.push(
      `parameter(s) ${envFileBlindSpotNames.join(", ")} may be supplied by a .env file this pre-flight cannot read`,
    );
  }
  if (unresolvableRequirements.length > 0) {
    parts.push(
      `malformed operation declaration(s): ${unresolvableRequirements.join("; ")}`,
    );
  }
  return parts.join("; ");
}

/** Whether `descriptor` is required for `step`, and by which operation. */
interface M3LCliFlowResolvedRequirement {
  /** Whether the descriptor is required, unconditionally or conditionally. */
  readonly required: boolean;
  /**
   * The operation whose conditional requirement made the descriptor
   * required, when it is not ALSO unconditionally required by its own
   * `required: true` — an unconditional requirement always takes precedence
   * over a conditional tag, mirroring {@link renderMissingParameter}'s own
   * secret-over-operation precedence.
   */
  readonly requiredForOperation?: string;
}

/**
 * Resolves whether `descriptor` is required for this step — unconditionally
 * (its own `required: true`), conditionally (an ADR-0055 selector on this
 * step resolved an operation requiring it), or not at all.
 *
 * @param descriptor - The descriptor to resolve.
 * @param conditionalRequiredNames - Canonical name to the operation that
 *   conditionally required it, for this step.
 * @returns The resolved requirement.
 */
function resolveRequirement(
  descriptor: M3LCliParameterDescriptor,
  conditionalRequiredNames: ReadonlyMap<string, string>,
): M3LCliFlowResolvedRequirement {
  if (descriptor.required) {
    return { required: true };
  }
  const requiredForOperation = conditionalRequiredNames.get(descriptor.name);
  if (requiredForOperation !== undefined) {
    return { required: true, requiredForOperation };
  }
  return { required: false };
}

/** The per-step analysis {@link analyzeStep} produces. */
interface M3LCliFlowStepAnalysis {
  /** Every required parameter this step provably would not receive. */
  readonly missingParameters: readonly M3LCliFlowPreflightMissingParameter[];
  /** Selectors the step gave no own value for. */
  readonly selectorWarnings: readonly string[];
  /** Required parameters possibly supplied by an unreadable env file. */
  readonly envFileBlindSpotNames: readonly string[];
  /** Malformed `requiredParameters` entries this step's selectors resolved to no declared parameter. */
  readonly unresolvableRequirements: readonly string[];
}

/**
 * Analyzes one reachable step against the parameters its target script
 * declares, resolving every required descriptor (unconditional or ADR-0055
 * conditional) to one of: satisfied, an env-file blind spot, or provably
 * missing.
 *
 * The declared-default check runs BEFORE either supply check: a required
 * descriptor carrying a declared default is never missing, whatever the
 * step's `parameters` or `context.envFileReachByScript` might otherwise
 * suggest, since {@link M3LConfigParameter} resolution itself would apply
 * that default before ever reaching the environment.
 *
 * `"in-process"` execution forces the env-file blind spot to `false`
 * unconditionally: {@link runInProcess} never spawns a child and never loads
 * an env file, so there is no blind spot to be uncertain about — an
 * unsupplied required parameter under `"in-process"` is always provably
 * missing, never merely unverified.
 *
 * @param step - The reachable step to analyze.
 * @param declared - The parameters the step's target script declares.
 * @param context - The injected pre-flight context.
 * @param provider - The environment provider probing `context.env`.
 * @returns The step's missing parameters, selector warnings, and env-file
 *   blind spots.
 */
function analyzeStep(
  step: M3LCliFlowStep,
  declared: readonly M3LCliParameterDescriptor[],
  context: M3LCliFlowPreflightContext,
  provider: Core.M3LEnvironmentConfigProvider,
): M3LCliFlowStepAnalysis {
  const { requiredNames, selectorWarnings, unresolvableRequirements } =
    resolveConditionalRequirements(step.parameters, declared);

  const missingParameters: M3LCliFlowPreflightMissingParameter[] = [];
  const envFileBlindSpotNames: string[] = [];

  for (const descriptor of declared) {
    const resolved = resolveRequirement(descriptor, requiredNames);
    if (!resolved.required) {
      continue;
    }
    if (descriptor.defaultValue !== undefined) {
      continue;
    }
    if (
      wouldStepParametersSupply(
        step.parameters,
        descriptor.name,
        step.execution,
      )
    ) {
      continue;
    }
    if (wouldEnvironmentSupply(context.env, provider, descriptor)) {
      continue;
    }

    const envFileReach =
      step.execution === "in-process"
        ? false
        : (context.envFileReachByScript.get(step.script) ?? false);
    if (envFileReach) {
      envFileBlindSpotNames.push(descriptor.name);
      continue;
    }

    missingParameters.push({
      name: descriptor.name,
      secret: descriptor.secret,
      ...(resolved.requiredForOperation === undefined
        ? {}
        : { requiredForOperation: resolved.requiredForOperation }),
    });
  }

  return {
    missingParameters,
    selectorWarnings,
    envFileBlindSpotNames,
    unresolvableRequirements,
  };
}

/**
 * Checks whether every reachable step of `definition` would receive its
 * required parameters at run time, given `context`'s injected knowledge of
 * the workspace.
 *
 * Reachability is computed once via {@link resolveReachableStepIds}; an
 * unreachable step (one no branch arm of a reachable step ever leads to)
 * contributes nothing to the report, matching what an actual run would
 * never visit. Every finding is reported in the flow definition's own
 * declaration order, regardless of the (unordered) traversal order the
 * reachability walk itself used. A step whose `script` is not a key of
 * `context.parametersByScript` at all — a context/definition mismatch,
 * distinct from a script legitimately declaring zero parameters — is routed
 * straight to `unverified` without any missing-parameter analysis, since
 * there is nothing declared to analyze it against.
 *
 * See the module's `@packageDocumentation` header for the fail-open
 * rationale governing `missing` versus `unverified`.
 *
 * @param definition - The validated flow definition to check.
 * @param context - The injected pre-flight context.
 * @returns The full report: every provably unsatisfiable step and every
 *   step the check could not fully resolve.
 *
 * @example
 * ```ts
 * const report = checkFlowPreflight(definition, {
 *   parametersByScript: new Map([["sqs-etl", declaredParameters]]),
 *   env: process.env,
 *   envFileReachByScript: new Map([["sqs-etl", true]]),
 * });
 * if (report.missing.length > 0) {
 *   rejectFlowPreflight(definition.name, report.missing);
 * }
 * ```
 */
export function checkFlowPreflight(
  definition: M3LCliFlowDefinition,
  context: M3LCliFlowPreflightContext,
): M3LCliFlowPreflightReport {
  const reachable = resolveReachableStepIds(definition, context.startStepId);
  const provider = new Core.M3LEnvironmentConfigProvider({ env: context.env });

  const missing: M3LCliFlowPreflightMissingStep[] = [];
  const unverified: M3LCliFlowPreflightUnverifiedStep[] = [];

  for (const step of definition.steps) {
    if (!reachable.has(step.id)) {
      continue;
    }
    if (!context.parametersByScript.has(step.script)) {
      unverified.push({
        stepId: step.id,
        script: step.script,
        reason: `script '${step.script}' has no known parameter descriptors in this pre-flight's context — its required parameters could not be checked`,
      });
      continue;
    }
    const declared = context.parametersByScript.get(step.script) ?? [];
    const analysis = analyzeStep(step, declared, context, provider);

    if (analysis.missingParameters.length > 0) {
      missing.push({
        stepId: step.id,
        script: step.script,
        parameters: analysis.missingParameters,
      });
    }

    const reason = buildUnverifiedReason(
      analysis.selectorWarnings,
      analysis.envFileBlindSpotNames,
      analysis.unresolvableRequirements,
    );
    if (reason !== "") {
      unverified.push({ stepId: step.id, script: step.script, reason });
    }
  }

  return { missing, unverified };
}

/**
 * Renders one missing parameter's annotation for
 * {@link rejectFlowPreflight}'s message: a secret annotation (naming the
 * ADR-0085 env var to set) wins over an operation annotation when both
 * apply, since a secret parameter must never be set through a flow
 * definition's own `parameters` regardless of why it became required.
 *
 * @param parameter - The missing parameter to render.
 * @returns The rendered annotation.
 */
function renderMissingParameter(
  parameter: M3LCliFlowPreflightMissingParameter,
): string {
  if (parameter.secret) {
    return `${parameter.name} [secret — set ${Core.deriveEnvVarName(parameter.name)} in the environment, ADR-0085]`;
  }
  if (parameter.requiredForOperation !== undefined) {
    return `${parameter.name} [required for operation '${parameter.requiredForOperation}']`;
  }
  return parameter.name;
}

/**
 * Refuses a flow run over `missing` — every reachable step
 * {@link checkFlowPreflight} proved would not receive a required parameter —
 * before any step executes.
 *
 * @param flowName - The flow's name, for the top-line message.
 * @param missing - Every provably unsatisfiable step, in declaration order.
 * @returns Never returns; always throws.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_PREFLIGHT_FAILED`, carrying
 *   no `suggestions` — there is no near-miss name to hint at, only a value
 *   the operator must supply. The message names every missing step (one
 *   line each, in `missing`'s own order) and every one of that step's
 *   missing parameters, each annotated per {@link renderMissingParameter}.
 *
 * @example
 * ```ts
 * import type { M3LCliFlowPreflightMissingStep } from "@m3l-automation/m3l-cli/flow/preflight.js";
 *
 * const missing: readonly M3LCliFlowPreflightMissingStep[] = [
 *   { stepId: "dump", script: "sqs-etl", parameters: [{ name: "queueUrl", secret: false }] },
 * ];
 * rejectFlowPreflight("dlq-reconcile", missing);
 * // throws M3LCliError coded ERR_CLI_FLOW_PREFLIGHT_FAILED
 * ```
 */
export function rejectFlowPreflight(
  flowName: string,
  missing: readonly M3LCliFlowPreflightMissingStep[],
): never {
  const topLine = `flow '${flowName}' cannot run: ${missing.length} step(s) would not receive a required parameter — no step was executed`;
  const stepLines = missing.map(
    (missingStep) =>
      `  flow step '${missingStep.stepId}' (${missingStep.script}) is missing: ${missingStep.parameters
        .map(renderMissingParameter)
        .join(", ")}`,
  );
  throw new M3LCliError(
    "ERR_CLI_FLOW_PREFLIGHT_FAILED",
    [topLine, ...stepLines].join("\n"),
    { suggestions: [] },
  );
}

/**
 * One candidate script location {@link resolveEnvFileReach} probes: the
 * script's name (the key the returned map is keyed by) and its resolved
 * directory (where an `"auto"` {@link M3LCliEnvFileSetting} looks for
 * `.env`).
 *
 * @example
 * ```ts
 * const location: M3LCliFlowPreflightScriptLocation = {
 *   name: "sqs-etl",
 *   directory: "/repo/scripts/sqs-etl",
 * };
 * ```
 */
export interface M3LCliFlowPreflightScriptLocation {
  /** The script's name — the key the returned map is keyed by. */
  readonly name: string;
  /** The script's resolved directory. */
  readonly directory: string;
}

/**
 * Resolves whether `envFile` reaches one script location.
 *
 * @param candidate - The script location to resolve.
 * @param envFile - The resolved env-file setting (ADR-0085).
 * @returns Whether the env file reaches `candidate`.
 */
function resolveOneEnvFileReach(
  candidate: M3LCliFlowPreflightScriptLocation,
  envFile: M3LCliEnvFileSetting,
): boolean {
  switch (envFile.kind) {
    case "disabled":
      return false;
    case "path":
      return existsSync(envFile.path);
    case "auto":
      return existsSync(join(candidate.directory, ".env"));
    default: {
      const exhaustive: never = envFile;
      throw new Error(
        `flow/preflight: unhandled M3LCliEnvFileSetting variant ${String(exhaustive)} — this indicates a new variant was added without updating resolveOneEnvFileReach, a programming error rather than an operator-facing refusal`,
      );
    }
  }
}

/**
 * Resolves, for every candidate script location, whether the resolved
 * `envFile` setting (ADR-0085) would reach it — the module's ONE filesystem
 * touch, used to build {@link M3LCliFlowPreflightContext.envFileReachByScript}
 * ahead of the otherwise-pure {@link checkFlowPreflight} call.
 *
 * `"disabled"` reaches nothing: every candidate maps to `false`. `"path"`
 * reaches every candidate identically — the same explicit file, checked
 * once per candidate but always against the SAME path, so every candidate's
 * result agrees. `"auto"` checks each candidate's OWN `<directory>/.env`
 * independently, exactly like the pre-ADR-0085 default a spawned child
 * always applied.
 *
 * @param candidates - Every script location to resolve reach for.
 * @param envFile - The resolved env-file setting (ADR-0085).
 * @returns A map from each candidate's `name` to whether the env file
 *   reaches it.
 *
 * @example
 * ```ts
 * const reach = resolveEnvFileReach(
 *   [{ name: "sqs-etl", directory: "/repo/scripts/sqs-etl" }],
 *   { kind: "auto" },
 * );
 * // reach.get("sqs-etl") === true when /repo/scripts/sqs-etl/.env exists
 * ```
 */
export function resolveEnvFileReach(
  candidates: readonly M3LCliFlowPreflightScriptLocation[],
  envFile: M3LCliEnvFileSetting,
): ReadonlyMap<string, boolean> {
  const reach = new Map<string, boolean>();
  for (const candidate of candidates) {
    reach.set(candidate.name, resolveOneEnvFileReach(candidate, envFile));
  }
  return reach;
}
