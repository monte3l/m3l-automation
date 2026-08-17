import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  EKS_OPS_OPERATIONS,
  FORCE_DEFAULT,
  MAX_WAIT_TIME_DEFAULT,
  YES_DEFAULT,
} from "../config.js";

/**
 * `steps/run-eks-ops` — the dispatcher for all 16 {@link EKS_OPS_OPERATIONS}.
 * Delegates all orchestration to `Core.M3LOperationPipeline`: resolves and
 * guard-checks config per operation, reads + JSON-parses `input` for the four
 * input-bearing operations (in the `prepare` phase), runs
 * `Core.confirmDestructive` for every mutating operation, dispatches via an
 * exhaustive per-operation handler table (cluster read/wait/write, nodegroup
 * read/wait/write), persists the result to `output` before throwing on a
 * not-found/failed/incomplete outcome. See `docs/reference/scripts/eks-ops.md`.
 *
 * @packageDocumentation
 */

/** The closed union of `eks-ops`'s declared `operation` values. */
type EksOperation = (typeof EKS_OPS_OPERATIONS)[number];

/** The raw, per-operation-optional config values `run-eks-ops` resolves once, up front. */
interface RawSettings {
  readonly cluster: string | undefined;
  readonly nodegroup: string | undefined;
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly kubernetesVersion: string | undefined;
  readonly releaseVersion: string | undefined;
  readonly force: boolean;
  readonly maxResults: number | undefined;
  readonly nextToken: string | undefined;
  readonly include: readonly string[] | undefined;
  readonly maxWaitTime: number;
  readonly yes: boolean;
}

/** The full dependency bag `runEksOps` receives and the pipeline threads through. */
interface Deps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly operations: AWS.M3LEKSOperations;
}

/**
 * The union of result shapes any dispatched operation can resolve. Read
 * handlers throw `ERR_EKS_OPS_NOT_FOUND` rather than returning `undefined`,
 * so this union contains no `undefined` member.
 */
type DispatchResult =
  | AWS.M3LEKSListClustersResult
  | AWS.M3LEKSClusterSummary
  | AWS.M3LEKSUpdate
  | AWS.M3LEKSWaiterResult
  | AWS.M3LEKSListNodegroupsResult
  | AWS.M3LEKSNodegroupSummary;

/** What the `prepare` phase returns for every write/delete/wait-version operation. */
interface PrepareResult {
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Builds a fresh `Core.M3LConfigAccessor` over `deps.config`, coded
 * `ERR_EKS_OPS_CONFIG`. `M3LOperationHandlers`/`prepare` only receive the
 * pipeline's `deps` bag — the one remaining site that still needs a config
 * read outside the engine's own phases (the completion-log re-read in
 * {@link runEksOps}) builds its own. `M3LConfigAccessor` is a stateless
 * read-through wrapper, so constructing a fresh one per call is behaviorally
 * identical to sharing one instance.
 */
function buildAccessor(deps: Deps): Core.M3LConfigAccessor {
  return new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_EKS_OPS_CONFIG",
  });
}

/** Builds a fresh `Core.M3LInputFileReader` over `deps.paths`, coded `ERR_EKS_OPS_CONFIG` — see {@link buildAccessor}. */
function buildReader(deps: Deps): Core.M3LInputFileReader {
  return new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_EKS_OPS_CONFIG",
  });
}

/**
 * Narrows an already-guarded optional settings field to its defined value,
 * throwing a defensive `ERR_EKS_OPS_CONFIG` otherwise. The pipeline's
 * `requiredFields` guard (phase 3) has already enforced presence for every
 * field callers read this way before those callers are ever invoked — this
 * is a type-narrowing safety net, not an expected runtime path.
 */
function requireDefined<TValue>(
  value: TValue | undefined,
  name: string,
): TValue {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_EKS_OPS_CONFIG",
    });
  }
  return value;
}

/**
 * Narrows `prepare`'s `PrepareResult | undefined` context to a defined plan.
 * An `undefined` context reaching a destructive handler or the `describe`
 * callback is unreachable except via engine misuse — guarded here
 * defensively.
 */
