import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as WatchExecutionModule from "../src/steps/watch-execution.js";

/**
 * Contract: `scripts/codepipeline-ops/src/steps/run-codepipeline-ops.ts` —
 * the dispatcher. Dynamic-`import()`s each of the 7 step modules
 * (`./read-pipelines.js`, `./read-state.js`, `./read-executions.js`,
 * `./write-pipeline.js`, `./execute.js`, `./transitions.js`,
 * `./watch-execution.js`) at dispatch time via an exhaustive
 * operation-narrowing chain. Runs `Core.confirmDestructive` before
 * dispatching any of `create-pipeline`/`update-pipeline`/`delete-pipeline` —
 * NOT before any of the other 10 operations. Persists the dispatch result to
 * `output` (when configured, skipped when the result is `undefined`) via
 * `Core.M3LJSONFileExporter`. After persisting, `assertWatchSucceeded` throws
 * `ERR_CODEPIPELINE_OPS_WATCH_FAILED` (with `context: {status}`) iff
 * `operation === "watch-execution"` and the resolved execution's `status` is
 * one of `Failed`/`Stopped`/`Cancelled` — NOT for `Succeeded`/`Superseded`.
 * Every per-operation missing-required-field guard throws
 * `ERR_CODEPIPELINE_OPS_CONFIG`; `input` file read/parse failures throw
 * `ERR_CODEPIPELINE_OPS_INPUT`. Step modules are mocked (this file asserts
 * ONLY the orchestrator's guard/gate/dispatch/persist wiring, never a step's
 * internal logic — that is each step's own test file's job);
 * `node:fs/promises` and `Core.M3LJSONFileExporter` are the true I/O
 * boundary, also mocked. The destructive gate itself
 * (`Core.confirmDestructive`) runs for real: it is exercised end to end and
 * observed at the one seam it always calls through — a per-test
 * `Core.M3LPrompt` instance's `confirm` method, spied via `vi.spyOn` (the
 * same technique `scripts/ecs-ops/tests/run-ecs-ops.test.ts` uses for its own
 * destructive gate). This is architecture-agnostic: it observes the gate at
 * the prompt boundary `confirmDestructive` has always called through,
 * regardless of how the pipeline that invokes it is wired.
 *
 * Target-graded escalation (ADR-0048/A2b): the pipeline's `destructive` gate
 * option wires `target: (_operation, _settings, _context, deps) =>
 * deps.awsTarget` and `isSensitiveTarget: (target) =>
 * target.profile.toLowerCase().includes("prod")`. `buildDeps`'s `awsTarget`
 * override defaults to a non-sensitive profile (`"dev-sandbox"`) so every
 * pre-existing test in this file is unaffected; tests that need the sensitive
 * path override it explicitly (e.g. `{ profile: "prod" }`). The escalated
 * path is observed at `prompt.text` — the same directly-injected-`M3LPrompt`
 * seam `confirmingPrompt` already uses for `prompt.confirm`.
 */

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// vi.hoisted() is required here (unlike the plain vi.fn() locals below):
// run-codepipeline-ops.ts statically imports `FAILED_STATUSES` from
// ./watch-execution.js (so `assertWatchSucceeded` doesn't hand-maintain a
// second copy of the same status set — see that module's export), which
// forces watch-execution.js's own mock factory to also run eagerly at
// module-eval time. The remaining relative-path step mocks are only resolved
// lazily via the dispatcher's dynamic import() inside a test body, by which
// point a plain const has long since run.
const watchExecutionMock = vi.hoisted(() => vi.fn());
const readPipelinesMock = vi.fn();
const readStateMock = vi.fn();
const readExecutionsMock = vi.fn();
const writePipelineMock = vi.fn();
const executeMock = vi.fn();
const transitionsMock = vi.fn();

