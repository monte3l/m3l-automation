/**
 * `flow/validate` — boundary validation for a `m3l flow` definition.
 *
 * Pure by design: every fact the rules need about the workspace's scripts
 * arrives as injected data on {@link M3LCliFlowValidationContext}, so the
 * whole format contract is exercisable as a plain function call — no
 * filesystem, no discovery, no process state. `flow/load` is the only module
 * that touches disk, and it delegates every judgement here.
 *
 * The rules are fail-closed: an unrecognized key is an error rather than
 * ignored data, at both the flow and the step level. A silently-ignored key
 * is the failure mode that matters for a definition file — a misspelled
 * `onFailrue:` would otherwise leave the author's intended branch silently
 * unset while the flow reports as valid.
 *
 * The same posture covers ADR-0085's secret handling. `flow/step.ts` renders
 * every parameter it is handed as an argv token, so a `secret: true`
 * parameter accepted here would reach the child through `/proc/<pid>/cmdline`
 * and resolve from argv (provider priority 1) instead of the environment
 * (priority 4) — the opposite of what the byte-identical hand-typed
 * invocation does. This module rejects such a key at load time rather than
 * reproducing the CLI's secret-only env overlay here.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import { suggestNames } from "../cli/suggest.js";
import {
  DEFAULT_MAX_STEP_EXECUTIONS,
  FLOW_NAME_RE,
  FLOW_STEP_ID_RE,
} from "./types.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowDefinition,
  M3LCliFlowExecution,
  M3LCliFlowStep,
} from "./types.js";

/**
 * One parameter a script declares, as the validator needs to see it: the name
 * it is addressed by, paired with whether the script flagged it `secret`.
 *
 * Both fields are required, deliberately. The alternative — a second
 * `secretParametersByScript` map — would let a caller populate the names and
 * omit the secrets, so the ADR-0085 screen would silently do nothing exactly
 * where it matters. Pairing the two facts makes an under-populated context a
 * compile error instead of a quiet leak.
 *
 * `Core.M3LConfigParameterDescriptor` is structurally assignable to this
 * shape, so `commands/flow.ts` hands its descriptors straight through rather
 * than projecting them down (the projection that dropped `secret` in the
 * first place).
 *
 * @example
 * ```ts
 * const parameter: M3LCliFlowValidationParameter = {
 *   name: "api-token",
 *   secret: true,
 * };
 * ```
 */
export interface M3LCliFlowValidationParameter {
  /** The parameter's declared name, as a `parameters` key must spell it. */
  readonly name: string;
  /** Whether the script declared the parameter secret (ADR-0085). */
  readonly secret: boolean;
}

/**
 * The script knowledge the validator narrows a step's `script` and
 * `parameters` against: every known script name mapped to the parameters it
 * declares. The known-script set is exactly this map's keys — there is no
 * second field, so the two can never disagree.
 *
 * Per ADR-0055 an operation selector is an ordinary declared parameter
 * (`sqs-etl` selects with `command`, `dynamodb-crud` with `operation`), so it
 * appears in its script's parameter list like any other and the flow format
 * needs no separate `operation:` key.
 *
 * @example
 * ```ts
 * const context: M3LCliFlowValidationContext = {
 *   parametersByScript: new Map([
 *     [
 *       "json-etl",
 *       [
 *         { name: "input", secret: false },
 *         { name: "output", secret: false },
 *       ],
 *     ],
 *   ]),
 * };
 * ```
 */
export interface M3LCliFlowValidationContext {
  /** Every known script name, mapped to the parameters it declares. */
  readonly parametersByScript: ReadonlyMap<
    string,
    readonly M3LCliFlowValidationParameter[]
  >;
}

/** The flow-level keys a definition file may declare. */
const FLOW_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "maxStepExecutions",
  "steps",
]);

/** The step-level keys a definition file may declare. */
const STEP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "script",
  "parameters",
  "execution",
  "onSuccess",
  "onFailure",
  "onPartial",
  "dryRun",
]);

/** The only key a `{ goto }` branch mapping may carry. */
const GOTO_KEYS: ReadonlySet<string> = new Set(["goto"]);

/** How the validator labels the document as a whole in its messages. */
const FLOW_LABEL = "the flow definition";

/**
 * Throws the one error class every rejection in this module raises. Declared
 * `never` so a call reads as terminal at each call site, keeping the rules
 * themselves free of `else` branches.
 *
 * @param message - Human-readable description of the rule that was broken.
 * @param suggestions - "Did you mean…" candidates, when a near-miss ranking
 *   applies; deliberately left empty for a prototype-pollution rejection, so
 *   a pollution vector is never echoed back as a friendly hint.
 */
