import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { CLOUDFORMATION_STACKS_OPERATIONS, YES_DEFAULT } from "../config.js";

/** The closed union of `cloudformation-stacks`'s declared `operation` values. */
type Operation = (typeof CLOUDFORMATION_STACKS_OPERATIONS)[number];

/** The raw, per-operation-optional config values `run-cloudformation-stacks` resolves once, up front. */
interface RawSettings {
  readonly stackName: string | undefined;
  readonly input: string | undefined;
  readonly template: string | undefined;
  readonly stackStatusFilter: string | undefined;
  readonly retainResources: string | undefined;
  readonly roleArn: string | undefined;
  readonly nextToken: string | undefined;
  readonly maxWaitTime: number | undefined;
  readonly yes: boolean;
  readonly output: string | undefined;
}

/** The full dependency bag `runCloudformationStacks` receives and the pipeline threads through. */
interface Deps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly correlationId: string;
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly signal?: AbortSignal;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | AWS.M3LCloudFormationListStacksResult
  | AWS.M3LCloudFormationStack
  | undefined
  | AWS.M3LCloudFormationDescribeStackEventsResult
  | AWS.M3LCloudFormationCreateStackResult
  | AWS.M3LCloudFormationUpdateStackResult
  | void
  | AWS.M3LCloudFormationWaiterResult;

/** The three `wait-stack-*-complete` operations. */
type WaitOperation =
  | "wait-stack-create-complete"
  | "wait-stack-update-complete"
  | "wait-stack-delete-complete";

/**
 * Builds a fresh `Core.M3LConfigAccessor` over `deps.config`, coded
 * `ERR_CLOUDFORMATION_STACKS_CONFIG`. `M3LOperationHandlers`/`prepare` only
 * receive the pipeline's `deps` bag — not the engine's own internal accessor
 * — so the one remaining site that still needs a config read outside the
 * engine's own phases (the completion-log re-read in
 * {@link runCloudformationStacks}) builds its own. `M3LConfigAccessor` is a
 * stateless read-through wrapper, so constructing a fresh one per call is
 * behaviorally identical to sharing one instance.
 */
function buildAccessor(deps: Deps): Core.M3LConfigAccessor {
  return new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
  });
}

/** Builds a fresh `Core.M3LInputFileReader` over `deps.paths`, coded `ERR_CLOUDFORMATION_STACKS_CONFIG` — see {@link buildAccessor}. */
function buildReader(deps: Deps): Core.M3LInputFileReader {
  return new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
  });
}

/**
 * Narrows an already-guarded optional settings field to its defined value,
 * throwing a defensive `ERR_CLOUDFORMATION_STACKS_CONFIG` otherwise. The
 * pipeline's `requiredFields` guard (phase 4) has already enforced presence
 * for every field callers read this way before those callers are ever invoked
 * — this is a type-narrowing safety net, not an expected runtime path.
 */
function requireDefined<TValue>(
  value: TValue | undefined,
  name: string,
): TValue {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
  }
  return value;
}

/** Splits `raw` on `,`, trims each segment, drops empty segments, and requires at least one remaining segment. */
function splitNonEmpty(raw: string, name: string): readonly string[] {
  const segments = raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Core.M3LError(
      `'${name}' must contain at least one non-empty segment after splitting on ','`,
      { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
    );
  }
  return segments;
}