vi.mock("../src/steps/read-pipelines.js", () => ({
  readPipelines: readPipelinesMock,
}));
vi.mock("../src/steps/read-state.js", () => ({
  readState: readStateMock,
}));
vi.mock("../src/steps/read-executions.js", () => ({
  readExecutions: readExecutionsMock,
}));
vi.mock("../src/steps/write-pipeline.js", () => ({
  writePipeline: writePipelineMock,
}));
vi.mock("../src/steps/execute.js", () => ({
  execute: executeMock,
}));
vi.mock("../src/steps/transitions.js", () => ({
  transitions: transitionsMock,
}));
// Preserves the real `FAILED_STATUSES` export (imported statically by
// run-codepipeline-ops.ts's `assertWatchSucceeded`) while overriding only
// `watchExecution` — the same importOriginal-preserving pattern the
// node:fs/promises mock above uses, needed here because a plain object-
// literal factory would silently drop FAILED_STATUSES and crash
// `assertWatchSucceeded` at `.has(...)` on `undefined`.
vi.mock("../src/steps/watch-execution.js", async () => {
  const actual = await vi.importActual<typeof WatchExecutionModule>(
    "../src/steps/watch-execution.js",
  );
  return { ...actual, watchExecution: watchExecutionMock };
});

import { Core } from "@m3l-automation/m3l-common";

import { runCodepipelineOps } from "../src/steps/run-codepipeline-ops.js";
import {
  buildConfig,
  createFakeCodePipelineOperations,
} from "./support/codePipelineFakes.js";

const PATHS = new Core.M3LPaths();

const DECLARATION = {
  name: "my-pipeline",
  roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
  stages: [{ name: "Source", actions: [] }],
};

/** Stubs `fsp.readFile` keyed by the exact resolved path it is called with. */
function stubReadFileByPath(entries: Record<string, string | Buffer>): void {
  vi.spyOn(fsp, "readFile").mockImplementation(((filePath: unknown) => {
    const key = String(filePath);
    const value = entries[key];
    if (value === undefined) {
      return Promise.reject(
        new Error(`stubReadFileByPath: unexpected path ${key}`),
      );
    }
    return Promise.resolve(
      typeof value === "string" ? Buffer.from(value, "utf8") : value,
    );
  }) as typeof fsp.readFile);
}

/** A non-sensitive default target — `awsTarget`'s profile never matches "prod". */
const DEFAULT_TARGET: Core.M3LDestructiveTarget = { profile: "dev-sandbox" };

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly operations?: ReturnType<typeof createFakeCodePipelineOperations>;
    readonly prompt?: Core.M3LPrompt;
    readonly awsTarget?: Core.M3LDestructiveTarget;
  },
): Parameters<typeof runCodepipelineOps>[0] {
  return {
    config: buildConfig(configValues),
    paths: PATHS,
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    operations: overrides?.operations ?? createFakeCodePipelineOperations(),
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
    awsTarget: overrides?.awsTarget ?? DEFAULT_TARGET,
  };
}

/**
 * Builds a `Core.M3LPrompt` whose `confirm` method is stubbed to resolve
 * `confirmed`, alongside the spy itself. `Core.confirmDestructive` always
 * calls `deps.prompt.confirm` directly on the decline/confirm path — this is
 * the seam every gate test in this file observes instead of a `Core`-barrel
 * override.
 */
function confirmingPrompt(confirmed: boolean) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(confirmed);
  return { prompt, confirm };
}

/**
 * Builds a `Core.M3LPrompt` whose `text` method is stubbed to resolve
 * `response` — the seam the escalated typed-echo path (`confirmDestructive`'s
 * states 4/5, for a sensitive target) calls through instead of `confirm`.
 * `confirm` is also spied (defaulted to resolve `true` so an unexpected call
 * doesn't hang the test on real stdin) so every test using this helper can
 * assert it was never called.
 */
function textRespondingPrompt(response: string) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
  const text = vi.spyOn(prompt, "text").mockResolvedValue(response);
  return { prompt, confirm, text };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies; it does not clear the
  // plain vi.fn() mocks created inside the top-level vi.mock() factories
  // above, so their call history would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockReset();
  readPipelinesMock.mockReset();
  readStateMock.mockReset();
  readExecutionsMock.mockReset();
  writePipelineMock.mockReset();
  executeMock.mockReset();
  transitionsMock.mockReset();
  watchExecutionMock.mockReset();
});

