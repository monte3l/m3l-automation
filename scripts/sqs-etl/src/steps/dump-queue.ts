import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `dump-queue` — long-polls `receive()` (10 messages/call,
 * `waitTimeSeconds: 20`) and streams each received message to `output` as
 * JSONL until `batchSize` is reached or an empty page is returned (the queue
 * is drained). `deleteAfterDump` additionally `deleteBatch()`s each written
 * page — a destructive turn from "dump" into "drain" — confirm-gated exactly
 * ONCE for the whole run (not once per page).
 */

const RECEIVE_MAX_MESSAGES = 10;
const RECEIVE_WAIT_TIME_SECONDS = 20;
const DEFAULT_BATCH_SIZE = 100;

/** The resolved, guard-checked settings a run needs. */
interface DumpSettings {
  readonly queueUrl: string;
  readonly output: string;
  readonly batchSize: number;
  readonly visibilityTimeoutSeconds: number | undefined;
  readonly deleteAfterDump: boolean;
  readonly yes: boolean;
  readonly yesSensitive: boolean;
}

/** Resolves and guard-checks every declared parameter `dumpQueue` needs. */
function resolveSettings(config: Core.M3LConfig): DumpSettings {
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: "ERR_SQS_ETL_CONFIG",
  });
  return {
    queueUrl: accessor.requiredString("queueUrl", "dump"),
    output: accessor.requiredString("output", "dump"),
    batchSize: accessor.numberWithDefault("batchSize", DEFAULT_BATCH_SIZE),
    visibilityTimeoutSeconds: accessor.optionalNumber(
      "visibilityTimeoutSeconds",
    ),
    deleteAfterDump: accessor.booleanWithDefault("deleteAfterDump", false),
    yes: accessor.booleanWithDefault("yes", false),
    yesSensitive: accessor.booleanWithDefault("yesSensitive", false),
  };
}

/**
 * Builds the `receive()` options for one page, capping `maxMessages` to
 * whatever remains of the `batchSize` budget so a single call never
 * over-fetches past the requested total, omitting `visibilityTimeout` when
 * unset.
 */
function buildReceiveOptions(
  settings: DumpSettings,
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

/** Maps one received page to the `deleteBatch()` entries for that page, chunk-scoped ids. */
function toDeleteEntries(
  messages: readonly AWS.M3LSQSReceivedMessage[],
): AWS.M3LSQSDeleteEntry[] {
  return messages.map((message, index) => ({
    id: String(index),
    receiptHandle: message.receiptHandle,
  }));
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
 * `dumpQueue` call: a no-op returning `true` on every call once `confirmed`
 * is already `true`.
 *
 * @returns `true` — either already confirmed, or just confirmed now.
 */
async function confirmDeleteOnce(
  confirmed: boolean,
  deps: {
    readonly prompt: Core.M3LPrompt;
    readonly logger: Core.M3LLogger;
    readonly awsTarget: Core.M3LDestructiveTarget;
  },
  description: string,
  yes: boolean,
  yesSensitive: boolean,
): Promise<boolean> {
  if (confirmed) return true;
  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description,
    yes,
    yesSensitive,
    code: "ERR_SQS_ETL_ABORTED",
    target: deps.awsTarget,
    isSensitiveTarget: (target) =>
      target.profile.toLowerCase().includes("prod"),
  });
  return true;
}

/** Best-effort closes `writer`, swallowing any close failure — used when a primary error already occurred and must not be masked by a subsequent close failure. */
async function closeWriterBestEffort(
  writer: Core.M3LListExporterStreamWriter<AWS.M3LSQSReceivedMessage>,
): Promise<void> {
  try {
    await writer.close();
  } catch {
    // best-effort: a close failure must not mask the original error
  }
}

/**
 * Runs the receive/write/delete loop until `settings.batchSize` is reached or
 * `receive()` returns an empty page: long-polls `queueUrl`, streams each
 * received message to `writer`, and (when `deleteAfterDump`, once confirmed)
 * `deleteBatch()`s the written page.
 *
 * @returns The total count of messages received across every page.
 */
async function runDumpPages(
  deps: {
    readonly logger: Core.M3LLogger;
    readonly sqsOperations: AWS.M3LSQSOperations;
    readonly prompt: Core.M3LPrompt;
    readonly awsTarget: Core.M3LDestructiveTarget;
  },
  settings: DumpSettings,
  writer: Core.M3LListExporterStreamWriter<AWS.M3LSQSReceivedMessage>,
): Promise<{ total: number }> {
  let confirmed = false;
  let total = 0;
  for (;;) {
    const receiveOptions = buildReceiveOptions(
      settings,
      settings.batchSize - total,
    );
    const messages = await deps.sqsOperations.receive(
      settings.queueUrl,
      receiveOptions,
    );
    if (messages.length === 0) break;

    for (const message of messages) {
      await writer.append(message);
    }

    if (settings.deleteAfterDump) {
      confirmed = await confirmDeleteOnce(
        confirmed,
        deps,
        `delete drained messages from queue ${settings.queueUrl}`,
        settings.yes,
        settings.yesSensitive,
      );
      const deleteResult = await deps.sqsOperations.deleteBatch(
        settings.queueUrl,
        toDeleteEntries(messages),
      );
      logDeleteFailures(deps.logger, deleteResult.failed);
    }

    total += messages.length;
    if (total >= settings.batchSize) break;
  }
  return { total };
}

/**
 * Runs the `dump` command: drains up to `batchSize` messages from
 * `queueUrl` into `output` as JSONL, optionally deleting each written page
 * (`deleteAfterDump`) once the `Core.confirmDestructive` confirmation has
 * cleared.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LSQSOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once the run completes.
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `queueUrl`/
 *   `output` is missing, or `"ERR_SQS_ETL_ABORTED"` when a `deleteAfterDump`
 *   confirmation is declined (the already-written output survives).
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { dumpQueue } from "./dump-queue.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * await dumpQueue({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "sqs-etl", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   sqsOperations,
 *   prompt: new Core.M3LPrompt(),
 *   awsTarget: { profile: "dev" },
 * });
 * ```
 */
export async function dumpQueue(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
  readonly prompt: Core.M3LPrompt;
  readonly awsTarget: Core.M3LDestructiveTarget;
}): Promise<void> {
  const settings = resolveSettings(deps.config);
  const outputPath = deps.paths.resolveOutput(settings.output);

  const exporter = new Core.M3LJSONListExporter<AWS.M3LSQSReceivedMessage>({
    filePath: outputPath,
    format: "jsonl",
  });
  const writer = exporter.exportStream();

  let result: { total: number };
  try {
    result = await runDumpPages(deps, settings, writer);
  } catch (cause) {
    await closeWriterBestEffort(writer);
    throw cause;
  }
  await writer.close();

  deps.logger.step(`sqs-etl dump run ${deps.correlationId} complete`, {
    total: result.total,
  });
}
