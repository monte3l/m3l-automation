import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `run-sqs-etl` — the thin composition step: reads the already
 * `oneOf`-validated `command` config parameter and dispatches, unchanged,
 * the full deps object to the matching step. This module owns no business
 * logic of its own beyond the dispatch `switch`.
 */

/** The dependencies every dispatched step receives, unchanged. */
interface RunSqsEtlDeps {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly sqsOperations: AWS.M3LSQSOperations;
  readonly prompt: Core.M3LPrompt;
}

/**
 * Runs `sqs-etl`: dispatches to the `steps/` module matching the resolved
 * `command`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LSQSOperations`, and the interactive-prompt facade —
 *   forwarded unchanged to whichever step is selected.
 * @returns The dispatched step's own return value (`void` for every command
 *   except `transform`, which returns its read/written/skipped summary).
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `command`
 *   is not one of the six declared modes — unreachable through the declared
 *   config schema's `oneOf` validator, guarded here defensively.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runSqsEtl } from "./run-sqs-etl.js";
 *
 * declare const sqsOperations: import("@m3l-automation/m3l-common/aws").M3LSQSOperations;
 *
 * await runSqsEtl({
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
export async function runSqsEtl(
  deps: RunSqsEtlDeps,
): Promise<{ read: number; written: number; skipped: number } | void> {
  const command = deps.config.get("command");

  // Each step module is imported dynamically, at dispatch time rather than
  // at this module's top level: `steps/*.test.ts` files replace these
  // modules with `vi.mock` factories that close over `vi.fn()` spies
  // declared later in the same test file, so a top-level static import here
  // would resolve the (mocked) module graph before those spies are
  // initialized. Dispatch-time dynamic import defers resolution until the
  // switch actually runs — inside a test body, after the spies exist.
  switch (command) {
    case "dump": {
      const { dumpQueue } = await import("./dump-queue.js");
      return dumpQueue(deps);
    }
    case "send": {
      const { sendBatch } = await import("./send-batch.js");
      return sendBatch(deps);
    }
    case "redrive": {
      const { redriveQueue } = await import("./redrive-queue.js");
      return redriveQueue(deps);
    }
    case "delete": {
      const { deleteMessages } = await import("./delete-messages.js");
      return deleteMessages(deps);
    }
    case "purge": {
      const { purgeQueue } = await import("./purge-queue.js");
      return purgeQueue(deps);
    }
    case "transform": {
      const { transformRecords } = await import("./transform-records.js");
      return transformRecords(deps);
    }
    default:
      throw new Core.M3LError(
        `unrecognized 'command' value: ${String(command)}`,
        { code: "ERR_SQS_ETL_CONFIG", context: { command } },
      );
  }
}
