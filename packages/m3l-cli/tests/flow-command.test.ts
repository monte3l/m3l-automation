/**
 * Contract: `packages/m3l-cli/src/commands/flow.ts` — the thin `m3l flow`
 * handler (U10 slice 3, stage C).
 *
 * ```
 * m3l flow list                             # the available flow names
 * m3l flow run <name> [--dry-run] [--json]  # execute a named flow
 * m3l flow                                  # usage error, exit 2
 * ```
 *
 * There is **no `--resume` flag** in U10 — that is U11. `runFlow` already
 * accepts `resumeFromStepId`, but nothing here may pass it, and
 * `m3l flow run x --resume` must be REJECTED rather than silently ignored.
 *
 * Every collaborator is mocked at its own module seam (`discovery/*`,
 * `flow/load`, `flow/run`, `flow/record`, `flow/envelope`, `flow/render`) —
 * never at a barrel — so this suite characterizes the WIRING and nothing
 * else. `flow/record.js` keeps its real pure exports (only
 * `writeFlowRunRecord` is replaced), so the record's `definitionHash` under
 * test is the genuine `hashFlowDefinition` digest.
 *
 * No filesystem is touched: nothing here mocks `node:fs`, because every
 * module that would reach it is mocked one level up.
 *
 * Stage-B contract revision (stage-C review): the command synthesizes NOTHING
 * per step any more. `M3LCliFlowRunResult.stepExecutions` carries each
 * execution's own observed window and unavailable reason
 * (`M3LCliFlowStepOutcome`), and `M3LCliFlowEnvelopeInput` has no parallel
 * `stepRuns` array — so the command hands the engine's result straight to
 * `buildFlowEnvelope` and the nested per-step windows are the engine's, never
 * the run's window stamped onto every step.
 *
 * RED phase: `src/commands/flow.ts`, `src/flow/envelope.ts` and
 * `src/flow/render.ts` do not exist yet, and `M3LCliFlowStepOutcome` is not yet
 * exported from `src/flow/types.ts`, so the imports below fail to resolve. That
 * is the expected failure for this phase.
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { dirname, join } from "node:path";

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));
vi.mock("../src/flow/load.js", () => ({
  listFlows: vi.fn(),
  loadFlowDefinition: vi.fn(),
}));
vi.mock("../src/flow/run.js", () => ({ runFlow: vi.fn() }));
vi.mock("../src/flow/record.js", async (importOriginal) => {
  const actual = await importOriginal<FlowRecordModule>();
  return { ...actual, writeFlowRunRecord: vi.fn() };
});
vi.mock("../src/flow/envelope.js", () => ({
  buildFlowEnvelope: vi.fn(),
  formatFlowEnvelope: vi.fn(),
}));
vi.mock("../src/flow/render.js", () => ({
  formatFlowRunLines: vi.fn(),
  formatFlowListLines: vi.fn(),
}));

import * as flowRecordModule from "../src/flow/record.js";

/**
 * The real `flow/record` module's type, named once so the `vi.mock` factory
 * above needs no inline `typeof import(...)` annotation (banned by
 * `@typescript-eslint/consistent-type-imports`).
 */
type FlowRecordModule = typeof flowRecordModule;

import { runFlowCommand } from "../src/commands/flow.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import type { M3LCliOutput } from "../src/cli/output.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import { listFlows, loadFlowDefinition } from "../src/flow/load.js";
import { runFlow } from "../src/flow/run.js";
import type {
  M3LCliFlowRunOptions,
  M3LCliFlowRunResult,
} from "../src/flow/run.js";
import type { M3LCliFlowRunRecord } from "../src/flow/record.js";
import { buildFlowEnvelope, formatFlowEnvelope } from "../src/flow/envelope.js";
import type { M3LCliFlowEnvelopeInput } from "../src/flow/envelope.js";
import { formatFlowListLines, formatFlowRunLines } from "../src/flow/render.js";
import type { M3LCliFlowRenderInput } from "../src/flow/render.js";
import type { M3LCliFlowStepContext } from "../src/flow/step.js";
import type { M3LCliFlowValidationContext } from "../src/flow/validate.js";
import type {
  M3LCliFlowDefinition,
  M3LCliFlowStep,
  M3LCliFlowStepOutcome,
} from "../src/flow/types.js";

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);
const listFlowsMock = vi.mocked(listFlows);
const loadFlowDefinitionMock = vi.mocked(loadFlowDefinition);
const runFlowMock = vi.mocked(runFlow);
const writeFlowRunRecordMock = vi.mocked(flowRecordModule.writeFlowRunRecord);
const buildFlowEnvelopeMock = vi.mocked(buildFlowEnvelope);
const formatFlowEnvelopeMock = vi.mocked(formatFlowEnvelope);
const formatFlowRunLinesMock = vi.mocked(formatFlowRunLines);
const formatFlowListLinesMock = vi.mocked(formatFlowListLines);

