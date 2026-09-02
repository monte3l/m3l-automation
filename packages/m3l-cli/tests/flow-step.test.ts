/**
 * Tests for src/flow/step.ts — executing exactly ONE flow step: resolving the
 * declared execution mode to a real mechanism, translating the step's
 * `parameters` into child argv, applying the dry-run floor, and reading the
 * step's outcome back through `locateRunReport` using that step's OWN observed
 * time window (`docs/plans/2026-09-01-orchestration-engine.md`
 * §_Reading a step's outcome_).
 *
 * Every collaborator is mocked at its module seam — `run/execute.js`,
 * `run/in-process.js`, `run/report-lookup.js` — so this file never calls a
 * real implementation. `node:fs` is mocked as a pass-through so the
 * "the engine never writes a run report" guarantee can be asserted rather
 * than assumed.
 *
 * RED phase: `src/flow/step.ts` does not exist yet, so its imports below fail
 * to resolve. That is the expected failure for this phase.
 */
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});
vi.mock("../src/run/execute.js", () => ({ executeScript: vi.fn() }));
vi.mock("../src/run/in-process.js", () => ({ runInProcess: vi.fn() }));
vi.mock("../src/run/report-lookup.js", () => ({ locateRunReport: vi.fn() }));

import { executeFlowStep } from "../src/flow/step.js";
import type {
  M3LCliFlowStepContext,
  M3LCliFlowStepOptions,
  M3LCliFlowStepResult,
} from "../src/flow/step.js";
import type { M3LCliEnvFileSetting } from "../src/cli/flags.js";
import type { M3LCliFlowStep } from "../src/flow/types.js";
import { executeScript } from "../src/run/execute.js";
import { runInProcess } from "../src/run/in-process.js";
import { locateRunReport } from "../src/run/report-lookup.js";
import type {
  M3LCliRunOutcome,
  M3LCliRunReportLookup,
  M3LCliRunReportUnavailableReason,
} from "../src/run/envelope.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliOutput } from "../src/cli/output.js";

const executeScriptMock = vi.mocked(executeScript);
const runInProcessMock = vi.mocked(runInProcess);
const locateRunReportMock = vi.mocked(locateRunReport);

afterEach(() => {
  executeScriptMock.mockReset();
  runInProcessMock.mockReset();
  locateRunReportMock.mockReset();
  vi.restoreAllMocks();
});

const OUTPUT_DIR = "/workspace/data/output";
const SQS_DIRECTORY = "/workspace/scripts/sqs-etl";
const JSON_DIRECTORY = "/workspace/scripts/json-etl";
const CLI_ENV: Readonly<Record<string, string | undefined>> = {
  PATH: "/usr/bin",
};

function createOutput(): M3LCliOutput {
  return {
    colorEnabled: false,
    info: vi.fn(),
    error: vi.fn(),
    heading: vi.fn(),
  };
}

function buildContext(
  overrides: Partial<M3LCliFlowStepContext> = {},
): M3LCliFlowStepContext {
  return {
    output: createOutput(),
    outputDirPath: OUTPUT_DIR,
    scriptDirectories: new Map([
      ["sqs-etl", SQS_DIRECTORY],
      ["json-etl", JSON_DIRECTORY],
    ]),
    env: CLI_ENV,
    envFile: { kind: "auto" },
    jsonOutput: false,
    ...overrides,
  };
}

function buildStep(overrides: Partial<M3LCliFlowStep> = {}): M3LCliFlowStep {
  return {
    id: "dump",
    script: "sqs-etl",
    parameters: {},
    execution: "auto",
    onSuccess: "continue",
    onFailure: "stop",
    onPartial: "stop",
    ...overrides,
  };
}

const UNAVAILABLE: M3LCliRunReportLookup = {
  status: "unavailable",
  reason: "no-matching-report",
};

function foundLookup(
  reportPath: string,
  outcome: M3LCliRunOutcome | null = "success",
): M3LCliRunReportLookup {
  return {
    status: "found",
    reportPath,
    summary: {
      outcome,
      timelineCount: 3,
      timelineSourceCount: 1,
      recoveryTotal: null,
    },
  };
}

/**
 * A `now` seam that returns each of `dates` in order and throws once the
 * queue is exhausted — an over-eager or under-eager clock read becomes a loud
 * failure rather than a silently reused stale `Date`.
 */