describe("runCodepipelineOps — per-operation config guards (fire before any AWS call or step dispatch)", () => {
  test.each([
    "describe-pipeline",
    "get-pipeline-state",
    "list-executions",
    "delete-pipeline",
    "start-execution",
    "enable-stage-transition",
    "watch-execution",
  ])(
    "throws ERR_CODEPIPELINE_OPS_CONFIG when operation '%s' is missing 'pipeline'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps(
        {
          operation,
          stage: "Deploy",
          transitionType: "Inbound",
          executionId: "exec-1",
        },
        { prompt },
      );

      await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(readPipelinesMock).not.toHaveBeenCalled();
      expect(readStateMock).not.toHaveBeenCalled();
      expect(readExecutionsMock).not.toHaveBeenCalled();
      expect(writePipelineMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(transitionsMock).not.toHaveBeenCalled();
      expect(watchExecutionMock).not.toHaveBeenCalled();
    },
  );

  test.each(["describe-execution", "stop-execution", "watch-execution"])(
    "throws ERR_CODEPIPELINE_OPS_CONFIG when operation '%s' is missing 'executionId'",
    async (operation) => {
      const deps = buildDeps({ operation, pipeline: "my-pipeline" });

      await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
      expect(readExecutionsMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(watchExecutionMock).not.toHaveBeenCalled();
    },
  );

  test.each(["create-pipeline", "update-pipeline"])(
    "throws ERR_CODEPIPELINE_OPS_CONFIG when operation '%s' is missing 'input'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps({ operation }, { prompt });

      await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(writePipelineMock).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when 'disable-stage-transition' is missing 'reason'", async () => {
    const deps = buildDeps({
      operation: "disable-stage-transition",
      pipeline: "my-pipeline",
      stage: "Deploy",
      transitionType: "Inbound",
    });

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_CONFIG",
    });
    expect(transitionsMock).not.toHaveBeenCalled();
  });

  test.each(["enable-stage-transition", "disable-stage-transition"])(
    "throws ERR_CODEPIPELINE_OPS_CONFIG when operation '%s' is missing 'stage'/'transitionType'",
    async (operation) => {
      const deps = buildDeps({
        operation,
        pipeline: "my-pipeline",
        reason: "why",
      });

      await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
      expect(transitionsMock).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({ operation: "frobnicate" });

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_CONFIG",
    });
    expect(readPipelinesMock).not.toHaveBeenCalled();
    expect(writePipelineMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(transitionsMock).not.toHaveBeenCalled();
    expect(watchExecutionMock).not.toHaveBeenCalled();
  });
});

