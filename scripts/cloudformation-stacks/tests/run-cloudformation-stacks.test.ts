import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

/**
 * Contract: docs/reference/scripts/cloudformation-stacks.md
 * `run-cloudformation-stacks` row — the orchestrator/dispatcher. Resolves
 * and guard-checks config per operation (throws
 * `ERR_CLOUDFORMATION_STACKS_CONFIG` before any AWS call); for
 * `create-stack`/`update-stack`, reads + JSON-parses `input` here, checks
 * the `template`/`input`-conflict rule BEFORE ever touching the template
 * file, then reads the template file only when no conflict exists and
 * `template` is set; runs `Core.confirmDestructive` for every mutating
 * operation (`create-stack`/`update-stack`/`delete-stack`); dynamic-imports
 * and dispatches to the operation-appropriate step; for `describe-stack`,
 * throws `ERR_CLOUDFORMATION_STACKS_NOT_FOUND` as soon as the step resolves
 * `undefined`, BEFORE any persistence; for the three wait operations,
 * persists `output` (when configured) FIRST, then throws
 * `ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE` on a non-`SUCCESS` state.
 * Step modules are mocked (this file asserts ONLY the orchestrator's
 * guard/gate/dispatch/persist wiring, never a step's internal logic — that
 * is each step's own test file's job); `node:fs/promises` and
 * `Core.M3LJSONFileExporter` are the true I/O boundary, also mocked.
 * The destructive gate is intercepted via a `vi.spyOn` on the injected
 * `Core.M3LPrompt` instance's `confirm` method — `confirmDestructive`
 * always delegates to `prompt.confirm(description)` internally, so this
 * seam works both before and after the orchestrator is migrated onto
 * `Core.M3LOperationPipeline`.
 */

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const readStacksMock = vi.fn();
const readStackEventsMock = vi.fn();
const writeStackMock = vi.fn();
const waitStackMock = vi.fn();

vi.mock("../src/steps/read-stacks.js", () => ({
  readStacks: readStacksMock,
}));
vi.mock("../src/steps/read-stack-events.js", () => ({
  readStackEvents: readStackEventsMock,
}));
vi.mock("../src/steps/write-stack.js", () => ({
  writeStack: writeStackMock,
}));
vi.mock("../src/steps/wait-stack.js", () => ({
  waitStack: waitStackMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import { runCloudformationStacks } from "../src/steps/run-cloudformation-stacks.js";
import {
  buildConfig,
  createFakeCloudFormationOperations,
} from "./support/cloudformationFakes.js";

const PATHS = new Core.M3LPaths();

const CREATE_STACK_RESULT = { stackId: "arn:aws:cloudformation::stack/x" };

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

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly operations?: ReturnType<typeof createFakeCloudFormationOperations>;
    readonly prompt?: Core.M3LPrompt;
  },
): Parameters<typeof runCloudformationStacks>[0] {
  return {
    config: buildConfig(configValues),
    paths: PATHS,
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    operations: overrides?.operations ?? createFakeCloudFormationOperations(),
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
  };
}

/** Returns a prompt spy that resolves the gate to `confirmed` and the spy for assertions. */
function confirmingPrompt(confirmed: boolean) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(confirmed);
  return { prompt, confirm };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies; it does not clear the
  // plain vi.fn() mocks created inside the top-level vi.mock() factories
  // above, so their call history would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockReset();
  readStacksMock.mockReset();
  readStackEventsMock.mockReset();
  writeStackMock.mockReset();
  waitStackMock.mockReset();
});

describe("runCloudformationStacks — per-operation config guards (fire before any AWS call or step dispatch)", () => {
  test.each([
    "describe-stack",
    "delete-stack",
    "describe-stack-events",
    "wait-stack-create-complete",
    "wait-stack-update-complete",
    "wait-stack-delete-complete",
  ])(
    "throws ERR_CLOUDFORMATION_STACKS_CONFIG when operation '%s' is missing 'stackName'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps({ operation }, { prompt });

      await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
        code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(readStacksMock).not.toHaveBeenCalled();
      expect(readStackEventsMock).not.toHaveBeenCalled();
      expect(writeStackMock).not.toHaveBeenCalled();
      expect(waitStackMock).not.toHaveBeenCalled();
    },
  );

  test.each(["create-stack", "update-stack"])(
    "throws ERR_CLOUDFORMATION_STACKS_CONFIG when operation '%s' is missing 'input'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps({ operation }, { prompt });

      await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
        code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(writeStackMock).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({ operation: "frobnicate" });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(readStacksMock).not.toHaveBeenCalled();
    expect(writeStackMock).not.toHaveBeenCalled();
    expect(waitStackMock).not.toHaveBeenCalled();
    expect(readStackEventsMock).not.toHaveBeenCalled();
  });
});

