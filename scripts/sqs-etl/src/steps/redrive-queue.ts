import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `redrive-queue` — moves messages from a DLQ (`dlqUrl`) back to their
 * source queue (`queueUrl`). Long-polls `receive()` from `dlqUrl` up to
 * `batchSize`, maps each page to `AWS.M3LSQSSendEntry` (body only — FIFO
 * passthrough is deliberately out of scope for this iteration),
 * `sendBatch()`s the page to `queueUrl`, then `deleteBatch()`s from `dlqUrl`
 * only the entries whose send succeeded (matched back by chunk-position
 * id). Unsent DLQ messages are left alone and logged to `failed.jsonl`.
 * Confirm-gated exactly ONCE for the whole run, before the first delete.
 */

const RECEIVE_MAX_MESSAGES = 10;
const RECEIVE_WAIT_TIME_SECONDS = 20;
const DEFAULT_BATCH_SIZE = 100;

/** The resolved, guard-checked settings a run needs. */
interface RedriveSettings {
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly batchSize: number;
  readonly visibilityTimeoutSeconds: number | undefined;
  readonly yes: boolean;
}

/**
 * Reads a required string parameter (`queueUrl`/`dlqUrl`), throwing when it
 * is missing (never declared `required: true` — F1b — so per-command
 * requiredness is guard-checked here) or was stored as a non-string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"`.
 */
