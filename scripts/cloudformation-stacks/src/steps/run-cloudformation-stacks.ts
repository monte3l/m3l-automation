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
}

/** The dependencies every dispatched operation needs, once `config` has resolved. */
interface DispatchDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly prompt: Core.M3LPrompt;
  readonly accessor: Core.M3LConfigAccessor;
  readonly reader: Core.M3LInputFileReader;
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
  deps: Pick<DispatchDeps, "paths" | "accessor" | "reader">,
): Promise<CreateOrUpdatePlan> {
  const inputName = deps.accessor.requiredFor(raw.input, "input", operation);
  const parsed: Record<string, unknown> =
    await deps.reader.readJSONRecord(inputName);
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
  deps: Pick<DispatchDeps, "paths" | "accessor" | "reader">,
): Promise<WriteDispatchPlan> {
  if (operation === "delete-stack") {
    const stackName = deps.accessor.requiredFor(
      raw.stackName,
      "stackName",
      operation,
    );
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

/** Runs `Core.confirmDestructive` — every mutating operation routes through this before dispatch. */
async function runGate(
  description: string,
  yes: boolean,
  deps: Pick<DispatchDeps, "prompt" | "logger">,
): Promise<void> {
  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description,
    yes,
    code: "ERR_CLOUDFORMATION_STACKS_ABORTED",
  });
}

/** `list-stacks`/`describe-stack`: guard-checks cross-parameter requirements, then dispatches to `read-stacks`. */
async function dispatchReadStacks(
  operation: "list-stacks" | "describe-stack",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const stackName =
    operation === "describe-stack"
      ? deps.accessor.requiredFor(raw.stackName, "stackName", operation)
      : undefined;
  const stackStatusFilter =
    raw.stackStatusFilter !== undefined
      ? splitNonEmpty(raw.stackStatusFilter, "stackStatusFilter")
      : undefined;

  const { readStacks } = await import("./read-stacks.js");
  return readStacks({
    operations: deps.operations,
    operation,
    stackName,
    stackStatusFilter,
    nextToken: raw.nextToken,
  });
}

/** `describe-stack-events`: guard-checks `stackName`, then dispatches to `read-stack-events`. Never gated. */
async function dispatchReadStackEvents(
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const stackName = deps.accessor.requiredFor(
    raw.stackName,
    "stackName",
    "describe-stack-events",
  );
  const { readStackEvents } = await import("./read-stack-events.js");
  return readStackEvents({
    operations: deps.operations,
    stackName,
    nextToken: raw.nextToken,
  });
}

/** The three `wait-stack-*-complete` operations. */
type WaitOperation =
  | "wait-stack-create-complete"
  | "wait-stack-update-complete"
  | "wait-stack-delete-complete";

/** `wait-stack-*-complete`: guard-checks `stackName`, then dispatches to `wait-stack`. Never gated. */
async function dispatchWait(
  operation: WaitOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const stackName = deps.accessor.requiredFor(
    raw.stackName,
    "stackName",
    operation,
  );
  const { waitStack } = await import("./wait-stack.js");
  return waitStack({
    operations: deps.operations,
    operation,
    stackName,
    maxWaitTime: raw.maxWaitTime,
  });
}

/** `create-stack`/`update-stack`/`delete-stack`: resolves the operation's plan, gates, then dispatches to `write-stack`. */
async function dispatchWrite(
  operation: "create-stack" | "update-stack" | "delete-stack",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const plan = await planWriteDispatch(operation, raw, deps);
  await runGate(plan.description, raw.yes, deps);

  const { writeStack } = await import("./write-stack.js");
  return writeStack({
    operations: deps.operations,
    operation,
    input: plan.input,
    templateText: plan.templateText,
    stackName: plan.stackName,
    retainResources: plan.retainResources,
    roleArn: plan.roleArn,
  });
}

/** The four dispatch families `cloudformation-stacks` routes operations into. */
type DispatchGroup = "read-stacks" | "read-stack-events" | "write" | "wait";

/**
 * Which dispatch family each operation belongs to. Keyed as a
 * `Record<Operation, …>` so a new operation added to
 * {@link CLOUDFORMATION_STACKS_OPERATIONS} without a corresponding entry here
 * is a compile error.
 */
const DISPATCH_GROUP: Record<Operation, DispatchGroup> = {
  "list-stacks": "read-stacks",
  "describe-stack": "read-stacks",
  "describe-stack-events": "read-stack-events",
  "create-stack": "write",
  "update-stack": "write",
  "delete-stack": "write",
  "wait-stack-create-complete": "wait",
  "wait-stack-update-complete": "wait",
  "wait-stack-delete-complete": "wait",
};

/** Narrows `operation` to `list-stacks`/`describe-stack`, matching {@link DISPATCH_GROUP}'s `"read-stacks"` entries. */
function isReadStacksOperation(
  operation: Operation,
): operation is "list-stacks" | "describe-stack" {
  return operation === "list-stacks" || operation === "describe-stack";
}

/** Narrows `operation` to the three mutating stack operations, matching {@link DISPATCH_GROUP}'s `"write"` entries. */
function isWriteOperation(
  operation: Operation,
): operation is "create-stack" | "update-stack" | "delete-stack" {
  return (
    operation === "create-stack" ||
    operation === "update-stack" ||
    operation === "delete-stack"
  );
}

