import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { watchExecution } from "../src/steps/watch-execution.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `scripts/codepipeline-ops/src/steps/watch-execution.ts` — the
 * load-bearing poll module. Uses `Core.M3LPoller` with
 * `Core.M3LBackoff.constant(waitIntervalSeconds * 1000)` and
 * `maxAttempts: waitMaxAttempts`, polling
 * `operations.getPipelineExecution(pipeline, executionId)`. Five documented
 * rules, each its own test group below:
 *
 * 1. `getPipelineExecution` resolving `undefined` continues polling.
 * 2. Terminal statuses `Succeeded`/`Failed`/`Stopped`/`Cancelled`/`Superseded`
 *    all resolve success — this function never throws on a failed terminal
 *    status; that decision is `run-codepipeline-ops`'s, after persisting.
 * 3. `Superseded` additionally calls `deps.logger.warning(...)`.
 * 4. An unrecognized status continues polling (with a `logger.warning` call)
 *    rather than being treated as terminal.
 * 5. Exhaustion (never reaching a terminal status within `waitMaxAttempts`)
 *    rejects with a `Core.M3LError` coded `"ERR_POLL_EXHAUSTED"` — caught by
 *    `.code`, not `instanceof`, since the poller's own error classes are
 *    internal/unexported.
 */

/**
 * Drives a promise to settlement while flushing all pending fake timers, so
 * `M3LPoller`'s constant-delay backoff resolves without real wall-clock
 * waits. Mirrors `packages/m3l-common/tests/polling.test.ts`'s
 * `settleWithTimers` helper.
 */
async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const settledOutcome = Promise.allSettled([promise]).then((results) => {
    settled = true;
    return results[0];
  });
  for (let i = 0; i < 1000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  const outcome = await settledOutcome;
  if (outcome?.status === "rejected") {
    throw outcome.reason;
  }
  return (outcome as PromiseFulfilledResult<T>).value;
}

