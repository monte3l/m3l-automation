import { writeFile } from "node:fs/promises";

import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import {
  BATCH_RETRY_ERROR_CODE,
  batchWriteTable,
} from "./batch-write-table.js";
import { DYNAMO_OPERATIONS } from "../config.js";
import { runDestructiveGate } from "./destructive-gate.js";
import type { SingleItemOperation } from "./single-item-ops.js";
import { runSingleItemOp } from "./single-item-ops.js";
import { scanTable } from "./scan-table.js";

/** The closed union of `dynamodb-crud`'s declared `operation` values. */
type DynamoOperation = (typeof DYNAMO_OPERATIONS)[number];

/** Operations that route through {@link runDestructiveGate} before proceeding. */
const DESTRUCTIVE_OPERATIONS: ReadonlySet<DynamoOperation> = new Set([
  "delete",
  "update",
  "batch-delete",
  "import",
]);

/** The run summary `run-dynamodb-crud` reports: items read/written/failed/skipped. */
export interface RunDynamodbCrudSummary {
  /** Items read (fetched, streamed, or successfully parsed from input). */
  readonly read: number;
  /** Items DynamoDB actually confirmed written/updated/deleted. */
  readonly written: number;
  /** Items still unprocessed once retries are exhausted (batch operations). */
  readonly failed: number;
  /** Malformed input records skipped rather than aborting the whole run. */
  readonly skipped: number;
}

/** The resolved, guard-checked settings a run needs. */
interface RunSettings {
  readonly operation: DynamoOperation;
  readonly tableName: string;
  readonly batchSize: number;
  readonly totalSegments: number;
  readonly maxPagesPerSecond: number | undefined;
  readonly maxInFlightBatches: number;
  readonly checkpointEveryPages: number;
  readonly runName: string | undefined;
  readonly resume: boolean;
  readonly key: Record<string, unknown> | undefined;
  readonly item: Record<string, unknown> | undefined;
  readonly indexName: string | undefined;
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly progressEveryRecords: number;
}

/** The dependencies every per-operation dispatcher needs, once `config` has resolved to `settings`. */
interface RunDynamodbCrudDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly dynamoDBDocument: Parameters<typeof AWS.getItem>[0];
}

/**
 * Reads the `operation` parameter, validating it against the declared set.
 * The declared `M3LConfigParameter`'s `oneOf` validator already enforces this
 * at config-load time in the real script; this defensive re-check protects a
 * caller (e.g. a test) that builds a `Core.M3LConfig` directly, bypassing
 * that validation.
 */
function readOperation(config: Core.M3LConfig): DynamoOperation {
  const value: unknown = config.get("operation");
  if (
    typeof value === "string" &&
    (DYNAMO_OPERATIONS as readonly string[]).includes(value)
  ) {
    return value as DynamoOperation;
  }
  throw new Core.M3LError(
    `'operation' must be one of: ${DYNAMO_OPERATIONS.join(", ")}`,
    { code: "ERR_DYNAMO_CRUD_CONFIG" },
  );
}

