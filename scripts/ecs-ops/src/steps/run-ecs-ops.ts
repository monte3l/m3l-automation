import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { ECS_OPERATIONS, FORCE_DEFAULT, YES_DEFAULT } from "../config.js";

/** The closed union of `ecs-ops`'s declared `operation` values. */
type EcsOperation = (typeof ECS_OPERATIONS)[number];

/** The raw, per-operation-optional config values `run-ecs-ops` resolves once, up front. */
interface RawSettings {
  readonly cluster: string | undefined;
  readonly service: string | undefined;
  readonly services: string | undefined;
  readonly input: string | undefined;
  readonly nextToken: string | undefined;
  readonly force: boolean;
  readonly maxWaitTime: number | undefined;
  readonly yes: boolean;
}

/** The dependencies every dispatched operation needs, once `config` has resolved. */
interface DispatchDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly operations: AWS.M3LECSOperations;
  readonly prompt: Core.M3LPrompt;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | AWS.M3LECSListServicesResult
  | AWS.M3LECSServiceDescription
  | AWS.M3LECSWaiterResult
  | AWS.M3LECSListClustersResult
  | AWS.M3LECSClusterSummary;

/**
 * Reads the `operation` parameter, validating it against the declared set.
 * The declared `M3LConfigParameter`'s `oneOf` validator already enforces this
 * at config-load time in the real script; this defensive re-check protects a
 * caller (e.g. a test) that builds a `Core.M3LConfig` directly, bypassing
 * that validation.
 */
function readOperation(config: Core.M3LConfig): EcsOperation {
  const value: unknown = config.get("operation");
  if (
    typeof value === "string" &&
    (ECS_OPERATIONS as readonly string[]).includes(value)
  ) {
    return value as EcsOperation;
  }
  throw new Core.M3LError(
    `'operation' must be one of: ${ECS_OPERATIONS.join(", ")}`,
    { code: "ERR_ECS_OPS_CONFIG" },
  );
}

/** Reads an optional string parameter, defensively re-checking its type (`undefined` when unset). */
function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Core.M3LError(`'${name}' must be a string`, {
      code: "ERR_ECS_OPS_CONFIG",
    });
  }
  return value;
}

/** Reads an optional number parameter, defensively re-checking its type (`undefined` when unset). */
function readOptionalNumber(
  config: Core.M3LConfig,
  name: string,
): number | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
      code: "ERR_ECS_OPS_CONFIG",
    });
  }
  return value;
}

/**
 * Reads a boolean parameter, falling back to `defaultValue` when unset. A
 * `Core.M3LConfig` built directly (as tests do) never applies a declared
 * parameter's `defaultValue` — only `M3LScript.getConfiguration()` does — so
 * this reproduces that default at the read site.
 */
function readBoolWithDefault(
  config: Core.M3LConfig,
  name: string,
  defaultValue: boolean,
): boolean {
  const value: unknown = config.get(name);
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Core.M3LError(`'${name}' must be a boolean`, {
      code: "ERR_ECS_OPS_CONFIG",
    });
  }
  return value;
}

/** Returns `value`, throwing `ERR_ECS_OPS_CONFIG` when it is `undefined` — the per-operation cross-parameter guard. */
function requireString(
  value: string | undefined,
  name: string,
  operation: EcsOperation,
): string {
  if (value === undefined) {
    throw new Core.M3LError(
      `'${name}' is required for operation '${operation}'`,
      { code: "ERR_ECS_OPS_CONFIG" },
    );
  }
  return value;
}

