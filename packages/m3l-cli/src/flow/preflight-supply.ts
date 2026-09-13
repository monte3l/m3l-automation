/**
 * `flow/preflight-supply` — pure predicate helpers `flow/preflight.ts`
 * layers its per-step analysis on: whether a step's own `parameters` would
 * actually supply a value at run time (mirroring `flow/step.ts`'s argv
 * emission rule), whether the environment supplies a value through a
 * descriptor's canonical name or any of its aliases, and the ADR-0055
 * conditional per-operation requirement walk.
 *
 * Split out of `flow/preflight.ts` purely to keep that file under the
 * per-file byte budget — the same one-directional relationship
 * `flow/validate.ts` has with `flow/validate-guards.ts`. Every export here is
 * an implementation detail `flow/preflight.ts` alone consumes.
 *
 * @packageDocumentation
 */

import { Core } from "@monte3l/m3l-common";

import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";
import type {
  M3LCliFlowDefinition,
  M3LCliFlowExecution,
  M3LCliFlowStep,
} from "./types.js";

/**
 * Checks whether a step's own `parameters` would supply a value for `name`
 * at run time, under the execution-mode-dependent emission rule.
 *
 * Absence is decided by `Object.hasOwn` alone — a name with no own key never
 * supplies a value, regardless of what an inherited `Object.prototype`
 * member of the same name might resolve to via bracket access.
 *
 * For `"spawn"`/`"auto"` this mirrors `flow/step.ts`'s `pushFlowParameterArg`
 * byte-for-byte: `true` and a non-empty array supply, `false`/`null`/
 * `undefined`/an empty array contribute nothing (the argv builder would
 * push zero tokens for them), and every other value supplies. `"in-process"`
 * never spawns, so it has no argv to mirror — `runInProcess` forwards
 * `parameters` straight through, and only an explicit `undefined` fails to
 * supply a value there.
 *
 * @param parameters - The step's own declared parameter values.
 * @param name - The descriptor name to check.
 * @param execution - The step's declared execution mode.
 * @returns Whether the step's own `parameters` would supply a value for
 *   `name`.
 *
 * @example
 * ```ts
 * wouldStepParametersSupply({ flag: false }, "flag", "spawn"); // false
 * wouldStepParametersSupply({ flag: false }, "flag", "in-process"); // true
 * ```
 */