/** Reads the required `tableName` string parameter, defensively re-checking its type. */
function readTableName(config: Core.M3LConfig): string {
  const value: unknown = config.get("tableName");
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError("'tableName' must be a non-empty string", {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  return value;
}

/** Reads a required numeric parameter, defensively re-checking its type. */
function readNumber(config: Core.M3LConfig, name: string): number {
  const value: unknown = config.get(name);
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  return value;
}

/** Reads an optional numeric parameter (`undefined` when unset). */
function readOptionalNumber(
  config: Core.M3LConfig,
  name: string,
): number | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  return value;
}

/** Reads a required boolean parameter, defensively re-checking its type. */
function readBool(config: Core.M3LConfig, name: string): boolean {
  const value: unknown = config.get(name);
  if (typeof value !== "boolean") {
    throw new Core.M3LError(`'${name}' must be a boolean`, {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  return value;
}

/** Reads an optional string parameter (`undefined` when unset). */
function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Core.M3LError(`'${name}' must be a string`, {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  return value;
}

/**
 * Parses a JSON-encoded `key`/`item` config string into a plain object. This
 * is the one place either field is ever parsed — every downstream step
 * receives an already-parsed object.
 *
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when `raw`
 *   is not valid JSON (chaining the `SyntaxError` as `cause`) or does not
 *   decode to a plain object.
 */
function parseJSONField(
  raw: string | undefined,
  name: "key" | "item",
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Core.M3LError(`'${name}' must be valid JSON`, {
      code: "ERR_DYNAMO_CRUD_CONFIG",
      cause,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Core.M3LError(`'${name}' must decode to a JSON object`, {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  return parsed as Record<string, unknown>;
}

/** The four cross-parameter fields an operation's requirements are drawn from. */
type GuardedFieldName = "key" | "item" | "input" | "output";

/**
 * Which of `key`/`item`/`input`/`output` each operation requires. Keyed as a
 * `Record<DynamoOperation, …>` so a new operation added to
 * {@link DYNAMO_OPERATIONS} without a corresponding entry here is a compile
 * error — the same exhaustiveness an explicit `switch` would give, without
 * the per-case line/complexity cost.
 */
const REQUIRED_FIELDS: Record<DynamoOperation, readonly GuardedFieldName[]> = {
  get: ["key", "output"],
  put: ["item"],
  update: ["key", "item"],
  delete: ["key"],
  query: ["key", "output"],
  scan: ["output"],
  export: ["output"],
  "batch-write": ["input"],
  "batch-delete": ["input"],
  import: ["input"],
};

/**
 * Applies the cross-parameter requirements `M3LConfigParameter` cannot
 * express on its own (e.g. `key` is required for `get` but not `scan`),
 * throwing before any AWS call.
 */
function applyOperationGuards(
  operation: DynamoOperation,
  fields: Record<
    GuardedFieldName,
    string | Record<string, unknown> | undefined
  >,
): void {
  for (const name of REQUIRED_FIELDS[operation]) {
    if (fields[name] === undefined) {
      throw new Core.M3LError(
        `'${name}' is required for operation '${operation}'`,
        { code: "ERR_DYNAMO_CRUD_CONFIG" },
      );
    }
  }
}

/**
 * Resolves and guard-checks every declared parameter this run needs,
 * throwing before any AWS call. `operation`/`tableName`/`aws.profile`
 * presence is enforced by the declared config schema at config-load time in
 * the real script; the type re-checks here are defensive (a caller building
 * `Core.M3LConfig` directly bypasses that validation), and the
 * cross-parameter requirements (e.g. `key` for `get`) are genuinely only
 * checkable here.
 */
function resolveSettings(config: Core.M3LConfig): RunSettings {
  const operation = readOperation(config);
  const tableName = readTableName(config);
  const key = parseJSONField(readOptionalString(config, "key"), "key");
  const item = parseJSONField(readOptionalString(config, "item"), "item");
  const input = readOptionalString(config, "input");
  const output = readOptionalString(config, "output");

  applyOperationGuards(operation, { key, item, input, output });

  return {
    operation,
    tableName,
    batchSize: readNumber(config, "batchSize"),
    totalSegments: readNumber(config, "totalSegments"),
    maxPagesPerSecond: readOptionalNumber(config, "maxPagesPerSecond"),
    maxInFlightBatches: readNumber(config, "maxInFlightBatches"),
    checkpointEveryPages: readNumber(config, "checkpointEveryPages"),
    runName: readOptionalString(config, "runName"),
    resume: readBool(config, "resume"),
    key,
    item,
    indexName: readOptionalString(config, "indexName"),
    input,
    output,
    progressEveryRecords: readNumber(config, "progressEveryRecords"),
  };
}

/** Writes a single-item result (`get`) as one JSON document. */
async function writeSingleResult(
  outputPath: string,
  item: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    await writeFile(outputPath, JSON.stringify(item ?? null));
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed writing result to '${outputPath}'`, {
      code: "ERR_DYNAMO_CRUD_OUTPUT",
      cause,
    });
  }
}

/**
 * `get`/`put`/`update`/`delete`: a single item is always counted as one
 * `read` (the config-supplied key/item unit processed); `written` is `1` for
 * every write operation (`put`/`update`/`delete`) and `0` for the read-only
 * `get`. `get`'s fetched item is persisted to `output` as a single JSON
 * document; the other three operations write nothing.
 */
async function dispatchSingleItem(
  operation: SingleItemOperation,
  settings: RunSettings,
  deps: RunDynamodbCrudDeps,
): Promise<RunDynamodbCrudSummary> {
  const result = await runSingleItemOp({
    dynamoDBDocument: deps.dynamoDBDocument,
    operation,
    tableName: settings.tableName,
    key: settings.key,
    item: settings.item,
  });

  if (operation === "get" && settings.output !== undefined) {
    await writeSingleResult(
      deps.paths.resolveOutput(settings.output),
      result.item,
    );
  }

  return {
    read: 1,
    written: operation === "get" ? 0 : 1,
    failed: 0,
    skipped: 0,
  };
}

/** Milliseconds per second — used to convert `maxPagesPerSecond` into a delay. */
const MS_PER_SECOND = 1_000;

/** Sleeps for `ms` milliseconds — used to throttle reads to `maxPagesPerSecond`. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Logs a progress line every `progressEveryRecords` records read. */
function logProgressIfDue(
  deps: RunDynamodbCrudDeps,
  read: number,
  progressEveryRecords: number,
): void {
  if (read % progressEveryRecords === 0) {
    deps.logger.step(`dynamodb-crud run ${deps.correlationId} progress`, {
      read,
    });
  }
}

/** Sleeps once per `batchSize` records read, when `maxPagesPerSecond` caps throughput. */
async function throttleIfDue(
  read: number,
  batchSize: number,
  maxPagesPerSecond: number | undefined,
): Promise<void> {
  if (maxPagesPerSecond === undefined) return;
  if (read % batchSize !== 0) return;
  await sleep(MS_PER_SECOND / maxPagesPerSecond);
}

/**
 * Streams `records` into `writer`, invoking `onItem` after each successful
 * append, then finalizes the output. Wraps the whole append/close lifecycle
 * in one fallible region: a failure mid-stream still attempts a best-effort
 * `close()` (without letting that cleanup attempt mask the original error).
 */
async function streamToExporter(
  records:
    AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  writer: Core.M3LListExporterStreamWriter<Record<string, unknown>>,
  logger: Core.M3LLogger,
  onItem: (item: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    for await (const item of records) {
      await writer.append(item);
      await onItem(item);
    }
    await writer.close();
  } catch (cause) {
    // Best-effort cleanup only: a second close() failure here must not mask
    // the primary read/append failure being re-thrown below.
    try {
      await writer.close();
    } catch (closeError) {
      logger.warning("export close after failure also failed", {
        cause: closeError,
      });
    }
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError("dynamodb-crud scan/query/export failed", {
      code: "ERR_DYNAMO_CRUD_OUTPUT",
      cause,
    });
  }
}

/**
 * Derives the checkpoint file's name for a resumable `scan`/`query`/`export`
 * run. Deliberately independent of `correlationId` — a fresh CLI invocation
 * generates a new `correlationId` every time (see `M3LScript`), so a
 * `--resume` run keying its checkpoint lookup off `correlationId` could never
 * find the checkpoint written by the run it is trying to resume. `runName`
 * (when the operator sets it) is the stable identity that survives a kill;
 * the `${operation}-${tableName}` fallback is deterministic for a given
 * table+operation but can collide across two concurrent differently
 * configured runs against the same table+operation (documented in
 * `docs/reference/scripts/dynamodb-crud.md`'s `runName` row).
 */
function resolveCheckpointFileName(settings: RunSettings): string {
  return `${settings.runName ?? `${settings.operation}-${settings.tableName}`}.checkpoint.json`;
}

/**
 * `query`/`scan`/`export`: streams every item `scanTable` yields straight to
 * `output` as JSONL, counting each streamed item as one `read`. `query`
 * drives `scanTable`'s `"query"` mode (using `key` as the equality
 * condition); `scan`/`export` both drive `"scan"` mode (a full-table scan —
 * `export` is semantically "dump the whole table", not a different AWS call
 * shape).
 */
async function dispatchScan(
  settings: RunSettings,
  deps: RunDynamodbCrudDeps,
): Promise<RunDynamodbCrudSummary> {
  if (settings.output === undefined) {
    // Guarded by applyOperationGuards before resolveSettings ever returns;
    // unreachable in practice, kept as a defensive type-narrowing check.
    throw new Core.M3LError("'output' is required for this operation", {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }
  const outputPath = deps.paths.resolveOutput(settings.output);
  const checkpointPath = deps.paths.resolveOutput(
    resolveCheckpointFileName(settings),
  );
  const mode: "scan" | "query" =
    settings.operation === "query" ? "query" : "scan";

  const records = scanTable({
    dynamoDBDocument: deps.dynamoDBDocument,
    mode,
    tableName: settings.tableName,
    totalSegments: settings.totalSegments,
    pageSize: settings.batchSize,
    indexName: settings.indexName,
    keyCondition: settings.key,
    checkpointEveryPages: settings.checkpointEveryPages,
    resume: settings.resume,
    checkpointPath,
    logger: deps.logger,
  });

  const exporter = new Core.M3LJSONListExporter<Record<string, unknown>>({
    filePath: outputPath,
    format: "jsonl",
  });

  let read = 0;
  await streamToExporter(
    records,
    exporter.exportStream(),
    deps.logger,
    async () => {
      read += 1;
      logProgressIfDue(deps, read, settings.progressEveryRecords);
      await throttleIfDue(read, settings.batchSize, settings.maxPagesPerSecond);
    },
  );

  return { read, written: 0, failed: 0, skipped: 0 };
}

/** Wraps `source`, invoking `onItem` once per yielded value before re-yielding it. */
async function* countingGenerator<T>(
  source: AsyncIterable<T>,
  onItem: () => void,
): AsyncGenerator<T> {
  for await (const item of source) {
    onItem();
    yield item;
  }
}

/** Writes `failed` as JSONL to `outputPath` (the batch write/delete/import failure sink). */
async function writeFailedRecords(
  outputPath: string,
  failed: readonly Record<string, unknown>[],
  logger: Core.M3LLogger,
): Promise<void> {
  const exporter = new Core.M3LJSONListExporter<Record<string, unknown>>({
    filePath: outputPath,
    format: "jsonl",
  });
  await streamToExporter(failed, exporter.exportStream(), logger, () =>
    Promise.resolve(),
  );
}

/**
 * Recognizes `batch-write-table`'s internal "chunk has unprocessed items"
 * sentinel by its `.code` (rather than importing the deliberately
 * unexported sentinel class) and classifies it `"retriable"`; abstains
 * (`"unknown"`) for everything else so {@link Core.combineClassifiers} falls
 * through to the next classifier in the chain.
 */
function batchSentinelClassifier(error: unknown): Core.M3LRetryDecision {
  if (error instanceof Core.M3LError && error.code === BATCH_RETRY_ERROR_CODE) {
    return "retriable";
  }
  return "unknown";
}

/**
 * The production retry classifier `dispatchBatch` hands to
 * `Core.M3LRetryRunner`: recognizes `batch-write-table`'s internal
 * "chunk has unprocessed items" sentinel via {@link batchSentinelClassifier},
 * falling back to `Core.awsThrottlingClassifier` for everything else
 * (genuine AWS throttling/rate-limit errors). Without this composition,
 * `Core.awsThrottlingClassifier` alone returns `"unknown"` for the sentinel,
 * which — combined with `unknownDecision: "fatal"` — would fail every chunk
 * with any unprocessed items on the very first attempt, never actually
 * retrying DynamoDB's normal partial-capacity response.
 */
const batchRetryClassifier = Core.combineClassifiers(
  batchSentinelClassifier,
  Core.awsThrottlingClassifier,
);

/**
 * `batch-write`/`batch-delete`/`import`: reads `input` via
 * `Core.M3LJSONListImporter`, counting successfully parsed records as
 * `read` and malformed skipped lines as `skipped`, then routes the stream
 * through `batchWriteTable` (`"delete"` mode for `batch-delete`, `"write"`
 * mode otherwise). Any items still unprocessed after retry are written to
 * `failed.jsonl` under the output tree.
 */
async function dispatchBatch(
  settings: RunSettings,
  deps: RunDynamodbCrudDeps,
): Promise<RunDynamodbCrudSummary> {
  if (settings.input === undefined) {
    // Guarded by applyOperationGuards before resolveSettings ever returns;
    // unreachable in practice, kept as a defensive type-narrowing check.
    throw new Core.M3LError("'input' is required for this operation", {
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
  }

  const inputPath = deps.paths.resolveInput(settings.input);
  const importer = new Core.M3LJSONListImporter<Record<string, unknown>>({
    filePath: inputPath,
  });

  let read = 0;
  let skipped = 0;
  importer.on("import:error", (event) => {
    skipped += 1;
    deps.logger.warning(
      `skipped malformed record at index ${String(event.index)}`,
      { cause: event.error },
    );
  });

  const records = countingGenerator(importer.importStream(), () => {
    read += 1;
  });

  const mode: "write" | "delete" =
    settings.operation === "batch-delete" ? "delete" : "write";

  const retryRunner = new Core.M3LRetryRunner({
    classifier: batchRetryClassifier,
    unknownDecision: "fatal",
  });

  const result = await batchWriteTable({
    dynamoDBDocument: deps.dynamoDBDocument,
    mode,
    tableName: settings.tableName,
    records,
    maxInFlightBatches: settings.maxInFlightBatches,
    retryRunner,
    logger: deps.logger,
  });

  if (result.failed.length > 0) {
    await writeFailedRecords(
      deps.paths.resolveOutput("failed.jsonl"),
      result.failed,
      deps.logger,
    );
  }

  return {
    read,
    written: result.written,
    failed: result.failed.length,
    skipped,
  };
}

/** The three dispatch families `dynamodb-crud` routes operations into. */
type DispatchGroup = "single" | "scan" | "batch";

/**
 * Which dispatch family each operation belongs to. Keyed as a
 * `Record<DynamoOperation, …>` so a new operation added to
 * {@link DYNAMO_OPERATIONS} without a corresponding entry here is a compile
 * error — the same exhaustiveness an explicit `switch` would give, without
 * the per-case line/complexity cost.
 */
const DISPATCH_GROUP: Record<DynamoOperation, DispatchGroup> = {
  get: "single",
  put: "single",
  update: "single",
  delete: "single",
  query: "scan",
  scan: "scan",
  export: "scan",
  "batch-write": "batch",
  "batch-delete": "batch",
  import: "batch",
};

/** Narrows `operation` to {@link SingleItemOperation}, matching {@link DISPATCH_GROUP}'s `"single"` entries. */
function isSingleItemOperation(
  operation: DynamoOperation,
): operation is SingleItemOperation {
  return (
    operation === "get" ||
    operation === "put" ||
    operation === "update" ||
    operation === "delete"
  );
}

/**
 * Dispatches to the operation-appropriate handler via {@link DISPATCH_GROUP},
 * which is exhaustive over {@link DynamoOperation} (a new operation without a
 * group entry is a compile error).
 */
async function dispatch(
  settings: RunSettings,
  deps: RunDynamodbCrudDeps,
): Promise<RunDynamodbCrudSummary> {
  const group = DISPATCH_GROUP[settings.operation];
  switch (group) {
    case "single": {
      const { operation } = settings;
      if (!isSingleItemOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a single-item operation`,
          { code: "ERR_DYNAMO_CRUD_CONFIG" },
        );
      }
      return dispatchSingleItem(operation, settings, deps);
    }
    case "scan":
      return dispatchScan(settings, deps);
    case "batch":
      return dispatchBatch(settings, deps);
    default: {
      const exhaustive: never = group;
      throw new Core.M3LError(
        `unhandled dispatch group: ${String(exhaustive)}`,
        {
          code: "ERR_DYNAMO_CRUD_CONFIG",
        },
      );
    }
  }
}

/**
 * Composes the `dynamodb-crud` pipeline end to end — the only module that
 * knows operation dispatch order: resolve + guard-check config → (the
 * destructive-operation gate, for `delete`/`update`/`batch-delete`/`import`)
 * → the operation-appropriate read/write step → the run summary.
 *
 * An operator declining the destructive-operation gate (`confirm` resolving
 * `false`, surfacing as `ERR_DYNAMO_CRUD_ABORTED`) soft-lands: this function
 * logs a warning and resolves an all-zero summary rather than throwing. Any
 * other gate failure (e.g. `describeTable` rejecting) propagates normally.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, the provisioned `dynamoDBDocument`/`dynamoDB` clients, and an
 *   injected `confirm` callback (mirrors `script.prompt.confirm`).
 * @returns The run summary: items read, written, failed (after retry), and
 *   skipped (malformed input records).
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when a
 *   required parameter is missing/malformed for the requested operation.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_FAILED_ITEMS` when
 *   the run completes but leaves one or more items failed after retry — a
 *   partial batch failure must never be silent.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runDynamodbCrud } from "./run-dynamodb-crud.js";
 *
 * const summary = await runDynamodbCrud({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "dynamodb-crud", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   dynamoDBDocument: script.aws.clients.dynamoDBDocument,
 *   dynamoDB: script.aws.clients.dynamoDB,
 *   confirm: (message) => script.prompt.confirm(message),
 * });
 * console.log(summary.read, summary.written, summary.failed, summary.skipped);
 * ```
 */
export async function runDynamodbCrud(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly dynamoDBDocument: Parameters<typeof AWS.getItem>[0];
  readonly dynamoDB: Parameters<typeof AWS.describeTable>[0];
  readonly confirm: (message: string) => Promise<boolean>;
}): Promise<RunDynamodbCrudSummary> {
  const settings = resolveSettings(deps.config);

  if (DESTRUCTIVE_OPERATIONS.has(settings.operation)) {
    try {
      await runDestructiveGate({
        dynamoDB: deps.dynamoDB,
        tableName: settings.tableName,
        operation: settings.operation,
        logger: deps.logger,
        confirm: deps.confirm,
      });
    } catch (cause) {
      if (
        cause instanceof Core.M3LError &&
        cause.code === "ERR_DYNAMO_CRUD_ABORTED"
      ) {
        deps.logger.warning(
          `dynamodb-crud run ${deps.correlationId} aborted before '${settings.operation}' on table '${settings.tableName}'`,
        );
        return { read: 0, written: 0, failed: 0, skipped: 0 };
      }
      throw cause;
    }
  }

  const summary = await dispatch(settings, {
    paths: deps.paths,
    logger: deps.logger,
    correlationId: deps.correlationId,
    dynamoDBDocument: deps.dynamoDBDocument,
  });

  deps.logger.step(`dynamodb-crud run ${deps.correlationId} complete`, {
    read: summary.read,
    written: summary.written,
    failed: summary.failed,
    skipped: summary.skipped,
  });

  // A partial batch failure must never be silent: this is the domain
  // decision that a non-zero `failed` count fails the whole run, so it lives
  // here (not in `main.ts`, which stays pure composition/propagation per
  // ADR-0022 — see main.ts's own header comment).
  if (summary.failed > 0) {
    throw new Core.M3LError(
      `dynamodb-crud run ${deps.correlationId} left ${String(summary.failed)} item(s) failed after retry`,
      { code: "ERR_DYNAMO_CRUD_FAILED_ITEMS", context: { ...summary } },
    );
  }

  return summary;
}