describe("runCodepipelineOps — destructive-gate dispatch (create/update/delete-pipeline only)", () => {
  test.each([
    "list-pipelines",
    "describe-pipeline",
    "get-pipeline-state",
    "list-executions",
    "describe-execution",
    "start-execution",
    "stop-execution",
    "enable-stage-transition",
    "disable-stage-transition",
    "watch-execution",
  ])("never runs destructive-gate for '%s'", async (operation) => {
    readPipelinesMock.mockResolvedValue({ pipelines: [] });
    readStateMock.mockResolvedValue({ pipelineName: "", stageStates: [] });
    readExecutionsMock.mockResolvedValue({ executionSummaries: [] });
    executeMock.mockResolvedValue({ pipelineExecutionId: "exec-1" });
    transitionsMock.mockResolvedValue(undefined);
    watchExecutionMock.mockResolvedValue({
      pipelineExecutionId: "exec-1",
      pipelineName: "my-pipeline",
      status: "Succeeded",
    });
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation,
        pipeline: "my-pipeline",
        executionId: "exec-1",
        stage: "Deploy",
        transitionType: "Inbound",
        reason: "why",
      },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(confirm).not.toHaveBeenCalled();
  });

  test("runs destructive-gate exactly once before dispatching 'delete-pipeline', building description from the pipeline config value", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline" },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("my-pipeline"),
    );
  });

  test("forwards 'yes' through to destructive-gate", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline", yes: true },
      { prompt },
    );

    await runCodepipelineOps(deps);

    // yes: true bypasses the interactive prompt; confirmDestructive logs a
    // warning instead of calling confirm
    expect(confirm).not.toHaveBeenCalled();
    expect(writePipelineMock).toHaveBeenCalled();
  });

  test("propagates ERR_CODEPIPELINE_OPS_ABORTED from destructive-gate, never dispatching writePipeline", async () => {
    const { prompt } = confirmingPrompt(false);
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline" },
      { prompt },
    );

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_ABORTED",
    });
    expect(writePipelineMock).not.toHaveBeenCalled();
  });

  test("runs destructive-gate exactly once before dispatching 'create-pipeline', building description from the parsed input's name", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify(DECLARATION) });
    writePipelineMock.mockResolvedValue(DECLARATION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-pipeline", input: "create.json" },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("my-pipeline"),
    );
  });

  test("runs destructive-gate exactly once before dispatching 'update-pipeline'", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify(DECLARATION) });
    writePipelineMock.mockResolvedValue(DECLARATION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "update-pipeline", input: "update.json" },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt, confirm } = confirmingPrompt(true);
    const text = vi.spyOn(prompt, "text");
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline" },
      { prompt, awsTarget: { profile: "dev-sandbox" } },
    );

    await runCodepipelineOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt, confirm, text } = textRespondingPrompt("prod");
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await runCodepipelineOps(deps);

    expect(text).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(writePipelineMock).toHaveBeenCalled();
  });

  test("throws ERR_CODEPIPELINE_OPS_ABORTED when the typed-echo input doesn't match the profile", async () => {
    const { prompt, text } = textRespondingPrompt("not-the-profile");
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_ABORTED",
    });
    expect(text).toHaveBeenCalledTimes(1);
    expect(writePipelineMock).not.toHaveBeenCalled();
  });

  test("bypasses confirmation with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const warningSpy = vi.spyOn(Core.M3LLogger.prototype, "warning");
    const { prompt, confirm } = confirmingPrompt(true);
    const promptTextSpy = vi.spyOn(prompt, "text");
    const deps = buildDeps(
      {
        operation: "delete-pipeline",
        pipeline: "my-pipeline",
        yes: true,
        yesSensitive: true,
      },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await runCodepipelineOps(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(promptTextSpy).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("prod"));
    expect(writePipelineMock).toHaveBeenCalled();
  });

  test("still escalates when yes:true but yesSensitive is false/absent, for a sensitive target", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt, confirm, text } = textRespondingPrompt("prod");
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline", yes: true },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await runCodepipelineOps(deps);

    expect(text).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(writePipelineMock).toHaveBeenCalled();
  });
});

describe("runCodepipelineOps — operation dispatch routing (one representative per dispatch family)", () => {
  test("'list-pipelines' (read-pipelines family) dispatches with pipeline/version/maxResults", async () => {
    readPipelinesMock.mockResolvedValue({ pipelines: [] });
    const deps = buildDeps({
      operation: "list-pipelines",
      maxResults: 10,
    });

    await runCodepipelineOps(deps);

    expect(readPipelinesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list-pipelines",
        maxResults: 10,
        operations: deps.operations,
      }),
    );
  });

  test("'get-pipeline-state' (read-state family) dispatches with pipeline", async () => {
    readStateMock.mockResolvedValue({
      pipelineName: "my-pipeline",
      stageStates: [],
    });
    const deps = buildDeps({
      operation: "get-pipeline-state",
      pipeline: "my-pipeline",
    });

    await runCodepipelineOps(deps);

    expect(readStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: "my-pipeline",
        operations: deps.operations,
      }),
    );
  });

  test("'list-executions' (read-executions family) dispatches with pipeline/maxResults", async () => {
    readExecutionsMock.mockResolvedValue({ executionSummaries: [] });
    const deps = buildDeps({
      operation: "list-executions",
      pipeline: "my-pipeline",
      maxResults: 5,
    });

    await runCodepipelineOps(deps);

    expect(readExecutionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list-executions",
        pipeline: "my-pipeline",
        maxResults: 5,
      }),
    );
  });

  test("'delete-pipeline' (write family) dispatches to writePipeline with pipeline from config, declaration undefined", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete-pipeline", pipeline: "my-pipeline" },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(writePipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "delete-pipeline",
        pipeline: "my-pipeline",
        declaration: undefined,
      }),
    );
  });

  test("'start-execution' (execute family) dispatches with pipeline/clientRequestToken", async () => {
    executeMock.mockResolvedValue({ pipelineExecutionId: "exec-1" });
    const deps = buildDeps({
      operation: "start-execution",
      pipeline: "my-pipeline",
      clientRequestToken: "token-1",
    });

    await runCodepipelineOps(deps);

    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "start-execution",
        pipeline: "my-pipeline",
        clientRequestToken: "token-1",
      }),
    );
  });

  test("'enable-stage-transition' (transitions family) dispatches with pipeline/stage/transitionType", async () => {
    transitionsMock.mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "enable-stage-transition",
      pipeline: "my-pipeline",
      stage: "Deploy",
      transitionType: "Inbound",
    });

    await runCodepipelineOps(deps);

    expect(transitionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "enable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Deploy",
        transitionType: "Inbound",
      }),
    );
  });

  test("'watch-execution' (watch family) dispatches with pipeline/executionId/waitMaxAttempts/waitIntervalSeconds", async () => {
    watchExecutionMock.mockResolvedValue({
      pipelineExecutionId: "exec-1",
      pipelineName: "my-pipeline",
      status: "Succeeded",
    });
    const deps = buildDeps({
      operation: "watch-execution",
      pipeline: "my-pipeline",
      executionId: "exec-1",
      waitMaxAttempts: 30,
      waitIntervalSeconds: 5,
    });

    await runCodepipelineOps(deps);

    expect(watchExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: "my-pipeline",
        executionId: "exec-1",
        waitMaxAttempts: 30,
        waitIntervalSeconds: 5,
      }),
    );
  });

  test("'create-pipeline' reads + parses input JSON, dispatching the record to writePipeline", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify(DECLARATION) });
    writePipelineMock.mockResolvedValue(DECLARATION);
    // create-pipeline is destructive-gated; a real (unstubbed) M3LPrompt
    // would otherwise block on real stdin here — see confirmingPrompt.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-pipeline", input: "create.json" },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(writePipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create-pipeline",
        declaration: DECLARATION,
      }),
    );
  });
});