function readRequiredString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required for 'redrive'`, {
      code: "ERR_SQS_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Reads the optional `visibilityTimeoutSeconds` parameter. */
function readOptionalNumber(
  config: Core.M3LConfig,
  name: string,
): number | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
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

/** Resolves and guard-checks every declared parameter `redriveQueue` needs. */
function resolveSettings(config: Core.M3LConfig): RedriveSettings {
  const batchSizeRaw = config.get("batchSize");
  return {
    queueUrl: readRequiredString(config, "queueUrl"),
    dlqUrl: readRequiredString(config, "dlqUrl"),
    batchSize:
      typeof batchSizeRaw === "number" ? batchSizeRaw : DEFAULT_BATCH_SIZE,
    visibilityTimeoutSeconds: readOptionalNumber(
      config,
      "visibilityTimeoutSeconds",
    ),
    yes: readBool(config, "yes"),
  };
}

/**
 * Builds the `receive()` options for one page, capping `maxMessages` to
 * whatever remains of the `batchSize` budget so a single call never
 * over-fetches past the requested total, omitting `visibilityTimeout` when
 * unset.
 */
function buildReceiveOptions(
  settings: RedriveSettings,
  remaining: number,
): AWS.M3LSQSReceiveOptions {
  return {
    maxMessages: Math.min(RECEIVE_MAX_MESSAGES, remaining),
    waitTimeSeconds: RECEIVE_WAIT_TIME_SECONDS,
    ...(settings.visibilityTimeoutSeconds !== undefined && {
      visibilityTimeout: settings.visibilityTimeoutSeconds,
    }),
  };
}

/** Maps one received DLQ page to its `sendBatch()` entries (body only, chunk-scoped ids). */
function toSendEntries(
  messages: readonly AWS.M3LSQSReceivedMessage[],
): AWS.M3LSQSSendEntry[] {
  return messages.map((message, index) => ({
    id: String(index),
    body: message.body,
  }));
}

/** Maps the DLQ page's messages whose send succeeded to `deleteBatch()` entries. */
function toDeleteEntries(
  messages: readonly AWS.M3LSQSReceivedMessage[],
  successfulIds: ReadonlySet<string>,
): AWS.M3LSQSDeleteEntry[] {
  return messages
    .map((message, index) => ({
      id: String(index),
      receiptHandle: message.receiptHandle,
    }))
    .filter((entry) => successfulIds.has(entry.id));
}

/**
 * Logs each `deleteBatch()` failure via `logger.warning`, surfacing it
 * instead of silently discarding it (the entry itself is not written to
 * `failed.jsonl` — that file's meaning is reserved for unsent `sendBatch`
 * entries).
 */
function logDeleteFailures(
  logger: Core.M3LLogger,
  failures: readonly AWS.M3LSQSBatchFailure<AWS.M3LSQSDeleteEntry>[],
): void {
  for (const failure of failures) {
    logger.warning(
      `deleteBatch failed for receipt handle ${failure.entry.receiptHandle}`,
      { failure },
    );
  }
}

/**
 * Runs the `Core.confirmDestructive` confirmation exactly once per
 * `redriveQueue` call: a no-op returning `true` on every call once
 * `confirmed` is already `true`.
 *
 * @returns `true` — either already confirmed, or just confirmed now.
 */
async function confirmDeleteOnce(
  confirmed: boolean,
  deps: { readonly prompt: Core.M3LPrompt; readonly logger: Core.M3LLogger },
  description: string,
  yes: boolean,
): Promise<boolean> {
  if (confirmed) return true;
  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description,
    yes,
    code: "ERR_SQS_ETL_ABORTED",
  });
  return true;
}

/** Best-effort closes `writer`, swallowing any close failure — used when a primary error already occurred and must not be masked by a subsequent close failure. */
async function closeWriterBestEffort(
  writer: Core.M3LListExporterStreamWriter<AWS.M3LSQSSendEntry>,
): Promise<void> {
  try {
    await writer.close();
  } catch {
    // best-effort: a close failure must not mask the original error
  }
}

/**
 * Runs the receive/send/delete loop until `settings.batchSize` is reached or
 * `receive()` returns an empty page: long-polls `dlqUrl`, `sendBatch()`s the
 * page to `queueUrl`, appends unsent entries to `failedWriter`, and (once
 * confirmed) `deleteBatch()`s from `dlqUrl` only the entries whose send
 * succeeded.
 *
 * @returns The total count of messages received across every page.
 */
async function runRedrivePages(
  deps: {
    readonly logger: Core.M3LLogger;
    readonly sqsOperations: AWS.M3LSQSOperations;
    readonly prompt: Core.M3LPrompt;
  },
  settings: RedriveSettings,
  failedWriter: Core.M3LListExporterStreamWriter<AWS.M3LSQSSendEntry>,
): Promise<{ total: number }> {
  let confirmed = false;
  let total = 0;
  for (;;) {
    const receiveOptions = buildReceiveOptions(
      settings,
      settings.batchSize - total,
    );
    const messages = await deps.sqsOperations.receive(
      settings.dlqUrl,
      receiveOptions,
    );
    if (messages.length === 0) break;

    const sendResult = await deps.sqsOperations.sendBatch(
      settings.queueUrl,
      toSendEntries(messages),
    );

    for (const failure of sendResult.failed) {
      await failedWriter.append(failure.entry);
    }

    if (sendResult.successful.length > 0) {
      confirmed = await confirmDeleteOnce(
        confirmed,
        deps,
        `delete redriven messages from queue ${settings.dlqUrl}`,
        settings.yes,
      );
      const successfulIds = new Set(
        sendResult.successful.map((entry) => entry.id),
      );
      const deleteResult = await deps.sqsOperations.deleteBatch(
        settings.dlqUrl,
        toDeleteEntries(messages, successfulIds),
      );
      logDeleteFailures(deps.logger, deleteResult.failed);
    }

    total += messages.length;
    if (total >= settings.batchSize) break;
  }
  return { total };
}

/**
 * Runs the `redrive` command: moves messages from `dlqUrl` back to
 * `queueUrl`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LSQSOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once the run completes.
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `queueUrl`/
 *   `dlqUrl` is missing, or `"ERR_SQS_ETL_ABORTED"` when the
 *   `Core.confirmDestructive` confirmation is declined (any already-sent
 *   entries stay sent — only the DLQ delete is aborted).
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { redriveQueue } from "./redrive-queue.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * await redriveQueue({
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
export async function redriveQueue(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const settings = resolveSettings(deps.config);
  const failedPath = deps.paths.resolveOutput("failed.jsonl");

  const failedExporter = new Core.M3LJSONListExporter<AWS.M3LSQSSendEntry>({
    filePath: failedPath,
    format: "jsonl",
  });
  const failedWriter = failedExporter.exportStream();

  let result: { total: number };
  try {
    result = await runRedrivePages(deps, settings, failedWriter);
  } catch (cause) {
    await closeWriterBestEffort(failedWriter);
    throw cause;
  }
  await failedWriter.close();

  deps.logger.step(`sqs-etl redrive run ${deps.correlationId} complete`, {
    total: result.total,
  });
}