function rejectFlow(
  message: string,
  suggestions: readonly string[] = [],
): never {
  throw new M3LCliError("ERR_CLI_FLOW_INVALID", message, { suggestions });
}

/**
 * Checks whether `value` is a non-array object — a YAML mapping.
 *
 * @param value - The candidate value.
 * @returns Whether `value` can be read as a keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether `value` is an array, without widening its items to `any`.
 *
 * @param value - The candidate value.
 * @returns Whether `value` is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Narrows `value` to a record, or rejects.
 *
 * @param value - The candidate value.
 * @param label - How to name `value` in the rejection message.
 * @returns The value as a record.
 */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    rejectFlow(`${label} must be a mapping`);
  }
  return value;
}

/**
 * Rejects when `record` declares a prototype-pollution vector key.
 *
 * `Core.M3LYAMLConfigProvider` screens only the document's TOP-LEVEL keys, so
 * every nested level — a step mapping, a `parameters` mapping, a branch
 * mapping — is this validator's own responsibility. The screen runs before
 * any unknown-key reporting: `__proto__` is also an undeclared name, and a
 * validator that reported unknown keys first would echo a pollution vector
 * back inside a "did you mean" list.
 *
 * @param record - The record whose own keys to screen.
 * @param label - How to name `record` in the rejection message.
 */
function screenDangerousKeys(
  record: Record<string, unknown>,
  label: string,
): void {
  const dangerous = Object.keys(record).filter((key) =>
    Core.isDangerousKey(key),
  );
  if (dangerous.length > 0) {
    rejectFlow(
      `${label} declares prototype-pollution key(s): ${dangerous.join(", ")}`,
    );
  }
}

/**
 * Rejects when `record` declares a key outside `known`, naming every
 * offending key so one pass over the file fixes them all.
 *
 * @param record - The record whose own keys to screen.
 * @param known - The keys this level of the format accepts.
 * @param label - How to name `record` in the rejection message.
 */
function screenUnknownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    rejectFlow(
      `${label} declares unknown key(s): ${unknown.join(", ")} — accepted: ${[...known].join(", ")}`,
    );
  }
}

/**
 * Reads a required string value, or rejects.
 *
 * @param record - The record to read from.
 * @param key - The key to read.
 * @param label - How to name `record` in the rejection message.
 * @returns The string value.
 */
function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    rejectFlow(`${label} requires a string '${key}'`);
  }
  return value;
}

/**
 * Reads an optional string value, or rejects when present but not a string.
 *
 * @param record - The record to read from.
 * @param key - The key to read.
 * @param label - How to name `record` in the rejection message.
 * @returns The string value, or `undefined` when the key is absent.
 */
function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    rejectFlow(`${label} declares a non-string '${key}'`);
  }
  return value;
}

/**
 * Reads an optional boolean value, or rejects when present but not a boolean.
 *
 * @param record - The record to read from.
 * @param key - The key to read.
 * @param label - How to name `record` in the rejection message.
 * @returns The boolean value, or `undefined` when the key is absent.
 */
function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    rejectFlow(`${label} declares a non-boolean '${key}'`);
  }
  return value;
}

/**
 * Reads and validates the document's `name`, which must match
 * {@link FLOW_NAME_RE} and equal the filename stem it was loaded from — a
 * renamed file would otherwise silently shadow another flow.
 *
 * @param record - The flow-level record.
 * @param expectedName - The filename stem the document must claim.
 * @returns The validated name.
 */
function readFlowName(
  record: Record<string, unknown>,
  expectedName: string,
): string {
  const name = readString(record, "name", FLOW_LABEL);
  if (!FLOW_NAME_RE.test(name)) {
    rejectFlow(
      `invalid flow name '${name}' — must match ${FLOW_NAME_RE.source}`,
    );
  }
  if (name !== expectedName) {
    rejectFlow(
      `${FLOW_LABEL} declares name '${name}' but its file is '${expectedName}.yaml' — the two must agree`,
    );
  }
  return name;
}

/**
 * Reads the run's step-execution guard, defaulting to
 * {@link DEFAULT_MAX_STEP_EXECUTIONS}. A positive safe integer is required:
 * a fractional or out-of-range value could not bound a `goto` cycle, and
 * `0` would forbid the first step from running at all.
 *
 * @param record - The flow-level record.
 * @returns The validated guard.
 */
