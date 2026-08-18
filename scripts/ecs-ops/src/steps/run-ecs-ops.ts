import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { ECS_OPERATIONS, FORCE_DEFAULT, YES_DEFAULT } from "../config.js";

/** The closed union of `ecs-ops`'s declared `operation` values. */
type EcsOperation = (typeof ECS_OPERATIONS)[number];

/** The raw, per-operation-optional config values `run-ecs-ops` resolves once, up front. */
interface RawSettings {
  readonly cluster: string | undefined;
  readonly service: string | undefined;
  readonly services: readonly string[] | undefined;
  readonly input: string | undefined;
  readonly nextToken: string | undefined;
  readonly force: boolean;
  readonly maxWaitTime: number | undefined;
  readonly yes: boolean;
  readonly output: string | undefined;
}

/** The full dependency bag `runEcsOps` receives and the pipeline threads through. */
interface Deps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly correlationId: string;
  readonly operations: AWS.M3LECSOperations;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | AWS.M3LECSListServicesResult
  | AWS.M3LECSServiceDescription
  | AWS.M3LECSWaiterResult
  | AWS.M3LECSListClustersResult
  | AWS.M3LECSClusterSummary;

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
  record: Readonly<Record<string, unknown>>,
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

/**
 * Builds a fresh `Core.M3LConfigAccessor` over `deps.config`, coded
 * `ERR_ECS_OPS_CONFIG`. `M3LOperationHandlers`/`prepare` only receive the
 * pipeline's `deps` bag — not the engine's own internal accessor — so the
 * one remaining site that still needs a config read outside the engine's own
 * phases (the completion-log re-read in {@link runEcsOps}) builds its own.
 * `M3LConfigAccessor` is a stateless read-through wrapper, so constructing a
 * fresh one per call is behaviorally identical to sharing one instance.
 */
function buildAccessor(deps: Deps): Core.M3LConfigAccessor {
  return new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_ECS_OPS_CONFIG",
  });
}

/** Builds a fresh `Core.M3LInputFileReader` over `deps.paths`, coded `ERR_ECS_OPS_CONFIG` — see {@link buildAccessor}. */
function buildReader(deps: Deps): Core.M3LInputFileReader {
  return new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_ECS_OPS_CONFIG",
  });
}

/**
 * Narrows an already-guarded optional settings field to its defined value,
 * throwing a defensive `ERR_ECS_OPS_CONFIG` otherwise. The pipeline's
 * `requiredFields` guard (phase 4) has already enforced presence for every
 * field callers read this way before those callers are ever invoked — this
 * is a type-narrowing safety net, not an expected runtime path.
 */
function requireDefined<TValue>(
  value: TValue | undefined,
  name: string,
): TValue {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_ECS_OPS_CONFIG",
    });
  }
  return value;
}

/**
 * Which of `cluster`/`service`/`services`/`input` each operation requires,
 * checked via `Core.M3LConfigAccessor.requiredFor` in the engine's own
 * "Guards" phase (phase 4) — before `prepare`, the destructive gate, or any
 * handler ever runs. Keyed as a `Record<EcsOperation, …>` so a new operation
 * added to {@link ECS_OPERATIONS} without a corresponding entry here is a
 * compile error. `wait-services-stable`'s non-empty-segments-after-split
 * check is content validation, not presence, and stays inline in
 * `dispatchWait`.
 */
const REQUIRED_FIELDS: Record<
  EcsOperation,
  readonly Core.M3LGuardableKey<RawSettings>[]
> = {
  "list-services": [],
  "describe-service": ["cluster", "service"],
  "create-service": ["input"],
  "update-service": ["input"],
  "delete-service": ["cluster", "service"],
  "wait-services-stable": ["cluster", "services"],
  "list-clusters": [],
  "describe-cluster": ["cluster"],
};

/**
 * Resolves the raw, per-operation-optional config values the pipeline reads
 * once, up front. Must not re-read `"operation"` or apply its own
 * required-field guards — those are owned by the engine's own "Operation"
 * and "Guards" phases (the latter driven by {@link REQUIRED_FIELDS}).
 */
function resolveSettings(accessor: Core.M3LConfigAccessor): RawSettings {
  return {
    cluster: accessor.optionalString("cluster"),
    service: accessor.optionalString("service"),
    services: accessor.optionalStringArray("services"),
    input: accessor.optionalString("input"),
    nextToken: accessor.optionalString("nextToken"),
    force: accessor.booleanWithDefault("force", FORCE_DEFAULT),
    maxWaitTime: accessor.optionalNumber("maxWaitTime"),
    yes: accessor.booleanWithDefault("yes", YES_DEFAULT),
    output: accessor.optionalString("output"),
  };
}