export function wouldStepParametersSupply(
  parameters: Readonly<Record<string, unknown>>,
  name: string,
  execution: M3LCliFlowExecution,
): boolean {
  if (!Object.hasOwn(parameters, name)) {
    return false;
  }
  const value = parameters[name];
  if (execution === "in-process") {
    return value !== undefined;
  }
  if (value === true) {
    return true;
  }
  if (value === false || value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

/**
 * Checks whether `env` has an OWN key — exact or derived
 * (`Core.deriveEnvVarName`) — naming `name`, before ever delegating to
 * `provider.getRawValue`.
 *
 * `M3LEnvironmentConfigProvider.getRawValue` reads its env map with plain
 * bracket access (`this.env[key]`), which — like any bracket read on an
 * ordinary object — walks the prototype chain. A descriptor legitimately
 * named `"toString"` (or any other `Object.prototype` member) would
 * therefore resolve the INHERITED function, not `undefined`, and get
 * misreported as environment-supplied even though `env` declares no such
 * key at all. Gating the delegation behind an `Object.hasOwn` check on both
 * the exact name and its derived form closes that hole while still routing
 * the actual value lookup through the provider.
 *
 * @param env - The environment map to check ownership against.
 * @param name - The candidate key (a descriptor's canonical name or alias).
 * @returns Whether `env` owns `name` or its derived env-var form.
 */
function hasOwnEnvKey(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return (
    Object.hasOwn(env, name) || Object.hasOwn(env, Core.deriveEnvVarName(name))
  );
}

/**
 * Checks whether the environment supplies a value for `descriptor`, through
 * either its canonical name or any of its declared aliases.
 *
 * Tries the canonical name first, then every alias in declaration order —
 * `Array.prototype.some` short-circuits on the first hit, so only as many
 * aliases as necessary are probed. An empty-string value still counts as
 * supplied: `M3LEnvironmentConfigProvider.getRawValue` only ever answers
 * `undefined` for "absent", never for "empty". See {@link hasOwnEnvKey} for
 * why `env` is checked in addition to `provider` rather than delegating to
 * the provider alone.
 *
 * @param env - The environment map `provider` was constructed over —
 *   threaded through separately so the `Object.hasOwn` collision guard can
 *   run before any bracket-access lookup.
 * @param provider - The environment provider to probe once ownership is
 *   confirmed.
 * @param descriptor - The parameter descriptor to check.
 * @returns Whether the environment supplies a value for `descriptor`.
 *
 * @example
 * ```ts
 * import { Core } from "@monte3l/m3l-common";
 *
 * const env = { AWS_PROFILE: "prod" };
 * const provider = new Core.M3LEnvironmentConfigProvider({ env });
 * wouldEnvironmentSupply(env, provider, {
 *   name: "aws.profile",
 *   aliases: [],
 *   type: "STRING",
 *   required: true,
 *   defaultValue: undefined,
 *   description: "",
 *   secret: false,
 *   operations: [],
 * }); // true
 * ```
 */
export function wouldEnvironmentSupply(
  env: Readonly<Record<string, string | undefined>>,
  provider: Core.M3LEnvironmentConfigProvider,
  descriptor: M3LCliParameterDescriptor,
): boolean {
  return [descriptor.name, ...descriptor.aliases].some(
    (name) =>
      hasOwnEnvKey(env, name) && provider.getRawValue(name) !== undefined,
  );
}

/**
 * Resolves a `requiredParameters` entry to its canonical (declared) name,
 * against plain descriptors rather than live `M3LConfigParameter` instances —
 * a pre-flight only ever has descriptors to work from.
 *
 * Resolution runs in **two passes, exact-name first**: every descriptor in
 * `declared` is checked for `name === entry` before any descriptor's
 * `aliases` are considered at all, mirroring
 * `core/config/deriveOperationValidators.ts`'s `resolveCanonicalName`
 * precedence. An exact canonical-name match always wins over another
 * descriptor's alias, regardless of declaration order — a single combined
 * pass would let an earlier-declared descriptor's alias shadow a
 * later-declared descriptor's own canonical name.
 *
 * @param declared - Every parameter the step's script declares.
 * @param entry - The `requiredParameters` entry to resolve.
 * @returns The resolved canonical name, or `undefined` when `entry` names no
 *   declared parameter by name or alias — a script-authoring bug this module
 *   does not own, so resolution itself does not throw. Its caller,
 *   {@link resolveConditionalRequirements}, does not discard an `undefined`
 *   result either: it reports the malformed entry as an unresolvable
 *   requirement rather than dropping it silently.
 */
function resolveCanonicalName(
  declared: readonly M3LCliParameterDescriptor[],
  entry: string,
): string | undefined {
  const byName = declared.find((candidate) => candidate.name === entry);
  if (byName !== undefined) {
    return byName.name;
  }
  const byAlias = declared.find((candidate) =>
    candidate.aliases.includes(entry),
  );
  return byAlias?.name;
}

/**
 * The outcome of walking a step's ADR-0055 conditional per-operation
 * requirements: every canonical name a selector's resolved operation made
 * required, paired with the operation that required it, plus the name of
 * every selector the step gave no own value for.
 *
 * @example
 * ```ts
 * const requirements: M3LCliFlowConditionalRequirements = {
 *   requiredNames: new Map([["queueUrl", "dump"]]),
 *   selectorWarnings: [],
 *   unresolvableRequirements: [],
 * };
 * ```
 */
export interface M3LCliFlowConditionalRequirements {
  /** Canonical parameter name to the (first) operation that required it. */
  readonly requiredNames: ReadonlyMap<string, string>;
  /** Names of selectors the step gave no own value for. */
  readonly selectorWarnings: readonly string[];
  /**
   * Human-readable descriptions of a `requiredParameters` entry that resolved
   * to no declared parameter — a malformed descriptor (a script-authoring
   * bug), reported rather than silently dropped so the genuinely-required
   * parameter it names is never mistaken for satisfied.
   */
  readonly unresolvableRequirements: readonly string[];
}

/**
 * Walks every selector `declared` carries — a descriptor with
 * `operations.length > 0` — and resolves the ADR-0055 conditional
 * requirements it contributes for this step.
 *
 * A selector with no own key in `parameters` contributes nothing and is
 * recorded as a warning: the pre-flight cannot see what the step would have
 * selected, so it cannot know which (if any) conditional requirements would
 * apply. A non-string value, or a string naming no declared operation, is
 * VACUOUS — it contributes nothing and produces no warning, mirroring
 * `core/config/deriveOperationValidators.ts`'s own vacuous guard for the
 * same cases. Only a string value naming a declared operation resolves its
 * `requiredParameters` — via {@link resolveCanonicalName} — into
 * `requiredNames`; an entry that resolves to no declared parameter is
 * reported in `unresolvableRequirements` rather than silently dropped, since
 * a malformed entry still names a parameter that was meant to be required.
 *
 * Two selectors both requiring the same canonical name is not a conflict:
 * the first operation to require it wins the `requiredNames` tag, since
 * which one is credited is immaterial to whether the parameter is required.
 *
 * @param parameters - The step's own declared parameter values.
 * @param declared - Every parameter the step's script declares.
 * @returns The resolved conditional requirements, selector warnings, and any
 *   malformed `requiredParameters` entries that resolved to no declared
 *   parameter.
 *
 * @example
 * ```ts
 * const { requiredNames, selectorWarnings, unresolvableRequirements } =
 *   resolveConditionalRequirements(
 *   { command: "dump" },
 *   [
 *     {
 *       name: "command",
 *       aliases: [],
 *       type: "STRING",
 *       required: true,
 *       defaultValue: undefined,
 *       description: "",
 *       secret: false,
 *       operations: [
 *         { name: "dump", description: "", requiredParameters: ["queueUrl"] },
 *       ],
 *     },
 *     {
 *       name: "queueUrl",
 *       aliases: [],
 *       type: "STRING",
 *       required: false,
 *       defaultValue: undefined,
 *       description: "",
 *       secret: false,
 *       operations: [],
 *     },
 *   ],
 * );
 * // requiredNames.get("queueUrl") === "dump"
 * ```
 */
export function resolveConditionalRequirements(
  parameters: Readonly<Record<string, unknown>>,
  declared: readonly M3LCliParameterDescriptor[],
): M3LCliFlowConditionalRequirements {
  const requiredNames = new Map<string, string>();
  const selectorWarnings: string[] = [];
  const unresolvableRequirements: string[] = [];
  const selectors = declared.filter(
    (descriptor) => descriptor.operations.length > 0,
  );

  for (const selector of selectors) {
    if (!Object.hasOwn(parameters, selector.name)) {
      selectorWarnings.push(selector.name);
      continue;
    }
    const value = parameters[selector.name];
    if (typeof value !== "string") {
      continue;
    }
    const operation = selector.operations.find((op) => op.name === value);
    if (operation === undefined) {
      continue;
    }
    for (const entry of operation.requiredParameters) {
      const canonical = resolveCanonicalName(declared, entry);
      if (canonical === undefined) {
        unresolvableRequirements.push(
          `'${entry}' (declared required by '${selector.name}'='${operation.name}', but '${entry}' names no declared parameter)`,
        );
        continue;
      }
      if (!requiredNames.has(canonical)) {
        requiredNames.set(canonical, operation.name);
      }
    }
  }

  return { requiredNames, selectorWarnings, unresolvableRequirements };
}

/**
 * Resolves a step's three branch arms in the fixed order the reachability
 * walk considers them, materializing an undeclared `onPartial` to
 * `onFailure` — the same default `flow/validate.ts` applies at load time,
 * reproduced here because a hand-built `M3LCliFlowStep` literal (as
 * `flow/preflight.ts`'s own tests use) may skip validation and omit it.
 *
 * @param step - The step whose branch arms to resolve.
 * @returns The step's `onSuccess`, `onFailure` and resolved `onPartial`, in
 *   that order.
 */
function resolveBranchArms(
  step: M3LCliFlowStep,
): readonly M3LCliFlowStep["onFailure"][] {
  const onPartial = step.onPartial ?? step.onFailure;
  return [step.onSuccess, step.onFailure, onPartial];
}

/**
 * Resolves the step id one branch arm leads to, or `undefined` for `"stop"`
 * (or a `"continue"` off the last declared step, which is the same thing).
 *
 * @param branch - The resolved branch arm to follow.
 * @param fromId - The id of the step this arm belongs to, for resolving
 *   `"continue"` against `indexById`.
 * @param definition - The flow definition, for resolving `"continue"`'s
 *   target step.
 * @param indexById - Every declared step id's index within
 *   `definition.steps`, for resolving `"continue"`.
 * @returns The target step id, or `undefined` when the arm leads nowhere.
 */
function resolveBranchTarget(
  branch: M3LCliFlowStep["onFailure"],
  fromId: string,
  definition: M3LCliFlowDefinition,
  indexById: ReadonlyMap<string, number>,
): string | undefined {
  if (branch === "stop") {
    return undefined;
  }
  if (branch === "continue") {
    const index = indexById.get(fromId);
    const next = index === undefined ? undefined : definition.steps[index + 1];
    return next?.id;
  }
  return branch.goto;
}

/**
 * Pushes every step id `step`'s three branch arms lead to onto `stack`, for
 * the reachability walk in {@link resolveReachableStepIds}.
 *
 * @param stack - The reachability walk's work stack; appended to in place.
 * @param step - The step whose branch arms to follow.
 * @param definition - The flow definition, for resolving `"continue"`.
 * @param indexById - Every declared step id's index, for resolving
 *   `"continue"`.
 */
function pushReachableTargets(
  stack: string[],
  step: M3LCliFlowStep,
  definition: M3LCliFlowDefinition,
  indexById: ReadonlyMap<string, number>,
): void {
  for (const branch of resolveBranchArms(step)) {
    const target = resolveBranchTarget(branch, step.id, definition, indexById);
    if (target !== undefined) {
      stack.push(target);
    }
  }
}

/**
 * Computes the set of step ids reachable from `startStepId` (or the first
 * declared step, when omitted) by a fixed point over every step's
 * `onSuccess`/`onFailure`/`onPartial` branch arms: `"continue"` reaches the
 * next declared step, `"stop"` reaches nothing further, and `{ goto }`
 * reaches the named step.
 *
 * Reachability does not leak transitively backward: a step reachable ONLY
 * from another step that is itself unreached is never visited, because the
 * walk only ever follows an arm belonging to a step already confirmed
 * reachable. A `goto` cycle terminates the walk rather than looping forever,
 * since a step already added to the reachable set is never re-queued.
 *
 * @param definition - The flow definition to walk.
 * @param startStepId - The step id to start from; a value naming no
 *   declared step means reachability genuinely cannot be determined from it,
 *   so this walk reports NO step as reachable — leaving the run to proceed
 *   to `runFlow`'s own `resolveStartIndex`, which throws the accurate
 *   `ERR_CLI_UNKNOWN_FLOW_STEP` rather than this check guessing at a
 *   reachable set and potentially refusing the run for the wrong reason. An
 *   empty `steps` array yields no reachable ids regardless.
 * @returns The set of reachable step ids.
 *
 * @example
 * ```ts
 * const reachable = resolveReachableStepIds(definition, undefined);
 * // reachable.has(definition.steps[0].id) === true
 * ```
 */
export function resolveReachableStepIds(
  definition: M3LCliFlowDefinition,
  startStepId: string | undefined,
): ReadonlySet<string> {
  const [firstStep] = definition.steps;
  if (firstStep === undefined) {
    return new Set();
  }
  const declaredIds = new Set(definition.steps.map((step) => step.id));
  if (startStepId !== undefined && !declaredIds.has(startStepId)) {
    return new Set();
  }

  const stepById = new Map(definition.steps.map((step) => [step.id, step]));
  const indexById = new Map(
    definition.steps.map((step, index) => [step.id, index]),
  );
  const reachable = new Set<string>();
  const stack: string[] = [startStepId ?? firstStep.id];

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reachable.has(id)) {
      continue;
    }
    const step = stepById.get(id);
    if (step === undefined) {
      continue;
    }
    reachable.add(id);
    pushReachableTargets(stack, step, definition, indexById);
  }
  return reachable;
}