describe("runCodepipelineOps — output persistence", () => {
  test("persists the result to 'output' via Core.M3LJSONFileExporter when configured", async () => {
    const result = { pipelines: [] };
    readPipelinesMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "list-pipelines",
      output: "result.json",
    });

    await runCodepipelineOps(deps);

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("does not persist anything when 'output' is unset", async () => {
    readPipelinesMock.mockResolvedValue({ pipelines: [] });
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({ operation: "list-pipelines" });

    await runCodepipelineOps(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });

  test("does not persist anything for 'delete-pipeline' (void result, nothing to persist), even when 'output' is configured", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete-pipeline",
        pipeline: "my-pipeline",
        output: "result.json",
      },
      { prompt },
    );

    await runCodepipelineOps(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe("runCodepipelineOps — assertWatchSucceeded: pass/throw split at the dispatcher level", () => {
  test.each(["Succeeded", "Superseded"] as const)(
    "completes the run normally for terminal status '%s', persisting output when configured",
    async (status) => {
      const execution = {
        pipelineExecutionId: "exec-1",
        pipelineName: "my-pipeline",
        status,
      };
      watchExecutionMock.mockResolvedValue(execution);
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation: "watch-execution",
        pipeline: "my-pipeline",
        executionId: "exec-1",
        output: "result.json",
      });

      await expect(runCodepipelineOps(deps)).resolves.toBeUndefined();
      expect(exportSpy).toHaveBeenCalledWith(execution);
    },
  );

  test.each(["Failed", "Stopped", "Cancelled"] as const)(
    "throws ERR_CODEPIPELINE_OPS_WATCH_FAILED for terminal status '%s', AFTER persisting output",
    async (status) => {
      const execution = {
        pipelineExecutionId: "exec-1",
        pipelineName: "my-pipeline",
        status,
      };
      watchExecutionMock.mockResolvedValue(execution);
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation: "watch-execution",
        pipeline: "my-pipeline",
        executionId: "exec-1",
        output: "result.json",
      });

      let thrown: unknown;
      try {
        await runCodepipelineOps(deps);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_CODEPIPELINE_OPS_WATCH_FAILED",
      );
      expect((thrown as Core.M3LError).context).toEqual({ status });
      // The persist call having actually happened (rather than being
      // skipped because the throw fired first) is what proves the
      // ordering: if the implementation threw before persisting, exportSpy
      // would never be called at all.
      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(exportSpy).toHaveBeenCalledWith(execution);
    },
  );

  test("still throws ERR_CODEPIPELINE_OPS_WATCH_FAILED when 'output' is unset (nothing to persist)", async () => {
    watchExecutionMock.mockResolvedValue({
      pipelineExecutionId: "exec-1",
      pipelineName: "my-pipeline",
      status: "Failed",
    });
    const deps = buildDeps({
      operation: "watch-execution",
      pipeline: "my-pipeline",
      executionId: "exec-1",
    });

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_WATCH_FAILED",
    });
  });

  test("never invokes assertWatchSucceeded's throw path for a non-watch-execution operation", async () => {
    readPipelinesMock.mockResolvedValue({ pipelines: [] });
    const deps = buildDeps({ operation: "list-pipelines" });

    await expect(runCodepipelineOps(deps)).resolves.toBeUndefined();
  });
});

