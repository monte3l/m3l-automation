import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { destructiveGate } from "./destructive-gate.js";

/**
 * `delete-messages` — streams `input` JSONL (`{ receiptHandle }` rows),
 * chunks them into at most 10-entry `AWS.M3LSQSDeleteEntry` batches (the SQS
 * `DeleteMessageBatch` cap), and `deleteBatch()`s each from `queueUrl`.
 * Per-entry failures are appended to `failed.jsonl`. Confirm-gated exactly
 * ONCE for the whole run, before any batch is deleted.
 */

const MAX_BATCH_ENTRIES = 10;
const DEFAULT_BATCH_SIZE = 100;

/** The resolved, guard-checked settings a run needs. */
interface DeleteSettings {
  readonly queueUrl: string;
  readonly input: string;
  readonly batchSize: number;
  readonly yes: boolean;
}

/**
 * Reads a required string parameter (`queueUrl`/`input`), throwing when it
 * is missing (never declared `required: true` — F1b — so per-command
 * requiredness is guard-checked here) or was stored as a non-string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"`.
 */
function readRequiredString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required for 'delete'`, {
      code: "ERR_SQS_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Reads a `BOOL` parameter, defaulting to `false` when unset. */
function readBool(config: Core.M3LConfig, name: string): boolean {
  const value: unknown = config.get(name);
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Core.M3LError(`'${name}' must be a boolean`, {
      code: "ERR_SQS_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Resolves and guard-checks every declared parameter `deleteMessages` needs. */
function resolveSettings(config: Core.M3LConfig): DeleteSettings {
  const batchSizeRaw = config.get("batchSize");
  return {
    queueUrl: readRequiredString(config, "queueUrl"),
    input: readRequiredString(config, "input"),
    batchSize:
      typeof batchSizeRaw === "number" ? batchSizeRaw : DEFAULT_BATCH_SIZE,
    yes: readBool(config, "yes"),
  };
}

/** Narrows `value` to a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Streams `filePath` as newline-delimited JSON, yielding each row's
 * `receiptHandle`. A line that fails to parse, or whose parsed record has no
 * string `receiptHandle`, is a per-record skip (reported to `onSkip`)
 * instead of aborting the stream.
 */
async function* readReceiptHandles(
  filePath: string,
  onSkip: (index: number, reason: string) => void,
): AsyncGenerator<string> {
  const buffer = await fsp.readFile(filePath);
  const lines = buffer
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let index = 0;
  for (const line of lines) {
    try {
      const record: unknown = JSON.parse(line);
      if (isPlainObject(record) && typeof record.receiptHandle === "string") {
        yield record.receiptHandle;
      } else {
        onSkip(index, "missing or mistyped 'receiptHandle'");
      }
    } catch {
      onSkip(index, "malformed JSON");
    }
    index += 1;
  }
}

/** Caps `source` at `capacity` items, then groups them into `chunkSize`-sized arrays. */
async function* chunkedRecords<T>(
  source: AsyncIterable<T>,
  capacity: number,
  chunkSize: number,
): AsyncGenerator<T[]> {
  let total = 0;
  let chunk: T[] = [];
  for await (const item of source) {
    if (total >= capacity) break;
    chunk.push(item);
    total += 1;
    if (chunk.length === chunkSize) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * Runs the `delete` command: streams `input`, chunks receipt handles into
 * at most 10-entry batches, and `deleteBatch()`s each from `queueUrl`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LSQSOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once every batch has been deleted.
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `queueUrl`/
 *   `input` is missing, or `"ERR_SQS_ETL_ABORTED"` when the destructive-gate
 *   confirmation is declined.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { deleteMessages } from "./delete-messages.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * await deleteMessages({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "sqs-etl", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   sqsOperations,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function deleteMessages(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const settings = resolveSettings(deps.config);
  const inputPath = deps.paths.resolveInput(settings.input);
  const failedPath = deps.paths.resolveOutput("failed.jsonl");

  await destructiveGate({
    prompt: deps.prompt,
    logger: deps.logger,
    description: `delete messages from queue ${settings.queueUrl}`,
    yes: settings.yes,
  });

  const failedExporter = new Core.M3LJSONListExporter<AWS.M3LSQSDeleteEntry>({
    filePath: failedPath,
    format: "jsonl",
  });
  const failedWriter = failedExporter.exportStream();

  let deleted = 0;
  let failed = 0;
  try {
    const receiptHandles = readReceiptHandles(inputPath, (index, reason) => {
      deps.logger.warning(
        `skipped malformed row at index ${String(index)}: ${reason}`,
      );
    });

    for await (const chunk of chunkedRecords(
      receiptHandles,
      settings.batchSize,
      MAX_BATCH_ENTRIES,
    )) {
      const entries: AWS.M3LSQSDeleteEntry[] = chunk.map(
        (receiptHandle, index) => ({ id: String(index), receiptHandle }),
      );
      const result = await deps.sqsOperations.deleteBatch(
        settings.queueUrl,
        entries,
      );
      for (const failure of result.failed) {
        await failedWriter.append(failure.entry);
      }
      deleted += result.successful.length;
      failed += result.failed.length;
    }
  } finally {
    await failedWriter.close();
  }

  deps.logger.step(`sqs-etl delete run ${deps.correlationId} complete`, {
    deleted,
    failed,
  });
}