function readMaxStepExecutions(record: Record<string, unknown>): number {
  const value = record["maxStepExecutions"];
  if (value === undefined) {
    return DEFAULT_MAX_STEP_EXECUTIONS;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    rejectFlow(
      `${FLOW_LABEL} declares an invalid 'maxStepExecutions' — must be a positive safe integer`,
    );
  }
  return value;
}

/**
 * Checks whether `value` is one of the declared execution modes.
 *
 * Spelled as an explicit disjunction rather than a lookup in a value array:
 * that is what lets TypeScript narrow `value` to the union, so no cast is
 * needed at the call site and adding a member to
 * {@link M3LCliFlowExecution} surfaces here as a compile error.
 *
 * @param value - The candidate value.
 * @returns Whether `value` is a valid execution mode.
 */
function isExecution(value: unknown): value is M3LCliFlowExecution {
  return value === "auto" || value === "in-process" || value === "spawn";
}

/**
 * Reads a step's `execution`, defaulting to `"auto"`. The declared literal is
 * preserved verbatim — resolving `auto` to a concrete mechanism is the
 * engine's job at execution time, and rewriting it here would lose what the
 * author actually asked for.
 *
 * @param record - The step-level record.
 * @param label - How to name the step in the rejection message.
 * @returns The validated execution mode.
 */
function readExecution(
  record: Record<string, unknown>,
  label: string,
): M3LCliFlowExecution {
  const value = record["execution"];
  if (value === undefined) {
    return "auto";
  }
  if (!isExecution(value)) {
    rejectFlow(
      `${label} declares an invalid 'execution' — must be 'auto', 'in-process' or 'spawn'`,
    );
  }
  return value;
}

/**
 * Validates one branch arm's value: `"continue"`, `"stop"`, or a `{ goto }`
 * mapping naming a declared step id. A `goto` may point forward, backward, or
 * at the step itself — a cycle is bounded by
 * {@link M3LCliFlowDefinition.maxStepExecutions}, not by this rule.
 *
 * @param value - The raw arm value.
 * @param arm - The arm's key name, for the rejection message.
 * @param label - How to name the step in the rejection message.
 * @param stepIds - Every declared step id, for `goto` resolution.
 * @returns The validated branch.
 */
function validateBranch(
  value: unknown,
  arm: string,
  label: string,
  stepIds: ReadonlySet<string>,
): M3LCliFlowBranch {
  if (typeof value === "string") {
    if (value === "continue" || value === "stop") {
      return value;
    }
    rejectFlow(
      `${label} declares an invalid '${arm}' value '${value}' — must be 'continue', 'stop' or a { goto } mapping`,
    );
  }

  const armLabel = `${label}'s '${arm}'`;
  const record = asRecord(value, armLabel);
  screenDangerousKeys(record, armLabel);
  screenUnknownKeys(record, GOTO_KEYS, armLabel);
  const target = readString(record, "goto", armLabel);
  if (!stepIds.has(target)) {
    rejectFlow(
      `${armLabel} names an undeclared step id '${target}' — no step in this flow declares it`,
    );
  }
  return { goto: target };
}

/**
 * Reads a branch arm, falling back to `fallback` when the key is absent.
 *
 * @param record - The step-level record.
 * @param arm - The arm's key name.
 * @param fallback - The branch to use when the arm is undeclared.
 * @param label - How to name the step in the rejection message.
 * @param stepIds - Every declared step id, for `goto` resolution.
 * @returns The validated branch, or `fallback`.
 */
function readBranch(
  record: Record<string, unknown>,
  arm: string,
  fallback: M3LCliFlowBranch,
  label: string,
  stepIds: ReadonlySet<string>,
): M3LCliFlowBranch {
  const value = record[arm];
  return value === undefined
    ? fallback
    : validateBranch(value, arm, label, stepIds);
}

/** A step's resolved script name plus the parameters that script declares. */
interface M3LCliFlowResolvedScript {
  /** The validated script name. */
  readonly script: string;
  /** The parameters that script declares, each with its secret-ness. */
  readonly declared: readonly M3LCliFlowValidationParameter[];
}

/**
 * Resolves a step's `script` against the injected context. Reads the map once
 * (`get`, not `has` then `get`) so the "known script" judgement and the
 * declared-parameter list can never come from two different lookups.
 *
 * @param record - The step-level record.
 * @param label - How to name the step in the rejection message.
 * @param context - The injected script knowledge.
 * @returns The script name and the parameters it declares.
 */