/** Narrows `operation` to the three wait operations, matching {@link DISPATCH_GROUP}'s `"wait"` entries. */
function isWaitOperation(operation: Operation): operation is WaitOperation {
  return (
    operation === "wait-stack-create-complete" ||
    operation === "wait-stack-update-complete" ||
    operation === "wait-stack-delete-complete"
  );
}

/**
 * Dispatches to the operation-appropriate step, dynamic-importing it at
 * dispatch time (not a top-level static import) — so `steps/*.test.ts` can
 * `vi.mock` a step module before dispatch resolves it. Routes through
 * {@link DISPATCH_GROUP} into the four per-family dispatchers, each of which
 * guard-checks its own per-operation cross-parameter requirements before any
 * gate or AWS call, then — for every mutating operation — runs
 * `Core.confirmDestructive`.
 */
async function dispatchOperation(
  operation: Operation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const group = DISPATCH_GROUP[operation];
  switch (group) {
    case "read-stacks": {
      if (!isReadStacksOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a read-stacks operation`,
          { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
        );
      }
      return dispatchReadStacks(operation, raw, deps);
    }
    case "read-stack-events":
      return dispatchReadStackEvents(raw, deps);
    case "write": {
      if (!isWriteOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a write operation`,
          { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
        );
      }
      return dispatchWrite(operation, raw, deps);
    }
    case "wait": {
      if (!isWaitOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a wait operation`,
          { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
        );
      }
      return dispatchWait(operation, raw, deps);
    }
    default: {
      const exhaustive: never = group;
      throw new Core.M3LError(
        `unhandled dispatch group: ${String(exhaustive)}`,
        { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
      );
    }
  }
}

/** Resolves the raw, per-operation-optional config values `run-cloudformation-stacks` reads once, up front. */
function readRawSettings(accessor: Core.M3LConfigAccessor): RawSettings {
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
  };
}

/**
 * Persists `result` to `output` via `Core.M3LJSONFileExporter` when both
 * `output` is configured and `result` is not `void`/`undefined` — this
 * single check covers both `delete-stack` (always `void`, nothing to
 * persist) and a `describe-stack` resolving `undefined` (never reached here,
 * since the dispatcher throws `NOT_FOUND` before calling this function).
 */
async function persistOutput(
  paths: Core.M3LPaths,
  output: string | undefined,
  result: DispatchResult,
): Promise<void> {
  if (output === undefined || result === undefined) return;
  const exporter = new Core.M3LJSONFileExporter({
    filePath: paths.resolveOutput(output),
  });
  await exporter.export(result);
}

/**
 * Throws `ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE` when `operation` is
 * one of the three `wait-stack-*-complete` operations and the resolved
 * `M3LCloudFormationWaiterResult.state` is not `"SUCCESS"` — called *after*
 * {@link persistOutput}, so the timeout/abort reason survives on disk even
 * though the run then fails.
 */
function assertWaitComplete(
  operation: Operation,
  result: DispatchResult,
  correlationId: string,
): void {
  if (!isWaitOperation(operation)) return;
  const waiterResult = result as AWS.M3LCloudFormationWaiterResult;
  if (waiterResult.state === "SUCCESS") return;
  throw new Core.M3LError(
    `cloudformation-stacks run ${correlationId}: ${operation} resolved '${waiterResult.state}', not SUCCESS`,
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
}

/**
 * Throws `ERR_CLOUDFORMATION_STACKS_NOT_FOUND` when `operation` is
 * `describe-stack` and the resolved result is `undefined` — checked *before*
 * any persistence is attempted, since there is no result object to persist
 * in that case.
 */
function assertDescribeStackFound(
  operation: Operation,
  result: DispatchResult,
  stackName: string | undefined,
): void {
  if (operation !== "describe-stack" || result !== undefined) return;
  throw new Core.M3LError(
    `describe-stack: stack '${stackName ?? ""}' not found`,
    { code: "ERR_CLOUDFORMATION_STACKS_NOT_FOUND" },
  );
}

/**
 * Composes the `cloudformation-stacks` pipeline end to end: resolves +
 * guard-checks config, runs `Core.confirmDestructive` for every mutating
 * operation, dispatches to the operation-appropriate step, and — following
 * the two orderings the spec page documents — either throws
 * `ERR_CLOUDFORMATION_STACKS_NOT_FOUND` before any persistence
 * (`describe-stack`) or persists `output` before throwing
 * `ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE` (the three wait operations).
 * Every other operation simply persists a non-`void` result to `output` when
 * configured.
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
 *   `undefined`.
 * @throws {@link Core.M3LError} coded
 *   `"ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE"` when a
 *   `wait-stack-*-complete` operation resolves a
 *   `M3LCloudFormationWaiterResult` whose `state` is not `"SUCCESS"`.
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
export async function runCloudformationStacks(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
  });
  const reader = new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
  });

  const operation = accessor.oneOf(
    "operation",
    CLOUDFORMATION_STACKS_OPERATIONS,
  );
  const raw = readRawSettings(accessor);
  const output = accessor.optionalString("output");

  const result = await dispatchOperation(operation, raw, {
    paths: deps.paths,
    logger: deps.logger,
    operations: deps.operations,
    prompt: deps.prompt,
    accessor,
    reader,
  });

  assertDescribeStackFound(operation, result, raw.stackName);
  await persistOutput(deps.paths, output, result);
  assertWaitComplete(operation, result, deps.correlationId);

  deps.logger.step(`cloudformation-stacks run ${deps.correlationId} complete`, {
    operation,
    ...(raw.stackName !== undefined && { stackName: raw.stackName }),
  });
}