describe("runCloudformationStacks — template/input conflict rule (runs before touching the template file)", () => {
  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when 'template' is set alongside an input record that already sets templateBody, never reading the template path", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    const templatePath = PATHS.resolveInput("template.yaml");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        stackName: "my-stack",
        templateBody: "already-set",
      }),
    });
    const deps = buildDeps({
      operation: "create-stack",
      input: "create.json",
      template: "template.yaml",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(fsp.readFile).not.toHaveBeenCalledWith(
      templatePath,
      expect.anything(),
    );
    expect(writeStackMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when 'template' is set alongside an input record that already sets templateUrl, never reading the template path", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    const templatePath = PATHS.resolveInput("template.yaml");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        stackName: "my-stack",
        templateUrl: "https://example.com/t.json",
      }),
    });
    const deps = buildDeps({
      operation: "update-stack",
      input: "update.json",
      template: "template.yaml",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(fsp.readFile).not.toHaveBeenCalledWith(
      templatePath,
      expect.anything(),
    );
    expect(writeStackMock).not.toHaveBeenCalled();
  });

  test("reads the template file and dispatches its text when no conflict exists", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    const templatePath = PATHS.resolveInput("template.yaml");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({ stackName: "my-stack" }),
      [templatePath]: "Resources: {}",
    });
    writeStackMock.mockResolvedValue(CREATE_STACK_RESULT);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "create-stack",
        input: "create.json",
        template: "template.yaml",
      },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(writeStackMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateText: "Resources: {}" }),
    );
  });
});

describe("runCloudformationStacks — describe-stack NOT_FOUND check runs before any persistence", () => {
  test("throws ERR_CLOUDFORMATION_STACKS_NOT_FOUND when describe-stack resolves undefined, never invoking the export path", async () => {
    readStacksMock.mockResolvedValue(undefined);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "describe-stack",
      stackName: "missing-stack",
      output: "result.json",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_NOT_FOUND",
    });
    expect(exportSpy).not.toHaveBeenCalled();
  });

  test("does not throw when describe-stack resolves a stack", async () => {
    readStacksMock.mockResolvedValue({
      stackName: "my-stack",
      stackStatus: "CREATE_COMPLETE",
    });
    const deps = buildDeps({
      operation: "describe-stack",
      stackName: "my-stack",
    });

    await expect(runCloudformationStacks(deps)).resolves.toBeUndefined();
  });
});

describe("runCloudformationStacks — wait operations: persist-then-throw ordering on non-SUCCESS", () => {
  test("persists the output BEFORE throwing ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE when 'output' is configured", async () => {
    const result = { state: "TIMEOUT", reason: "took too long" };
    waitStackMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "wait-stack-create-complete",
      stackName: "my-stack",
      output: "result.json",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE",
    });

    // The persist call having actually happened (rather than being skipped
    // because the throw fired first) is what proves the ordering: if the
    // implementation threw before persisting, exportSpy would never be
    // called at all.
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("still throws ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE when 'output' is unset (nothing to persist)", async () => {
    waitStackMock.mockResolvedValue({ state: "ABORTED" });
    const deps = buildDeps({
      operation: "wait-stack-update-complete",
      stackName: "my-stack",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE",
    });
  });

  test("does not throw when a wait operation resolves SUCCESS", async () => {
    waitStackMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-stack-delete-complete",
      stackName: "my-stack",
    });

    await expect(runCloudformationStacks(deps)).resolves.toBeUndefined();
  });
});

