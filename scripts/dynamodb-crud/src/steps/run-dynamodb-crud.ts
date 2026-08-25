import { writeFile } from "node:fs/promises";

import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import {
  BATCH_RETRY_ERROR_CODE,
  batchWriteTable,
} from "./batch-write-table.js";
import { DYNAMO_OPERATIONS } from "../config.js";
import { runDestructiveGate } from "./destructive-gate.js";
import type { ScanCheckpoint } from "./scan-table.js";
import { isScanCheckpoint, scanTable } from "./scan-table.js";
import type { SingleItemOperation } from "./single-item-ops.js";
import { runSingleItemOp } from "./single-item-ops.js";

/** The closed union of `dynamodb-crud`'s declared `operation` values. */
type DynamoOperation = (typeof DYNAMO_OPERATIONS)[number];

/** Operations that route through {@link runDestructiveGate} before proceeding. */
const DESTRUCTIVE_OPERATIONS: ReadonlySet<DynamoOperation> = new Set([
  "delete",
  "update",
  "batch-delete",
  "import",
]);

/**
 * The fallback `Core.M3LDestructiveTarget` used when a caller omits
 * `deps.awsTarget` (e.g. a unit test constructing `Core.M3LConfig` directly
 * rather than going through `M3LScript`). `"unresolved"` never contains
 * `"prod"`, so it never trips the escalated typed-echo confirmation path —
 * the safe default for an identity that genuinely could not be resolved.
 */