describe("runCodepipelineOps — malformed/unreadable input-file failure paths", () => {
  test("wraps an unreadable input file's read failure as ERR_CODEPIPELINE_OPS_INPUT, chaining the raw cause", async () => {
    const cause = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);
    const deps = buildDeps({
      operation: "create-pipeline",
      input: "create.json",
    });

    let thrown: unknown;
    try {
      await runCodepipelineOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_INPUT");
    expect((thrown as Core.M3LError).cause).toBe(cause);
    expect(writePipelineMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CODEPIPELINE_OPS_INPUT ('must be valid JSON') when the input file's content is malformed JSON", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-pipeline",
      input: "create.json",
    });

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_INPUT",
    });
    expect(writePipelineMock).not.toHaveBeenCalled();
  });

  test("F10: malformed JSON parse failure does not chain the raw SyntaxError as cause", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-pipeline",
      input: "create.json",
    });

    let thrown: unknown;
    try {
      await runCodepipelineOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_INPUT");
    expect((thrown as Core.M3LError).cause).toBeUndefined();
    expect((thrown as Core.M3LError).message).toMatch(
      /must be valid JSON \(\w+Error\)/,
    );
  });

  test("throws ERR_CODEPIPELINE_OPS_INPUT ('contains an unsafe key') when the parsed input has a top-level __proto__ key", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: '{"__proto__":{"polluted":true}}' });
    const deps = buildDeps({
      operation: "create-pipeline",
      input: "create.json",
    });

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_INPUT",
    });
    expect(writePipelineMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CODEPIPELINE_OPS_INPUT ('must decode to a JSON object') when the parsed input is a JSON array", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify([1, 2, 3]) });
    const deps = buildDeps({
      operation: "update-pipeline",
      input: "update.json",
    });

    await expect(runCodepipelineOps(deps)).rejects.toMatchObject({
      code: "ERR_CODEPIPELINE_OPS_INPUT",
    });
    expect(writePipelineMock).not.toHaveBeenCalled();
  });
});

