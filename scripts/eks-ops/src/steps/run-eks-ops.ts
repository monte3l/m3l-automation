import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  EKS_OPS_OPERATIONS,
  FORCE_DEFAULT,
  MAX_WAIT_TIME_DEFAULT,
  YES_DEFAULT,
} from "../config.js";
import { readClusters } from "./read-clusters.js";
import { readNodegroups } from "./read-nodegroups.js";
import { waitCluster } from "./wait-cluster.js";
import { waitNodegroup } from "./wait-nodegroup.js";
import { writeCluster } from "./write-cluster.js";
import { writeNodegroup } from "./write-nodegroup.js";

/**
 * `steps/run-eks-ops` — the dispatcher for all 16 {@link EKS_OPS_OPERATIONS}.
 * Resolves and guard-checks config per operation, JSON-parses `input` for
 * the four input-bearing operations, runs `Core.confirmDestructive` for
 * every mutating operation, dispatches via a two-level exhaustive
 * type-predicate chain (cluster-vs-nodegroup, then read/write/wait), and
 * persists the result to `output` before throwing on a not-found/failed/
 * incomplete outcome. See `docs/reference/scripts/eks-ops.md`.
 *
 * @packageDocumentation
 */

/** The closed union of `eks-ops`'s declared `operation` values. */
type EksOperation = (typeof EKS_OPS_OPERATIONS)[number];

/** The eight cluster-side operations `run-eks-ops` dispatches. */
type ClusterOperation = Exclude<
  EksOperation,
  | "list-nodegroups"
  | "describe-nodegroup"
  | "create-nodegroup"
  | "update-nodegroup-config"
  | "update-nodegroup-version"
  | "delete-nodegroup"
  | "wait-nodegroup-active"
  | "wait-nodegroup-deleted"
>;

/** The eight nodegroup-side operations `run-eks-ops` dispatches. */
type NodegroupOperation = Exclude<EksOperation, ClusterOperation>;

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

/** The dependencies every dispatched operation needs, once `config` has resolved. */
interface DispatchDeps {
  readonly logger: Core.M3LLogger;
  readonly operations: AWS.M3LEKSOperations;
  readonly prompt: Core.M3LPrompt;
  readonly accessor: Core.M3LConfigAccessor;
  readonly reader: Core.M3LInputFileReader;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | AWS.M3LEKSListClustersResult
  | AWS.M3LEKSClusterSummary
  | AWS.M3LEKSUpdate
  | AWS.M3LEKSWaiterResult
  | AWS.M3LEKSListNodegroupsResult
  | AWS.M3LEKSNodegroupSummary
  | undefined;

/**
 * Reads the `operation` parameter, validating it against the declared set.
 * The declared `M3LConfigParameter`'s `oneOf` validator already enforces
 * this at config-load time in the real script; this defensive re-check
 * protects a caller (e.g. a test) that builds a `Core.M3LConfig` directly,
 * bypassing that validation.
 */
function readOperation(accessor: Core.M3LConfigAccessor): EksOperation {
  return accessor.oneOf("operation", EKS_OPS_OPERATIONS);
}

/** Resolves the raw, per-operation-optional config values `run-eks-ops` reads once, up front. */
function readRawSettings(accessor: Core.M3LConfigAccessor): RawSettings {
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
 * Formats the gate description from the already-resolved `cluster`/
 * `nodegroup` config values and runs `Core.confirmDestructive` — every
 * mutating operation routes through this before dispatch. Description
 * formatting is folded in here rather than kept as a separate helper: both
 * call sites use it for nothing else.
 */
async function gateOperation(
  operation: string,
  raw: RawSettings,
  deps: Pick<DispatchDeps, "prompt" | "logger">,
): Promise<void> {
  const target =
    raw.nodegroup !== undefined
      ? `cluster '${raw.cluster ?? ""}' nodegroup '${raw.nodegroup}'`
      : `cluster '${raw.cluster ?? ""}'`;
  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description: `${operation} ${target}`,
    yes: raw.yes,
    code: "ERR_EKS_OPS_ABORTED",
  });
}