function readScript(
  record: Record<string, unknown>,
  label: string,
  context: M3LCliFlowValidationContext,
): M3LCliFlowResolvedScript {
  const script = readString(record, "script", label);
  const declared = context.parametersByScript.get(script);
  if (declared === undefined) {
    rejectFlow(
      `${label} names an unknown script '${script}'`,
      suggestNames(script, [...context.parametersByScript.keys()]),
    );
  }
  return { script, declared };
}

/**
 * Rejects when `parameters` names a key the script declared `secret`
 * (ADR-0085), naming every offending key so one pass over the file fixes them
 * all — and never the value, which is the whole reason the key is refused.
 *
 * A secret literal has no place in a flow definition, because a definition
 * file is committed. The rule is fail-closed rather than permissive: the
 * spawned child already inherits the CLI's own environment, so a secret held
 * there reaches the script without ever appearing in the YAML.
 *
 * Knowingly STRICTER than `commands/dynamic-argv.ts`'s `translateArgv`, which
 * exempts a secret `BOOL` from its env overlay because a flag carries no
 * payload: here EVERY declared-secret key is refused whatever its type. A
 * flow step has no env overlay to fall back to, so there is nothing for a
 * type-aware carve-out to route the value through — do not "harmonize" the
 * two.
 *
 * @param parameters - The step's raw `parameters` record.
 * @param resolved - The step's script and the parameters it declares.
 * @param parametersLabel - How to name the record in the rejection message.
 */
function screenSecretParameters(
  parameters: Record<string, unknown>,
  resolved: M3LCliFlowResolvedScript,
  parametersLabel: string,
): void {
  const secretNames = new Set(
    resolved.declared
      .filter((parameter) => parameter.secret)
      .map((parameter) => parameter.name),
  );
  const offending = Object.keys(parameters).filter((key) =>
    secretNames.has(key),
  );
  if (offending.length > 0) {
    // No `suggestions`: a near-miss hint would list the script's other
    // parameter names, and the fix is never "spell it differently" — it is
    // "remove the key and put the value in the environment".
    rejectFlow(
      `${parametersLabel} declares secret key(s): ${offending.join(", ")} — a secret must never live in a committed flow definition, and the spawned script already inherits the CLI's environment (ADR-0085)`,
    );
  }
}

/**
 * Validates a step's `parameters` against the parameters its own script
 * declares — not against the union of every script's, so a parameter borrowed
 * from a sibling script is caught here rather than at run time.
 *
 * The secret screen runs BEFORE the undeclared-key report, and the two can
 * never fire on the same key: a secret key is by definition declared, so it
 * cannot be an unknown name. Ordering it first means a step carrying both a
 * secret key and a typo still reports the security fault, which is the one
 * that must not be deferred to a second round trip.
 *
 * @param record - The step-level record.
 * @param resolved - The step's script and the parameters it declares.
 * @param label - How to name the step in the rejection message.
 * @returns A shallow copy of the validated parameter record.
 */
function readParameters(
  record: Record<string, unknown>,
  resolved: M3LCliFlowResolvedScript,
  label: string,
): Readonly<Record<string, unknown>> {
  const parametersLabel = `${label}'s 'parameters'`;
  const parameters = asRecord(record["parameters"], parametersLabel);
  screenDangerousKeys(parameters, parametersLabel);
  screenSecretParameters(parameters, resolved, parametersLabel);

  const declaredNames = new Set(
    resolved.declared.map((parameter) => parameter.name),
  );
  const [firstUnknown, ...restUnknown] = Object.keys(parameters).filter(
    (key) => !declaredNames.has(key),
  );
  if (firstUnknown !== undefined) {
    rejectFlow(
      `${parametersLabel} declares key(s) '${resolved.script}' does not accept: ${[firstUnknown, ...restUnknown].join(", ")}`,
      suggestNames(firstUnknown, [...declaredNames]),
    );
  }

  // A shallow copy: the caller's raw record must not stay reachable through
  // the validated definition, or a later mutation of the parsed document
  // would silently change an already-validated step.
  return { ...parameters };
}

/**
 * Validates one step record into a fully-defaulted {@link M3LCliFlowStep}.
 *
 * @param record - The step-level record.
 * @param id - The step's already-validated id.
 * @param stepIds - Every declared step id, for `goto` resolution.
 * @param context - The injected script knowledge.
 * @returns The validated step.
 */