describe("runCodepipelineOps — exhaustive operation-narrowing chain (all 13 operations reach a step)", () => {
  test("'list-pipelines' reaches readPipelines", async () => {
    readPipelinesMock.mockResolvedValue({ pipelines: [] });
    await expect(
      runCodepipelineOps(buildDeps({ operation: "list-pipelines" })),
    ).resolves.toBeUndefined();
    expect(readPipelinesMock).toHaveBeenCalledTimes(1);
  });

  test("'describe-pipeline' reaches readPipelines", async () => {
    readPipelinesMock.mockResolvedValue(DECLARATION);
    await expect(
      runCodepipelineOps(
        buildDeps({ operation: "describe-pipeline", pipeline: "my-pipeline" }),
      ),
    ).resolves.toBeUndefined();
    expect(readPipelinesMock).toHaveBeenCalledTimes(1);
  });

  test("'get-pipeline-state' reaches readState", async () => {
    readStateMock.mockResolvedValue({
      pipelineName: "my-pipeline",
      stageStates: [],
    });
    await expect(
      runCodepipelineOps(
        buildDeps({ operation: "get-pipeline-state", pipeline: "my-pipeline" }),
      ),
    ).resolves.toBeUndefined();
    expect(readStateMock).toHaveBeenCalledTimes(1);
  });

  test("'list-executions' reaches readExecutions", async () => {
    readExecutionsMock.mockResolvedValue({ executionSummaries: [] });
    await expect(
      runCodepipelineOps(
        buildDeps({ operation: "list-executions", pipeline: "my-pipeline" }),
      ),
    ).resolves.toBeUndefined();
    expect(readExecutionsMock).toHaveBeenCalledTimes(1);
  });

  test("'describe-execution' reaches readExecutions", async () => {
    readExecutionsMock.mockResolvedValue({
      pipelineExecutionId: "exec-1",
      pipelineName: "my-pipeline",
      status: "Succeeded",
    });
    await expect(
      runCodepipelineOps(
        buildDeps({
          operation: "describe-execution",
          pipeline: "my-pipeline",
          executionId: "exec-1",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(readExecutionsMock).toHaveBeenCalledTimes(1);
  });

  test("'create-pipeline' reaches writePipeline", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify(DECLARATION) });
    writePipelineMock.mockResolvedValue(DECLARATION);
    const { prompt } = confirmingPrompt(true);
    await expect(
      runCodepipelineOps(
        buildDeps(
          { operation: "create-pipeline", input: "create.json" },
          { prompt },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(writePipelineMock).toHaveBeenCalledTimes(1);
  });

  test("'update-pipeline' reaches writePipeline", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify(DECLARATION) });
    writePipelineMock.mockResolvedValue(DECLARATION);
    const { prompt } = confirmingPrompt(true);
    await expect(
      runCodepipelineOps(
        buildDeps(
          { operation: "update-pipeline", input: "update.json" },
          { prompt },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(writePipelineMock).toHaveBeenCalledTimes(1);
  });

  test("'delete-pipeline' reaches writePipeline", async () => {
    writePipelineMock.mockResolvedValue(undefined);
    const { prompt } = confirmingPrompt(true);
    await expect(
      runCodepipelineOps(
        buildDeps(
          { operation: "delete-pipeline", pipeline: "my-pipeline" },
          { prompt },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(writePipelineMock).toHaveBeenCalledTimes(1);
  });

  test("'start-execution' reaches execute", async () => {
    executeMock.mockResolvedValue({ pipelineExecutionId: "exec-1" });
    await expect(
      runCodepipelineOps(
        buildDeps({ operation: "start-execution", pipeline: "my-pipeline" }),
      ),
    ).resolves.toBeUndefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("'stop-execution' reaches execute", async () => {
    executeMock.mockResolvedValue({ pipelineExecutionId: "exec-1" });
    await expect(
      runCodepipelineOps(
        buildDeps({
          operation: "stop-execution",
          pipeline: "my-pipeline",
          executionId: "exec-1",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("'enable-stage-transition' reaches transitions", async () => {
    transitionsMock.mockResolvedValue(undefined);
    await expect(
      runCodepipelineOps(
        buildDeps({
          operation: "enable-stage-transition",
          pipeline: "my-pipeline",
          stage: "Deploy",
          transitionType: "Inbound",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(transitionsMock).toHaveBeenCalledTimes(1);
  });

  test("'disable-stage-transition' reaches transitions", async () => {
    transitionsMock.mockResolvedValue(undefined);
    await expect(
      runCodepipelineOps(
        buildDeps({
          operation: "disable-stage-transition",
          pipeline: "my-pipeline",
          stage: "Deploy",
          transitionType: "Inbound",
          reason: "why",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(transitionsMock).toHaveBeenCalledTimes(1);
  });

  test("'watch-execution' reaches watchExecution", async () => {
    watchExecutionMock.mockResolvedValue({
      pipelineExecutionId: "exec-1",
      pipelineName: "my-pipeline",
      status: "Succeeded",
    });
    await expect(
      runCodepipelineOps(
        buildDeps({
          operation: "watch-execution",
          pipeline: "my-pipeline",
          executionId: "exec-1",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(watchExecutionMock).toHaveBeenCalledTimes(1);
  });
});

describe("type contract", () => {
  test("runCodepipelineOps resolves void", () => {
    expectTypeOf(runCodepipelineOps).returns.toEqualTypeOf<Promise<void>>();
  });
});