/** Reads+parses `input` for `create-cluster`/`update-cluster-config`; `undefined` for the other two cluster-write operations. `create-cluster`'s parsed `input` is additionally checked for the two fields `AWS.M3LEKSCreateClusterInput` requires. */
async function resolveClusterInput(
  operation: ClusterOperation,
  raw: RawSettings,
  deps: Pick<DispatchDeps, "accessor" | "reader">,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (operation !== "create-cluster" && operation !== "update-cluster-config") {
    return undefined;
  }
  const inputName = deps.accessor.requiredFor(raw.input, "input", operation);
  const input = await deps.reader.readJSONRecord(inputName);
  if (operation === "create-cluster") {
    deps.reader.requiredStringField(input, "roleArn", operation);
    const vpcConfig = deps.reader.requireRecord(
      deps.reader.optionalRecordField(input, "resourcesVpcConfig"),
      "resourcesVpcConfig",
      operation,
    );
    deps.reader.requiredArrayField(vpcConfig, "subnetIds", operation);
  }
  return input;
}

/** Reads+parses `input` for `create-nodegroup`/`update-nodegroup-config`; `undefined` for the other two nodegroup-write operations. `create-nodegroup`'s parsed `input` is additionally checked for the two fields `AWS.M3LEKSCreateNodegroupInput` requires. */
async function resolveNodegroupInput(
  operation: NodegroupOperation,
  raw: RawSettings,
  deps: Pick<DispatchDeps, "accessor" | "reader">,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (
    operation !== "create-nodegroup" &&
    operation !== "update-nodegroup-config"
  ) {
    return undefined;
  }
  const inputName = deps.accessor.requiredFor(raw.input, "input", operation);
  const input = await deps.reader.readJSONRecord(inputName);
  if (operation === "create-nodegroup") {
    deps.reader.requiredStringField(input, "nodeRole", operation);
    deps.reader.requiredArrayField(input, "subnets", operation);
  }
  return input;
}