/** The per-write-operation description/input resolved before gating. */
interface WriteDispatchPlan {
  readonly description: string;
  readonly input: Record<string, unknown> | undefined;
}

/**
 * Narrows `prepare`'s `WriteDispatchPlan | undefined` context to a defined
 * plan. `TContext` is uniform across every handler table entry (it is
 * `WriteDispatchPlan | undefined` for every operation, not just the three
 * write ones), but `prepare` only ever produces a defined plan for
 * `create-service`/`update-service`/`delete-service` — an `undefined`
 * context reaching a write handler or the destructive `describe` callback is
 * unreachable except via caller misuse of the engine, guarded here
 * defensively.
 */
function requireWritePlan(
  context: WriteDispatchPlan | undefined,
  operation: "create-service" | "update-service" | "delete-service",
): WriteDispatchPlan {
  if (context === undefined) {
    throw new Core.M3LError(
      `internal: no write-dispatch plan resolved for '${operation}'`,
      { code: "ERR_ECS_OPS_CONFIG" },
    );
  }
  return context;
}

/**
 * Narrows `destructive.describe`'s `operation` — typed as the full
 * `EcsOperation` union (the engine's `M3LPipelineDestructiveOptions.describe`
 * signature is not narrowed to `destructive.operations`'s subset) — to the
 * three write operations. The engine only invokes `describe` for a member of
 * `destructive.operations`, so reaching the defensive throw means the engine
 * itself miscalled it.
 */
function requireWriteOperation(
  operation: EcsOperation,
): "create-service" | "update-service" | "delete-service" {
  if (
    operation === "create-service" ||
    operation === "update-service" ||
    operation === "delete-service"
  ) {
    return operation;
  }
  throw new Core.M3LError(
    `internal: destructive gate invoked for non-destructive operation '${operation}'`,
    { code: "ERR_ECS_OPS_CONFIG" },
  );
}

/**
 * The pipeline's `prepare` phase: runs once per run, before the destructive
 * gate, for every operation. Resolves `delete-service`'s gate description
 * directly from config, or reads+parses `create-service`/`update-service`'s
 * `input` file (the one place either file is ever read). Presence of
 * `cluster`/`service`/`input` is already enforced by the engine's "Guards"
 * phase (phase 4, driven by {@link REQUIRED_FIELDS}) before `prepare` ever
 * runs — the {@link requireDefined} calls below are a defensive type-narrowing
 * safety net, not a runtime guard. Every non-write operation resolves
 * `undefined`.
 */
async function prepareWriteDispatch(
  operation: EcsOperation,
  raw: RawSettings,
  deps: Deps,
): Promise<WriteDispatchPlan | undefined> {
  switch (operation) {
    case "delete-service": {
      const cluster = requireDefined(raw.cluster, "cluster");
      const service = requireDefined(raw.service, "service");
      return {
        description: buildDeleteGateDescription(cluster, service),
        input: undefined,
      };
    }
    case "create-service":
    case "update-service": {
      const inputName = requireDefined(raw.input, "input");
      const parsed = await buildReader(deps).readJSONRecord(inputName);
      return {
        description: buildRecordGateDescription(operation, parsed),
        input: { ...parsed },
      };
    }
    case "list-services":
    case "describe-service":
    case "wait-services-stable":
    case "list-clusters":
    case "describe-cluster":
      return undefined;
    default: {
      const exhaustive: never = operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_ECS_OPS_CONFIG",
      });
    }
  }
}

/** `list-services`/`describe-service`: dispatches to `read-services`. Cross-parameter presence for `describe-service` is enforced by the engine's Guards phase before this runs — see {@link REQUIRED_FIELDS}. */
async function dispatchReadServices(
  operation: "list-services" | "describe-service",
  raw: RawSettings,
  _context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const { readServices } = await import("./read-services.js");
  return readServices({
    operations: deps.operations,
    operation,
    cluster: raw.cluster,
    service: raw.service,
    nextToken: raw.nextToken,
  });
}

/** `list-clusters`/`describe-cluster`: dispatches to `read-clusters`. Cross-parameter presence for `describe-cluster` is enforced by the engine's Guards phase before this runs — see {@link REQUIRED_FIELDS}. */
async function dispatchReadClusters(
  operation: "list-clusters" | "describe-cluster",
  raw: RawSettings,
  _context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const { readClusters } = await import("./read-clusters.js");
  return readClusters({
    operations: deps.operations,
    operation,
    cluster: raw.cluster,
    nextToken: raw.nextToken,
  });
}

