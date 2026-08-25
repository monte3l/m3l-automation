import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

/**
 * Contract: docs/reference/scripts/lambda-ops.md `run-lambda-ops` row — the
 * orchestrator/dispatcher. Guard-checks the resolved config per operation
 * (throws `ERR_LAMBDA_OPS_CONFIG` before any AWS call), runs `destructive-gate`
 * for every operation except `list`/`describe`, resolves `zipFilePath`/`input`
 * into raw bytes/parsed JSON (the ONE place either file is ever read),
 * dynamic-imports and dispatches to the operation-appropriate step, persists
 * the returned result to `output` via `Core.M3LJSONFileExporter` when
 * configured (BEFORE the `invoke` functionError check), and throws
 * `ERR_LAMBDA_OPS_FUNCTION_ERROR` when an `invoke` result's `functionError` is
 * populated. Step modules are mocked (this file asserts ONLY the
 * orchestrator's guard/gate/dispatch/persist wiring, never a step's internal
 * logic — that is each step's own test file's job); `node:fs/promises` and
 * `Core.M3LJSONFileExporter` are the true I/O boundary, also mocked. The
 * destructive gate itself (`Core.confirmDestructive`) runs for real and is
 * observed at the one seam it always calls through — a per-test
 * `Core.M3LPrompt` instance's `confirm` method, spied via `vi.spyOn` (the same
 * technique `scripts/ecs-ops/tests/run-ecs-ops.test.ts` uses for its own
 * destructive gate). This is architecture-agnostic: it observes the gate at
 * the prompt boundary `confirmDestructive` has always called through, regardless
 * of how the dispatcher that invokes it is wired (issue #437 migration target).
 */

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const readFunctionsMock = vi.fn();
const writeFunctionMock = vi.fn();
const invokeFunctionMock = vi.fn();

vi.mock("../src/steps/read-functions.js", () => ({
  readFunctions: readFunctionsMock,
}));
vi.mock("../src/steps/write-function.js", () => ({
  writeFunction: writeFunctionMock,
}));
vi.mock("../src/steps/invoke-function.js", () => ({
  invokeFunction: invokeFunctionMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import { runLambdaOps } from "../src/steps/run-lambda-ops.js";
import {
  buildConfig,
  createFakeLambdaOperations,
} from "./support/lambdaFakes.js";

const PATHS = new Core.M3LPaths();

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

/**
 * Non-sensitive by the retrofit's `profile.toLowerCase().includes("prod")`
 * predicate (issue #483 / ADR-0048) — the default `awsTarget` for every
 * pre-existing test in this file, so none of them exercise the escalated
 * typed-echo path unless they opt in via `overrides.awsTarget`.
 */
const NON_SENSITIVE_TARGET: Core.M3LDestructiveTarget = {
  profile: "dev-sandbox",
};

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly operations?: ReturnType<typeof createFakeLambdaOperations>;
    readonly prompt?: Core.M3LPrompt;
    readonly awsTarget?: Core.M3LDestructiveTarget;
  },
): Parameters<typeof runLambdaOps>[0] {
  return {
    config: buildConfig(configValues),
    paths: PATHS,
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    operations: overrides?.operations ?? createFakeLambdaOperations(),
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
    // Not yet declared on `Deps` (issue #483 RED phase) — the destructive
    // block wires `deps.awsTarget` through to `confirmDestructive`'s `target`
    // once `src/steps/run-lambda-ops.ts` lands the field.
    awsTarget: overrides?.awsTarget ?? NON_SENSITIVE_TARGET,
  };
}

/**
 * Builds a `Core.M3LPrompt` whose `confirm` method is stubbed to resolve
 * `confirmed` and whose `text` method (the escalated typed-echo path added by
 * issue #483 / ADR-0048) is stubbed to resolve `textResponse`, alongside both
 * spies. `Core.confirmDestructive` (invoked internally by `run-lambda-ops`)
 * always calls `deps.prompt.confirm`/`deps.prompt.text` directly — this is the
 * seam every gate test in this file observes instead of a `Core`-barrel
 * override.
 */
function confirmingPrompt(
  confirmed: boolean,
  options?: { readonly textResponse?: string },
) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(confirmed);
  const text = vi
    .spyOn(prompt, "text")
    .mockResolvedValue(options?.textResponse ?? "");
  return { prompt, confirm, text };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (the exporter prototype spy
  // and prompt.confirm spies above); it does not clear the plain vi.fn() mocks
  // created inside the top-level vi.mock() factories above, so their call
  // history would otherwise leak into the next test. fsp.readFile is one such
  // vi.fn() (wrapped once at module scope by the node:fs/promises factory
  // above): vi.spyOn(fsp, "readFile") in stubReadFileByPath() detects it is
  // already a mock and reuses that same instance rather than layering a fresh
  // spy, so restoreAllMocks() does not reset its call log either — it needs its
  // own explicit mockReset() here, same as the step mocks below.
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockReset();
  readFunctionsMock.mockReset();
  writeFunctionMock.mockReset();
  invokeFunctionMock.mockReset();
});

