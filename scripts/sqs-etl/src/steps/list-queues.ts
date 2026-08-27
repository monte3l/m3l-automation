import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `list-queues` — lists the account's SQS queue URLs via
 * `sqsOperations.listQueues()`. Read-only: no `prompt`/`awsTarget`/
 * `reportRecovery` dependency and never destructive-gated.
 */

/**
 * Runs the `list-queues` command: forwards the optional `queueNamePrefix`/
 * `nextToken` config values to `sqsOperations.listQueues()` and returns the
 * raw result unchanged, optionally persisting it to `output` as a single
 * JSON document (via {@link Core.M3LJSONFileExporter} — never wrapped in an
 * array).
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, and
 *   the injected `AWS.M3LSQSOperations`.
 * @returns The raw `AWS.M3LSQSListQueuesResult` page returned by
 *   `sqsOperations.listQueues()`.
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when
 *   `queueNamePrefix` or `nextToken` is stored as a non-string value.
 * @throws {@link AWS.M3LSQSOperationError} when the underlying `ListQueues`
 *   call fails.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { listQueues } from "./list-queues.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * const result = await listQueues({
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
export async function listQueues(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
}): Promise<AWS.M3LSQSListQueuesResult> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_SQS_ETL_CONFIG",
  });
  const queueNamePrefix = accessor.optionalString("queueNamePrefix");
  const nextToken = accessor.optionalString("nextToken");
  const output = accessor.optionalString("output");

  const result = await deps.sqsOperations.listQueues({
    ...(queueNamePrefix !== undefined && { queueNamePrefix }),
    ...(nextToken !== undefined && { nextToken }),
  });

  if (output !== undefined) {
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(output),
    });
    await exporter.export(result);
  }

  deps.logger.step(`sqs-etl list-queues run ${deps.correlationId} complete`, {
    count: result.queueUrls.length,
    ...(result.nextToken !== undefined && { nextToken: result.nextToken }),
  });

  return result;
}