/** Reads the file at `paths.resolveInput(name)` as raw text — the one place `template` is ever read. */
async function readTextFile(
  paths: Core.M3LPaths,
  name: string,
): Promise<string> {
  const resolved = paths.resolveInput(name);
  try {
    return (await fsp.readFile(resolved)).toString("utf8");
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading template file '${name}'`, {
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
      cause,
    });
  }
}

/**
 * Resolves the template text to dispatch: `undefined` when `template` is
 * unset; otherwise checks the `template`/record conflict **before** ever
 * touching the template file (throwing without reading on conflict), and
 * only reads the template file's text when no conflict exists.
 */
async function resolveTemplateText(
  template: string | undefined,
  record: Record<string, unknown>,
  paths: Core.M3LPaths,
): Promise<string | undefined> {
  if (template === undefined) return undefined;
  if (
    record["templateBody"] !== undefined ||
    record["templateUrl"] !== undefined
  ) {
    throw new Core.M3LError(
      "'template' conflicts with an 'input' record that already sets templateBody/templateUrl",
      { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
    );
  }
  return readTextFile(paths, template);
}

/** Builds `create-stack`/`update-stack`'s gate description from the parsed input record's `stackName` field, best-effort. */
function buildRecordGateDescription(
  operation: "create-stack" | "update-stack",
  record: Record<string, unknown>,
): string {
  const stackNameValue = record["stackName"];
  const stackName =
    typeof stackNameValue === "string" ? stackNameValue : "(see input file)";
  return `${operation} stack '${stackName}'`;
}

/** The already-read+parsed plan `create-stack`/`update-stack` need before gating. */
interface CreateOrUpdatePlan {
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly templateText: string | undefined;
}

/** Reads+parses `input`, resolves `templateText` (conflict-checked), for `create-stack`/`update-stack`. */
async function planCreateOrUpdate(
  operation: "create-stack" | "update-stack",
  raw: RawSettings,
  deps: Deps,
): Promise<CreateOrUpdatePlan> {
  const inputName = requireDefined(raw.input, "input");
  const parsed: Record<string, unknown> =
    await buildReader(deps).readJSONRecord(inputName);
  const templateText = await resolveTemplateText(
    raw.template,
    parsed,
    deps.paths,
  );
  return {
    description: buildRecordGateDescription(operation, parsed),
    input: parsed,
    templateText,
  };
}

/** The per-write-operation plan resolved before gating. */
interface WriteDispatchPlan {
  readonly description: string;
  readonly input: Record<string, unknown> | undefined;
  readonly templateText: string | undefined;
  readonly stackName: string | undefined;
  readonly retainResources: readonly string[] | undefined;
  readonly roleArn: string | undefined;
}

/** Resolves `delete-stack`'s gate description/options directly from config, or reads+parses `create-stack`/`update-stack`'s `input`+`template`. */
async function planWriteDispatch(
  operation: "create-stack" | "update-stack" | "delete-stack",
  raw: RawSettings,
  deps: Deps,
): Promise<WriteDispatchPlan> {
  if (operation === "delete-stack") {
    const stackName = requireDefined(raw.stackName, "stackName");
    const retainResources =
      raw.retainResources !== undefined
        ? splitNonEmpty(raw.retainResources, "retainResources")
        : undefined;
    return {
      description: `delete-stack '${stackName}'`,
      input: undefined,
      templateText: undefined,
      stackName,
      retainResources,
      roleArn: raw.roleArn,
    };
  }

  const plan = await planCreateOrUpdate(operation, raw, deps);
  return {
    description: plan.description,
    input: plan.input,
    templateText: plan.templateText,
    stackName: undefined,
    retainResources: undefined,
    roleArn: undefined,
  };
}

/**
 * Narrows `prepare`'s `WriteDispatchPlan | undefined` context to a defined
 * plan. `TContext` is uniform across every handler table entry (it is
 * `WriteDispatchPlan | undefined` for every operation, not just the three
 * write ones), but `prepare` only ever produces a defined plan for
 * `create-stack`/`update-stack`/`delete-stack` — an `undefined` context
 * reaching a write handler or the destructive `describe` callback is
 * unreachable except via caller misuse of the engine, guarded here
 * defensively.
 */
function requireWritePlan(
  context: WriteDispatchPlan | undefined,
  operation: "create-stack" | "update-stack" | "delete-stack",
): WriteDispatchPlan {
  if (context === undefined) {
    throw new Core.M3LError(
      `internal: no write-dispatch plan resolved for '${operation}'`,
      { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
    );
  }
  return context;
}

/**
 * Narrows `destructive.describe`'s `operation` — typed as the full
 * `Operation` union (the engine's `M3LPipelineDestructiveOptions.describe`
 * signature is not narrowed to `destructive.operations`'s subset) — to the
 * three write operations. The engine only invokes `describe` for a member of
 * `destructive.operations`, so reaching the defensive throw means the engine
 * itself miscalled it.
 */
function requireWriteOperation(
  operation: Operation,
): "create-stack" | "update-stack" | "delete-stack" {
  if (
    operation === "create-stack" ||
    operation === "update-stack" ||
    operation === "delete-stack"
  ) {
    return operation;
  }
  throw new Core.M3LError(
    `internal: destructive gate invoked for non-destructive operation '${operation}'`,
    { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
  );
}

/**
 * The pipeline's `prepare` phase: runs once per run, before the destructive
 * gate, for every operation. Resolves `delete-stack`'s gate description
 * directly from config, or reads+parses `create-stack`/`update-stack`'s
 * `input` file (the one place either file is ever read). Presence of
 * `stackName`/`input` is already enforced by the engine's "Guards" phase
 * (phase 4, driven by {@link REQUIRED_FIELDS}) before `prepare` ever runs —
 * the {@link requireDefined} calls below are a defensive type-narrowing
 * safety net, not a runtime guard. Every non-write operation resolves
 * `undefined`.
 */
async function prepareWriteDispatch(
  operation: Operation,
  raw: RawSettings,
  deps: Deps,
): Promise<WriteDispatchPlan | undefined> {
  switch (operation) {
    case "create-stack":
    case "update-stack":
    case "delete-stack":
      return planWriteDispatch(operation, raw, deps);
    case "list-stacks":
    case "describe-stack":
    case "describe-stack-events":
    case "wait-stack-create-complete":
    case "wait-stack-update-complete":
    case "wait-stack-delete-complete":
      return undefined;
    default: {
      const exhaustive: never = operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
      });
    }
  }
}

/**
 * Which of `stackName`/`input` each operation requires, checked via
 * `Core.M3LConfigAccessor.requiredFor` in the engine's own "Guards" phase
 * (phase 4) — before `prepare`, the destructive gate, or any handler ever
 * runs. Keyed as a `Record<Operation, …>` so a new operation added to
 * {@link CLOUDFORMATION_STACKS_OPERATIONS} without a corresponding entry here
 * is a compile error.
 */
const REQUIRED_FIELDS: Record<
  Operation,
  readonly Core.M3LGuardableKey<RawSettings>[]
> = {
  "list-stacks": [],
  "describe-stack": ["stackName"],
  "describe-stack-events": ["stackName"],
  "create-stack": ["input"],
  "update-stack": ["input"],
  "delete-stack": ["stackName"],
  "wait-stack-create-complete": ["stackName"],
  "wait-stack-update-complete": ["stackName"],
  "wait-stack-delete-complete": ["stackName"],
};

/**
 * Resolves the raw, per-operation-optional config values the pipeline reads
 * once, up front. Must not re-read `"operation"` or apply its own
 * required-field guards — those are owned by the engine's own "Operation"
 * and "Guards" phases (the latter driven by {@link REQUIRED_FIELDS}).
 */
function resolveSettings(accessor: Core.M3LConfigAccessor): RawSettings {
  return {
    stackName: accessor.optionalString("stackName"),
    input: accessor.optionalString("input"),
    template: accessor.optionalString("template"),
    stackStatusFilter: accessor.optionalString("stackStatusFilter"),
    retainResources: accessor.optionalString("retainResources"),
    roleArn: accessor.optionalString("roleArn"),
    nextToken: accessor.optionalString("nextToken"),
    maxWaitTime: accessor.optionalNumber("maxWaitTime"),
    yes: accessor.booleanWithDefault("yes", YES_DEFAULT),
    output: accessor.optionalString("output"),
  };
}

/** `list-stacks`/`describe-stack`: dispatches to `read-stacks`. For `describe-stack`, throws `ERR_CLOUDFORMATION_STACKS_NOT_FOUND` when the step resolves `undefined` — in the Dispatch phase, before any persistence. Cross-parameter presence for `describe-stack` is enforced by the engine's Guards phase before this runs — see {@link REQUIRED_FIELDS}. */
async function dispatchReadStacks(
  operation: "list-stacks" | "describe-stack",
  raw: RawSettings,
  _context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const stackName =
    operation === "describe-stack"
      ? requireDefined(raw.stackName, "stackName")
      : undefined;
  const stackStatusFilter =
    raw.stackStatusFilter !== undefined
      ? splitNonEmpty(raw.stackStatusFilter, "stackStatusFilter")
      : undefined;

  const { readStacks } = await import("./read-stacks.js");
  const result = await readStacks({
    operations: deps.operations,
    operation,
    stackName,
    stackStatusFilter,
    nextToken: raw.nextToken,
  });

  if (operation === "describe-stack" && result === undefined) {
    throw new Core.M3LError(
      `describe-stack: stack '${requireDefined(raw.stackName, "stackName")}' not found`,
      { code: "ERR_CLOUDFORMATION_STACKS_NOT_FOUND" },
    );
  }

  return result;
}

/** `describe-stack-events`: dispatches to `read-stack-events`. Never gated. Cross-parameter presence for `stackName` is enforced by the engine's Guards phase before this runs — see {@link REQUIRED_FIELDS}. */
async function dispatchReadStackEvents(
  _operation: "describe-stack-events",
  raw: RawSettings,
  _context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const stackName = requireDefined(raw.stackName, "stackName");
  const { readStackEvents } = await import("./read-stack-events.js");
  return readStackEvents({
    operations: deps.operations,
    stackName,
    nextToken: raw.nextToken,
  });
}

/** `wait-stack-*-complete`: dispatches to `wait-stack`. Never gated. Cross-parameter presence for `stackName` is enforced by the engine's Guards phase before this runs — see {@link REQUIRED_FIELDS}. */
async function dispatchWait(
  operation: WaitOperation,
  raw: RawSettings,
  _context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const stackName = requireDefined(raw.stackName, "stackName");
  const { waitStack } = await import("./wait-stack.js");
  return waitStack({
    operations: deps.operations,
    operation,
    stackName,
    maxWaitTime: raw.maxWaitTime,
    ...(deps.signal !== undefined && { signal: deps.signal }),
  });
}

/** `create-stack`/`update-stack`/`delete-stack`: dispatches to `write-stack` using the plan `prepare` resolved before the gate. */
async function dispatchWrite(
  operation: "create-stack" | "update-stack" | "delete-stack",
  _raw: RawSettings,
  context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const plan = requireWritePlan(context, operation);
  const { writeStack } = await import("./write-stack.js");
  return writeStack({
    operations: deps.operations,
    reader: buildReader(deps),
    operation,
    input: plan.input,
    templateText: plan.templateText,
    stackName: plan.stackName,
    retainResources: plan.retainResources,
    roleArn: plan.roleArn,
  });
}

/**
 * The `cloudformation-stacks` pipeline: resolve settings → (for every
 * operation) plan a write dispatch → (for `create-stack`/`update-stack`/
 * `delete-stack`) the destructive-operation gate → the operation-appropriate
 * step → persist the result to `output` (when configured) → assert a
 * `wait-stack-*-complete` operation resolved `SUCCESS`, all owned by
 * `Core.M3LOperationPipeline`. Built once at module load — a pipeline
 * instance is stateless across `run()` calls.
 *
 * A declined destructive-operation gate (`ERR_CLOUDFORMATION_STACKS_ABORTED`)
 * propagates to the caller unmodified (`onDecline: { kind: "throw" }`) —
 * a decline here aborts the whole run rather than soft-landing an empty result.
 */
const pipeline = new Core.M3LOperationPipeline<
  Operation,
  RawSettings,
  Deps,
  DispatchResult,
  WriteDispatchPlan | undefined
>({
  operations: CLOUDFORMATION_STACKS_OPERATIONS,
  configCode: "ERR_CLOUDFORMATION_STACKS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  prepare: prepareWriteDispatch,
  destructive: {
    operations: new Set([
      "create-stack",
      "update-stack",
      "delete-stack",
    ] as const),
    describe: (operation, _settings, context) =>
      requireWritePlan(context, requireWriteOperation(operation)).description,
    yes: (settings) => settings.yes,
    abortCode: "ERR_CLOUDFORMATION_STACKS_ABORTED",
    onDecline: { kind: "throw" },
  },
  handlers: {
    "list-stacks": dispatchReadStacks,
    "describe-stack": dispatchReadStacks,
    "describe-stack-events": dispatchReadStackEvents,
    "create-stack": dispatchWrite,
    "update-stack": dispatchWrite,
    "delete-stack": dispatchWrite,
    "wait-stack-create-complete": dispatchWait,
    "wait-stack-update-complete": dispatchWait,
    "wait-stack-delete-complete": dispatchWait,
  },
  persist: async (result, settings, deps) => {
    if (settings.output === undefined || result === undefined) return;
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(settings.output),
    });
    await exporter.export(result);
  },
  finalize: (result, _settings, deps, operation) => {
    if (
      operation !== "wait-stack-create-complete" &&
      operation !== "wait-stack-update-complete" &&
      operation !== "wait-stack-delete-complete"
    )
      return;
    const waiterResult = result as AWS.M3LCloudFormationWaiterResult;
    if (waiterResult.state === "SUCCESS") return;
    throw new Core.M3LError(
      `cloudformation-stacks run ${deps.correlationId}: wait operation resolved '${waiterResult.state}', not SUCCESS`,
      {
        code: "ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE",
        context: {
          state: waiterResult.state,
          ...(waiterResult.reason !== undefined && {
            reason: waiterResult.reason,
          }),
        },
      },
    );
  },
});

/**
 * Composes the `cloudformation-stacks` pipeline end to end via
 * `Core.M3LOperationPipeline`: resolves + guard-checks config, runs
 * `Core.confirmDestructive` for every mutating operation, dispatches to the
 * operation-appropriate step, persists the result to `output` (when
 * configured) via `Core.M3LJSONFileExporter`, and — for the three
 * `wait-stack-*-complete` operations — throws once the result has had a
 * chance to be persisted first.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LCloudFormationOperations`, and the interactive-prompt
 *   facade.
 * @returns A promise that resolves once the run completes successfully.
 * @throws {@link Core.M3LError} coded `"ERR_CLOUDFORMATION_STACKS_CONFIG"`
 *   when a guard-checked per-operation requirement is unmet, `input` fails to
 *   read or parse, `template` conflicts with an `input` record that already
 *   sets `templateBody`/`templateUrl`, a `stackStatusFilter`/
 *   `retainResources` value is empty after split+trim+drop-empty, or
 *   `operation` is outside the declared set (unreachable through the config
 *   schema's `oneOf` validator, guarded here defensively).
 * @throws {@link Core.M3LError} coded `"ERR_CLOUDFORMATION_STACKS_ABORTED"`
 *   when the destructive-operation confirmation is declined.
 * @throws {@link Core.M3LError} coded
 *   `"ERR_CLOUDFORMATION_STACKS_NOT_FOUND"` when `describe-stack` resolves
 *   `undefined` — thrown during the Dispatch phase, before any persistence.
 * @throws {@link Core.M3LError} coded
 *   `"ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE"` when a
 *   `wait-stack-*-complete` operation resolves a
 *   `M3LCloudFormationWaiterResult` whose `state` is not `"SUCCESS"` —
 *   thrown *after* the result has been persisted to `output`, when
 *   configured, so the timeout/abort reason is still on disk for diagnosis.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runCloudformationStacks } from "./run-cloudformation-stacks.js";
 *
 * declare const operations: AWS.M3LCloudFormationOperations;
 *
 * await runCloudformationStacks({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "cloudformation-stacks", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   operations,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function runCloudformationStacks(deps: Deps): Promise<void> {
  const outcome = await pipeline.run(deps);
  const accessor = buildAccessor(deps);
  const stackName = accessor.optionalString("stackName");
  deps.logger.step(`cloudformation-stacks run ${deps.correlationId} complete`, {
    operation: outcome.operation,
    ...(stackName !== undefined && { stackName }),
  });
}