function requireContext(
  context: PrepareResult | undefined,
  operation: EksOperation,
): PrepareResult {
  if (context === undefined) {
    throw new Core.M3LError(
      `internal: no prepare result for operation '${operation}'`,
      { code: "ERR_EKS_OPS_CONFIG" },
    );
  }
  return context;
}

/**
 * Which of `cluster`/`nodegroup`/`input`/`kubernetesVersion` each operation
 * requires, checked via `Core.M3LConfigAccessor.requiredFor` in the engine's
 * own "Guards" phase (phase 3) — before `prepare`, the destructive gate, or
 * any handler ever runs. Keyed as `Record<EksOperation, …>` so adding an
 * operation without a corresponding entry is a compile error.
 */
const REQUIRED_FIELDS: Record<
  EksOperation,
  readonly Core.M3LGuardableKey<RawSettings>[]
> = {
  "list-clusters": [],
  "describe-cluster": ["cluster"],
  "create-cluster": ["cluster", "input"],
  "update-cluster-config": ["cluster", "input"],
  "update-cluster-version": ["cluster", "kubernetesVersion"],
  "delete-cluster": ["cluster"],
  "wait-cluster-active": ["cluster"],
  "wait-cluster-deleted": ["cluster"],
  "list-nodegroups": ["cluster"],
  "describe-nodegroup": ["cluster", "nodegroup"],
  "create-nodegroup": ["cluster", "nodegroup", "input"],
  "update-nodegroup-config": ["cluster", "nodegroup", "input"],
  "update-nodegroup-version": ["cluster", "nodegroup"],
  "delete-nodegroup": ["cluster", "nodegroup"],
  "wait-nodegroup-active": ["cluster", "nodegroup"],
  "wait-nodegroup-deleted": ["cluster", "nodegroup"],
};

/**
 * The four mutating operations that need a gate description but carry no
 * `input` file: matched with `Set.has` to avoid a four-arm `||` chain in
 * {@link prepare} that would push its cyclomatic complexity over the
 * scripts-zone cap of 10.
 */
const MUTATING_NO_INPUT: ReadonlySet<EksOperation> = new Set([
  "delete-cluster",
  "update-cluster-version",
  "delete-nodegroup",
  "update-nodegroup-version",
] as const);

/**
 * Resolves the raw, per-operation-optional config values the pipeline reads
 * once, up front. Must not re-read `"operation"` or apply its own
 * required-field guards — those are owned by the engine's own "Operation"
 * and "Guards" phases (the latter driven by {@link REQUIRED_FIELDS}).
 */
function resolveSettings(accessor: Core.M3LConfigAccessor): RawSettings {
  return {
    cluster: accessor.optionalString("cluster"),
    nodegroup: accessor.optionalString("nodegroup"),
    input: accessor.optionalString("input"),
    output: accessor.optionalString("output"),
    kubernetesVersion: accessor.optionalString("kubernetesVersion"),
    releaseVersion: accessor.optionalString("releaseVersion"),
    force: accessor.booleanWithDefault("force", FORCE_DEFAULT),
    maxResults: accessor.optionalNumber("maxResults"),
    nextToken: accessor.optionalString("nextToken"),
    include: accessor.optionalStringArray("include"),
    maxWaitTime: accessor.numberWithDefault(
      "maxWaitTime",
      MAX_WAIT_TIME_DEFAULT,
    ),
    yes: accessor.booleanWithDefault("yes", YES_DEFAULT),
  };
}

/**
 * Validates the `create-cluster` `input` file's required structure:
 * `roleArn` must be a non-empty string, `resourcesVpcConfig` must be a
 * record with a non-empty `subnetIds` array. Guards presence and type only —
 * semantic SDK constraints are the wrapper's responsibility.
 */
function validateClusterCreateInput(
  record: Readonly<Record<string, unknown>>,
  deps: Deps,
): void {
  const reader = buildReader(deps);
  reader.requiredStringField(record, "roleArn", "create-cluster");
  const vpcConfig = reader.requireRecord(
    reader.optionalRecordField(record, "resourcesVpcConfig"),
    "resourcesVpcConfig",
    "create-cluster",
  );
  reader.requiredArrayField(vpcConfig, "subnetIds", "create-cluster");
}

