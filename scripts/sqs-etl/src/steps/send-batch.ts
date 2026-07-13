import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `send-batch` — streams `input` JSONL, maps each record to an
 * `AWS.M3LSQSSendEntry`, chunks entries into at most 10-entry batches (the SQS
 * `SendMessageBatch` cap), and `sendBatch()`s each chunk to `queueUrl`.
 * Per-entry send failures (returned, never thrown, by `sendBatch`) are
 * appended to the fixed `failed.jsonl` re-drive file.
 */

const MAX_BATCH_ENTRIES = 10;
const DEFAULT_BATCH_SIZE = 100;

/** The resolved, guard-checked settings a run needs. */
interface SendSettings {
  readonly queueUrl: string;
  readonly input: string;
  readonly batchSize: number;
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
    throw new Core.M3LError(`'${name}' is required for 'send'`, {
      code: "ERR_SQS_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Resolves and guard-checks every declared parameter `sendBatch` needs. */
function resolveSettings(config: Core.M3LConfig): SendSettings {
  const batchSizeRaw = config.get("batchSize");
  return {
    queueUrl: readRequiredString(config, "queueUrl"),
    input: readRequiredString(config, "input"),
    batchSize:
      typeof batchSizeRaw === "number" ? batchSizeRaw : DEFAULT_BATCH_SIZE,
  };
}

/**
 * Streams `filePath` as newline-delimited JSON, JSON-parsing each non-empty
 * line and yielding the parsed value; a line that fails to parse is reported
 * to `onSkip` (index + cause) instead of aborting the stream.
 */
async function* readJsonlRecords(
  filePath: string,
  onSkip: (index: number, cause: unknown) => void,
): AsyncGenerator<unknown> {
  const buffer = await fsp.readFile(filePath);
  const lines = buffer
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let index = 0;
  for (const line of lines) {
    try {
      yield JSON.parse(line) as unknown;
    } catch (cause) {
      onSkip(index, cause);
    }
    index += 1;
  }
}

/** Caps `source` at `capacity` items, then groups them into `chunkSize`-sized arrays. */
async function* chunkedRecords(
  source: AsyncIterable<unknown>,
  capacity: number,
  chunkSize: number,
): AsyncGenerator<unknown[]> {
  let total = 0;
  let chunk: unknown[] = [];
  for await (const record of source) {
    if (total >= capacity) break;
    chunk.push(record);
    total += 1;
    if (chunk.length === chunkSize) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
}

/** The optional passthrough fields a `body`-carrying record may declare. */
interface SendEntryOptionalFields {
  readonly delaySeconds?: number;
  readonly messageGroupId?: string;
  readonly messageDeduplicationId?: string;
}

/** Reads `record`'s optional send-entry fields, validating each field's type. */
function readSendEntryOptionalFields(
  record: Record<string, unknown>,
): SendEntryOptionalFields {
  const delaySeconds =
    typeof record.delaySeconds === "number" ? record.delaySeconds : undefined;
  const messageGroupId =
    typeof record.messageGroupId === "string"
      ? record.messageGroupId
      : undefined;
  const messageDeduplicationId =
    typeof record.messageDeduplicationId === "string"
      ? record.messageDeduplicationId
      : undefined;
  return {
    ...(delaySeconds !== undefined && { delaySeconds }),
    ...(messageGroupId !== undefined && { messageGroupId }),
    ...(messageDeduplicationId !== undefined && { messageDeduplicationId }),
  };
}

/** Narrows `value` to a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps one parsed record to its `M3LSQSSendEntry` body (and optional
 * fields), minus the caller-assigned `id`: a bare string is used verbatim; a
 * record carrying a `body` property uses it verbatim when already a string
 * or `JSON.stringify`s it otherwise, and passes through
 * `delaySeconds`/`messageGroupId`/`messageDeduplicationId` when present; any
 * other record (including one with no `body` property) is `JSON.stringify`d
 * whole.
 */
function toSendEntryFields(
  record: unknown,
): { readonly body: string } & SendEntryOptionalFields {
  if (typeof record === "string") return { body: record };

  if (isPlainObject(record) && "body" in record) {
    const bodyValue = record.body;
    const body =
      typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);
    return { body, ...readSendEntryOptionalFields(record) };
  }

  return { body: JSON.stringify(record) };
}

/**
 * Runs the `send` command: streams `input`, chunks records into at most 10-entry
 * batches, and `sendBatch()`s each chunk to `queueUrl`. Per-entry failures
 * are appended to `failed.jsonl`, ready to re-drive with no id bookkeeping.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, and
 *   the injected `AWS.M3LSQSOperations`.
 * @returns A promise that resolves once every chunk has been sent.
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `queueUrl`/
 *   `input` is missing.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { sendBatch } from "./send-batch.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * await sendBatch({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "sqs-etl", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   sqsOperations,
 * });
 * ```
 */
export async function sendBatch(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
}): Promise<void> {
  const settings = resolveSettings(deps.config);
  const inputPath = deps.paths.resolveInput(settings.input);
  const failedPath = deps.paths.resolveOutput("failed.jsonl");

  const failedExporter = new Core.M3LJSONListExporter<AWS.M3LSQSSendEntry>({
    filePath: failedPath,
    format: "jsonl",
  });
  const failedWriter = failedExporter.exportStream();

  let sent = 0;
  let failed = 0;
  try {
    const records = readJsonlRecords(inputPath, (index, cause) => {
      deps.logger.warning(
        `skipped malformed JSONL line at index ${String(index)}`,
        { cause },
      );
    });

    for await (const chunk of chunkedRecords(
      records,
      settings.batchSize,
      MAX_BATCH_ENTRIES,
    )) {
      const entries: AWS.M3LSQSSendEntry[] = chunk.map((record, index) => ({
        id: String(index),
        ...toSendEntryFields(record),
      }));
      const result = await deps.sqsOperations.sendBatch(
        settings.queueUrl,
        entries,
      );
      for (const failure of result.failed) {
        await failedWriter.append(failure.entry);
      }
      sent += result.successful.length;
      failed += result.failed.length;
    }
  } finally {
    await failedWriter.close();
  }

  deps.logger.step(`sqs-etl send run ${deps.correlationId} complete`, {
    sent,
    failed,
  });
}