afterEach(() => {
  // `vi.restoreAllMocks()` would NOT clear these — they are plain `vi.fn()`s
  // created inside `vi.mock` factories, so their call history and
  // implementations must be reset by name or they leak into the next test.
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
  listFlowsMock.mockReset();
  loadFlowDefinitionMock.mockReset();
  runFlowMock.mockReset();
  writeFlowRunRecordMock.mockReset();
  buildFlowEnvelopeMock.mockReset();
  formatFlowEnvelopeMock.mockReset();
  formatFlowRunLinesMock.mockReset();
  formatFlowListLinesMock.mockReset();
});

const WORKSPACE_ROOT = "/workspace";
const CACHE_FILE_PATH = "/workspace/data/cache/m3l-cli/discovery.json";

interface CapturedContext {
  readonly context: M3LCliCommandContext;
  readonly infoLines: string[];
  readonly errorLines: string[];
  readonly headingLines: string[];
}

function buildContext(jsonOutput = false): CapturedContext {
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  const headingLines: string[] = [];
  const output: M3LCliOutput = {
    colorEnabled: false,
    info: (text: string) => {
      infoLines.push(text);
    },
    error: (text: string) => {
      errorLines.push(text);
    },
    heading: (text: string) => {
      headingLines.push(text);
    },
  };
  return {
    context: {
      workspaceRoot: WORKSPACE_ROOT,
      output,
      jsonOutput,
      cacheFilePath: CACHE_FILE_PATH,
      historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
      outputDirPath: "/workspace/data/output",
      env: { PATH: "/usr/bin" },
      envFile: { kind: "auto" },
    },
    infoLines,
    errorLines,
    headingLines,
  };
}

/** One discovered-script candidate fixture — the shape lives here only. */
function candidate(name: string): M3LCliScriptCandidate {
  return {
    name,
    directory: `/workspace/scripts/${name}`,
    description: "",
  };
}

function step(overrides: Partial<M3LCliFlowStep> = {}): M3LCliFlowStep {
  return {
    id: "dump",
    script: "sqs-etl",
    parameters: { command: "dump" },
    execution: "auto",
    onSuccess: "continue",
    onFailure: "stop",
    onPartial: "stop",
    ...overrides,
  };
}

function definition(
  overrides: Partial<M3LCliFlowDefinition> = {},
): M3LCliFlowDefinition {
  return {
    name: "dlq-reconcile",
    maxStepExecutions: 50,
    steps: [step(), step({ id: "republish", script: "json-etl" })],
    ...overrides,
  };
}

/*
 * The two steps' observed windows are deliberately DISJOINT, and neither spans
 * the run's own 10:00:00–10:00:12.500 window. That is what makes the
 * straight-through assertions below discriminating: a command that
 * re-synthesized a per-step window from the run's would have to collapse both
 * onto one identical pair.
 */
const DUMP_STARTED = new Date("2026-09-01T10:00:00.000Z");
const DUMP_FINISHED = new Date("2026-09-01T10:00:04.000Z");
const REPUBLISH_STARTED = new Date("2026-09-01T10:00:06.000Z");
const REPUBLISH_FINISHED = new Date("2026-09-01T10:00:11.250Z");

function execution(
  overrides: Partial<M3LCliFlowStepOutcome> = {},
): M3LCliFlowStepOutcome {
  return {
    stepId: "dump",
    script: "sqs-etl",
    attempt: 1,
    exitCode: 0,
    outcome: "success",
    reportPath: "/workspace/data/output/dump/run-report.json",
    branch: "continue",
    startedAt: DUMP_STARTED,
    finishedAt: DUMP_FINISHED,
    reportUnavailable: null,
    ...overrides,
  };
}

function runResult(
  overrides: Partial<M3LCliFlowRunResult> = {},
): M3LCliFlowRunResult {
  return {
    flowName: "dlq-reconcile",
    status: "completed",
    exitCode: 0,
    startedAt: new Date("2026-09-01T10:00:00.000Z"),
    finishedAt: new Date("2026-09-01T10:00:12.500Z"),
    stepExecutionCount: 2,
    haltingStepId: "republish",
    resumeStepId: null,
    stepExecutions: [
      execution(),
      execution({
        stepId: "republish",
        script: "json-etl",
        branch: "stop",
        startedAt: REPUBLISH_STARTED,
        finishedAt: REPUBLISH_FINISHED,
      }),
    ],
    ...overrides,
  };
}