function scriptedNow(...dates: readonly Date[]): () => Date {
  const queue = [...dates];
  return (): Date => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("scriptedNow: called more times than dates provided");
    }
    return next;
  };
}

const T0 = new Date("2026-09-01T10:00:00.000Z");
const T1 = new Date("2026-09-01T10:00:05.000Z");
const T2 = new Date("2026-09-01T10:00:09.000Z");
const T3 = new Date("2026-09-01T10:00:14.000Z");

describe("executeFlowStep — execution-mode resolution", () => {
  test.each([["auto"], ["spawn"]] as const)(
    "execution '%s' takes the spawn path and reports execution 'spawn'",
    async (execution: "auto" | "spawn") => {
      executeScriptMock.mockResolvedValue(0);
      locateRunReportMock.mockReturnValue(UNAVAILABLE);

      const result = await executeFlowStep(
        buildContext(),
        buildStep({ execution }),
        false,
        { now: scriptedNow(T0, T1) },
      );

      expect(executeScriptMock).toHaveBeenCalledTimes(1);
      expect(runInProcessMock).not.toHaveBeenCalled();
      expect(result.execution).toBe("spawn");
    },
  );

  test("execution 'in-process' takes the runInProcess path", async () => {
    runInProcessMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    const result = await executeFlowStep(
      buildContext(),
      buildStep({ execution: "in-process" }),
      false,
      { now: scriptedNow(T0, T1) },
    );

    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(result.execution).toBe("in-process");
  });

  test("the spawn path is handed the script's resolved directory and a jsonOutput:false context", async () => {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    const context = buildContext();

    await executeFlowStep(context, buildStep(), false, {
      now: scriptedNow(T0, T1),
    });

    const call = executeScriptMock.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const [executeContext, scriptName, scriptDirectory] = call;
    expect(scriptName).toBe("sqs-etl");
    expect(scriptDirectory).toBe(SQS_DIRECTORY);
    expect(executeContext.outputDirPath).toBe(OUTPUT_DIR);
    // jsonOutput MUST stay false: `executeScript` would otherwise emit its own
    // per-run envelope line on stdout, corrupting the single flow envelope
    // stage C emits.
    expect(executeContext.jsonOutput).toBe(false);
  });

  test("a flow run with --json redirects the spawned child's stdout while the spawn's own jsonOutput stays false", async () => {
    // The two concerns are independent: `context.jsonOutput` (the FLOW's
    // `--json` flag) controls `redirectStdoutToStderr` on the spawn options,
    // while `executeContext.jsonOutput` (whether THIS `executeScript` call
    // emits its own envelope) is always pinned false regardless.
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    await executeFlowStep(
      buildContext({ jsonOutput: true }),
      buildStep(),
      false,
      {
        now: scriptedNow(T0, T1),
      },
    );

    const call = executeScriptMock.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const [executeContext, , , , options] = call;
    expect(executeContext.jsonOutput).toBe(false);
    expect(options).toMatchObject({ redirectStdoutToStderr: true });
  });

  test("a flow run without --json does not redirect the spawned child's stdout", async () => {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    await executeFlowStep(
      buildContext({ jsonOutput: false }),
      buildStep(),
      false,
      {
        now: scriptedNow(T0, T1),
      },
    );

    expect(executeScriptMock.mock.calls[0]?.[4]).toMatchObject({
      redirectStdoutToStderr: false,
    });
  });

  test("rejects with ERR_CLI_UNKNOWN_SCRIPT when the step's script has no resolved directory", async () => {
    const context = buildContext({ scriptDirectories: new Map() });

    let thrown: unknown;
    try {
      await executeFlowStep(context, buildStep(), false, {
        now: scriptedNow(T0, T1),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_SCRIPT");
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(runInProcessMock).not.toHaveBeenCalled();
  });
});

describe("executeFlowStep — child argv translation", () => {
  /**
   * Reads the argv the spawn path was handed, so each assertion below names
   * the observable child argv rather than an internal helper.
   */
  function spawnedArgv(): readonly string[] {
    const call = executeScriptMock.mock.calls[0];
    if (call === undefined) throw new Error("executeScript was not called");
    return call[3];
  }

  async function runWithParameters(
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<readonly string[]> {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    await executeFlowStep(buildContext(), buildStep({ parameters }), false, {
      now: scriptedNow(T0, T1),
    });
    return spawnedArgv();
  }

  test("a string value becomes a single equals-joined --name=value token", async () => {
    // Mirrors `commands/dynamic-argv.ts`'s `pushTranslatedArg`, which emits
    // `--${name}=${value}` — NOT a two-token `--name value` pair — so a flow
    // step and a hand-typed `m3l <script>` invocation produce identical argv.
    await expect(runWithParameters({ command: "dump" })).resolves.toEqual([
      "--command=dump",
    ]);
  });

  test("boolean true becomes a bare --name flag", async () => {
    await expect(runWithParameters({ verbose: true })).resolves.toEqual([
      "--verbose",
    ]);
  });

  test("boolean false is omitted entirely", async () => {
    await expect(runWithParameters({ verbose: false })).resolves.toEqual([]);
  });

  test("an array value becomes one repeated --name=value token per item", async () => {
    await expect(
      runWithParameters({ fields: ["body=body", "id=id"] }),
    ).resolves.toEqual(["--fields=body=body", "--fields=id=id"]);
  });

  test("a numeric value is stringified into --name=value", async () => {
    await expect(runWithParameters({ limit: 25 })).resolves.toEqual([
      "--limit=25",
    ]);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("a %s value is omitted entirely", async (_label, value: unknown) => {
    // A YAML key written with no value parses to null; it must contribute no
    // argv token rather than the literal string "null".
    await expect(runWithParameters({ output: value })).resolves.toEqual([]);
  });

  test("tokens follow the parameters record's own key order", async () => {
    await expect(
      runWithParameters({
        command: "dump",
        queueUrl: "https://q",
        output: "o",
      }),
    ).resolves.toEqual([
      "--command=dump",
      "--queueUrl=https://q",
      "--output=o",
    ]);
  });

  test("the in-process path forwards the step's parameters verbatim as parameterValues", async () => {
    runInProcessMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    const parameters = { input: "data/output/a.jsonl", format: "jsonl" };

    await executeFlowStep(
      buildContext(),
      buildStep({ script: "json-etl", execution: "in-process", parameters }),
      false,
      { now: scriptedNow(T0, T1) },
    );

    const call = runInProcessMock.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const [scriptDirectory, options] = call;
    expect(scriptDirectory).toBe(JSON_DIRECTORY);
    expect(options.parameterValues).toEqual(parameters);
  });
});

describe("executeFlowStep — the child environment (ADR-0085)", () => {
  /** An obvious placeholder — never a realistic-looking credential. */
  const PLACEHOLDER_SECRET = "PLACEHOLDER-NOT-A-REAL-SECRET";

  /** Reads the execute context the spawn path was handed. */
  function spawnedExecuteContext(): {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly envFile: M3LCliEnvFileSetting;
  } {
    const call = executeScriptMock.mock.calls[0];
    if (call === undefined) throw new Error("executeScript was not called");
    return call[0];
  }

  test("the spawn path hands executeScript the context's env and envFile verbatim", async () => {
    // ADR-0085: a step's child must inherit the same environment, and load the
    // same env file, a hand-typed `m3l <script>` invocation would — including
    // the secret-carrying variables, which is the whole reason a secret never
    // needs to appear in the definition file. Identity, not equality: a copy
    // would be a re-derivation this module has no business making.
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    const envFile: M3LCliEnvFileSetting = {
      kind: "path",
      path: "/workspace/staging.env",
    };
    const context = buildContext({ envFile });

    await executeFlowStep(context, buildStep(), false, {
      now: scriptedNow(T0, T1),
    });

    expect(spawnedExecuteContext().env).toBe(CLI_ENV);
    expect(spawnedExecuteContext().envFile).toBe(envFile);
  });

  test.each([
    [{ kind: "auto" }],
    [{ kind: "path", path: "/workspace/ci.env" }],
    [{ kind: "disabled" }],
  ] as readonly [M3LCliEnvFileSetting][])(
    "forwards the %o env-file decision unchanged, so a step never resolves a different file than the operator chose",
    async (envFile: M3LCliEnvFileSetting) => {
      executeScriptMock.mockResolvedValue(0);
      locateRunReportMock.mockReturnValue(UNAVAILABLE);

      await executeFlowStep(buildContext({ envFile }), buildStep(), false, {
        now: scriptedNow(T0, T1),
      });

      expect(spawnedExecuteContext().envFile).toEqual(envFile);
    },
  );

  test("the in-process path is handed neither env nor envFile — it never spawns a child", async () => {
    // There is no child process to populate, so an `env`/`envFile` key on the
    // in-process options would be a field nobody reads: dead configuration
    // that a later reader could mistake for an honoured setting.
    runInProcessMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    await executeFlowStep(
      buildContext(),
      buildStep({ execution: "in-process" }),
      false,
      { now: scriptedNow(T0, T1) },
    );

    const call = runInProcessMock.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call[1]).not.toHaveProperty("env");
    expect(call[1]).not.toHaveProperty("envFile");
    expect(call[2]).not.toHaveProperty("env");
    expect(call[2]).not.toHaveProperty("envFile");
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  /*
   * [KNOWN GAP] The test that would have caught the leak — kept failing BY
   * DESIGN, not weakened.
   *
   * ADR-0085 requires a `secret: true` parameter to reach a child through its
   * environment, never its argv: argv is world-readable in
   * /proc/<pid>/cmdline, and it also resolves at provider priority 1 instead
   * of the env's 4. `commands/dynamic-argv.ts`'s `translateArgv` complies by
   * dropping the argv token for a secret; `buildStepArgv` here is a
   * hand-maintained clone that predates that change and emits `--name=value`
   * for EVERY parameter, because a step carries only names and opaque values —
   * this module has no descriptor knowledge whatsoever.
   *
   * The maintainer's chosen fix is fail-closed at LOAD time (`flow/validate.ts`
   * rejects a `parameters` key the target script declares secret), so a
   * VALIDATED step can never carry one. This test exists because
   * `M3LCliFlowStep` is a public type: a hand-built literal reaches
   * `executeFlowStep` without ever passing the validator, and nothing at this
   * layer stops the token.
   *
   * Closing it needs a decision, not a patch: either the secret names join
   * `M3LCliFlowStepContext` (a sixth field, which the exact-shape pin below
   * would have to grow) or the flow env-overlay work ADR-0085 deferred. Until
   * then `test.fails` keeps the suite green while pinning the gap exactly —
   * the day the step layer learns which parameters are secret this reports an
   * XPASS, which is the signal to flip it to a plain `test`.
   */
  test.fails(
    "[KNOWN GAP] a secret parameter's value never reaches the argv a flow step builds",
    async () => {
      executeScriptMock.mockResolvedValue(0);
      locateRunReportMock.mockReturnValue(UNAVAILABLE);

      await executeFlowStep(
        buildContext(),
        buildStep({
          script: "sqs-etl",
          parameters: { command: "dump", "api-token": PLACEHOLDER_SECRET },
        }),
        false,
        { now: scriptedNow(T0, T1) },
      );

      const call = executeScriptMock.mock.calls[0];
      if (call === undefined) throw new Error("executeScript was not called");
      const argv = call[3];
      // The non-secret parameter still has to flow: a step whose argv went
      // empty would satisfy a naive "no secret in argv" assertion while
      // breaking every flow.
      expect(argv).toContain("--command=dump");
      expect(argv.join(" ")).not.toContain(PLACEHOLDER_SECRET);
    },
  );
});

describe("executeFlowStep — the dry-run floor", () => {
  function spawnDryRunArgv(
    flowDryRun: boolean,
    stepDryRun?: boolean,
  ): Promise<M3LCliFlowStepResult> {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    return executeFlowStep(
      buildContext(),
      buildStep(stepDryRun === undefined ? {} : { dryRun: stepDryRun }),
      flowDryRun,
      { now: scriptedNow(T0, T1) },
    );
  }

  test("a step declaring dryRun:true still runs dry when the flow-level flag is false", async () => {
    const result = await spawnDryRunArgv(false, true);

    expect(result.dryRun).toBe(true);
    const call = executeScriptMock.mock.calls[0];
    expect(call?.[3]).toContain("--dry-run");
  });

  test("the flow-level flag forces dry-run on a step that declares nothing", async () => {
    const result = await spawnDryRunArgv(true);

    expect(result.dryRun).toBe(true);
    expect(executeScriptMock.mock.calls[0]?.[3]).toContain("--dry-run");
  });

  test("a step declaring dryRun:false is still forced dry by the flow-level flag — the floor never lowers", async () => {
    const result = await spawnDryRunArgv(true, false);

    expect(result.dryRun).toBe(true);
    expect(executeScriptMock.mock.calls[0]?.[3]).toContain("--dry-run");
  });

  test("neither flag set runs wet and emits no --dry-run token", async () => {
    const result = await spawnDryRunArgv(false, false);

    expect(result.dryRun).toBe(false);
    expect(executeScriptMock.mock.calls[0]?.[3]).not.toContain("--dry-run");
  });

  test("the in-process path receives the effective dry-run as options.dryRun", async () => {
    runInProcessMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    await executeFlowStep(
      buildContext(),
      buildStep({ execution: "in-process", dryRun: true }),
      false,
      { now: scriptedNow(T0, T1) },
    );

    expect(runInProcessMock.mock.calls[0]?.[1].dryRun).toBe(true);
  });
});

describe("executeFlowStep — reading the outcome through its own window", () => {
  test("locateRunReport is called with the step's own observed start/finish window", async () => {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    const result = await executeFlowStep(buildContext(), buildStep(), false, {
      now: scriptedNow(T0, T1),
    });

    expect(locateRunReportMock).toHaveBeenCalledTimes(1);
    expect(locateRunReportMock).toHaveBeenCalledWith({
      outputDirPath: OUTPUT_DIR,
      scriptName: "sqs-etl",
      startedAt: T0,
      finishedAt: T1,
    });
    expect(result.startedAt).toBe(T0);
    expect(result.finishedAt).toBe(T1);
  });

  /*
   * THE load-bearing test of this file. The acceptance flow invokes `sqs-etl`
   * twice, and the design doc states no per-step correlation id is needed
   * because each step passes its OWN observed window. If an implementation
   * hoisted the clock read out of the per-step path (one window reused for the
   * whole run), both lookups would carry identical bounds and the two
   * invocations of the same script would become indistinguishable — the exact
   * defect this pins.
   */
  test("two steps invoking the SAME script are disambiguated purely by their windows", async () => {
    const firstReport = "/workspace/data/output/a/run-report.json";
    const secondReport = "/workspace/data/output/b/run-report.json";
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock
      .mockReturnValueOnce(foundLookup(firstReport))
      .mockReturnValueOnce(foundLookup(secondReport));
    const context = buildContext();
    const now = scriptedNow(T0, T1, T2, T3);

    const first = await executeFlowStep(
      context,
      buildStep({ id: "dump", script: "sqs-etl" }),
      false,
      { now },
    );
    const second = await executeFlowStep(
      context,
      buildStep({ id: "republish", script: "sqs-etl" }),
      false,
      { now },
    );

    expect(locateRunReportMock.mock.calls[0]?.[0]).toMatchObject({
      scriptName: "sqs-etl",
      startedAt: T0,
      finishedAt: T1,
    });
    expect(locateRunReportMock.mock.calls[1]?.[0]).toMatchObject({
      scriptName: "sqs-etl",
      startedAt: T2,
      finishedAt: T3,
    });
    // Non-overlapping windows, so the two reports resolve independently.
    expect(first.reportPath).toBe(firstReport);
    expect(second.reportPath).toBe(secondReport);
  });

  test("a found report supplies the step's outcome and reportPath", async () => {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(
      foundLookup("/workspace/data/output/x/run-report.json"),
    );

    const result = await executeFlowStep(buildContext(), buildStep(), false, {
      now: scriptedNow(T0, T1),
    });

    expect(result).toMatchObject({
      stepId: "dump",
      script: "sqs-etl",
      exitCode: 0,
      outcome: "success",
      reportPath: "/workspace/data/output/x/run-report.json",
      reportUnavailable: null,
    });
  });

  test("a found report whose own outcome is null does not crash and yields outcome null", async () => {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue({
      status: "found",
      reportPath: "/workspace/data/output/x/run-report.json",
      summary: {
        outcome: null,
        timelineCount: null,
        timelineSourceCount: null,
        recoveryTotal: null,
      },
    });

    const result = await executeFlowStep(buildContext(), buildStep(), false, {
      now: scriptedNow(T0, T1),
    });

    expect(result.outcome).toBeNull();
    expect(result.reportPath).toBe("/workspace/data/output/x/run-report.json");
  });

  test.each([
    ["output-directory-missing"],
    ["output-directory-unreadable"],
    ["no-matching-report"],
    ["report-unreadable"],
    ["report-malformed"],
  ] as const)(
    "tolerates the '%s' unavailable reason without crashing",
    async (reason) => {
      executeScriptMock.mockResolvedValue(4);
      locateRunReportMock.mockReturnValue({ status: "unavailable", reason });

      const result = await executeFlowStep(buildContext(), buildStep(), false, {
        now: scriptedNow(T0, T1),
      });

      expect(result.outcome).toBeNull();
      expect(result.reportPath).toBeNull();
      expect(result.reportUnavailable).toBe(reason);
      expect(result.exitCode).toBe(4);
    },
  );

  test("never writes or rewrites anything on disk", async () => {
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);
    const mkdirSpy = vi
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => undefined);
    const appendSpy = vi
      .spyOn(fs, "appendFileSync")
      .mockImplementation(() => undefined);
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(
      foundLookup("/workspace/data/output/x/run-report.json"),
    );

    await executeFlowStep(buildContext(), buildStep(), false, {
      now: scriptedNow(T0, T1),
    });

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  test("the report lookup still runs for an in-process step, to recover reportPath", async () => {
    // `runInProcess` resolves only a number, so the in-process path has no
    // authoritative outcome of its own; the lookup is the ONLY source of
    // `reportPath` (and of `outcome`) on that path too.
    runInProcessMock.mockResolvedValue(6);
    locateRunReportMock.mockReturnValue({
      status: "found",
      reportPath: "/workspace/data/output/y/run-report.json",
      summary: {
        outcome: "partial",
        timelineCount: 2,
        timelineSourceCount: 1,
        recoveryTotal: 7,
      },
    });

    const result = await executeFlowStep(
      buildContext(),
      buildStep({ script: "json-etl", execution: "in-process" }),
      false,
      { now: scriptedNow(T0, T1) },
    );

    expect(locateRunReportMock).toHaveBeenCalledWith({
      outputDirPath: OUTPUT_DIR,
      scriptName: "json-etl",
      startedAt: T0,
      finishedAt: T1,
    });
    expect(result).toMatchObject({
      stepId: "dump",
      script: "json-etl",
      execution: "in-process",
      dryRun: false,
      exitCode: 6,
      outcome: "partial",
      reportPath: "/workspace/data/output/y/run-report.json",
      reportUnavailable: null,
    });
  });
});

describe("executeFlowStep — failure propagation and seams", () => {
  test("a spawn-path rejection propagates unchanged", async () => {
    const cause = new M3LCliError("ERR_CLI_SPAWN_FAILED", "spawn blew up");
    executeScriptMock.mockRejectedValue(cause);

    await expect(
      executeFlowStep(buildContext(), buildStep(), false, {
        now: scriptedNow(T0, T1),
      }),
    ).rejects.toBe(cause);
    expect(locateRunReportMock).not.toHaveBeenCalled();
  });

  test("an in-process rejection propagates unchanged", async () => {
    const cause = new M3LCliError(
      "ERR_CLI_COMMAND_MODULE_INVALID",
      "no command module",
    );
    runInProcessMock.mockRejectedValue(cause);

    await expect(
      executeFlowStep(
        buildContext(),
        buildStep({ execution: "in-process" }),
        false,
        { now: scriptedNow(T0, T1) },
      ),
    ).rejects.toBe(cause);
  });

  test("spawnImpl and stderrStream are forwarded to executeScript", async () => {
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    const spawnImpl = vi.fn();
    const stderrStream = { write: vi.fn() };

    await executeFlowStep(buildContext(), buildStep(), false, {
      now: scriptedNow(T0, T1),
      spawnImpl: spawnImpl as unknown as M3LCliFlowStepOptions["spawnImpl"],
      stderrStream:
        stderrStream as unknown as M3LCliFlowStepOptions["stderrStream"],
    });

    expect(executeScriptMock.mock.calls[0]?.[4]).toMatchObject({
      spawnImpl,
      stderrStream,
    });
  });

  test("importModule is forwarded to runInProcess's import options", async () => {
    runInProcessMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);
    const importModule = vi.fn(() => Promise.resolve({}));

    await executeFlowStep(
      buildContext(),
      buildStep({ execution: "in-process" }),
      false,
      { now: scriptedNow(T0, T1), importModule },
    );

    expect(runInProcessMock.mock.calls[0]?.[2]).toMatchObject({
      importModule,
    });
  });

  test("the now seam is read exactly twice per step execution", async () => {
    // Two reads and no more: the step's own window is the only clock this
    // module owns, and `executeScript`'s own `now` is NOT forwarded (called
    // with jsonOutput:false it never uses its timing). A third read would
    // throw from scriptedNow.
    executeScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(UNAVAILABLE);

    await expect(
      executeFlowStep(buildContext(), buildStep(), false, {
        now: scriptedNow(T0, T1),
      }),
    ).resolves.toMatchObject({ startedAt: T0, finishedAt: T1 });
    expect(executeScriptMock.mock.calls[0]?.[4]).not.toHaveProperty("now");
  });
});

describe("executeFlowStep — types", () => {
  test("the step result carries the resolved mechanism, the effective dry-run, and the observed window", () => {
    expectTypeOf<M3LCliFlowStepResult>().toEqualTypeOf<{
      readonly stepId: string;
      readonly script: string;
      readonly execution: "in-process" | "spawn";
      readonly dryRun: boolean;
      readonly startedAt: Date;
      readonly finishedAt: Date;
      readonly exitCode: number;
      readonly outcome: M3LCliRunOutcome | null;
      readonly reportPath: string | null;
      readonly reportUnavailable: M3LCliRunReportUnavailableReason | null;
    }>();
  });

  test("the step context names exactly six fields: the three this module reads, ADR-0085's env and envFile, plus jsonOutput", () => {
    // An EXACT-shape pin, deliberately: this context is the seam
    // `commands/flow.ts` populates, and a field appearing here silently is how
    // a spawned step ends up configured differently from the hand-typed
    // `m3l <script>` invocation it is supposed to be identical to.
    //
    // Three fields are this module's own work: `output` (handed to whichever
    // mechanism runs the step), `outputDirPath` (scanned for the step's
    // `run-report.json`), and `scriptDirectories` (the dispatch target).
    //
    // Two more exist ONLY for ADR-0085, and only the spawn path reads them:
    // `env` is the base environment the child inherits — the channel a
    // secret must travel through, since it may never appear in argv — and
    // `envFile` is the resolved `--env-file`/`--no-env-file` decision. Both are
    // required rather than optional-with-a-default: a forgotten field would
    // otherwise spawn steps with an empty environment, or load a `.env` the
    // operator suppressed with `--no-env-file`, with nothing to catch it.
    //
    // The two are present because they are FORWARDED, not incidentally: the
    // "the child environment" block above asserts each one reaching
    // `executeScript`, so this pin can never drift into documenting a dead
    // field.
    //
    // `jsonOutput` is the sixth: whether the FLOW itself was invoked with
    // `--json`, forwarded to `dispatchStep`'s `redirectStdoutToStderr` so a
    // spawned step's own stdout cannot interleave with (or forge) the single
    // flow-level envelope. Also required rather than defaulted, for the same
    // reason `env`/`envFile` are.
    expectTypeOf<M3LCliFlowStepContext>().toEqualTypeOf<{
      readonly output: M3LCliOutput;
      readonly outputDirPath: string;
      readonly scriptDirectories: ReadonlyMap<string, string>;
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly envFile: M3LCliEnvFileSetting;
      readonly jsonOutput: boolean;
    }>();
  });

  test("executeFlowStep takes (context, step, flowDryRun, options?) and resolves a step result", () => {
    expectTypeOf(executeFlowStep).toEqualTypeOf<
      (
        context: M3LCliFlowStepContext,
        step: M3LCliFlowStep,
        flowDryRun: boolean,
        options?: M3LCliFlowStepOptions,
      ) => Promise<M3LCliFlowStepResult>
    >();
  });
});
