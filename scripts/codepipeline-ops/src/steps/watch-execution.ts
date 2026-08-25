import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The two `PipelineExecutionStatus` values meaning "not yet terminal" — poll
 * again. This module owns its own copy of the full status set rather than a
 * library-provided one: `M3LCodePipelineExecution.status` is typed plain
 * `string` (a closed union on a read path would make a future server-side
 * value a type-level lie), so nothing at the type level enumerates these —
 * see `docs/reference/aws/codepipeline.md`'s "Watching an execution"
 * section.
 */
const NON_TERMINAL_STATUSES = new Set(["InProgress", "Stopping"]);

/** The one terminal status meaning the execution completed successfully. */
const SUCCEEDED_STATUS = "Succeeded";

/**
 * The terminal status meaning a later execution overtook this one before it
 * reached `Succeeded` or `Failed` — CodePipeline's default `SUPERSEDED`
 * execution mode. This is routine, not a failure: it is logged as a warning
 * and treated as a successful watch resolution.
 */
const SUPERSEDED_STATUS = "Superseded";

/**
 * The three terminal statuses meaning the execution did not succeed.
 * Exported so `run-codepipeline-ops.ts`'s `assertWatchSucceeded` shares this
 * one set rather than hand-maintaining a second, independently-drifting
 * copy of the same domain fact.
 */
export const FAILED_STATUSES: Set<string> = new Set([
  "Failed",
  "Stopped",
  "Cancelled",
]);

/**
 * The dependencies `watchExecution` needs, already resolved and
 * guard-checked by `run-codepipeline-ops`. Never gated — watching is
 * read-only.
 */
interface WatchExecutionDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly logger: Core.M3LLogger;
  readonly pipeline: string;
  readonly executionId: string;
  readonly waitMaxAttempts: number;
  readonly waitIntervalSeconds: number;
  readonly signal?: AbortSignal;
}

const MS_PER_SECOND = 1000;

/**
 * Polls `operations.getPipelineExecution(pipeline, executionId)` via
 * `Core.M3LPoller` until the execution reaches a terminal
 * `PipelineExecutionStatus`, using a script-owned constant-delay policy — no
 * library-provided `M3LPollingPolicies` entry exists for CodePipeline
 * because terminal-state detection here needs no follow-up result retrieval
 * (unlike Athena/CloudWatch Logs Insights queries).
 *
 * Four rules, each closing a documented sharp edge:
 *
 * 1. `getPipelineExecution` resolving `undefined` (the wrapper's signal for
 *    `PipelineNotFoundException` *or* `PipelineExecutionNotFoundException`)
 *    is treated as `{ type: "continue" }` — the eventual-consistency window
 *    right after `start-execution` triggers, not a failure. Every attempt
 *    that hits this branch logs a warning (matching the unrecognized-status
 *    branch below), so a persistently-`undefined` result — e.g. a typo'd
 *    `executionId` that will never resolve — is visible during the run
 *    rather than indistinguishable from a genuinely slow pipeline.
 * 2. This function never returns a `failure` decision — that decision arm
 *    carries no payload, which would lose the execution record needed for
 *    the output artifact. Every terminal status resolves a `success`
 *    decision carrying the execution; `run-codepipeline-ops` decides
 *    pass/fail *after* `poll()` resolves, once the result is in hand to
 *    persist first.
 * 3. An unrecognized `status` value continues polling rather than treating
 *    it as terminal — `status` is `string`, and a future server-side value
 *    must not be silently misclassified either way; exhaustion surfaces it.
 * 4. `Superseded` is logged via `deps.logger.warning` and resolved as a
 *    success — it is not in {@link FAILED_STATUSES}.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations`, logger, target
 *   `pipeline`/`executionId`, and the resolved `waitMaxAttempts`/
 *   `waitIntervalSeconds` poll policy.
 * @returns The terminal `M3LCodePipelineExecution` — callers must inspect
 *   `.status` themselves to distinguish `Succeeded`/`Superseded` from
 *   `Failed`/`Stopped`/`Cancelled`; this function does not throw on a
 *   failed terminal status.
 * @throws {@link Core.M3LError} coded `"ERR_POLL_EXHAUSTED"` when
 *   `waitMaxAttempts` is reached while the execution is still non-terminal
 *   (or reporting an unrecognized status) — re-thrown with the `pipeline`/
 *   `executionId` context and the original poller error chained as `cause`,
 *   so an exhausted watch is diagnosable (a mistyped `executionId` that
 *   never resolves vs. a genuinely slow pipeline) rather than the poller's
 *   own bare "poll exhausted after N attempts" message.
 *
 * @example
 * ```typescript
 * import type { AWS, Core } from "@m3l-automation/m3l-common";
 * import { watchExecution } from "./watch-execution.js";
 *
 * declare const operations: AWS.M3LCodePipelineOperations;
 * declare const logger: Core.M3LLogger;
 *
 * const execution = await watchExecution({
 *   operations,
 *   logger,
 *   pipeline: "my-pipeline",
 *   executionId: "11111111-2222-3333-4444-555555555555",
 *   waitMaxAttempts: 60,
 *   waitIntervalSeconds: 15,
 * });
 * ```
 */
export async function watchExecution(
  deps: WatchExecutionDeps,
): Promise<AWS.M3LCodePipelineExecution> {
  const poller = new Core.M3LPoller({
    backoff: Core.M3LBackoff.constant(deps.waitIntervalSeconds * MS_PER_SECOND),
    maxAttempts: deps.waitMaxAttempts,
    ...(deps.signal !== undefined && { signal: deps.signal }),
  });

  let response;
  try {
    response = await poller.poll(async () => {
      const execution = await deps.operations.getPipelineExecution(
        deps.pipeline,
        deps.executionId,
      );
      if (execution === undefined) {
        deps.logger.warning(
          `watch-execution: execution '${deps.executionId}' on pipeline '${deps.pipeline}' not yet visible — continuing to poll`,
        );
        return { type: "continue" };
      }
      return checkTerminal(execution, deps);
    });
  } catch (cause) {
    if (cause instanceof Core.M3LError && cause.code === "ERR_POLL_EXHAUSTED") {
      throw new Core.M3LError(
        `watch-execution: exhausted waiting for execution '${deps.executionId}' on pipeline '${deps.pipeline}' to reach a terminal status`,
        { code: "ERR_POLL_EXHAUSTED", cause },
      );
    }
    throw cause;
  }
  return response;
}

/** Classifies a resolved `M3LCodePipelineExecution` into a poll decision — the four status-handling rules documented on {@link watchExecution}. */
function checkTerminal(
  execution: AWS.M3LCodePipelineExecution,
  deps: Pick<WatchExecutionDeps, "logger" | "pipeline" | "executionId">,
): Core.M3LPollDecision<AWS.M3LCodePipelineExecution> {
  if (execution.status === SUPERSEDED_STATUS) {
    deps.logger.warning(
      `watch-execution: execution '${deps.executionId}' on pipeline '${deps.pipeline}' was superseded by a later execution`,
    );
    return { type: "success", value: execution };
  }
  if (
    execution.status === SUCCEEDED_STATUS ||
    FAILED_STATUSES.has(execution.status)
  ) {
    return { type: "success", value: execution };
  }
  if (!NON_TERMINAL_STATUSES.has(execution.status)) {
    deps.logger.warning(
      `watch-execution: execution '${deps.executionId}' reported unrecognized status '${execution.status}' — continuing to poll`,
    );
  }
  return { type: "continue" };
}