describe("runCloudformationStacks — destructive-gate dispatch (create/update/delete-stack only)", () => {
  test.each([
    "list-stacks",
    "describe-stack",
    "describe-stack-events",
    "wait-stack-create-complete",
    "wait-stack-update-complete",
    "wait-stack-delete-complete",
  ])("never runs destructive-gate for '%s'", async (operation) => {
    readStacksMock.mockResolvedValue({ stackSummaries: [] });
    readStackEventsMock.mockResolvedValue({ stackEvents: [] });
    waitStackMock.mockResolvedValue({ state: "SUCCESS" });
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps({ operation, stackName: "my-stack" }, { prompt });

    await runCloudformationStacks(deps);

    expect(confirm).not.toHaveBeenCalled();
  });

  test("runs destructive-gate before dispatching 'delete-stack', building description from the stackName config value", async () => {
    writeStackMock.mockResolvedValue(undefined);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete-stack", stackName: "my-stack" },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-stack"));
  });

  test("forwards 'yes' through to destructive-gate", async () => {
    writeStackMock.mockResolvedValue(undefined);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete-stack", stackName: "my-stack", yes: true },
      { prompt },
    );

    await runCloudformationStacks(deps);

    // When yes=true, confirmDestructive bypasses prompt.confirm entirely
    // (logs a warning instead) — so the spy must not be called.
    expect(confirm).not.toHaveBeenCalled();
  });

  test("propagates ERR_CLOUDFORMATION_STACKS_ABORTED from destructive-gate, never dispatching writeStack", async () => {
    const { prompt } = confirmingPrompt(false);
    const deps = buildDeps(
      { operation: "delete-stack", stackName: "my-stack" },
      { prompt },
    );

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_ABORTED",
    });
    expect(writeStackMock).not.toHaveBeenCalled();
  });

  test("runs destructive-gate before dispatching 'create-stack', building the description from the parsed input's stackName", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({ stackName: "my-stack" }),
    });
    writeStackMock.mockResolvedValue(CREATE_STACK_RESULT);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-stack", input: "create.json" },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-stack"));
  });
});

describe("runCloudformationStacks — 'stackStatusFilter'/'retainResources' comma-split/trim/drop-empty semantics", () => {
  test("splits on ',', trims each segment, and drops empty segments before dispatching to readStacks (list-stacks)", async () => {
    readStacksMock.mockResolvedValue({ stackSummaries: [] });
    const deps = buildDeps({
      operation: "list-stacks",
      stackStatusFilter:
        " CREATE_COMPLETE ,UPDATE_COMPLETE,, ROLLBACK_COMPLETE ",
    });

    await runCloudformationStacks(deps);

    expect(readStacksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stackStatusFilter: [
          "CREATE_COMPLETE",
          "UPDATE_COMPLETE",
          "ROLLBACK_COMPLETE",
        ],
      }),
    );
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when 'stackStatusFilter' is empty after split+trim+drop-empty", async () => {
    const deps = buildDeps({
      operation: "list-stacks",
      stackStatusFilter: " , , ",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(readStacksMock).not.toHaveBeenCalled();
  });

  test("splits/trims/drops-empty 'retainResources' before dispatching to writeStack (delete-stack)", async () => {
    writeStackMock.mockResolvedValue(undefined);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete-stack",
        stackName: "my-stack",
        retainResources: " BucketA ,BucketB,, BucketC ",
      },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(writeStackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        retainResources: ["BucketA", "BucketB", "BucketC"],
      }),
    );
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when 'retainResources' is empty after split+trim+drop-empty", async () => {
    const deps = buildDeps({
      operation: "delete-stack",
      stackName: "my-stack",
      retainResources: " , , ",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(writeStackMock).not.toHaveBeenCalled();
  });
});