const UNRESOLVED_TARGET: Core.M3LDestructiveTarget = { profile: "unresolved" };

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
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
  readonly signal?: AbortSignal;
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
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: "ERR_DYNAMO_CRUD_CONFIG",
  });
  const operation = accessor.oneOf("operation", DYNAMO_OPERATIONS);
  const tableName = accessor.requiredString("tableName", operation);
  const key = parseJSONField(accessor.optionalString("key"), "key");
  const item = parseJSONField(accessor.optionalString("item"), "item");
  const input = accessor.optionalString("input");
  const output = accessor.optionalString("output");

  applyOperationGuards(operation, { key, item, input, output });

  return {
    operation,
    tableName,
    batchSize: accessor.requiredNumber("batchSize", operation),
    totalSegments: accessor.requiredNumber("totalSegments", operation),
    maxPagesPerSecond: accessor.optionalNumber("maxPagesPerSecond"),
    maxInFlightBatches: accessor.requiredNumber(
      "maxInFlightBatches",
      operation,
    ),
    checkpointEveryPages: accessor.requiredNumber(
      "checkpointEveryPages",
      operation,
    ),
    runName: accessor.optionalString("runName"),
    resume: accessor.requiredBoolean("resume", operation),
    key,
    item,
    indexName: accessor.optionalString("indexName"),
    input,
    output,
    progressEveryRecords: accessor.requiredNumber(
      "progressEveryRecords",
      operation,
    ),
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
 * The `Core.M3LError` code {@link closeExporterWriterAfterRun} throws with
 * when `writer.close()` fails and it is the ONLY failure — the loop in
 * {@link streamToExporter} already completed cleanly. Kept distinct from
 * `"ERR_DYNAMO_CRUD_OUTPUT"` (which still covers a mid-stream append/read
 * failure, and a `close()` failure secondary to one) so an operator can tell
 * "a resumed run's checkpoint claims more bytes than the output file
 * actually has" apart from an ordinary mid-scan/append failure.
 */
const OUTPUT_WRITER_CODE = "ERR_DYNAMO_CRUD_OUTPUT_WRITER";

/**
 * Closes `writer` after {@link streamToExporter}'s loop has finished,
 * attributing a `close()` failure correctly depending on whether that loop
 * already threw:
 *
 * - `primaryFailed: true` — the loop already threw, and that error is what's
 *   propagating past this call. A `close()` failure here is secondary, so
 *   it's only logged; re-throwing it would replace the original error
 *   mid-flight instead of letting it continue propagating.
 * - `primaryFailed: false` — the loop completed cleanly, so a `close()`
 *   failure here is the ONLY signal of a real problem: e.g. a resumed run
 *   whose checkpoint claims an output byte offset beyond the file's actual
 *   size, a failure the writer defers until its first `write()`/`end()` call
 *   (which happens inside `close()` when zero items were newly appended this
 *   run). Swallowing it would report a clean run over a truncated/invalid
 *   resume, so it propagates as a dedicated typed `M3LError` instead.
 *
 * @throws {@link Core.M3LError} coded `"ERR_DYNAMO_CRUD_OUTPUT_WRITER"` when
 *   `writer.close()` fails and `primaryFailed` is `false`.
 */
async function closeExporterWriterAfterRun(
  writer: Core.M3LListExporterStreamWriter<Record<string, unknown>>,
  primaryFailed: boolean,
  logger: Core.M3LLogger,
): Promise<void> {
  try {
    await writer.close();
  } catch (closeError) {
    if (primaryFailed) {
      logger.warning("export close after failure also failed", {
        cause: closeError,
      });
      return;
    }
    throw new Core.M3LError(
      "dynamodb-crud export writer failed to close after a successful run",
      { code: OUTPUT_WRITER_CODE, cause: closeError },
    );
  }
}

/**
 * Streams `records` into `writer`, invoking `onItem` after each successful
 * append, then finalizes the output. Wraps the whole append/close lifecycle
 * in one fallible region: a failure mid-stream still attempts a best-effort
 * `close()` (without letting that cleanup attempt mask the original error) —
 * see {@link closeExporterWriterAfterRun} for how a `close()`-only failure is
 * distinguished from one secondary to a mid-stream failure.
 */
async function streamToExporter(
  records:
    AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  writer: Core.M3LListExporterStreamWriter<Record<string, unknown>>,
  logger: Core.M3LLogger,
  onItem: (item: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let primaryFailed = false;
  try {
    for await (const item of records) {
      await writer.append(item);
      await onItem(item);
    }
  } catch (cause) {
    primaryFailed = true;
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError("dynamodb-crud scan/query/export failed", {
      code: "ERR_DYNAMO_CRUD_OUTPUT",
      cause,
    });
  } finally {
    await closeExporterWriterAfterRun(writer, primaryFailed, logger);
  }
}

/**
 * Derives the checkpoint's bare identity/name for a resumable
 * `scan`/`query`/`export` run. Deliberately independent of `correlationId` —
 * a fresh CLI invocation generates a new `correlationId` every time (see
 * `M3LScript`), so a `--resume` run keying its checkpoint lookup off
 * `correlationId` could never find the checkpoint written by the run it is
 * trying to resume. `runName` (when the operator sets it) is the stable
 * identity that survives a kill; the `${operation}-${tableName}` fallback is
 * deterministic for a given table+operation but can collide across two
 * concurrent differently configured runs against the same table+operation
 * (documented in `docs/reference/scripts/dynamodb-crud.md`'s `runName` row).
 *
 * @returns The checkpoint's bare identity/name, without the file suffix —
 *   `Core.M3LCheckpointStore` appends `.checkpoint.json` itself.
 */
function resolveCheckpointName(settings: RunSettings): string {
  return settings.runName ?? `${settings.operation}-${settings.tableName}`;
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
  const checkpointStore = new Core.M3LCheckpointStore<ScanCheckpoint>({
    paths: deps.paths,
    name: resolveCheckpointName(settings),
    validate: isScanCheckpoint,
    missing: settings.resume
      ? { kind: "error" }
      : { kind: "empty", value: { segments: {}, outputBytes: 0 } },
  });
  const mode: "scan" | "query" =
    settings.operation === "query" ? "query" : "scan";

  // Read the checkpoint's `outputBytes` BEFORE constructing the exporter, so
  // a resumed run reopens `output` in append mode at that offset instead of
  // a fresh, truncating exporter silently destroying every record a prior
  // interrupted run already wrote. Safe to call `read()` unconditionally —
  // when `resume` is false, the store's `missing` policy above resolves an
  // empty `outputBytes: 0` value rather than throwing.
  const outputBytes = settings.resume
    ? (await checkpointStore.read()).outputBytes
    : 0;

  const exporter = new Core.M3LJSONListExporter<Record<string, unknown>>({
    filePath: outputPath,
    format: "jsonl",
    resumeFromByte: outputBytes,
  });
  const writer = exporter.exportStream();

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
    checkpointStore,
    getOutputBytes: () => writer.bytesWritten,
    logger: deps.logger,
  });

  let read = 0;
  await streamToExporter(records, writer, deps.logger, async () => {
    read += 1;
    logProgressIfDue(deps, read, settings.progressEveryRecords);
    await throttleIfDue(read, settings.batchSize, settings.maxPagesPerSecond);
  });

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
 * Persists items still unprocessed after retry to `failed.jsonl` AND absorbs
 * each one via `reportRecovery` (demoting the run's outcome rather than
 * throwing) — the two things `dispatchBatch` must do once `batchWriteTable`
 * reports a non-empty `failed` list.
 */
async function handleFailedRecords(
  failed: readonly Record<string, unknown>[],
  deps: RunDynamodbCrudDeps,
): Promise<void> {
  await writeFailedRecords(
    deps.paths.resolveOutput("failed.jsonl"),
    failed,
    deps.logger,
  );
  for (const record of failed) {
    deps.reportRecovery({
      item: JSON.stringify(record),
      error: [
        { name: "M3LError", message: "item remained unprocessed after retry" },
      ],
      recordedAt: new Date().toISOString(),
    });
  }
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
    ...(deps.signal !== undefined && { signal: deps.signal }),
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
    await handleFailedRecords(result.failed, deps);
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
 * A batch operation leaving one or more items unprocessed after retry is
 * likewise not fatal: each unprocessed item is reported via `reportRecovery`
 * (demoting the run's outcome rather than throwing), and `summary.failed`
 * still carries the count for the caller to inspect.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, the provisioned `dynamoDBDocument`/`dynamoDB` clients, an injected
 *   `Core.M3LPrompt` (mirrors `script.prompt`), `reportRecovery` (mirrors
 *   `script.reportRecovery`) for absorbing per-item batch failures, and the
 *   resolved `awsTarget` (mirrors `script.awsTarget`) forwarded to
 *   {@link runDestructiveGate}.
 * @returns The run summary: items read, written, failed (after retry), and
 *   skipped (malformed input records).
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when a
 *   required parameter is missing/malformed for the requested operation.
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
 *   prompt: script.prompt,
 *   reportRecovery: script.reportRecovery.bind(script),
 *   awsTarget: { profile: "prod" },
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
  readonly prompt: Core.M3LPrompt;
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
  readonly signal?: AbortSignal;
  /**
   * The resolved AWS identity this run is pointed at (mirrors
   * `script.awsTarget`), forwarded to {@link runDestructiveGate} for
   * target-graded confirmation. Optional so callers that construct
   * `Core.M3LConfig` directly (bypassing the `M3LScript` lifecycle, e.g.
   * this module's own unit tests) are not forced to fabricate one; when
   * omitted, {@link UNRESOLVED_TARGET} is used, which never matches the
   * `"prod"` escalation predicate.
   */
  readonly awsTarget?: Core.M3LDestructiveTarget;
}): Promise<RunDynamodbCrudSummary> {
  const settings = resolveSettings(deps.config);

  if (DESTRUCTIVE_OPERATIONS.has(settings.operation)) {
    try {
      await runDestructiveGate({
        dynamoDB: deps.dynamoDB,
        tableName: settings.tableName,
        operation: settings.operation,
        logger: deps.logger,
        prompt: deps.prompt,
        awsTarget: deps.awsTarget ?? UNRESOLVED_TARGET,
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
    reportRecovery: deps.reportRecovery,
    ...(deps.signal !== undefined && { signal: deps.signal }),
  });

  deps.logger.step(`dynamodb-crud run ${deps.correlationId} complete`, {
    read: summary.read,
    written: summary.written,
    failed: summary.failed,
    skipped: summary.skipped,
  });

  return summary;
}
