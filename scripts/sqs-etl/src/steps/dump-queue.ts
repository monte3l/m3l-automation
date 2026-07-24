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
}

/**
 * Reads a required string parameter (`queueUrl`/`output`), throwing when it
 * is missing (never declared `required: true` — F1b — so per-command
 * requiredness is guard-checked here) or was stored as a non-string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"`.
 */
function readRequiredString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required for 'dump'`, {
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

/** Resolves and guard-checks every declared parameter `dumpQueue` needs. */
function resolveSettings(config: Core.M3LConfig): DumpSettings {
  const batchSizeRaw = config.get("batchSize");
  return {
    queueUrl: readRequiredString(config, "queueUrl"),
    output: readRequiredString(config, "output"),
    batchSize:
      typeof batchSizeRaw === "number" ? batchSizeRaw : DEFAULT_BATCH_SIZE,
    visibilityTimeoutSeconds: readOptionalNumber(
      config,
      "visibilityTimeoutSeconds",
    ),
    deleteAfterDump: readBool(config, "deleteAfterDump"),
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
}): Promise<void> {
  const settings = resolveSettings(deps.config);
  const outputPath = deps.paths.resolveOutput(settings.output);

  const exporter = new Core.M3LJSONListExporter<AWS.M3LSQSReceivedMessage>({
    filePath: outputPath,
    format: "jsonl",
  });
  const writer = exporter.exportStream();

  let confirmed = false;
  let total = 0;
  try {
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
  } catch (cause) {
    try {
      await writer.close();
    } catch {
      // best-effort: a close failure must not mask the original error
    }
    throw cause;
  }
  await writer.close();

  deps.logger.step(`sqs-etl dump run ${deps.correlationId} complete`, {
    total,
  });
}
