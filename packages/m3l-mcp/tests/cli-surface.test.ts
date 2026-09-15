/**
 * Tests for `src/cli/surface.ts` (V10c2b contract, "File 4") — the argv
 * table plus invocation that V10c3's `tools/health.ts` calls. Every test
 * injects `runProcess` through `CreateM3LMcpCliSurfaceDeps`; the real
 * `runCliProcess` (which would spawn a real child process) is never called.
 *
 * The single most important behavioral assertion in this file: `m3l doctor`
 * exit codes `0` AND `1` are BOTH success — a failing health check is the
 * answer this tool returns, not a tool-level error. A naive implementation
 * that treats any non-zero exit as failure passes every other test here and
 * still gets this one wrong, so it is asserted on its own with an explicit
 * "does not throw" plus the parsed value.
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as CliProcessModule from "../src/cli/process.js";

// Mocked only so the "runProcess default" test below can observe that
// `createM3LMcpCliSurface`'s default seam IS `runCliProcess` — via a fake
// that never spawns a real process — without disturbing any other test in
// this file, which all inject their own `runProcess` fake and never reach
// the default.
vi.mock("../src/cli/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CliProcessModule>()),
  runCliProcess: vi.fn(),
}));

import {
  runCliProcess,
  type CliRunDisposition,
  type CliRunResult,
  type RunCliProcessOptions,
} from "../src/cli/process.js";
import type { M3LMcpSettings } from "../src/config/settings.js";
import { M3LMcpError } from "../src/errors/mcp-error.js";
import type { M3LMcpDoctorCheck } from "../src/cli/envelopes.js";
import type {
  CreateM3LMcpCliSurfaceDeps,
  M3LMcpCliSurface,
} from "../src/cli/surface.js";
import { createM3LMcpCliSurface } from "../src/cli/surface.js";

/**
 * Two distinct sentinel absolute paths. `ENTRYPOINT_SENTINEL` stands in for
 * the settings' `cliEntrypoint`; `STDERR_SENTINEL` stands in for a child's
 * raw stderr text. Every failure test that constructs a `CliRunResult` or
 * `M3LMcpSettings` by hand plants one or both of these, then asserts the
 * thrown error's `message` contains NEITHER — this text can reach a model
 * verbatim in slice V10c3.
 */
const ENTRYPOINT_SENTINEL = "/home/someone/secret/entrypoint-4c1a";
const STDERR_SENTINEL = "/home/someone/secret/leak-9f2a";

/**
 * Stands in for a secret embedded directly in the CLI's raw `stdout` text.
 * `parseDoctorOutput`'s two `OUTPUT_NOT_PARSEABLE` throws are the only paths
 * in this module that ever touch `stdout` content (every other throw here
 * only ever sees `exitCode`/`disposition`/`stderr`), so a leak here would
 * migrate specifically through `context.reason` or `context.value`, not
 * through the `stderr`-shaped sentinel above.
 */
const STDOUT_SENTINEL = "/home/someone/secret/stdout-leak-3d7c";

/**
 * Stands in for the message of a value a rejecting `runProcess` settles
 * with. `invokeDoctor` catches this at an untyped boundary (a rejected
 * promise, which may resolve to anything), so it must never appear in the
 * thrown `M3LMcpError`'s fixed message or in `toJSON()`'s output — only via
 * the chained `cause`, which is deliberate (see the "a rejecting
 * runProcess" describe block below).
 */
const RUN_PROCESS_REJECTION_SENTINEL = "/home/someone/secret/run-process-6a1f";

/**
 * Serializes a caught error the same way a real client would see it over the
 * wire — `message`, `context`, and the full chained-`cause` tree in one
 * string. A non-leak assertion that only checks `error.message` cannot catch
 * detail migrating into `context` or a chained `cause`; matches the pattern
 * in `tests/settings.test.ts` and `tests/cli-process.test.ts`.
 */
function serialize(error: M3LMcpError): string {
  return JSON.stringify(error.toJSON());
}