/**
 * Validates the `create-nodegroup` `input` file's required structure:
 * `nodeRole` must be a non-empty string and `subnets` must be an array.
 */
function validateNodegroupCreateInput(
  record: Readonly<Record<string, unknown>>,
  deps: Deps,
): void {
  const reader = buildReader(deps);
  reader.requiredStringField(record, "nodeRole", "create-nodegroup");
  reader.requiredArrayField(record, "subnets", "create-nodegroup");
}

/** Reads + parses the `input` file for `create-cluster`/`update-cluster-config`, validating create's required fields. */
async function prepareClusterInput(
  operation: "create-cluster" | "update-cluster-config",
  raw: RawSettings,
  deps: Deps,
  description: string,
): Promise<PrepareResult> {
  const inputName = requireDefined(raw.input, "input");
  const parsed = await buildReader(deps).readJSONRecord(inputName);
  if (operation === "create-cluster") {
    validateClusterCreateInput(parsed, deps);
  }
  return { description, input: { ...parsed } };
}

/** Reads + parses the `input` file for `create-nodegroup`/`update-nodegroup-config`, validating create's required fields. */
async function prepareNodegroupInput(
  operation: "create-nodegroup" | "update-nodegroup-config",
  raw: RawSettings,
  deps: Deps,
  description: string,
): Promise<PrepareResult> {
  const inputName = requireDefined(raw.input, "input");
  const parsed = await buildReader(deps).readJSONRecord(inputName);
  if (operation === "create-nodegroup") {
    validateNodegroupCreateInput(parsed, deps);
  }
  return { description, input: { ...parsed } };
}

/**
 * The pipeline's `prepare` phase: runs once per run, before the destructive
 * gate, for every operation. Resolves a {@link PrepareResult} (description +
 * optional parsed input) for every write/delete operation, `undefined` for
 * read and wait operations. Presence of `cluster`/`nodegroup`/`input` is
 * already enforced by the engine's Guards phase (phase 3) before `prepare`
 * ever runs — the {@link requireDefined} calls in sub-helpers are a defensive
 * type-narrowing safety net, not runtime guards.
 */
async function prepare(
  operation: EksOperation,
  raw: RawSettings,
  deps: Deps,
): Promise<PrepareResult | undefined> {
  const cluster = raw.cluster ?? "";
  const target =
    raw.nodegroup !== undefined
      ? `cluster '${cluster}' nodegroup '${raw.nodegroup}'`
      : `cluster '${cluster}'`;
  const description = `${operation} ${target}`;

  if (operation === "create-cluster" || operation === "update-cluster-config") {
    return prepareClusterInput(operation, raw, deps, description);
  }
  if (
    operation === "create-nodegroup" ||
    operation === "update-nodegroup-config"
  ) {
    return prepareNodegroupInput(operation, raw, deps, description);
  }
  if (MUTATING_NO_INPUT.has(operation)) {
    return { description, input: undefined };
  }
  return undefined;
}

/**
 * `list-clusters`/`describe-cluster`: dispatches to `read-clusters`.
 * Throws `ERR_EKS_OPS_NOT_FOUND` if the step resolves `undefined` (only
 * possible for `describe-cluster` when no matching cluster is found). The
 * NOT_FOUND check is placed here, in the Dispatch phase, so the Persist
 * phase never runs for a missing resource.
 */
async function dispatchReadClusters(
  operation: "list-clusters" | "describe-cluster",
  raw: RawSettings,
  _context: PrepareResult | undefined,
  deps: Deps,
): Promise<AWS.M3LEKSListClustersResult | AWS.M3LEKSClusterSummary> {
  const { readClusters } = await import("./read-clusters.js");
  const result = await readClusters({
    operations: deps.operations,
    operation,
    cluster: raw.cluster,
    nextToken: raw.nextToken,
    maxResults: raw.maxResults,
    include: raw.include,
  });
  if (result === undefined) {
    throw new Core.M3LError(
      `eks-ops: ${operation} resolved no matching resource`,
      { code: "ERR_EKS_OPS_NOT_FOUND" },
    );
  }
  return result;
}