/** Reads the file at `paths.resolveInput(name)` as raw text — the one place `input` is ever read. */
async function readInputFileText(
  paths: Core.M3LPaths,
  name: string,
): Promise<string> {
  const resolved = paths.resolveInput(name);
  try {
    return (await fsp.readFile(resolved)).toString("utf8");
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading input file '${name}'`, {
      code: "ERR_ECS_OPS_CONFIG",
      cause,
    });
  }
}

/**
 * Reads and JSON-parses `input` under `M3L_INPUT_DIR`, for
 * `create-service`/`update-service`. The read and the parse are two genuinely
 * distinct fallible operations (a missing file vs. malformed JSON), so each
 * is wrapped in its own narrow `try`/`catch`.
 */
async function readJSONFile(
  paths: Core.M3LPaths,
  name: string,
): Promise<unknown> {
  const raw = await readInputFileText(paths, name);
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Core.M3LError(`'${name}' must be valid JSON`, {
      code: "ERR_ECS_OPS_CONFIG",
      cause,
    });
  }
}

/** Narrows an already-parsed JSON value to a plain object, for `create-service`/`update-service`'s `input`. */
function asInputRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Core.M3LError(`'${name}' must decode to a JSON object`, {
      code: "ERR_ECS_OPS_CONFIG",
    });
  }
  return value as Record<string, unknown>;
}

/** Splits `raw` on `,`, trims each segment, and drops empty segments — the `services` cross-parameter shape `wait-services-stable` needs. */
function splitServices(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
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
    code: "ERR_ECS_OPS_ABORTED",
  });
}

/** Builds `delete-service`'s gate description from the `cluster`/`service` config values. */
function buildDeleteGateDescription(cluster: string, service: string): string {
  return `delete-service cluster '${cluster}' service '${service}'`;
}

/**
 * A generic phrase used when the parsed `create-service`/`update-service`
 * input record carries neither a recognizable service name nor cluster.
 */
const UNKNOWN_TARGET_PHRASE = "(see input file)";

/**
 * Builds `create-service`/`update-service`'s gate description from a
 * best-effort read of the already-parsed input record's `serviceName` (or
 * `service`) and `cluster` fields — informational only, not a validation
 * step (full required-field enforcement happens inside `write-service` after
 * confirmation).
 */
function buildRecordGateDescription(
  operation: "create-service" | "update-service",
  record: Record<string, unknown>,
): string {
  const serviceNameValue = record["serviceName"] ?? record["service"];
  const serviceName =
    typeof serviceNameValue === "string" ? serviceNameValue : undefined;
  const clusterValue = record["cluster"];
  const cluster = typeof clusterValue === "string" ? clusterValue : undefined;

  if (serviceName === undefined && cluster === undefined) {
    return `${operation} ${UNKNOWN_TARGET_PHRASE}`;
  }
  return `${operation} cluster '${cluster ?? UNKNOWN_TARGET_PHRASE}' service '${serviceName ?? UNKNOWN_TARGET_PHRASE}'`;
}

/** `list-services`/`describe-service`: guard-checks cross-parameter requirements, then dispatches to `read-services`. */
async function dispatchReadServices(
  operation: "list-services" | "describe-service",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (operation === "describe-service") {
    requireString(raw.cluster, "cluster", operation);
    requireString(raw.service, "service", operation);
  }
  const { readServices } = await import("./read-services.js");
  return readServices({
    operations: deps.operations,
    operation,
    cluster: raw.cluster,
    service: raw.service,
    nextToken: raw.nextToken,
  });
}

/** `list-clusters`/`describe-cluster`: guard-checks cross-parameter requirements, then dispatches to `read-clusters`. */
async function dispatchReadClusters(
  operation: "list-clusters" | "describe-cluster",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (operation === "describe-cluster") {
    requireString(raw.cluster, "cluster", operation);
  }
  const { readClusters } = await import("./read-clusters.js");
  return readClusters({
    operations: deps.operations,
    operation,
    cluster: raw.cluster,
    nextToken: raw.nextToken,
  });
}

/** `wait-services-stable`: guard-checks `cluster`/`services`, splits `services`, then dispatches to `wait-services`. Never gated. */
async function dispatchWait(
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const cluster = requireString(raw.cluster, "cluster", "wait-services-stable");
  const servicesRaw = requireString(
    raw.services,
    "services",
    "wait-services-stable",
  );
  const services = splitServices(servicesRaw);
  if (services.length === 0) {
    throw new Core.M3LError(
      "'services' must contain at least one non-empty segment after splitting on ','",
      { code: "ERR_ECS_OPS_CONFIG" },
    );
  }

  const { waitServices } = await import("./wait-services.js");
  return waitServices({
    operations: deps.operations,
    cluster,
    services,
    maxWaitTime: raw.maxWaitTime,
  });
}

/** The per-write-operation description/input resolved before gating. */
interface WriteDispatchPlan {
  readonly description: string;
  readonly input: Record<string, unknown> | undefined;
}

/** Resolves `delete-service`'s gate description directly from config, or reads+parses `create-service`/`update-service`'s `input` file. */
async function planWriteDispatch(
  operation: "create-service" | "update-service" | "delete-service",
  raw: RawSettings,
  paths: Core.M3LPaths,
): Promise<WriteDispatchPlan> {
  if (operation === "delete-service") {
    const cluster = requireString(raw.cluster, "cluster", operation);
    const service = requireString(raw.service, "service", operation);
    return {
      description: buildDeleteGateDescription(cluster, service),
      input: undefined,
    };
  }

  const inputName = requireString(raw.input, "input", operation);
  const parsed = asInputRecord(await readJSONFile(paths, inputName), inputName);
  return {
    description: buildRecordGateDescription(operation, parsed),
    input: parsed,
  };
}

/** `create-service`/`update-service`/`delete-service`: resolves the operation's plan, gates, then dispatches to `write-service`. */
async function dispatchWriteService(
  operation: "create-service" | "update-service" | "delete-service",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const plan = await planWriteDispatch(operation, raw, deps.paths);
  await runGate(plan.description, raw.yes, deps);

  const { writeService } = await import("./write-service.js");
  return writeService({
    operations: deps.operations,
    operation,
    input: plan.input,
    cluster: raw.cluster,
    service: raw.service,
    force: raw.force,
  });
}

/** The four dispatch families `ecs-ops` routes operations into. */
type DispatchGroup = "read-services" | "read-clusters" | "write" | "wait";

/**
 * Which dispatch family each operation belongs to. Keyed as a
 * `Record<EcsOperation, …>` so a new operation added to {@link ECS_OPERATIONS}
 * without a corresponding entry here is a compile error.
 */
const DISPATCH_GROUP: Record<EcsOperation, DispatchGroup> = {
  "list-services": "read-services",
  "describe-service": "read-services",
  "create-service": "write",
  "update-service": "write",
  "delete-service": "write",
  "wait-services-stable": "wait",
  "list-clusters": "read-clusters",
  "describe-cluster": "read-clusters",
};

/** Narrows `operation` to `list-services`/`describe-service`, matching {@link DISPATCH_GROUP}'s `"read-services"` entries. */
function isReadServicesOperation(
  operation: EcsOperation,
): operation is "list-services" | "describe-service" {
  return operation === "list-services" || operation === "describe-service";
}

/** Narrows `operation` to `list-clusters`/`describe-cluster`, matching {@link DISPATCH_GROUP}'s `"read-clusters"` entries. */
function isReadClustersOperation(
  operation: EcsOperation,
): operation is "list-clusters" | "describe-cluster" {
  return operation === "list-clusters" || operation === "describe-cluster";
}

/** Narrows `operation` to the three mutating service operations, matching {@link DISPATCH_GROUP}'s `"write"` entries. */
function isWriteOperation(
  operation: EcsOperation,
): operation is "create-service" | "update-service" | "delete-service" {
  return (
    operation === "create-service" ||
    operation === "update-service" ||
    operation === "delete-service"
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
  operation: EcsOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const group = DISPATCH_GROUP[operation];
  switch (group) {
    case "read-services": {
      if (!isReadServicesOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a read-services operation`,
          { code: "ERR_ECS_OPS_CONFIG" },
        );
      }
      return dispatchReadServices(operation, raw, deps);
    }
    case "read-clusters": {
      if (!isReadClustersOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a read-clusters operation`,
          { code: "ERR_ECS_OPS_CONFIG" },
        );
      }
      return dispatchReadClusters(operation, raw, deps);
    }
    case "write": {
      if (!isWriteOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a write operation`,
          { code: "ERR_ECS_OPS_CONFIG" },
        );
      }
      return dispatchWriteService(operation, raw, deps);
    }
    case "wait":
      return dispatchWait(raw, deps);
    default: {
      const exhaustive: never = group;
      throw new Core.M3LError(
        `unhandled dispatch group: ${String(exhaustive)}`,
        { code: "ERR_ECS_OPS_CONFIG" },
      );
    }
  }
}