function buildSettings(
  overrides: Partial<M3LMcpSettings> = {},
): M3LMcpSettings {
  return {
    nodeExecPath: "/usr/bin/node",
    cliEntrypoint: ENTRYPOINT_SENTINEL,
    cwd: "/repo/packages/m3l-cli/bin",
    cliTimeoutMs: 30_000,
    maxOutputBytes: 1_048_576,
    ...overrides,
  };
}

const DOCTOR_CHECKS_JSON = JSON.stringify([
  { name: "node-version", status: "ok", detail: "Node 24 detected" },
]);

function buildExitedResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "exited",
    exitCode: 0,
    stdout: DOCTOR_CHECKS_JSON,
    stderr: "",
    failureCode: undefined,
    ...overrides,
  };
}

/**
 * Builds a `runProcess` fake that resolves to a fixed `CliRunResult`,
 * regardless of what it is called with — every test asserts the
 * `RunCliProcessOptions` it was CALLED with separately, via
 * `runProcess.mock.calls`. Never `async`: the fake does no awaiting of its
 * own, so wrapping the fixed result in `Promise.resolve` keeps the type
 * (`Promise<CliRunResult>`) without an empty `async` body.
 */
function fakeRunProcess(
  result: CliRunResult,
): ReturnType<
  typeof vi.fn<(options: RunCliProcessOptions) => Promise<CliRunResult>>
> {
  return vi.fn<(options: RunCliProcessOptions) => Promise<CliRunResult>>(() =>
    Promise.resolve(result),
  );
}

/**
 * Builds a `runProcess` fake that REJECTS with a fixed value, regardless of
 * what it is called with — the counterpart to {@link fakeRunProcess} for
 * exercising `invokeDoctor`'s handling of a rejecting seam. `rejection` is
 * typed `unknown`, not `Error`, because a bare `catch` at this boundary can
 * receive anything a caller's `runProcess` implementation settles with.
 */
function fakeRejectingRunProcess(
  rejection: unknown,
): ReturnType<
  typeof vi.fn<(options: RunCliProcessOptions) => Promise<CliRunResult>>
> {
  return vi.fn<(options: RunCliProcessOptions) => Promise<CliRunResult>>(() =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately rejecting with a non-Error-typed value to prove invokeDoctor's catch boundary normalizes ANY caught value, not only genuine Errors
    Promise.reject(rejection),
  );
}

describe("createM3LMcpCliSurface().doctor() — argv and options threading", () => {
  test("invokes runProcess with argv exactly ['doctor', '--json']", async () => {
    const settings = buildSettings();
    const runProcess = fakeRunProcess(buildExitedResult());
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    await surface.doctor();

    expect(runProcess).toHaveBeenCalledTimes(1);
    const options = runProcess.mock.calls[0]?.[0];
    expect(options?.args).toEqual(["doctor", "--json"]);
  });

  test("threads the settings' nodeExecPath, cliEntrypoint, cwd, cliTimeoutMs (as timeoutMs), and maxOutputBytes", async () => {
    const settings = buildSettings({
      nodeExecPath: "/opt/node/bin/node",
      cwd: "/repo/packages/m3l-cli/bin",
      cliTimeoutMs: 12_345,
      maxOutputBytes: 999_999,
    });
    const runProcess = fakeRunProcess(buildExitedResult());
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    await surface.doctor();

    const options = runProcess.mock.calls[0]?.[0];
    expect(options?.nodeExecPath).toBe(settings.nodeExecPath);
    expect(options?.entrypoint).toBe(settings.cliEntrypoint);
    expect(options?.cwd).toBe(settings.cwd);
    expect(options?.timeoutMs).toBe(settings.cliTimeoutMs);
    expect(options?.maxOutputBytes).toBe(settings.maxOutputBytes);
  });
});