describe("runLambdaOps — config guards (fire before any AWS call or step dispatch)", () => {
  test.each([
    "describe",
    "invoke",
    "create",
    "update-code",
    "update-configuration",
    "delete",
  ])(
    "throws ERR_LAMBDA_OPS_CONFIG when operation '%s' is missing 'functionName'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps({ operation }, { prompt });

      await expect(runLambdaOps(deps)).rejects.toMatchObject({
        code: "ERR_LAMBDA_OPS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(readFunctionsMock).not.toHaveBeenCalled();
      expect(writeFunctionMock).not.toHaveBeenCalled();
      expect(invokeFunctionMock).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_LAMBDA_OPS_CONFIG when operation 'create' is missing 'zipFilePath'", async () => {
    const deps = buildDeps({
      operation: "create",
      functionName: "my-function",
      input: "def.json",
    });

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when operation 'update-code' is missing 'zipFilePath'", async () => {
    const deps = buildDeps({
      operation: "update-code",
      functionName: "my-function",
    });

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when operation 'create' is missing 'input'", async () => {
    const deps = buildDeps({
      operation: "create",
      functionName: "my-function",
      zipFilePath: "code.zip",
    });

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when operation 'update-configuration' is missing 'input'", async () => {
    const deps = buildDeps({
      operation: "update-configuration",
      functionName: "my-function",
    });

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({
      operation: "frobnicate",
      functionName: "my-function",
    });

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
    expect(readFunctionsMock).not.toHaveBeenCalled();
    expect(writeFunctionMock).not.toHaveBeenCalled();
    expect(invokeFunctionMock).not.toHaveBeenCalled();
  });
});

describe("runLambdaOps — destructive-gate dispatch", () => {
  test.each(["list", "describe"])(
    "never runs destructive-gate for '%s'",
    async (operation) => {
      readFunctionsMock.mockResolvedValue({ functions: [] });
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps(
        { operation, functionName: "my-function" },
        { prompt },
      );

      await runLambdaOps(deps);

      expect(confirm).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["invoke", { input: undefined }],
    ["delete", {}],
  ] as const)(
    "runs destructive-gate before dispatching '%s'",
    async (operation, extra) => {
      invokeFunctionMock.mockResolvedValue({ statusCode: 200 });
      writeFunctionMock.mockResolvedValue(undefined);
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps(
        {
          operation,
          functionName: "my-function",
          ...extra,
        },
        { prompt },
      );

      await runLambdaOps(deps);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(
        expect.stringMatching(/^Confirm: .*\?$/),
      );
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("my-function"),
      );
    },
  );

  test("'yes: true' bypasses the interactive prompt entirely and logs the gate's own bypass warning, still dispatching writeFunction", async () => {
    writeFunctionMock.mockResolvedValue(undefined);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete",
        functionName: "my-function",
        yes: true,
      },
      { prompt },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    await runLambdaOps(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalled();
    expect(writeFunctionMock).toHaveBeenCalled();
  });

  test("propagates ERR_LAMBDA_OPS_ABORTED from destructive-gate, never dispatching the step", async () => {
    const { prompt } = confirmingPrompt(false);
    const deps = buildDeps(
      {
        operation: "delete",
        functionName: "my-function",
      },
      { prompt },
    );

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_ABORTED",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });
});

/**
 * Issue #483 (A2b) / ADR-0048 fleet retrofit: `lambda-ops` wires
 * `deps.awsTarget` and a per-script inline sensitivity predicate
 * (`target.profile.toLowerCase().includes("prod")`) into the pipeline's
 * `destructive.target`/`isSensitiveTarget`/`yesSensitive` fields — none of
 * which are declared on `Deps`/the `destructive` block yet, so every test
 * below is expected to fail RED until `src/steps/run-lambda-ops.ts` lands the
 * wiring. `delete` is used throughout as the clearest always-destructive
 * operation. `Core.confirmDestructive` runs for real (see the file header);
 * these tests observe the same `prompt.confirm`/`prompt.text` seam, never a
 * `Core`-barrel override.
 */
describe("runLambdaOps — target-graded destructive confirmation (issue #483)", () => {
  test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
    writeFunctionMock.mockResolvedValue(undefined);
    const { prompt, confirm, text } = confirmingPrompt(true, {
      textResponse: "prod",
    });
    const deps = buildDeps(
      { operation: "delete", functionName: "my-function" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await runLambdaOps(deps);

    expect(text).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(writeFunctionMock).toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_ABORTED when the typed-echo input doesn't match the profile", async () => {
    const { prompt } = confirmingPrompt(true, { textResponse: "not-prod" });
    const deps = buildDeps(
      { operation: "delete", functionName: "my-function" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_ABORTED",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });

  test("bypasses confirmation with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
    writeFunctionMock.mockResolvedValue(undefined);
    const { prompt, confirm, text } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete",
        functionName: "my-function",
        yes: true,
        yesSensitive: true,
      },
      { prompt, awsTarget: { profile: "prod" } },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    await runLambdaOps(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("prod"));
    expect(writeFunctionMock).toHaveBeenCalled();
  });

  test.each([
    ["absent", {}],
    ["false", { yesSensitive: false }],
  ] as const)(
    "still escalates when yes:true but yesSensitive is %s, for a sensitive target",
    async (_label, extra) => {
      writeFunctionMock.mockResolvedValue(undefined);
      const { prompt, text } = confirmingPrompt(true, {
        textResponse: "prod",
      });
      const deps = buildDeps(
        {
          operation: "delete",
          functionName: "my-function",
          yes: true,
          ...extra,
        },
        { prompt, awsTarget: { profile: "prod" } },
      );

      await runLambdaOps(deps);

      expect(text).toHaveBeenCalledTimes(1);
    },
  );

  test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
    writeFunctionMock.mockResolvedValue(undefined);
    const { prompt, confirm, text } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete", functionName: "my-function" },
      { prompt, awsTarget: { profile: "dev" } },
    );

    await runLambdaOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });
});

describe("runLambdaOps — operation dispatch routing", () => {
  test("'list' dispatches to readFunctions with the resolved marker", async () => {
    readFunctionsMock.mockResolvedValue({ functions: [] });
    const deps = buildDeps({ operation: "list", marker: "prev-token" });

    await runLambdaOps(deps);

    expect(readFunctionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list",
        marker: "prev-token",
        operations: deps.operations,
      }),
    );
  });

  test("'list' omits marker (passes undefined) when unset", async () => {
    readFunctionsMock.mockResolvedValue({ functions: [] });
    const deps = buildDeps({ operation: "list" });

    await runLambdaOps(deps);

    const call = readFunctionsMock.mock.calls[0] as [
      { readonly marker: string | undefined },
    ];
    expect(call[0].marker).toBeUndefined();
  });

  test("'describe' dispatches to readFunctions with functionName", async () => {
    readFunctionsMock.mockResolvedValue({
      functionName: "my-function",
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-01T00:00:00Z",
    });
    const deps = buildDeps({
      operation: "describe",
      functionName: "my-function",
    });

    await runLambdaOps(deps);

    expect(readFunctionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "describe",
        functionName: "my-function",
      }),
    );
  });

  test("'create' reads zipFilePath bytes + parses input JSON, dispatching both to writeFunction", async () => {
    const zipPath = PATHS.resolveInput("code.zip");
    const inputPath = PATHS.resolveInput("def.json");
    const zipBytes = Buffer.from([1, 2, 3, 4]);
    const parsedInput = {
      runtime: "nodejs20.x",
      role: "arn:aws:iam::123456789012:role/my-role",
      handler: "index.handler",
    };
    stubReadFileByPath({
      [zipPath]: zipBytes,
      [inputPath]: JSON.stringify(parsedInput),
    });
    writeFunctionMock.mockResolvedValue({
      functionName: "my-function",
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-01T00:00:00Z",
    });
    // create is destructive-gated; a real (unstubbed) M3LPrompt would
    // otherwise block on real stdin here — see confirmingPrompt.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "create",
        functionName: "my-function",
        zipFilePath: "code.zip",
        input: "def.json",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    expect(writeFunctionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        functionName: "my-function",
        input: parsedInput,
      }),
    );
    const call = writeFunctionMock.mock.calls[0] as [
      { readonly zipFile: Uint8Array },
    ];
    expect(Buffer.from(call[0].zipFile)).toEqual(zipBytes);
  });

  test("'update-code' reads only zipFilePath bytes (input undefined)", async () => {
    const zipPath = PATHS.resolveInput("code.zip");
    const zipBytes = Buffer.from([9, 9, 9]);
    stubReadFileByPath({ [zipPath]: zipBytes });
    writeFunctionMock.mockResolvedValue({
      functionName: "my-function",
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-01T00:00:00Z",
    });
    // update-code is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "update-code",
        functionName: "my-function",
        zipFilePath: "code.zip",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    const call = writeFunctionMock.mock.calls[0] as [
      { readonly zipFile: Uint8Array; readonly input: unknown },
    ];
    expect(Buffer.from(call[0].zipFile)).toEqual(zipBytes);
    expect(call[0].input).toBeUndefined();
  });

  test("'update-configuration' reads only parsed input (zipFile undefined)", async () => {
    const inputPath = PATHS.resolveInput("def.json");
    const parsedInput = { timeout: 60 };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeFunctionMock.mockResolvedValue({
      functionName: "my-function",
      functionArn: "arn:aws:lambda:us-east-1:123:function:my-function",
      lastModified: "2026-01-01T00:00:00Z",
    });
    // update-configuration is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "update-configuration",
        functionName: "my-function",
        input: "def.json",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    const call = writeFunctionMock.mock.calls[0] as [
      { readonly zipFile: unknown; readonly input: unknown },
    ];
    expect(call[0].zipFile).toBeUndefined();
    expect(call[0].input).toEqual(parsedInput);
  });

  test("'delete' dispatches to writeFunction with neither zipFile nor input", async () => {
    writeFunctionMock.mockResolvedValue(undefined);
    // delete is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete",
        functionName: "my-function",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    expect(writeFunctionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "delete",
        functionName: "my-function",
        zipFile: undefined,
        input: undefined,
      }),
    );
  });

  test("'invoke' reads and parses the optional input payload, dispatching it to invokeFunction", async () => {
    const inputPath = PATHS.resolveInput("payload.json");
    const payload = { key: "value" };
    stubReadFileByPath({ [inputPath]: JSON.stringify(payload) });
    invokeFunctionMock.mockResolvedValue({ statusCode: 200 });
    // invoke is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
        input: "payload.json",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    expect(invokeFunctionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "my-function",
        payload,
      }),
    );
  });

  test("'invoke' omits the payload (passes undefined) when 'input' is unset", async () => {
    invokeFunctionMock.mockResolvedValue({ statusCode: 200 });
    // invoke is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    const call = invokeFunctionMock.mock.calls[0] as [
      { readonly payload: unknown },
    ];
    expect(call[0].payload).toBeUndefined();
    expect(fsp.readFile).not.toHaveBeenCalled();
  });
});