function validateStep(
  record: Record<string, unknown>,
  id: string,
  stepIds: ReadonlySet<string>,
  context: M3LCliFlowValidationContext,
): M3LCliFlowStep {
  const label = `flow step '${id}'`;
  screenDangerousKeys(record, label);
  screenUnknownKeys(record, STEP_KEYS, label);

  const resolved = readScript(record, label, context);
  const parameters = readParameters(record, resolved, label);
  const execution = readExecution(record, label);
  const onSuccess = readBranch(record, "onSuccess", "continue", label, stepIds);
  const onFailure = readBranch(record, "onFailure", "stop", label, stepIds);
  // An undeclared `onPartial` materializes to `onFailure` rather than staying
  // undefined: a partial outcome the author did not separately account for is
  // a failure, and resolving it here means no consumer re-derives the rule.
  const onPartial = readBranch(record, "onPartial", onFailure, label, stepIds);
  const dryRun = readOptionalBoolean(record, "dryRun", label);

  return {
    id,
    script: resolved.script,
    parameters,
    execution,
    onSuccess,
    onFailure,
    onPartial,
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}

/** A raw step mapping paired with the id it declares. */
interface M3LCliFlowRawStep {
  /** The step's raw mapping, not yet validated beyond its id. */
  readonly record: Record<string, unknown>;
  /** The step's validated, flow-unique id. */
  readonly id: string;
}

/**
 * Validates the `steps` sequence's shape and every step's id, in one pass.
 *
 * Ids are collected before any step's body is validated because a `goto` may
 * name a step declared later in the file: the full id set has to exist before
 * the first branch arm can be resolved.
 *
 * @param raw - The raw `steps` value.
 * @returns Each step's raw record paired with its validated id, in file order.
 */
function collectRawSteps(raw: unknown): readonly M3LCliFlowRawStep[] {
  if (!isUnknownArray(raw)) {
    rejectFlow(`${FLOW_LABEL} requires 'steps' to be a sequence of mappings`);
  }
  if (raw.length === 0) {
    rejectFlow(`${FLOW_LABEL} requires 'steps' to declare at least one step`);
  }

  const collected: M3LCliFlowRawStep[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const label = `the flow's step at index ${index}`;
    const record = asRecord(entry, label);
    const id = readString(record, "id", label);
    if (!FLOW_STEP_ID_RE.test(id)) {
      rejectFlow(
        `invalid step id '${id}' — must match ${FLOW_STEP_ID_RE.source}`,
      );
    }
    if (seen.has(id)) {
      rejectFlow(`duplicate step id '${id}' — step ids must be unique`);
    }
    seen.add(id);
    collected.push({ record, id });
  }
  return collected;
}

/**
 * Validates a raw flow document into a fully-narrowed
 * {@link M3LCliFlowDefinition}, applying every documented default. Never
 * returns a partial definition: any broken rule throws instead.
 *
 * @param raw - The parsed document, straight from the file — unknown shape.
 * @param expectedName - The filename stem the document's `name` must equal.
 * @param context - The injected script knowledge to narrow `script` and
 *   `parameters` against.
 * @returns The validated definition, with `maxStepExecutions`, `execution`
 *   and every branch arm resolved to a concrete value.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_INVALID` for any broken
 *   rule — including a `parameters` key the target script declares `secret`
 *   (ADR-0085) — carrying near-miss `suggestions` for an unknown script or
 *   parameter name and an empty `suggestions` for a prototype-pollution or
 *   secret key.
 *
 * @example
 * ```ts
 * const definition = validateFlowDefinition(
 *   { name: "demo", steps: [{ id: "one", script: "json-etl", parameters: {} }] },
 *   "demo",
 *   {
 *     parametersByScript: new Map([
 *       ["json-etl", [{ name: "input", secret: false }]],
 *     ]),
 *   },
 * );
 * // definition.steps[0].onFailure === "stop"
 * ```
 */
export function validateFlowDefinition(
  raw: unknown,
  expectedName: string,
  context: M3LCliFlowValidationContext,
): M3LCliFlowDefinition {
  const record = asRecord(raw, FLOW_LABEL);
  screenDangerousKeys(record, FLOW_LABEL);
  screenUnknownKeys(record, FLOW_KEYS, FLOW_LABEL);

  const name = readFlowName(record, expectedName);
  const description = readOptionalString(record, "description", FLOW_LABEL);
  const maxStepExecutions = readMaxStepExecutions(record);

  const rawSteps = collectRawSteps(record["steps"]);
  const stepIds = new Set(rawSteps.map((step) => step.id));
  const steps = rawSteps.map((step) =>
    validateStep(step.record, step.id, stepIds, context),
  );

  return {
    name,
    ...(description === undefined ? {} : { description }),
    maxStepExecutions,
    steps,
  };
}