function buildExecution(status: string): AWS.M3LCodePipelineExecution {
  return {
    pipelineExecutionId: "exec-1",
    pipelineName: "my-pipeline",
    status,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("watchExecution — rule 1: undefined result continues polling", () => {
  test("continues polling when getPipelineExecution resolves undefined, then succeeds on the terminal execution", async () => {
    const succeeded = buildExecution("Succeeded");
    const getPipelineExecution = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(succeeded);
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });
    const logger = new Core.M3LLogger([]);

    const result = await settleWithTimers(
      watchExecution({
        operations,
        logger,
        pipeline: "my-pipeline",
        executionId: "exec-1",
        waitMaxAttempts: 10,
        waitIntervalSeconds: 1,
      }),
    );

    expect(result).toEqual(succeeded);
    expect(getPipelineExecution.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("watchExecution — rule 2: terminal statuses all resolve success, never throw", () => {
  test.each([
    "Succeeded",
    "Failed",
    "Stopped",
    "Cancelled",
    "Superseded",
  ] as const)(
    "resolves the execution for terminal status '%s' without throwing",
    async (status) => {
      const execution = buildExecution(status);
      const getPipelineExecution = vi.fn().mockResolvedValue(execution);
      const operations = createFakeCodePipelineOperations({
        getPipelineExecution,
      });
      const logger = new Core.M3LLogger([]);

      const result = await settleWithTimers(
        watchExecution({
          operations,
          logger,
          pipeline: "my-pipeline",
          executionId: "exec-1",
          waitMaxAttempts: 5,
          waitIntervalSeconds: 1,
        }),
      );

      expect(result).toEqual(execution);
    },
  );
});

describe("watchExecution — rule 3: Superseded logs a warning", () => {
  test("calls deps.logger.warning when the execution status is Superseded", async () => {
    const execution = buildExecution("Superseded");
    const getPipelineExecution = vi.fn().mockResolvedValue(execution);
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    await settleWithTimers(
      watchExecution({
        operations,
        logger,
        pipeline: "my-pipeline",
        executionId: "exec-1",
        waitMaxAttempts: 5,
        waitIntervalSeconds: 1,
      }),
    );

    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0]?.[0]).toContain("exec-1");
  });

  test.each(["Succeeded", "Failed", "Stopped", "Cancelled"] as const)(
    "does not call deps.logger.warning for terminal status '%s'",
    async (status) => {
      const execution = buildExecution(status);
      const getPipelineExecution = vi.fn().mockResolvedValue(execution);
      const operations = createFakeCodePipelineOperations({
        getPipelineExecution,
      });
      const logger = new Core.M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");

      await settleWithTimers(
        watchExecution({
          operations,
          logger,
          pipeline: "my-pipeline",
          executionId: "exec-1",
          waitMaxAttempts: 5,
          waitIntervalSeconds: 1,
        }),
      );

      expect(warningSpy).not.toHaveBeenCalled();
    },
  );
});

describe("watchExecution — rule 4: unrecognized status continues polling with a warning", () => {
  test("logs a warning and continues polling on an unrecognized status, then succeeds once terminal", async () => {
    const succeeded = buildExecution("Succeeded");
    const getPipelineExecution = vi
      .fn()
      .mockResolvedValueOnce(buildExecution("SomeFutureStatus"))
      .mockResolvedValue(succeeded);
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    const result = await settleWithTimers(
      watchExecution({
        operations,
        logger,
        pipeline: "my-pipeline",
        executionId: "exec-1",
        waitMaxAttempts: 10,
        waitIntervalSeconds: 1,
      }),
    );

    expect(result).toEqual(succeeded);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0]?.[0]).toContain("SomeFutureStatus");
  });

  test("does not treat 'InProgress'/'Stopping' as unrecognized (no warning, keeps polling)", async () => {
    const succeeded = buildExecution("Succeeded");
    const getPipelineExecution = vi
      .fn()
      .mockResolvedValueOnce(buildExecution("InProgress"))
      .mockResolvedValueOnce(buildExecution("Stopping"))
      .mockResolvedValue(succeeded);
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    const result = await settleWithTimers(
      watchExecution({
        operations,
        logger,
        pipeline: "my-pipeline",
        executionId: "exec-1",
        waitMaxAttempts: 10,
        waitIntervalSeconds: 1,
      }),
    );

    expect(result).toEqual(succeeded);
    expect(warningSpy).not.toHaveBeenCalled();
  });
});

describe("watchExecution — rule 5: exhaustion rejects with ERR_POLL_EXHAUSTED", () => {
  test("rejects with a Core.M3LError coded ERR_POLL_EXHAUSTED when never reaching a terminal status", async () => {
    const getPipelineExecution = vi
      .fn()
      .mockResolvedValue(buildExecution("InProgress"));
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await settleWithTimers(
        watchExecution({
          operations,
          logger,
          pipeline: "my-pipeline",
          executionId: "exec-1",
          waitMaxAttempts: 2,
          waitIntervalSeconds: 1,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_POLL_EXHAUSTED");
  });
});

describe("watchExecution — signal: cooperative cancellation (ADR-0049)", () => {
  test("rejects with M3LOperationAbortedError when the signal is already aborted before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const getPipelineExecution = vi
      .fn()
      .mockResolvedValue(buildExecution("InProgress"));
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await settleWithTimers(
        watchExecution({
          operations,
          logger,
          pipeline: "my-pipeline",
          executionId: "exec-1",
          waitMaxAttempts: 5,
          waitIntervalSeconds: 1,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
    // The poller must check the signal before invoking the check function —
    // an already-aborted signal rejects without ever calling
    // getPipelineExecution.
    expect(getPipelineExecution).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("watchExecution resolves M3LCodePipelineExecution", () => {
    expectTypeOf(
      watchExecution,
    ).returns.resolves.toEqualTypeOf<AWS.M3LCodePipelineExecution>();
  });
});