/** Resolves the raw, per-operation-optional config values `run-ecs-ops` reads once, up front. */
function readRawSettings(config: Core.M3LConfig): RawSettings {
  return {
    cluster: readOptionalString(config, "cluster"),
    service: readOptionalString(config, "service"),
    services: readOptionalString(config, "services"),
    input: readOptionalString(config, "input"),
    nextToken: readOptionalString(config, "nextToken"),
    force: readBoolWithDefault(config, "force", FORCE_DEFAULT),
    maxWaitTime: readOptionalNumber(config, "maxWaitTime"),
    yes: readBoolWithDefault(config, "yes", YES_DEFAULT),
  };
}

/** Persists `result` to `output` (when configured) via `Core.M3LJSONFileExporter`. */
async function persistOutput(
  paths: Core.M3LPaths,
  output: string | undefined,
  result: DispatchResult,
): Promise<void> {
  if (output === undefined) return;
  const exporter = new Core.M3LJSONFileExporter({
    filePath: paths.resolveOutput(output),
  });
  await exporter.export(result);
}

/**
 * Throws `ERR_ECS_OPS_WAIT_NOT_STABLE` when `operation` is
 * `wait-services-stable` and the resolved `M3LECSWaiterResult.state` is not
 * `"SUCCESS"` — called *after* {@link persistOutput}, so the timeout/abort
 * reason survives on disk even though the run then fails.
 */
