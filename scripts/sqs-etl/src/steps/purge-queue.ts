import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `purge-queue` — clears `queueUrl`'s contents via
 * `sqsOperations.purgeQueue()`. Confirm-gated (bypassed by `yes`). SQS
 * enforces a 60-second cooldown between purges (`PurgeQueueInProgress`),
 * which surfaces as the typed `AWS.M3LSQSOperationError` the library already
 * throws — this step does not retry through it.
 */

/**
 * Runs the `purge` command: clears `queueUrl` once the
 * `Core.confirmDestructive` confirmation has cleared.
 *
 * @param deps - The resolved config, logger, correlation id, the injected
 *   `AWS.M3LSQSOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once the queue has been purged.
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `queueUrl`
 *   is missing, or `"ERR_SQS_ETL_ABORTED"` when the confirmation is
 *   declined.
 * @throws {@link AWS.M3LSQSOperationError} when the underlying `PurgeQueue`
 *   call fails, including a `PurgeQueueInProgress` cooldown rejection.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { purgeQueue } from "./purge-queue.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * await purgeQueue({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "sqs-etl", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   sqsOperations,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function purgeQueue(deps: {
  readonly config: Core.M3LConfig;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_SQS_ETL_CONFIG",
  });
  const queueUrl = accessor.requiredString("queueUrl", "purge");
  const yes = accessor.booleanWithDefault("yes", false);

  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description: `purge queue ${queueUrl}`,
    yes,
    code: "ERR_SQS_ETL_ABORTED",
  });

  await deps.sqsOperations.purgeQueue(queueUrl);

  deps.logger.step(`sqs-etl purge run ${deps.correlationId} complete`, {
    queueUrl,
  });
}