describe("runLambdaOps — output persistence", () => {
  test("persists the result to 'output' via Core.M3LJSONFileExporter when configured", async () => {
    const result = { functions: [] };
    readFunctionsMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "list",
      output: "result.json",
    });

    await runLambdaOps(deps);

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("does not persist anything when 'output' is unset, logging a summary (never the full result)", async () => {
    const result = { functions: [{ functionName: "sensitive-fn-name" }] };
    readFunctionsMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({ operation: "list" });
    const stepSpy = vi.spyOn(deps.logger, "step");

    await runLambdaOps(deps);

    expect(exportSpy).not.toHaveBeenCalled();
    expect(stepSpy).toHaveBeenCalledTimes(1);
    const call = stepSpy.mock.calls[0] as [string, Record<string, unknown>?];
    // The summary log never echoes the result payload itself — only
    // operation/functionName/(invoke-only) statusCode.
    expect(call[1]).not.toHaveProperty("functions");
    expect(call[1]).not.toHaveProperty("result");
  });

  test("'delete' persists nothing even when 'output' is configured", async () => {
    writeFunctionMock.mockResolvedValue(undefined);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    // delete is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete",
        functionName: "my-function",
        output: "result.json",
      },
      { prompt },
    );

    await runLambdaOps(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe("runLambdaOps — invoke functionError: persist-then-throw ordering", () => {
  test("persists the output BEFORE throwing ERR_LAMBDA_OPS_FUNCTION_ERROR when 'output' is configured", async () => {
    const result = {
      statusCode: 200,
      functionError: "Unhandled",
      payload: '{"errorMessage":"boom"}',
    };
    invokeFunctionMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    // invoke is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
        output: "result.json",
      },
      { prompt },
    );

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_FUNCTION_ERROR",
    });

    // The persist call having actually happened (rather than being skipped
    // because the throw fired first) is what proves the ordering: if the
    // implementation threw before persisting, exportSpy would never be
    // called at all.
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("still throws ERR_LAMBDA_OPS_FUNCTION_ERROR when 'output' is unset (nothing to persist)", async () => {
    invokeFunctionMock.mockResolvedValue({
      statusCode: 200,
      functionError: "Unhandled",
    });
    // invoke is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
      },
      { prompt },
    );

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_FUNCTION_ERROR",
    });
  });

  test("does not throw when 'invoke' succeeds without a functionError", async () => {
    invokeFunctionMock.mockResolvedValue({ statusCode: 200 });
    // invoke is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
      },
      { prompt },
    );

    await expect(runLambdaOps(deps)).resolves.toBeUndefined();
  });
});