/** `list-clusters`/`describe-cluster`: guard-checks `cluster` for `describe-cluster`, then dispatches to `read-clusters`. Never gated. */
function dispatchReadCluster(
  operation: "list-clusters" | "describe-cluster",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<
  AWS.M3LEKSListClustersResult | AWS.M3LEKSClusterSummary | undefined
> {
  if (operation === "describe-cluster") {
    deps.accessor.requiredFor(raw.cluster, "cluster", operation);
  }
  return readClusters({
    operations: deps.operations,
    operation,
    cluster: raw.cluster,
    nextToken: raw.nextToken,
    maxResults: raw.maxResults,
    include: raw.include,
  });
}

/** `wait-cluster-active`/`wait-cluster-deleted`: guard-checks `cluster`, then dispatches to `wait-cluster`. Never gated. */
function dispatchWaitCluster(
  operation: "wait-cluster-active" | "wait-cluster-deleted",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<AWS.M3LEKSWaiterResult> {
  const cluster = deps.accessor.requiredFor(raw.cluster, "cluster", operation);
  return waitCluster({
    operations: deps.operations,
    operation,
    cluster,
    maxWaitTime: raw.maxWaitTime,
  });
}

/**
 * `create-cluster`/`update-cluster-config`/`update-cluster-version`/
 * `delete-cluster`: guard-checks `cluster` (and `input`/`kubernetesVersion`
 * where required), resolves `input`, gates, then dispatches to
 * `write-cluster`.
 */
async function dispatchWriteCluster(
  operation:
    | "create-cluster"
    | "update-cluster-config"
    | "update-cluster-version"
    | "delete-cluster",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<AWS.M3LEKSClusterSummary | AWS.M3LEKSUpdate> {
  const cluster = deps.accessor.requiredFor(raw.cluster, "cluster", operation);
  const input = await resolveClusterInput(operation, raw, deps);
  if (operation === "update-cluster-version") {
    deps.accessor.requiredFor(
      raw.kubernetesVersion,
      "kubernetesVersion",
      operation,
    );
  }

  await gateOperation(operation, raw, deps);

  return writeCluster({
    operations: deps.operations,
    operation,
    cluster,
    input,
    kubernetesVersion: raw.kubernetesVersion,
    force: raw.force,
  });
}

/** `list-nodegroups`/`describe-nodegroup`: guard-checks `cluster` (and `nodegroup` for `describe-nodegroup`), then dispatches to `read-nodegroups`. Never gated. */
function dispatchReadNodegroup(
  operation: "list-nodegroups" | "describe-nodegroup",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<
  AWS.M3LEKSListNodegroupsResult | AWS.M3LEKSNodegroupSummary | undefined
> {
  const cluster = deps.accessor.requiredFor(raw.cluster, "cluster", operation);
  if (operation === "describe-nodegroup") {
    deps.accessor.requiredFor(raw.nodegroup, "nodegroup", operation);
  }
  return readNodegroups({
    operations: deps.operations,
    operation,
    cluster,
    nodegroup: raw.nodegroup,
    nextToken: raw.nextToken,
    maxResults: raw.maxResults,
  });
}

/** `wait-nodegroup-active`/`wait-nodegroup-deleted`: guard-checks `cluster`/`nodegroup`, then dispatches to `wait-nodegroup`. Never gated. */
function dispatchWaitNodegroup(
  operation: "wait-nodegroup-active" | "wait-nodegroup-deleted",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<AWS.M3LEKSWaiterResult> {
  const cluster = deps.accessor.requiredFor(raw.cluster, "cluster", operation);
  const nodegroup = deps.accessor.requiredFor(
    raw.nodegroup,
    "nodegroup",
    operation,
  );
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
 * `delete-nodegroup`: guard-checks `cluster`/`nodegroup` (and `input` where
 * required), resolves `input`, gates, then dispatches to `write-nodegroup`.
 */
async function dispatchWriteNodegroup(
  operation:
    | "create-nodegroup"
    | "update-nodegroup-config"
    | "update-nodegroup-version"
    | "delete-nodegroup",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<AWS.M3LEKSNodegroupSummary | AWS.M3LEKSUpdate> {
  const cluster = deps.accessor.requiredFor(raw.cluster, "cluster", operation);
  const nodegroup = deps.accessor.requiredFor(
    raw.nodegroup,
    "nodegroup",
    operation,
  );
  const input = await resolveNodegroupInput(operation, raw, deps);

  await gateOperation(operation, raw, deps);

  return writeNodegroup({
    operations: deps.operations,
    operation,
    cluster,
    nodegroup,
    input,
    kubernetesVersion: raw.kubernetesVersion,
    releaseVersion: raw.releaseVersion,
    force: raw.force,
  });
}

/** Narrows `operation` to `list-clusters`/`describe-cluster`. */
function isClusterReadOperation(
  operation: ClusterOperation,
): operation is "list-clusters" | "describe-cluster" {
  return operation === "list-clusters" || operation === "describe-cluster";
}

/** Narrows `operation` to `wait-cluster-active`/`wait-cluster-deleted`. */
function isClusterWaitOperation(
  operation: ClusterOperation,
): operation is "wait-cluster-active" | "wait-cluster-deleted" {
  return (
    operation === "wait-cluster-active" || operation === "wait-cluster-deleted"
  );
}

/** Narrows `operation` to `list-nodegroups`/`describe-nodegroup`. */
function isNodegroupReadOperation(
  operation: NodegroupOperation,
): operation is "list-nodegroups" | "describe-nodegroup" {
  return operation === "list-nodegroups" || operation === "describe-nodegroup";
}

/** Narrows `operation` to `wait-nodegroup-active`/`wait-nodegroup-deleted`. */
function isNodegroupWaitOperation(
  operation: NodegroupOperation,
): operation is "wait-nodegroup-active" | "wait-nodegroup-deleted" {
  return (
    operation === "wait-nodegroup-active" ||
    operation === "wait-nodegroup-deleted"
  );
}

/** Narrows `operation` to the eight {@link NodegroupOperation} members — every operation whose name contains `"nodegroup"`. */
function isNodegroupOperation(
  operation: EksOperation,
): operation is NodegroupOperation {
  return operation.includes("nodegroup");
}

/**
 * The second level of the exhaustive dispatch chain for the cluster side:
 * read (never gated), wait (never gated), or write (gated).
 */
function dispatchClusterOperation(
  operation: ClusterOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (isClusterReadOperation(operation)) {
    return dispatchReadCluster(operation, raw, deps);
  }
  if (isClusterWaitOperation(operation)) {
    return dispatchWaitCluster(operation, raw, deps);
  }
  return dispatchWriteCluster(operation, raw, deps);
}

/**
 * The second level of the exhaustive dispatch chain for the nodegroup side:
 * read (never gated), wait (never gated), or write (gated).
 */
function dispatchNodegroupOperation(
  operation: NodegroupOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (isNodegroupReadOperation(operation)) {
    return dispatchReadNodegroup(operation, raw, deps);
  }
  if (isNodegroupWaitOperation(operation)) {
    return dispatchWaitNodegroup(operation, raw, deps);
  }
  return dispatchWriteNodegroup(operation, raw, deps);
}

/**
 * The top level of the exhaustive dispatch chain: splits on cluster-vs-
 * nodegroup, then hands off to {@link dispatchClusterOperation}/
 * {@link dispatchNodegroupOperation} for the read/write/wait split. A
 * two-level chain (rather than one 16-arm `switch`) is what keeps every
 * function here under the `scripts/*\/src/**` ESLint complexity/line caps —
 * see `.claude/rules/scripts.md`.
 */
function dispatchOperation(
  operation: EksOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (isNodegroupOperation(operation)) {
    return dispatchNodegroupOperation(operation, raw, deps);
  }
  return dispatchClusterOperation(operation, raw, deps);
}

/**
 * Throws `ERR_EKS_OPS_NOT_FOUND` when `operation` is `describe-cluster`/
 * `describe-nodegroup` and `result` is `undefined` (the wrapper's
 * not-found convention) — called *before* any persist attempt.
 */
function assertFound(operation: EksOperation, result: DispatchResult): void {
  if (operation !== "describe-cluster" && operation !== "describe-nodegroup") {
    return;
  }
  if (result !== undefined) return;
  throw new Core.M3LError(
    `eks-ops: ${operation} resolved no matching resource`,
    { code: "ERR_EKS_OPS_NOT_FOUND" },
  );
}

/**
 * Persists `result` to `output` (when configured and non-`undefined`) via
 * `Core.M3LJSONFileExporter`. For a `wait-*`/`update-*` `operation`, the
 * persisted value is run through {@link buildSafeSummaryFields}'s allowlist
 * of the result's own documented fields — `M3LEKSWaiterResult`'s `state` and
 * `reason`, or `M3LEKSUpdate`'s `id`, `status`, `type`, `createdAt`, and
 * `errors` — so the *persisted file* never carries a field beyond that type,
 * regardless of what extra field a (possibly future-regressed) wrapper
 * attaches to the raw result (see § Security note,
 * `docs/reference/scripts/eks-ops.md`). Every other operation persists its
 * full, documented result unchanged.
 */
async function persistOutput(
  paths: Core.M3LPaths,
  output: string | undefined,
  operation: EksOperation,
  result: DispatchResult,
): Promise<void> {
  if (output === undefined || result === undefined) return;
  const safeResult =
    operation.startsWith("wait-") || operation.startsWith("update-")
      ? buildSafeSummaryFields(operation, result)
      : result;
  const exporter = new Core.M3LJSONFileExporter({
    filePath: paths.resolveOutput(output),
  });
  await exporter.export(safeResult);
}

/**
 * Builds the run-summary log fields (and, via {@link persistOutput}, the
 * persisted-output fields) for `result`, deliberately allowlisting only the
 * fields each type actually declares — `M3LEKSWaiterResult`'s `state` and
 * `reason` for a `wait-*` operation, `M3LEKSUpdate`'s `id`, `status`,
 * `type`, `createdAt`, and `errors` for an `update-*` operation, nothing for
 * every other operation. Never spreads or `JSON.stringify`s `result`
 * itself: an opaque, non-secret field the type declares (e.g. `id`) is fine
 * to surface, but an *undeclared* field a caller/test double or a
 * future-regressed wrapper attaches beyond the type's own shape must never
 * reach a log line or the persisted file (see § Security note,
 * `docs/reference/scripts/eks-ops.md`).
 */
function buildSafeSummaryFields(
  operation: EksOperation,
  result: DispatchResult,
): Record<string, unknown> {
  if (operation.startsWith("wait-")) {
    const waiterResult = result as AWS.M3LEKSWaiterResult;
    return {
      state: waiterResult.state,
      ...(waiterResult.reason !== undefined && {
        reason: waiterResult.reason,
      }),
    };
  }
  if (operation.startsWith("update-")) {
    const update = result as AWS.M3LEKSUpdate;
    return {
      id: update.id,
      status: update.status,
      ...(update.type !== undefined && { type: update.type }),
      ...(update.createdAt !== undefined && { createdAt: update.createdAt }),
      ...(update.errors !== undefined && { errors: update.errors }),
    };
  }
  return {};
}

/**
 * Throws `ERR_EKS_OPS_UPDATE_FAILED` when `operation` is one of the four
 * `update-*` operations and the resolved `M3LEKSUpdate.status` is
 * `"Failed"` — called *after* {@link persistOutput}, so the failure's
 * `errors[]` survives on disk even though the run then fails.
 */
function assertUpdateSucceeded(
  operation: EksOperation,
  result: DispatchResult,
): void {
  if (!operation.startsWith("update-")) return;
  const update = result as AWS.M3LEKSUpdate;
  if (update.status !== "Failed") return;
  throw new Core.M3LError(`eks-ops: ${operation} resolved status 'Failed'`, {
    code: "ERR_EKS_OPS_UPDATE_FAILED",
    context: {
      status: update.status,
      ...(update.errors !== undefined && { errors: update.errors }),
    },
  });
}

/**
 * Throws `ERR_EKS_OPS_WAIT_NOT_COMPLETE` when `operation` is one of the
 * four `wait-*` operations and the resolved `M3LEKSWaiterResult.state` is
 * not `"SUCCESS"` — called *after* {@link persistOutput}, so the
 * timeout/abort reason survives on disk even though the run then fails.
 */
function assertWaitComplete(
  operation: EksOperation,
  result: DispatchResult,
): void {
  if (!operation.startsWith("wait-")) return;
  const waiterResult = result as AWS.M3LEKSWaiterResult;
  if (waiterResult.state === "SUCCESS") return;
  throw new Core.M3LError(
    `eks-ops: ${operation} resolved state '${waiterResult.state}'`,
    {
      code: "ERR_EKS_OPS_WAIT_NOT_COMPLETE",
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
 * Composes the `eks-ops` pipeline end to end: resolves + guard-checks
 * config, runs `Core.confirmDestructive` for every mutating operation,
 * dispatches to the operation-appropriate step, converts a
 * `describe-cluster`/`describe-nodegroup` `undefined` result into
 * `ERR_EKS_OPS_NOT_FOUND` before any persist attempt, persists the result
 * to `output` (when configured) via `Core.M3LJSONFileExporter`, logs a
 * scrubbed run summary, then throws `ERR_EKS_OPS_UPDATE_FAILED`/
 * `ERR_EKS_OPS_WAIT_NOT_COMPLETE` on a bad terminal state.
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
export async function runEksOps(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly operations: AWS.M3LEKSOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_EKS_OPS_CONFIG",
  });
  const reader = new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_EKS_OPS_CONFIG",
  });

  const operation = readOperation(accessor);
  const raw = readRawSettings(accessor);

  const dispatchDeps: DispatchDeps = {
    logger: deps.logger,
    operations: deps.operations,
    prompt: deps.prompt,
    accessor,
    reader,
  };
  const result = await dispatchOperation(operation, raw, dispatchDeps);

  assertFound(operation, result);
  await persistOutput(deps.paths, raw.output, operation, result);

  deps.logger.step(`eks-ops operation '${operation}' complete`, {
    operation,
    ...(raw.cluster !== undefined && { cluster: raw.cluster }),
    ...(raw.nodegroup !== undefined && { nodegroup: raw.nodegroup }),
    ...buildSafeSummaryFields(operation, result),
  });

  assertUpdateSucceeded(operation, result);
  assertWaitComplete(operation, result);
}