describe("createM3LMcpCliSurface().doctor() — exit policy: 0 and 1 are BOTH success", () => {
  test("exit 0 resolves without throwing and returns the parsed checks", async () => {
    const settings = buildSettings();
    const runProcess = fakeRunProcess(buildExitedResult({ exitCode: 0 }));
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    const checks = await surface.doctor();

    expect(checks).toEqual([
      { name: "node-version", status: "ok", detail: "Node 24 detected" },
    ]);
  });

  test("exit 1 (a failing health check) resolves without throwing and returns the parsed checks — a failing check is the ANSWER, not a tool error", async () => {
    const settings = buildSettings();
    const failingChecksJson = JSON.stringify([
      { name: "node-version", status: "fail", detail: "Node 18 detected" },
    ]);
    const runProcess = fakeRunProcess(
      buildExitedResult({ exitCode: 1, stdout: failingChecksJson }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    await expect(surface.doctor()).resolves.toEqual([
      { name: "node-version", status: "fail", detail: "Node 18 detected" },
    ]);
  });
});

describe("createM3LMcpCliSurface().doctor() — exit codes beyond the {0,1} policy raise ERR_MCP_CLI", () => {
  test.each([[2], [3], [127]])(
    "exit code %i raises M3LMcpError('ERR_MCP_CLI')",
    async (exitCode) => {
      const settings = buildSettings();
      const runProcess = fakeRunProcess(buildExitedResult({ exitCode }));
      const surface = createM3LMcpCliSurface({ settings, runProcess });

      let thrown: unknown;
      try {
        await surface.doctor();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LMcpError);
      expect((thrown as M3LMcpError).code).toBe("ERR_MCP_CLI");
    },
  );

  test("exit 2's thrown message contains neither the entrypoint path nor the child's stderr text", async () => {
    const settings = buildSettings({ cliEntrypoint: ENTRYPOINT_SENTINEL });
    const runProcess = fakeRunProcess(
      buildExitedResult({ exitCode: 2, stderr: STDERR_SENTINEL }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const serialized = serialize(thrown as M3LMcpError);
    expect(serialized).not.toContain(ENTRYPOINT_SENTINEL);
    expect(serialized).not.toContain(STDERR_SENTINEL);
  });
});

describe("createM3LMcpCliSurface().doctor() — every non-'exited' disposition raises ERR_MCP_CLI", () => {
  test.each<CliRunDisposition>([
    "spawn-failed",
    "timed-out",
    "aborted",
    "signalled",
    "output-truncated",
    "stream-failed",
  ])(
    "disposition '%s' raises M3LMcpError('ERR_MCP_CLI')",
    async (disposition) => {
      const settings = buildSettings();
      const runProcess = fakeRunProcess(
        buildExitedResult({ disposition, exitCode: null, stdout: "" }),
      );
      const surface = createM3LMcpCliSurface({ settings, runProcess });

      let thrown: unknown;
      try {
        await surface.doctor();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LMcpError);
      expect((thrown as M3LMcpError).code).toBe("ERR_MCP_CLI");
    },
  );

  test("a 'timed-out' disposition's thrown message contains neither the entrypoint path nor the child's stderr text", async () => {
    const settings = buildSettings({ cliEntrypoint: ENTRYPOINT_SENTINEL });
    const runProcess = fakeRunProcess(
      buildExitedResult({
        disposition: "timed-out",
        exitCode: null,
        stdout: "",
        stderr: STDERR_SENTINEL,
      }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const serialized = serialize(thrown as M3LMcpError);
    expect(serialized).not.toContain(ENTRYPOINT_SENTINEL);
    expect(serialized).not.toContain(STDERR_SENTINEL);
  });
});

describe("createM3LMcpCliSurface().doctor() — a parse failure raises ERR_MCP_CLI", () => {
  test("well-formed exit-0 CliRunResult whose stdout is not valid doctor JSON raises", async () => {
    const settings = buildSettings();
    const runProcess = fakeRunProcess(
      buildExitedResult({ exitCode: 0, stdout: "not valid json at all" }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LMcpError);
    expect((thrown as M3LMcpError).code).toBe("ERR_MCP_CLI");
  });

  test("well-formed exit-1 CliRunResult whose stdout is a JSON object, not an array, raises", async () => {
    const settings = buildSettings();
    const runProcess = fakeRunProcess(
      buildExitedResult({ exitCode: 1, stdout: JSON.stringify({}) }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    await expect(surface.doctor()).rejects.toBeInstanceOf(M3LMcpError);
  });

  // Mirrors the exit-2 / 'timed-out' leak-regression tests above. Unlike
  // every other throw in this module, `parseDoctorOutput`'s two
  // `OUTPUT_NOT_PARSEABLE` throws are the only paths that ever touch the
  // CLI's real stdout content, making them the likeliest place for a future
  // leak — this is a regression guard (verified by reading
  // `parseDoctorOutput`/`envelopes.ts`: every failure reason is already a
  // fixed enum token, never a fragment of the input), not a bug fix.
  test("stdout that is not valid JSON at all: thrown message contains neither the entrypoint path nor a secret embedded in the malformed stdout", async () => {
    const settings = buildSettings({ cliEntrypoint: ENTRYPOINT_SENTINEL });
    const runProcess = fakeRunProcess(
      buildExitedResult({
        exitCode: 0,
        stdout: `not valid json ${STDOUT_SENTINEL}`,
      }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const serialized = serialize(thrown as M3LMcpError);
    expect(serialized).not.toContain(ENTRYPOINT_SENTINEL);
    expect(serialized).not.toContain(STDOUT_SENTINEL);
  });

  test("stdout that is well-formed JSON but the wrong shape: thrown message contains neither the entrypoint path nor a secret embedded in the malformed stdout", async () => {
    const settings = buildSettings({ cliEntrypoint: ENTRYPOINT_SENTINEL });
    const runProcess = fakeRunProcess(
      buildExitedResult({
        exitCode: 1,
        stdout: JSON.stringify({ leaked: STDOUT_SENTINEL }),
      }),
    );
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const serialized = serialize(thrown as M3LMcpError);
    expect(serialized).not.toContain(ENTRYPOINT_SENTINEL);
    expect(serialized).not.toContain(STDOUT_SENTINEL);
  });
});

describe("createM3LMcpCliSurface().doctor() — a rejecting runProcess raises ERR_MCP_CLI, never the raw rejection", () => {
  // FINDING 1: `invokeDoctor` wraps `await runProcess(...)` in a try/catch
  // that normalizes ANY caught value — an `Error`, a primitive, or a
  // null-prototype object — into `M3LMcpError("ERR_MCP_CLI", ...)`. The
  // three tests below pin that invariant: the fixed module-level message
  // never carries a fragment of the caught value (checked in both
  // `mcpError.message` and `mcpError.toJSON()`), while the caught value
  // itself is still chained as `cause` — never dropped, never leaked
  // outside `cause`.
  test("an Error rejection surfaces as M3LMcpError('ERR_MCP_CLI') whose fixed message carries no fragment of the caught error's message, and whose cause is the original error", async () => {
    const settings = buildSettings();
    const rejection = new Error(RUN_PROCESS_REJECTION_SENTINEL);
    const runProcess = fakeRejectingRunProcess(rejection);
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const mcpError = thrown as M3LMcpError;
    expect(mcpError.code).toBe("ERR_MCP_CLI");

    // The thrown message is always a fixed module constant — asserted
    // directly (not via the file's `serialize` helper) because this
    // specific invariant is about `message` alone: a naive fix that does
    // `` `...: ${cause.message}` `` would fail exactly this line while
    // still passing an assertion scoped to `context`.
    expect(mcpError.message).not.toContain(RUN_PROCESS_REJECTION_SENTINEL);

    // `Core.M3LError#toJSON` collapses a foreign (non-`M3LError`) cause to
    // `{ name }` only — assert that collapse actually holds for THIS error,
    // checked separately from `message` above since `context` could smuggle
    // the same fragment `message` never would.
    expect(JSON.stringify(mcpError.toJSON())).not.toContain(
      RUN_PROCESS_REJECTION_SENTINEL,
    );

    // Chaining the caught error as `cause` is deliberate and safe here:
    // `packages/m3l-mcp/bin/m3l-mcp.mjs` is the only place that ever prints
    // a caught error to a stream, and it prints `error.message` alone —
    // explicitly never a chained `cause` or a stack.
    expect(mcpError.cause).toBe(rejection);
  });

  test("a non-Error primitive rejection surfaces as M3LMcpError('ERR_MCP_CLI') with the same containment, and the primitive is still chained as cause", async () => {
    const settings = buildSettings();
    // A bare `catch` may receive a primitive, not only an `Error` — this
    // proves invokeDoctor's fix normalizes ANY caught value, not just ones
    // shaped like an `Error`.
    const rejection: unknown = RUN_PROCESS_REJECTION_SENTINEL;
    const runProcess = fakeRejectingRunProcess(rejection);
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const mcpError = thrown as M3LMcpError;
    expect(mcpError.code).toBe("ERR_MCP_CLI");
    expect(mcpError.message).not.toContain(RUN_PROCESS_REJECTION_SENTINEL);
    expect(JSON.stringify(mcpError.toJSON())).not.toContain(
      RUN_PROCESS_REJECTION_SENTINEL,
    );
    expect(mcpError.cause).toBe(rejection);
  });

  test("a null-prototype object rejection surfaces as M3LMcpError('ERR_MCP_CLI') with the same containment, and the object is still chained as cause", async () => {
    const settings = buildSettings();
    // A null-prototype object has no `Error.prototype` in its chain, so it
    // is neither a genuine `M3LError` nor a foreign `Error` from
    // `resolveCauseForJSON`'s point of view — it takes the
    // `deriveForeignCauseName` branch, which reads only a safely-derived
    // constructor name, never `.message`.
    const rejection: unknown = Object.assign(Object.create(null) as object, {
      message: RUN_PROCESS_REJECTION_SENTINEL,
    });
    const runProcess = fakeRejectingRunProcess(rejection);
    const surface = createM3LMcpCliSurface({ settings, runProcess });

    let thrown: unknown;
    try {
      await surface.doctor();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const mcpError = thrown as M3LMcpError;
    expect(mcpError.code).toBe("ERR_MCP_CLI");
    expect(mcpError.message).not.toContain(RUN_PROCESS_REJECTION_SENTINEL);
    expect(JSON.stringify(mcpError.toJSON())).not.toContain(
      RUN_PROCESS_REJECTION_SENTINEL,
    );
    expect(mcpError.cause).toBe(rejection);
  });
});

describe("createM3LMcpCliSurface() — runProcess default", () => {
  afterEach(() => {
    vi.mocked(runCliProcess).mockReset();
  });

  test("defaults runProcess to runCliProcess: constructing without it still routes doctor() through the mocked seam", async () => {
    // `../src/cli/process.js` is mocked at the top of this file, so this
    // exercises the REAL default-selection code path (`deps.runProcess ??
    // runCliProcess`) without ever spawning a real child process — the
    // mocked `runCliProcess` stands in for it.
    const settings = buildSettings();
    vi.mocked(runCliProcess).mockResolvedValue(buildExitedResult());
    const surface = createM3LMcpCliSurface({ settings });

    const checks = await surface.doctor();

    expect(runCliProcess).toHaveBeenCalledTimes(1);
    expect(checks).toEqual([
      { name: "node-version", status: "ok", detail: "Node 24 detected" },
    ]);
  });
});

describe("M3LMcpCliSurface / CreateM3LMcpCliSurfaceDeps (type level)", () => {
  test("M3LMcpCliSurface has exactly the documented doctor() method", () => {
    expectTypeOf<M3LMcpCliSurface>().toEqualTypeOf<{
      doctor(): Promise<readonly M3LMcpDoctorCheck[]>;
    }>();
  });

  test("CreateM3LMcpCliSurfaceDeps requires settings and an optional runProcess", () => {
    expectTypeOf<CreateM3LMcpCliSurfaceDeps>().toEqualTypeOf<{
      readonly settings: M3LMcpSettings;
      readonly runProcess?: (
        options: RunCliProcessOptions,
      ) => Promise<CliRunResult>;
    }>();
  });
});