describe("runLambdaOps — summary log context (statusCode only for 'invoke')", () => {
  test("'invoke's summary log includes statusCode from the result", async () => {
    invokeFunctionMock.mockResolvedValue({ statusCode: 200 });
    // invoke is destructive-gated; see the create test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
      },
      { prompt },
    );
    const stepSpy = vi.spyOn(deps.logger, "step");

    await runLambdaOps(deps);

    const call = stepSpy.mock.calls[0] as [string, Record<string, unknown>?];
    expect(call[1]).toMatchObject({ statusCode: 200 });
  });

  test.each(["list", "describe"] as const)(
    "'%s's summary log has no statusCode key",
    async (operation) => {
      readFunctionsMock.mockResolvedValue({ functions: [] });
      const deps = buildDeps({ operation, functionName: "my-function" });
      const stepSpy = vi.spyOn(deps.logger, "step");

      await runLambdaOps(deps);

      const call = stepSpy.mock.calls[0] as [string, Record<string, unknown>?];
      expect(call[1]).not.toHaveProperty("statusCode");
    },
  );
});

describe("runLambdaOps — malformed/unreadable input-file failure paths", () => {
  test("wraps an unreadable input file's read failure as ERR_LAMBDA_OPS_CONFIG, chaining the raw cause", async () => {
    const cause = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);
    // invoke's gate fires before reading the input file, so a confirming
    // prompt is required to let execution reach the read.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
        input: "payload.json",
      },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runLambdaOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_LAMBDA_OPS_CONFIG");
    expect((thrown as Core.M3LError).cause).toBe(cause);
    expect(invokeFunctionMock).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG ('must be valid JSON') when the input file's content is malformed JSON", async () => {
    const inputPath = PATHS.resolveInput("payload.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    // invoke is destructive-gated and its gate fires before reading the input
    // file; see the test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
        input: "payload.json",
      },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runLambdaOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_LAMBDA_OPS_CONFIG");
    expect((thrown as Core.M3LError).message).toContain("must be valid JSON");
    expect(invokeFunctionMock).not.toHaveBeenCalled();
  });

  test("F10: malformed JSON parse failure does not chain the raw SyntaxError as cause", async () => {
    const inputPath = PATHS.resolveInput("payload.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    // invoke is destructive-gated; see the test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "invoke",
        functionName: "my-function",
        input: "payload.json",
      },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runLambdaOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).cause).toBeUndefined();
    expect((thrown as Core.M3LError).message).toMatch(
      /must be valid JSON \(\w+Error\)/,
    );
    expect(invokeFunctionMock).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG ('contains an unsafe key') when the parsed input has a top-level __proto__ key", async () => {
    const inputPath = PATHS.resolveInput("def.json");
    stubReadFileByPath({
      [inputPath]: '{"__proto__":{"polluted":true}}',
    });
    // update-configuration is destructive-gated; see the test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "update-configuration",
        functionName: "my-function",
        input: "def.json",
      },
      { prompt },
    );

    await expect(runLambdaOps(deps)).rejects.toMatchObject({
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG ('must decode to a JSON object') when the parsed input is a JSON array", async () => {
    const inputPath = PATHS.resolveInput("def.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify([1, 2, 3]) });
    // update-configuration is destructive-gated; see the test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "update-configuration",
        functionName: "my-function",
        input: "def.json",
      },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runLambdaOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_LAMBDA_OPS_CONFIG");
    expect((thrown as Core.M3LError).message).toContain(
      "must decode to a JSON object",
    );
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });

  test("throws ERR_LAMBDA_OPS_CONFIG ('must decode to a JSON object') when the parsed input is a JSON primitive", async () => {
    const inputPath = PATHS.resolveInput("def.json");
    stubReadFileByPath({ [inputPath]: "42" });
    // update-configuration is destructive-gated; see the test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "update-configuration",
        functionName: "my-function",
        input: "def.json",
      },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runLambdaOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_LAMBDA_OPS_CONFIG");
    expect((thrown as Core.M3LError).message).toContain(
      "must decode to a JSON object",
    );
    expect(writeFunctionMock).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("runLambdaOps resolves void", () => {
    expectTypeOf(runLambdaOps).returns.toEqualTypeOf<Promise<void>>();
  });
});