/** `wait-cluster-active`/`wait-cluster-deleted`: dispatches to `wait-cluster`. Never gated. */
async function dispatchWaitCluster(
  operation: "wait-cluster-active" | "wait-cluster-deleted",
  raw: RawSettings,
  _context: PrepareResult | undefined,
  deps: Deps,
): Promise<AWS.M3LEKSWaiterResult> {
  const cluster = requireDefined(raw.cluster, "cluster");
  const { waitCluster } = await import("./wait-cluster.js");
  return waitCluster({
    operations: deps.operations,
    operation,
    cluster,
    maxWaitTime: raw.maxWaitTime,
  });
}

/**
 * `create-cluster`/`update-cluster-config`/`update-cluster-version`/
 * `delete-cluster`: dispatches to `write-cluster` using the plan `prepare`
 * resolved before the gate. `requireContext` and `requireDefined` are
 * type-narrowing safety nets — the engine's Guards and prepare phases already
 * enforce presence before this handler is ever invoked.
 */
async function dispatchWriteCluster(
  operation:
    | "create-cluster"
    | "update-cluster-config"
    | "update-cluster-version"
    | "delete-cluster",
  raw: RawSettings,
  context: PrepareResult | undefined,
  deps: Deps,
): Promise<AWS.M3LEKSClusterSummary | AWS.M3LEKSUpdate> {
  const plan = requireContext(context, operation);
  const { writeCluster } = await import("./write-cluster.js");
  return writeCluster({
    operations: deps.operations,
    operation,
    cluster: requireDefined(raw.cluster, "cluster"),
    input: plan.input,
    kubernetesVersion: raw.kubernetesVersion,
    force: raw.force,
  });
}

/**
 * `list-nodegroups`/`describe-nodegroup`: dispatches to `read-nodegroups`.
 * Throws `ERR_EKS_OPS_NOT_FOUND` if the step resolves `undefined` (only
 * possible for `describe-nodegroup`).
 */
async function dispatchReadNodegroups(
  operation: "list-nodegroups" | "describe-nodegroup",
  raw: RawSettings,
  _context: PrepareResult | undefined,
  deps: Deps,
): Promise<AWS.M3LEKSListNodegroupsResult | AWS.M3LEKSNodegroupSummary> {
  const cluster = requireDefined(raw.cluster, "cluster");
  const { readNodegroups } = await import("./read-nodegroups.js");
  const result = await readNodegroups({
    operations: deps.operations,
    operation,
    cluster,
    nodegroup: raw.nodegroup,
    nextToken: raw.nextToken,
    maxResults: raw.maxResults,
  });
  if (result === undefined) {
    throw new Core.M3LError(
      `eks-ops: ${operation} resolved no matching resource`,
      { code: "ERR_EKS_OPS_NOT_FOUND" },
    );
  }
  return result;
}

/** `wait-nodegroup-active`/`wait-nodegroup-deleted`: dispatches to `wait-nodegroup`. Never gated. */
async function dispatchWaitNodegroup(
  operation: "wait-nodegroup-active" | "wait-nodegroup-deleted",
  raw: RawSettings,
  _context: PrepareResult | undefined,
  deps: Deps,
): Promise<AWS.M3LEKSWaiterResult> {
  const cluster = requireDefined(raw.cluster, "cluster");
  const nodegroup = requireDefined(raw.nodegroup, "nodegroup");
  const { waitNodegroup } = await import("./wait-nodegroup.js");
  return waitNodegroup({
    operations: deps.operations,
    operation,
    cluster,
    nodegroup,
    maxWaitTime: raw.maxWaitTime,
  });
}

/**
 * `create-nodegroup`/`update-nodegroup-config`/`update-nodegroup-version`/
 * `delete-nodegroup`: dispatches to `write-nodegroup` using the plan
 * `prepare` resolved before the gate.
 */
async function dispatchWriteNodegroup(
  operation:
    | "create-nodegroup"
    | "update-nodegroup-config"
    | "update-nodegroup-version"
    | "delete-nodegroup",
  raw: RawSettings,
  context: PrepareResult | undefined,
  deps: Deps,
): Promise<AWS.M3LEKSNodegroupSummary | AWS.M3LEKSUpdate> {
  const plan = requireContext(context, operation);
  const { writeNodegroup } = await import("./write-nodegroup.js");
  return writeNodegroup({
    operations: deps.operations,
    operation,
    cluster: requireDefined(raw.cluster, "cluster"),
    nodegroup: requireDefined(raw.nodegroup, "nodegroup"),
    input: plan.input,
    kubernetesVersion: raw.kubernetesVersion,
    releaseVersion: raw.releaseVersion,
    force: raw.force,
  });
}