function assertWaitStable(
  operation: EcsOperation,
  result: DispatchResult,
  correlationId: string,
): void {
  if (operation !== "wait-services-stable") return;
  const waiterResult = result as AWS.M3LECSWaiterResult;
  if (waiterResult.state === "SUCCESS") return;
  throw new Core.M3LError(
    `ecs-ops run ${correlationId}: wait-services-stable resolved '${waiterResult.state}', not SUCCESS`,
    {
      code: "ERR_ECS_OPS_WAIT_NOT_STABLE",
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
 * Composes the `ecs-ops` pipeline end to end: resolves + guard-checks
 * config, runs `Core.confirmDestructive` for every mutating operation, dispatches to
 * the operation-appropriate step, persists the result to `output` (when
 * configured) via `Core.M3LJSONFileExporter`, and — for
 * `wait-services-stable` — throws once the result has had a chance to be
 * persisted first.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LECSOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once the run completes successfully.
 * @throws {@link Core.M3LError} coded `"ERR_ECS_OPS_CONFIG"` when a
 *   guard-checked per-operation requirement is unmet, `input` fails to read
 *   or parse, or `operation` is outside the declared set (unreachable
 *   through the config schema's `oneOf` validator, guarded here
 *   defensively).
 * @throws {@link Core.M3LError} coded `"ERR_ECS_OPS_ABORTED"` when the
 *   destructive-operation confirmation is declined.
 * @throws {@link Core.M3LError} coded `"ERR_ECS_OPS_WAIT_NOT_STABLE"` when
 *   `wait-services-stable` resolves a `M3LECSWaiterResult` whose `state` is
 *   not `"SUCCESS"` — thrown *after* the result has been persisted to
 *   `output`, when configured, so the timeout/abort reason is still on disk
 *   for diagnosis.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runEcsOps } from "./run-ecs-ops.js";
 *
 * declare const operations: AWS.M3LECSOperations;
 *
 * await runEcsOps({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "ecs-ops", version: "0.0.0" },
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
export async function runEcsOps(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly operations: AWS.M3LECSOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const operation = readOperation(deps.config);
  const raw = readRawSettings(deps.config);
  const output = readOptionalString(deps.config, "output");

  const result = await dispatchOperation(operation, raw, {
    paths: deps.paths,
    logger: deps.logger,
    operations: deps.operations,
    prompt: deps.prompt,
  });

  await persistOutput(deps.paths, output, result);
  assertWaitStable(operation, result, deps.correlationId);

  deps.logger.step(`ecs-ops run ${deps.correlationId} complete`, {
    operation,
    ...(raw.cluster !== undefined && { cluster: raw.cluster }),
    ...(raw.service !== undefined && { service: raw.service }),
    ...(raw.services !== undefined && { services: raw.services }),
  });
}