/**
 * `wait-services-stable`: dispatches to `wait-services`. Never gated.
 * Presence of `cluster`/`services` is enforced by the engine's Guards phase
 * (see {@link REQUIRED_FIELDS}); the non-empty-segments-after-split check
 * below is content validation the engine cannot express, so it stays inline.
 */
async function dispatchWait(
  _operation: "wait-services-stable",
  raw: RawSettings,
  _context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const cluster = requireDefined(raw.cluster, "cluster");
  const services = requireDefined(raw.services, "services");
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

/** `create-service`/`update-service`/`delete-service`: dispatches to `write-service` using the plan `prepare` resolved before the gate. */
async function dispatchWriteService(
  operation: "create-service" | "update-service" | "delete-service",
  raw: RawSettings,
  context: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const plan = requireWritePlan(context, operation);
  const { writeService } = await import("./write-service.js");
  return writeService({
    operations: deps.operations,
    reader: buildReader(deps),
    operation,
    input: plan.input,
    cluster: raw.cluster,
    service: raw.service,
    force: raw.force,
  });
}

/**
 * The `ecs-ops` pipeline: resolve settings -&gt; (for every operation) plan
 * a write dispatch -&gt; (for `create-service`/`update-service`/`delete-service`)
 * the destructive-operation gate -&gt; the operation-appropriate step -&gt;
 * persist the result to `output` (when configured) -&gt; assert
 * `wait-services-stable` resolved `SUCCESS`, all owned by
 * `Core.M3LOperationPipeline`. Built once at module load — a pipeline
 * instance is stateless across `run()` calls.
 *
 * A declined destructive-operation gate (`ERR_ECS_OPS_ABORTED`) propagates
 * to the caller unmodified (`onDecline: { kind: "throw" }`) — unlike
 * `s3-objects`, a decline here aborts the whole run rather than soft-landing
 * an empty result.
 */
const pipeline = new Core.M3LOperationPipeline<
  EcsOperation,
  RawSettings,
  Deps,
  DispatchResult,
  WriteDispatchPlan | undefined
>({
  operations: ECS_OPERATIONS,
  configCode: "ERR_ECS_OPS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  prepare: prepareWriteDispatch,
  destructive: {
    operations: new Set([
      "create-service",
      "update-service",
      "delete-service",
    ] as const),
    describe: (operation, _settings, context) =>
      requireWritePlan(context, requireWriteOperation(operation)).description,
    yes: (settings) => settings.yes,
    abortCode: "ERR_ECS_OPS_ABORTED",
    onDecline: { kind: "throw" },
  },
  handlers: {
    "list-services": dispatchReadServices,
    "describe-service": dispatchReadServices,
    "create-service": dispatchWriteService,
    "update-service": dispatchWriteService,
    "delete-service": dispatchWriteService,
    "wait-services-stable": dispatchWait,
    "list-clusters": dispatchReadClusters,
    "describe-cluster": dispatchReadClusters,
  },
  persist: async (result, settings, deps) => {
    if (settings.output === undefined) return;
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(settings.output),
    });
    await exporter.export(result);
  },
  finalize: (result, _settings, deps, operation) => {
    if (operation !== "wait-services-stable") return;
    const waiterResult = result as AWS.M3LECSWaiterResult;
    if (waiterResult.state === "SUCCESS") return;
    throw new Core.M3LError(
      `ecs-ops run ${deps.correlationId}: wait-services-stable resolved '${waiterResult.state}', not SUCCESS`,
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
  },
});

/**
 * Composes the `ecs-ops` pipeline end to end via
 * `Core.M3LOperationPipeline`: resolves + guard-checks config, runs
 * `Core.confirmDestructive` for every mutating operation, dispatches to the
 * operation-appropriate step, persists the result to `output` (when
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
export async function runEcsOps(deps: Deps): Promise<void> {
  const outcome = await pipeline.run(deps);

  // Re-derives the same cluster/service/services log context the
  // pre-migration orchestrator read once up front — `M3LOperationPipeline`'s
  // outcome doesn't carry the resolved settings, and this stays a pure
  // config read with no side effect, so recomputing it here (after `run()`
  // resolves, so it never fires when `finalize` throws) preserves the
  // completion log's shape.
  const accessor = buildAccessor(deps);
  const cluster = accessor.optionalString("cluster");
  const service = accessor.optionalString("service");
  const services = accessor.optionalStringArray("services");

  deps.logger.step(`ecs-ops run ${deps.correlationId} complete`, {
    operation: outcome.operation,
    ...(cluster !== undefined && { cluster }),
    ...(service !== undefined && { service }),
    ...(services !== undefined && { services: services.join(",") }),
  });
}