/**
 * True when `result` is a `wait-*` outcome — the only members of
 * {@link DispatchResult} carrying a `state` field. `finalize` is not passed
 * `operation` (it is not part of the engine's `finalize` contract), so this
 * structural check is how it recognizes a wait result.
 */
function isWaiterResult(
  result: DispatchResult,
): result is AWS.M3LEKSWaiterResult {
  return "state" in result;
}

/**
 * True when `result` is an `update-*` outcome — the only members of
 * {@link DispatchResult} carrying an `id` field (which `M3LEKSWaiterResult`
 * and the summary types do not).
 */
function isUpdateResult(result: DispatchResult): result is AWS.M3LEKSUpdate {
  return "id" in result;
}

/**
 * Builds the run-summary log fields (and the persisted-output shape) for a
 * `wait-*` or `update-*` result, deliberately allowlisting only the fields
 * each type actually declares. Never spreads or `JSON.stringify`s `result`
 * itself: an undeclared field a caller/test double or a future-regressed
 * wrapper attaches beyond the type's own shape must never reach a log line
 * or the persisted file (see § Security note,
 * `docs/reference/scripts/eks-ops.md`).
 */
function buildSafeSummaryFields(
  result: AWS.M3LEKSWaiterResult | AWS.M3LEKSUpdate,
): Record<string, unknown> {
  if ("state" in result) {
    return {
      state: result.state,
      ...(result.reason !== undefined && { reason: result.reason }),
    };
  }
  return {
    id: result.id,
    status: result.status,
    ...(result.type !== undefined && { type: result.type }),
    ...(result.createdAt !== undefined && { createdAt: result.createdAt }),
    ...(result.errors !== undefined && { errors: result.errors }),
  };
}

/**
 * The `eks-ops` pipeline: resolve settings → (for every operation) prepare
 * the write-dispatch plan → (for the 8 mutating operations) the destructive-
 * operation gate → the operation-appropriate step → persist the result to
 * `output` (when configured) → assert wait resolved `SUCCESS` and update
 * resolved non-`Failed`, all owned by `Core.M3LOperationPipeline`. Built
 * once at module load — a pipeline instance is stateless across `run()` calls.
 *
 * A declined destructive-operation gate (`ERR_EKS_OPS_ABORTED`) propagates
 * to the caller unmodified (`onDecline: { kind: "throw" }`).
 */
const pipeline = new Core.M3LOperationPipeline<
  EksOperation,
  RawSettings,
  Deps,
  DispatchResult,
  PrepareResult | undefined