describe("runCloudformationStacks — operation dispatch routing (dynamic-imports the 4 step modules)", () => {
  test("'list-stacks' dispatches to readStacks with stackStatusFilter/nextToken", async () => {
    readStacksMock.mockResolvedValue({ stackSummaries: [] });
    const deps = buildDeps({
      operation: "list-stacks",
      nextToken: "prev-token",
    });

    await runCloudformationStacks(deps);

    expect(readStacksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list-stacks",
        nextToken: "prev-token",
        operations: deps.operations,
      }),
    );
  });

  test("'describe-stack' dispatches to readStacks with stackName", async () => {
    readStacksMock.mockResolvedValue({
      stackName: "my-stack",
      stackStatus: "CREATE_COMPLETE",
    });
    const deps = buildDeps({
      operation: "describe-stack",
      stackName: "my-stack",
    });

    await runCloudformationStacks(deps);

    expect(readStacksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "describe-stack",
        stackName: "my-stack",
      }),
    );
  });

  test("'describe-stack-events' dispatches to readStackEvents with stackName/nextToken", async () => {
    readStackEventsMock.mockResolvedValue({ stackEvents: [] });
    const deps = buildDeps({
      operation: "describe-stack-events",
      stackName: "my-stack",
      nextToken: "prev-token",
    });

    await runCloudformationStacks(deps);

    expect(readStackEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: "my-stack",
        nextToken: "prev-token",
      }),
    );
  });

  test("'create-stack' reads + parses input JSON, dispatching the record to writeStack", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    const parsedInput = { stackName: "my-stack" };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeStackMock.mockResolvedValue(CREATE_STACK_RESULT);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-stack", input: "create.json" },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(writeStackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create-stack",
        input: parsedInput,
      }),
    );
  });

  test("'delete-stack' dispatches to writeStack with stackName/retainResources/roleArn from config, input undefined", async () => {
    writeStackMock.mockResolvedValue(undefined);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete-stack",
        stackName: "my-stack",
        roleArn: "arn:aws:iam::123:role/deploy",
      },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(writeStackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "delete-stack",
        stackName: "my-stack",
        roleArn: "arn:aws:iam::123:role/deploy",
        input: undefined,
      }),
    );
  });

  test("'wait-stack-create-complete' dispatches to waitStack with stackName/maxWaitTime", async () => {
    waitStackMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-stack-create-complete",
      stackName: "my-stack",
      maxWaitTime: 120,
    });

    await runCloudformationStacks(deps);

    expect(waitStackMock).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: "my-stack", maxWaitTime: 120 }),
    );
  });
});

describe("runCloudformationStacks — output persistence", () => {
  test("persists the result to 'output' via Core.M3LJSONFileExporter when configured (list-stacks)", async () => {
    const result = { stackSummaries: [] };
    readStacksMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "list-stacks",
      output: "result.json",
    });

    await runCloudformationStacks(deps);

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("does not persist anything when 'output' is unset", async () => {
    readStacksMock.mockResolvedValue({ stackSummaries: [] });
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({ operation: "list-stacks" });

    await runCloudformationStacks(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });

  test("does not persist anything for 'delete-stack' (void result, nothing to persist), even when 'output' is configured", async () => {
    writeStackMock.mockResolvedValue(undefined);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete-stack",
        stackName: "my-stack",
        output: "result.json",
      },
      { prompt },
    );

    await runCloudformationStacks(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe("runCloudformationStacks — malformed/unreadable input-file failure paths", () => {
  test("wraps an unreadable input file's read failure as ERR_CLOUDFORMATION_STACKS_CONFIG, chaining the raw cause", async () => {
    const cause = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);
    const deps = buildDeps({
      operation: "create-stack",
      input: "create.json",
    });

    let thrown: unknown;
    try {
      await runCloudformationStacks(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_CLOUDFORMATION_STACKS_CONFIG",
    );
    expect((thrown as Core.M3LError).cause).toBe(cause);
    expect(writeStackMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG ('must be valid JSON') when the input file's content is malformed JSON", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-stack",
      input: "create.json",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(writeStackMock).not.toHaveBeenCalled();
  });

  test("F10: malformed JSON parse failure does not chain the raw SyntaxError as cause", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-stack",
      input: "create.json",
    });

    let thrown: unknown;
    try {
      await runCloudformationStacks(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).cause).toBeUndefined();
    expect((thrown as Core.M3LError).message).toMatch(
      /must be valid JSON \(\w+Error\)/,
    );
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG ('contains an unsafe key') when the parsed input has a top-level __proto__ key", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: '{"__proto__":{"polluted":true}}',
    });
    const deps = buildDeps({
      operation: "create-stack",
      input: "create.json",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(writeStackMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG ('must decode to a JSON object') when the parsed input is a JSON array", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify([1, 2, 3]) });
    const deps = buildDeps({
      operation: "update-stack",
      input: "update.json",
    });

    await expect(runCloudformationStacks(deps)).rejects.toMatchObject({
      code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
    });
    expect(writeStackMock).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("runCloudformationStacks resolves void", () => {
    expectTypeOf(runCloudformationStacks).returns.toEqualTypeOf<
      Promise<void>
    >();
  });
});