/** Arms every collaborator for a successful `flow run dlq-reconcile`. */
function armHappyPath(result: M3LCliFlowRunResult = runResult()): void {
  discoverScriptsMock.mockReturnValue([
    candidate("sqs-etl"),
    candidate("json-etl"),
  ]);
  loadParametersCachedMock.mockResolvedValue([]);
  listFlowsMock.mockReturnValue(["dlq-reconcile", "nightly-export"]);
  loadFlowDefinitionMock.mockReturnValue(definition());
  runFlowMock.mockResolvedValue(result);
  formatFlowRunLinesMock.mockReturnValue([
    "rendered line 1",
    "rendered line 2",
  ]);
  formatFlowEnvelopeMock.mockReturnValue('{"kind":"m3l.flow.result"}');
}

describe("runFlowCommand — usage errors", () => {
  test("a bare `m3l flow` is a usage error at exit 2, naming both subcommands", async () => {
    const { context, errorLines } = buildContext();

    const code = await runFlowCommand(context, []);

    expect(code).toBe(2);
    const rendered = errorLines.join("\n");
    expect(rendered).toContain("list");
    expect(rendered).toContain("run");
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(listFlowsMock).not.toHaveBeenCalled();
  });

  test("an unrecognized subcommand is a usage error at exit 2", async () => {
    const { context, errorLines } = buildContext();

    const code = await runFlowCommand(context, ["resume"]);

    expect(code).toBe(2);
    expect(errorLines.join("\n")).toContain("resume");
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  test("`flow run` with no <name> positional is a usage error at exit 2", async () => {
    const { context, errorLines } = buildContext();

    const code = await runFlowCommand(context, ["run"]);

    expect(code).toBe(2);
    expect(errorLines.join("\n")).toContain("m3l flow run <name>");
    expect(loadFlowDefinitionMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  test("`flow run` with only flags and no <name> is a usage error, not a flow named '--dry-run'", async () => {
    const { context } = buildContext();

    const code = await runFlowCommand(context, ["run", "--dry-run"]);

    expect(code).toBe(2);
    expect(loadFlowDefinitionMock).not.toHaveBeenCalled();
  });
});

describe("runFlowCommand — U10 ships no --resume flag", () => {
  test.each<[string, readonly string[]]>([
    ["bare --resume", ["run", "dlq-reconcile", "--resume"]],
    ["--resume with a step id", ["run", "dlq-reconcile", "--resume", "dump"]],
    ["--resume=<id>", ["run", "dlq-reconcile", "--resume=dump"]],
  ])("rejects %s rather than silently ignoring it", async (_label, rawArgs) => {
    armHappyPath();
    const { context, errorLines } = buildContext();

    const code = await runFlowCommand(context, rawArgs);

    expect(code).toBe(2);
    expect(errorLines.join("\n")).toContain("--resume");
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(writeFlowRunRecordMock).not.toHaveBeenCalled();
  });

  test("rejects any other unknown flag at exit 2", async () => {
    armHappyPath();
    const { context, errorLines } = buildContext();

    const code = await runFlowCommand(context, [
      "run",
      "dlq-reconcile",
      "--from-step",
      "dump",
    ]);

    expect(code).toBe(2);
    expect(errorLines.join("\n")).toContain("--from-step");
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  test("never passes resumeFromStepId or stepExecutionCount to runFlow", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    const [, , options] = runFlowMock.mock.calls[0] as [
      M3LCliFlowStepContext,
      M3LCliFlowDefinition,
      M3LCliFlowRunOptions | undefined,
    ];
    expect(options?.resumeFromStepId).toBeUndefined();
    expect(options?.stepExecutionCount).toBeUndefined();
  });
});

describe("runFlowCommand — flow list", () => {
  test("renders the listed flow names through flow/render", async () => {
    listFlowsMock.mockReturnValue(["dlq-reconcile", "nightly-export"]);
    formatFlowListLinesMock.mockReturnValue([
      "dlq-reconcile",
      "nightly-export",
    ]);
    const { context, infoLines, headingLines } = buildContext();

    const code = await runFlowCommand(context, ["list"]);

    expect(code).toBe(0);
    expect(listFlowsMock).toHaveBeenCalledWith(WORKSPACE_ROOT);
    expect(formatFlowListLinesMock).toHaveBeenCalledWith([
      "dlq-reconcile",
      "nightly-export",
    ]);
    expect(infoLines).toEqual(["dlq-reconcile", "nightly-export"]);
    expect(headingLines.join("\n")).toContain("Flow");
  });

  test("an empty flows directory says so rather than printing nothing", async () => {
    listFlowsMock.mockReturnValue([]);
    formatFlowListLinesMock.mockReturnValue(["no flows found"]);
    const { context, infoLines } = buildContext();

    const code = await runFlowCommand(context, ["list"]);

    expect(code).toBe(0);
    expect(formatFlowListLinesMock).toHaveBeenCalledWith([]);
    expect(infoLines.length).toBeGreaterThan(0);
    expect(infoLines.join("\n")).toContain("no flows found");
  });

  test("`flow list --json` emits exactly one line of JSON and suppresses human rendering", async () => {
    listFlowsMock.mockReturnValue(["dlq-reconcile", "nightly-export"]);
    const { context, infoLines, headingLines } = buildContext(true);

    const code = await runFlowCommand(context, ["list", "--json"]);

    expect(code).toBe(0);
    expect(infoLines).toEqual([
      JSON.stringify(["dlq-reconcile", "nightly-export"]),
    ]);
    expect(formatFlowListLinesMock).not.toHaveBeenCalled();
    expect(headingLines).toEqual([]);
  });

  test("never loads a definition, so one malformed flow cannot make the rest unlistable", async () => {
    listFlowsMock.mockReturnValue(["dlq-reconcile"]);
    formatFlowListLinesMock.mockReturnValue(["dlq-reconcile"]);
    const { context } = buildContext();

    await runFlowCommand(context, ["list"]);

    expect(loadFlowDefinitionMock).not.toHaveBeenCalled();
    expect(discoverScriptsMock).not.toHaveBeenCalled();
  });

  test("propagates a listFlows failure rather than reporting an empty flow set", async () => {
    listFlowsMock.mockImplementation(() => {
      throw new M3LCliError(
        "ERR_CLI_FLOW_INVALID",
        "failed to list flow definitions in '/workspace/data/config/flows'",
      );
    });
    const { context } = buildContext();

    await expect(runFlowCommand(context, ["list"])).rejects.toThrow(
      M3LCliError,
    );
  });
});

describe("runFlowCommand — flow run: building the validation context", () => {
  test("builds M3LCliFlowValidationContext from discovery + the cached parameter load, carrying each parameter's secret flag", async () => {
    discoverScriptsMock.mockReturnValue([
      candidate("sqs-etl"),
      candidate("json-etl"),
    ]);
    loadParametersCachedMock.mockImplementation((scriptName) =>
      Promise.resolve(
        scriptName === "sqs-etl"
          ? [
              {
                name: "command",
                type: "string",
                required: true,
                secret: false,
                aliases: [],
                operations: [],
                description: "",
                defaultValue: undefined,
              },
              {
                name: "api-token",
                type: "string",
                required: false,
                secret: true,
                aliases: [],
                operations: [],
                description: "",
                defaultValue: undefined,
              },
            ]
          : [],
      ),
    );
    listFlowsMock.mockReturnValue(["dlq-reconcile"]);
    loadFlowDefinitionMock.mockReturnValue(definition());
    runFlowMock.mockResolvedValue(runResult());
    formatFlowRunLinesMock.mockReturnValue(["rendered"]);
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(loadParametersCachedMock).toHaveBeenCalledWith(
      "sqs-etl",
      "/workspace/scripts/sqs-etl",
      CACHE_FILE_PATH,
    );
    const [root, name, validationContext] = loadFlowDefinitionMock.mock
      .calls[0] as [string, string, M3LCliFlowValidationContext];
    expect(root).toBe(WORKSPACE_ROOT);
    expect(name).toBe("dlq-reconcile");
    expect([...validationContext.parametersByScript.keys()].toSorted()).toEqual(
      ["json-etl", "sqs-etl"],
    );
    // Projected to the two facts the validator's contract names, so this
    // assertion does not care whether the command hands the descriptors
    // through whole or narrows them — only that `secret` survives the trip.
    // Discarding it here is exactly what let a `secret: true` parameter into a
    // step's argv (ADR-0085).
    expect(
      validationContext.parametersByScript.get("sqs-etl")?.map((parameter) => ({
        name: parameter.name,
        secret: parameter.secret,
      })),
    ).toEqual([
      { name: "command", secret: false },
      { name: "api-token", secret: true },
    ]);
    expect(validationContext.parametersByScript.get("json-etl")).toEqual([]);
  });

  test("a script whose config will not load degrades to an empty parameter list and is REPORTED, never swallowed", async () => {
    discoverScriptsMock.mockReturnValue([
      candidate("sqs-etl"),
      candidate("broken"),
    ]);
    loadParametersCachedMock.mockImplementation((scriptName) =>
      scriptName === "broken"
        ? Promise.reject(
            new M3LCliError("ERR_CLI_CONFIG_IMPORT", "config.ts is unreadable"),
          )
        : Promise.resolve([]),
    );
    listFlowsMock.mockReturnValue(["dlq-reconcile"]);
    loadFlowDefinitionMock.mockReturnValue(definition());
    runFlowMock.mockResolvedValue(runResult());
    formatFlowRunLinesMock.mockReturnValue(["rendered"]);
    const { context, errorLines } = buildContext();

    const code = await runFlowCommand(context, ["run", "dlq-reconcile"]);

    // The flow still runs (one unrelated broken script must not block every
    // flow), but the degradation reaches stderr — the same tolerance
    // `commands/completion.ts` gives an unloadable script, with the reason
    // recorded rather than absorbed.
    expect(code).toBe(0);
    expect(errorLines.join("\n")).toContain("broken");
    const [, , validationContext] = loadFlowDefinitionMock.mock.calls[0] as [
      string,
      string,
      M3LCliFlowValidationContext,
    ];
    expect(validationContext.parametersByScript.get("broken")).toEqual([]);
  });

  test("surfaces an unknown flow as ERR_CLI_UNKNOWN_FLOW with suggestions, unchanged", async () => {
    discoverScriptsMock.mockReturnValue([]);
    loadParametersCachedMock.mockResolvedValue([]);
    listFlowsMock.mockReturnValue(["dlq-reconcile"]);
    loadFlowDefinitionMock.mockImplementation(() => {
      throw new M3LCliError(
        "ERR_CLI_UNKNOWN_FLOW",
        "unknown flow 'dlq-reconcil'",
        { suggestions: ["dlq-reconcile"] },
      );
    });
    const { context } = buildContext();

    let thrown: unknown;
    try {
      await runFlowCommand(context, ["run", "dlq-reconcil"]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_FLOW");
    expect((thrown as M3LCliError).suggestions).toEqual(["dlq-reconcile"]);
    expect(runFlowMock).not.toHaveBeenCalled();
    expect(writeFlowRunRecordMock).not.toHaveBeenCalled();
  });

  test("propagates ERR_CLI_FLOW_INVALID from a malformed definition, unchanged", async () => {
    discoverScriptsMock.mockReturnValue([]);
    loadParametersCachedMock.mockResolvedValue([]);
    listFlowsMock.mockReturnValue(["dlq-reconcile"]);
    loadFlowDefinitionMock.mockImplementation(() => {
      throw new M3LCliError(
        "ERR_CLI_FLOW_INVALID",
        "flow 'dlq-reconcile' declares an unrecognized key 'onFailrue'",
      );
    });
    const { context } = buildContext();

    await expect(
      runFlowCommand(context, ["run", "dlq-reconcile"]),
    ).rejects.toMatchObject({ code: "ERR_CLI_FLOW_INVALID" });
  });
});

describe("runFlowCommand — flow run: driving the engine", () => {
  test("hands runFlow the step context assembled from discovery and the output dir", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(runFlowMock).toHaveBeenCalledTimes(1);
    const [stepContext, passedDefinition] = runFlowMock.mock.calls[0] as [
      M3LCliFlowStepContext,
      M3LCliFlowDefinition,
      M3LCliFlowRunOptions | undefined,
    ];
    expect(stepContext.output).toBe(context.output);
    expect(stepContext.outputDirPath).toBe("/workspace/data/output");
    expect([...stepContext.scriptDirectories.entries()].toSorted()).toEqual([
      ["json-etl", "/workspace/scripts/json-etl"],
      ["sqs-etl", "/workspace/scripts/sqs-etl"],
    ]);
    expect(passedDefinition).toEqual(definition());
  });

  test("--dry-run reaches runFlow as the flow-level floor", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile", "--dry-run"]);

    const [, , options] = runFlowMock.mock.calls[0] as [
      M3LCliFlowStepContext,
      M3LCliFlowDefinition,
      M3LCliFlowRunOptions | undefined,
    ];
    expect(options?.dryRun).toBe(true);
  });

  test("without --dry-run the floor is falsy, never silently true", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    const [, , options] = runFlowMock.mock.calls[0] as [
      M3LCliFlowStepContext,
      M3LCliFlowDefinition,
      M3LCliFlowRunOptions | undefined,
    ];
    expect(options?.dryRun ?? false).toBe(false);
  });

  test.each<[number]>([[0], [1], [3], [4], [137]])(
    "returns the flow's exit code %i unchanged",
    async (exitCode) => {
      armHappyPath(
        runResult({
          exitCode,
          status: exitCode === 0 ? "completed" : "failed",
        }),
      );
      const { context } = buildContext();

      const code = await runFlowCommand(context, ["run", "dlq-reconcile"]);

      expect(code).toBe(exitCode);
    },
  );

  test("propagates a runFlow rejection unchanged and persists no record", async () => {
    armHappyPath();
    runFlowMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_SPAWN_FAILED", "spawn ENOENT"),
    );
    const { context } = buildContext();

    await expect(
      runFlowCommand(context, ["run", "dlq-reconcile"]),
    ).rejects.toMatchObject({ code: "ERR_CLI_SPAWN_FAILED" });
    expect(writeFlowRunRecordMock).not.toHaveBeenCalled();
  });
});

describe("runFlowCommand — human rendering", () => {
  test("renders through flow/render and writes each returned line", async () => {
    armHappyPath();
    const { context, infoLines, headingLines } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(formatFlowRunLinesMock).toHaveBeenCalledTimes(1);
    const [renderInput] = formatFlowRunLinesMock.mock.calls[0] as [
      M3LCliFlowRenderInput,
    ];
    expect(renderInput.dryRun).toBe(false);
    expect(renderInput.maxStepExecutions).toBe(50);
    expect(renderInput.result).toEqual(runResult());
    expect(typeof renderInput.runId).toBe("string");
    expect(renderInput.runId.length).toBeGreaterThan(0);
    expect(infoLines).toEqual(["rendered line 1", "rendered line 2"]);
    expect(headingLines.join("\n")).toContain("Flow");
  });

  test("tells the renderer a dry run was a dry run", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile", "--dry-run"]);

    const [renderInput] = formatFlowRunLinesMock.mock.calls[0] as [
      M3LCliFlowRenderInput,
    ];
    expect(renderInput.dryRun).toBe(true);
  });

  test("builds no --json envelope on the human path", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(buildFlowEnvelopeMock).not.toHaveBeenCalled();
    expect(formatFlowEnvelopeMock).not.toHaveBeenCalled();
  });
});

describe("runFlowCommand — --json rendering", () => {
  test("emits exactly one line and suppresses human rendering entirely", async () => {
    armHappyPath();
    const { context, infoLines, headingLines } = buildContext(true);

    await runFlowCommand(context, ["run", "dlq-reconcile", "--json"]);

    expect(infoLines).toEqual(['{"kind":"m3l.flow.result"}']);
    expect(formatFlowRunLinesMock).not.toHaveBeenCalled();
    expect(headingLines).toEqual([]);
  });

  test("feeds buildFlowEnvelope the run result, the dry-run flag and the record's own definitionHash", async () => {
    armHappyPath();
    const { context } = buildContext(true);

    await runFlowCommand(context, ["run", "dlq-reconcile", "--json"]);

    expect(buildFlowEnvelopeMock).toHaveBeenCalledTimes(1);
    const [envelopeInput] = buildFlowEnvelopeMock.mock.calls[0] as [
      M3LCliFlowEnvelopeInput,
    ];
    expect(envelopeInput.result).toEqual(runResult());
    expect(envelopeInput.dryRun).toBe(false);
    // The digest is the real `hashFlowDefinition` output — the command must
    // reuse the record's hash rather than recomputing a second one.
    expect(envelopeInput.definitionHash).toBe(
      flowRecordModule.hashFlowDefinition(definition()),
    );
  });

  test("the envelope and the persisted record share one run id", async () => {
    armHappyPath();
    const { context } = buildContext(true);

    await runFlowCommand(context, ["run", "dlq-reconcile", "--json"]);

    const [envelopeInput] = buildFlowEnvelopeMock.mock.calls[0] as [
      M3LCliFlowEnvelopeInput,
    ];
    const [, record] = writeFlowRunRecordMock.mock.calls[0] as [
      string,
      M3LCliFlowRunRecord,
    ];
    expect(envelopeInput.runId).toBe(record.runId);
    expect(record.runId.length).toBeGreaterThan(0);
  });

  test("two invocations produce two distinct run ids", async () => {
    armHappyPath();
    const first = buildContext();
    const second = buildContext();

    await runFlowCommand(first.context, ["run", "dlq-reconcile"]);
    await runFlowCommand(second.context, ["run", "dlq-reconcile"]);

    expect(formatFlowRunLinesMock).toHaveBeenCalledTimes(2);
    const [firstInput] = formatFlowRunLinesMock.mock.calls[0] as [
      M3LCliFlowRenderInput,
    ];
    const [secondInput] = formatFlowRunLinesMock.mock.calls[1] as [
      M3LCliFlowRenderInput,
    ];

    expect(secondInput.runId).not.toBe(firstInput.runId);
  });

  test("passes the engine's own per-step observations straight through, unsynthesized", async () => {
    /*
     * The command builds NO parallel step array and synthesizes NO per-step
     * window: `flow/envelope.ts` derives every nested envelope from
     * `result.stepExecutions`, whose entries already carry the window
     * `flow/step.ts` observed for that execution.
     *
     * The two fixture steps have DISJOINT windows, so a command that stamped
     * the run's own window onto each step (the pre-split behaviour) would
     * produce two identical pairs and fail here.
     */
    armHappyPath();
    const { context } = buildContext(true);

    await runFlowCommand(context, ["run", "dlq-reconcile", "--json"]);

    const [envelopeInput] = buildFlowEnvelopeMock.mock.calls[0] as [
      M3LCliFlowEnvelopeInput,
    ];
    expect(envelopeInput.result.stepExecutions).toEqual(
      runResult().stepExecutions,
    );
    const windows: [Date, Date][] = [];
    for (const entry of envelopeInput.result.stepExecutions) {
      windows.push([entry.startedAt, entry.finishedAt]);
    }
    expect(windows).toEqual([
      [DUMP_STARTED, DUMP_FINISHED],
      [REPUBLISH_STARTED, REPUBLISH_FINISHED],
    ]);
    expect(windows[0]).not.toEqual(windows[1]);
    // Neither step's window is the RUN's own.
    expect(windows[1]?.[1]).not.toEqual(runResult().finishedAt);
  });

  test("the envelope input's own keys are exactly runId/definitionHash/dryRun/result", async () => {
    // Pinned as a closed set so a reintroduced parallel `stepRuns` array — or
    // any other command-side reconstruction of what the result already
    // carries — fails here rather than silently drifting from it.
    armHappyPath();
    const { context } = buildContext(true);

    await runFlowCommand(context, ["run", "dlq-reconcile", "--json"]);

    const [envelopeInput] = buildFlowEnvelopeMock.mock.calls[0] as [
      M3LCliFlowEnvelopeInput,
    ];
    expect(Object.keys(envelopeInput).toSorted()).toEqual(
      ["definitionHash", "dryRun", "result", "runId"].toSorted(),
    );
  });

  test("forwards each step's own reportUnavailable reason without flattening it", async () => {
    // Reconstructing the nested `lookup` is `flow/envelope.ts`'s job, and it
    // needs the REAL observed reason — the command must not collapse an
    // unavailable report to a single hardcoded reason on its way there.
    armHappyPath(
      runResult({
        stepExecutions: [
          execution({
            reportPath: null,
            outcome: null,
            reportUnavailable: "report-malformed",
          }),
          execution({
            stepId: "republish",
            script: "json-etl",
            branch: "stop",
            reportPath: null,
            outcome: null,
            reportUnavailable: "output-directory-missing",
            startedAt: REPUBLISH_STARTED,
            finishedAt: REPUBLISH_FINISHED,
          }),
        ],
      }),
    );
    const { context } = buildContext(true);

    await runFlowCommand(context, ["run", "dlq-reconcile", "--json"]);

    const [envelopeInput] = buildFlowEnvelopeMock.mock.calls[0] as [
      M3LCliFlowEnvelopeInput,
    ];
    const reasons: (string | null)[] = [];
    for (const entry of envelopeInput.result.stepExecutions) {
      reasons.push(entry.reportUnavailable);
    }
    expect(reasons).toEqual(["report-malformed", "output-directory-missing"]);
  });
});

describe("runFlowCommand — the run record is persisted loudly", () => {
  test("persists the record under the cache directory's flows/<name>.json", async () => {
    armHappyPath();
    const { context } = buildContext();

    await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(writeFlowRunRecordMock).toHaveBeenCalledTimes(1);
    const [recordFilePath, record] = writeFlowRunRecordMock.mock.calls[0] as [
      string,
      M3LCliFlowRunRecord,
    ];
    expect(recordFilePath).toBe(
      join(dirname(CACHE_FILE_PATH), "flows", "dlq-reconcile.json"),
    );
    expect(record).toMatchObject({
      kind: "m3l.flow.record",
      schemaVersion: 1,
      flowName: "dlq-reconcile",
      status: "completed",
      exitCode: 0,
      stepExecutionCount: 2,
      haltingStepId: "republish",
      resumeStepId: null,
      definitionHash: flowRecordModule.hashFlowDefinition(definition()),
    });
    expect(record.stepExecutions).toHaveLength(2);
  });

  /**
   * RULING: a record-write failure is NOT swallowed and DOES change the
   * resolved exit code — it propagates, so `main.ts` maps
   * `ERR_CLI_FLOW_RECORD_WRITE_FAILED` to exit 1 and prints the chained
   * cause. `flow/record.ts`'s own module doc makes this the only honest
   * choice: the record is a resume ledger, and a run whose ledger is missing
   * cannot be resumed. The exact inverse of `history/store.ts`, whose
   * best-effort entry must never move an exit code.
   *
   * Rendering happens BEFORE persistence, so a failed write still leaves the
   * operator the full result (and, under `--json`, the envelope line) on
   * stdout.
   */
  test("a write failure propagates instead of being absorbed into a success exit code", async () => {
    armHappyPath();
    const cause = new Error("EACCES: permission denied");
    writeFlowRunRecordMock.mockImplementation(() => {
      throw new M3LCliError(
        "ERR_CLI_FLOW_RECORD_WRITE_FAILED",
        "failed to write the flow run record",
        { cause },
      );
    });
    const { context, infoLines } = buildContext();

    let thrown: unknown;
    try {
      await runFlowCommand(context, ["run", "dlq-reconcile"]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe(
      "ERR_CLI_FLOW_RECORD_WRITE_FAILED",
    );
    expect((thrown as M3LCliError).cause).toBe(cause);
    // The result reached the operator before the ledger write was attempted.
    expect(infoLines).toEqual(["rendered line 1", "rendered line 2"]);
  });

  test("a write failure also outranks a NON-zero flow exit code (the ledger is the louder signal)", async () => {
    armHappyPath(runResult({ status: "failed", exitCode: 3 }));
    writeFlowRunRecordMock.mockImplementation(() => {
      throw new M3LCliError(
        "ERR_CLI_FLOW_RECORD_WRITE_FAILED",
        "failed to write the flow run record",
      );
    });
    const { context } = buildContext();

    await expect(
      runFlowCommand(context, ["run", "dlq-reconcile"]),
    ).rejects.toMatchObject({ code: "ERR_CLI_FLOW_RECORD_WRITE_FAILED" });
  });

  test("persists the record even for a failed run, so the run is resumable", async () => {
    armHappyPath(
      runResult({
        status: "failed",
        exitCode: 3,
        haltingStepId: "republish",
        resumeStepId: "republish",
      }),
    );
    const { context } = buildContext();

    const code = await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(code).toBe(3);
    const [, record] = writeFlowRunRecordMock.mock.calls[0] as [
      string,
      M3LCliFlowRunRecord,
    ];
    expect(record.status).toBe("failed");
    expect(record.resumeStepId).toBe("republish");
  });

  test("persists the record for a loop-guard trip, carrying the cumulative count forward", async () => {
    armHappyPath(
      runResult({
        status: "loop-guard-exceeded",
        exitCode: 2,
        stepExecutionCount: 50,
        haltingStepId: "retry",
        resumeStepId: "retry",
      }),
    );
    const { context } = buildContext();

    const code = await runFlowCommand(context, ["run", "dlq-reconcile"]);

    expect(code).toBe(2);
    const [, record] = writeFlowRunRecordMock.mock.calls[0] as [
      string,
      M3LCliFlowRunRecord,
    ];
    expect(record.stepExecutionCount).toBe(50);
    expect(record.status).toBe("loop-guard-exceeded");
  });

  test("`flow list` persists nothing", async () => {
    listFlowsMock.mockReturnValue([]);
    formatFlowListLinesMock.mockReturnValue(["no flows found"]);
    const { context } = buildContext();

    await runFlowCommand(context, ["list"]);

    expect(writeFlowRunRecordMock).not.toHaveBeenCalled();
  });
});

describe("runFlowCommand — flag placement tolerance", () => {
  test.each<[string, readonly string[]]>([
    ["flags after the name", ["run", "dlq-reconcile", "--dry-run", "--json"]],
    ["flags before the name", ["--json", "run", "--dry-run", "dlq-reconcile"]],
    ["--json interleaved", ["run", "--json", "dlq-reconcile", "--dry-run"]],
  ])("resolves the <name> positional with %s", async (_label, rawArgs) => {
    armHappyPath();
    const { context } = buildContext(true);

    const code = await runFlowCommand(context, rawArgs);

    expect(code).toBe(0);
    const [, name] = loadFlowDefinitionMock.mock.calls[0] as [
      string,
      string,
      M3LCliFlowValidationContext,
    ];
    expect(name).toBe("dlq-reconcile");
  });
});

describe("runFlowCommand — type contract", () => {
  test("takes the shared command context plus a raw argument slice", () => {
    expectTypeOf(runFlowCommand)
      .parameter(0)
      .toEqualTypeOf<M3LCliCommandContext>();
    expectTypeOf(runFlowCommand)
      .parameter(1)
      .toEqualTypeOf<readonly string[]>();
  });

  test("resolves the general number, not the narrower M3LCliExitCode — a step's code propagates verbatim", () => {
    expectTypeOf(runFlowCommand).returns.toEqualTypeOf<Promise<number>>();
  });
});