>({
  operations: EKS_OPS_OPERATIONS,
  configCode: "ERR_EKS_OPS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  prepare,
  destructive: {
    operations: new Set([
      "create-cluster",
      "update-cluster-config",
      "update-cluster-version",
      "delete-cluster",
      "create-nodegroup",
      "update-nodegroup-config",
      "update-nodegroup-version",
      "delete-nodegroup",
    ] as const),
    describe: (operation, _settings, context) =>
      requireContext(context, operation).description,
    yes: (settings) => settings.yes,
    abortCode: "ERR_EKS_OPS_ABORTED",
    onDecline: { kind: "throw" },
  },
  handlers: {
    "list-clusters": dispatchReadClusters,
    "describe-cluster": dispatchReadClusters,
    "create-cluster": dispatchWriteCluster,
    "update-cluster-config": dispatchWriteCluster,
    "update-cluster-version": dispatchWriteCluster,
    "delete-cluster": dispatchWriteCluster,
    "wait-cluster-active": dispatchWaitCluster,
    "wait-cluster-deleted": dispatchWaitCluster,
    "list-nodegroups": dispatchReadNodegroups,
    "describe-nodegroup": dispatchReadNodegroups,
    "create-nodegroup": dispatchWriteNodegroup,
    "update-nodegroup-config": dispatchWriteNodegroup,
    "update-nodegroup-version": dispatchWriteNodegroup,
    "delete-nodegroup": dispatchWriteNodegroup,
    "wait-nodegroup-active": dispatchWaitNodegroup,
    "wait-nodegroup-deleted": dispatchWaitNodegroup,
  },
  persist: async (result, settings, deps) => {
    if (settings.output === undefined) return;
    let safeResult: DispatchResult | Record<string, unknown> = result;
    if (isWaiterResult(result) || isUpdateResult(result)) {
      safeResult = buildSafeSummaryFields(result);
    }
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(settings.output),
    });
    await exporter.export(safeResult);
  },
  finalize: (result, _settings, _deps) => {
    if (isWaiterResult(result)) {
      if (result.state === "SUCCESS") return;
      throw new Core.M3LError(
        `eks-ops: wait resolved state '${result.state}'`,
        {
          code: "ERR_EKS_OPS_WAIT_NOT_COMPLETE",
          context: {
            state: result.state,
            ...(result.reason !== undefined && { reason: result.reason }),
          },
        },
      );
    }
    if (isUpdateResult(result)) {
      if (result.status !== "Failed") return;
      throw new Core.M3LError(`eks-ops: update resolved status 'Failed'`, {
        code: "ERR_EKS_OPS_UPDATE_FAILED",
        context: {
          status: result.status,
          ...(result.errors !== undefined && { errors: result.errors }),
        },
      });
    }
  },
});

/**
 * Composes the `eks-ops` pipeline end to end via
 * `Core.M3LOperationPipeline`: resolves + guard-checks config, runs
 * `Core.confirmDestructive` for every mutating operation, dispatches to the
 * operation-appropriate step, converts a `describe-cluster`/
 * `describe-nodegroup` `undefined` result into `ERR_EKS_OPS_NOT_FOUND`
 * before any persist attempt, persists the result to `output` (when
 * configured) via `Core.M3LJSONFileExporter`, logs a scrubbed run summary,
 * then throws `ERR_EKS_OPS_UPDATE_FAILED`/`ERR_EKS_OPS_WAIT_NOT_COMPLETE`
 * on a bad terminal state.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, the injected
 *   `AWS.M3LEKSOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once the run completes successfully.
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_CONFIG"` when a
 *   guard-checked per-operation requirement is unmet, `input` fails to read
 *   or parse, or `operation` is outside the declared set (unreachable
 *   through the config schema's `oneOf` validator, guarded here
 *   defensively).
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_ABORTED"` when the
 *   destructive-operation confirmation is declined.
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_NOT_FOUND"` when
 *   `describe-cluster`/`describe-nodegroup` resolves `undefined`.
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_UPDATE_FAILED"` when an
 *   `update-*` call resolves an `M3LEKSUpdate` whose `status` is
 *   `"Failed"` — thrown *after* the result has been persisted to `output`,
 *   when configured.
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_WAIT_NOT_COMPLETE"` when
 *   a `wait-*` call resolves an `M3LEKSWaiterResult` whose `state` is
 *   `"TIMEOUT"`/`"ABORTED"` — thrown *after* the result has been persisted
 *   to `output`, when configured.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runEksOps } from "./run-eks-ops.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * await runEksOps({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "eks-ops", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   operations,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function runEksOps(deps: Deps): Promise<void> {
  const outcome = await pipeline.run(deps);

  // Re-derives the cluster/nodegroup log context — the outcome carries no
  // settings. This stays a pure config read with no side effect, so
  // recomputing it here (after `run()` resolves, so it never fires when
  // `finalize` throws) preserves the completion log's shape.
  const accessor = buildAccessor(deps);
  const cluster = accessor.optionalString("cluster");
  const nodegroup = accessor.optionalString("nodegroup");

  let summaryFields: Record<string, unknown> = {};
  if (isWaiterResult(outcome.result) || isUpdateResult(outcome.result)) {
    summaryFields = buildSafeSummaryFields(outcome.result);
  }

  deps.logger.step(`eks-ops operation '${outcome.operation}' complete`, {
    operation: outcome.operation,
    ...(cluster !== undefined && { cluster }),
    ...(nodegroup !== undefined && { nodegroup }),
    ...summaryFields,
  });
}
