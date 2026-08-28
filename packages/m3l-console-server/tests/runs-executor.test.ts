/**
 * Tests for src/runs/executor.ts — the two `M3LRunExecutor` ports
 * (m3l-console-server X4 run-executors contract): `createSpawnExecutor`
 * spawns a script's `dist/main.js` as a child process, and
 * `createInProcessExecutor` dynamically imports and invokes a script's
 * opted-in `dist/command.js` in-process. Both map their observed result onto
 * `M3LSpawnExitInfo`.
 *
 * RED: `../src/runs/executor.ts` does not exist yet — every import below is
 * expected to fail to resolve until the implementer lands the module.
 */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createInProcessExecutor,
  createSpawnExecutor,
} from "../src/runs/executor.js";
import type { M3LLineSink, M3LRunExecutor } from "../src/runs/executor.js";
import type { M3LSpawnExitInfo } from "../src/runs/outcome.js";

const scriptDir = "/scripts/example";

/**
 * A fake `ChildProcess`: a real `EventEmitter` (satisfies `once`/`off`) with
 * `stdout`/`stderr` as real `PassThrough` streams (so any real readline-based
 * implementation can attach to them) and a spy `kill`.
 */
function createFakeChild(): EventEmitter & {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn<(signal?: string) => boolean>>;
  readonly pid: number;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn<(signal?: string) => boolean>>;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((): boolean => true);
  child.pid = 4321;
  return child;
}

/** Yields to the microtask/macrotask queue so buffered stream writes flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function baseExecuteOptions(
  overrides: Partial<{
    readonly dryRun: boolean;
    readonly signal: AbortSignal;
    readonly onLine: M3LLineSink;
  }> = {},
): {
  scriptDir: string;
  parameters: Record<string, string>;
  dryRun: boolean;
  signal: AbortSignal;
  onLine: M3LLineSink;
} {
  return {
    scriptDir,
    parameters: {},
    dryRun: false,
    signal: new AbortController().signal,
    onLine: vi.fn(),
    ...overrides,
  };
}

describe("createSpawnExecutor — clean exit", () => {
  test("resolves {exitCode: 0, killRequested: false, dryRun: false} when the child exits 0", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(baseExecuteOptions());
    fakeChild.emit("close", 0, null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
  });

  test("resolves with the child's non-zero exit code", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(baseExecuteOptions());
    fakeChild.emit("close", 2, null);

    const info = await resultPromise;
    expect(info.exitCode).toBe(2);
    expect(info.killRequested).toBe(false);
  });

  test("reports killRequested=false when the child exits normally (no abort)", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(baseExecuteOptions());
    fakeChild.emit("close", 0, null);

    const info = await resultPromise;
    expect(info.killRequested).toBe(false);
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });
});

describe("createSpawnExecutor — argv (--dry-run flag)", () => {
  test("passes --dry-run when dryRun is true", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(
      baseExecuteOptions({ dryRun: true }),
    );
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      ["dist/main.js", "--dry-run"],
      expect.objectContaining({ cwd: scriptDir }),
    );
  });

  test("does NOT pass --dry-run when dryRun is false", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(
      baseExecuteOptions({ dryRun: false }),
    );
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      ["dist/main.js"],
      expect.objectContaining({ cwd: scriptDir }),
    );
  });
});

describe("createSpawnExecutor — env (parameters)", () => {
  test("passes parameters as M3L_RUN_PARAMETERS JSON env var merged into process.env", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );
    const resultPromise = executor.execute({
      ...baseExecuteOptions(),
      parameters: { region: "us-east-1", queue: "my-q" },
    });
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      expect.any(Array),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any; safe in test assertions
        env: expect.objectContaining({
          M3L_RUN_PARAMETERS: JSON.stringify({
            region: "us-east-1",
            queue: "my-q",
          }),
        }),
      }),
    );
  });

  test("passes M3L_RUN_PARAMETERS as '{}' when parameters is empty", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );
    const resultPromise = executor.execute(baseExecuteOptions());
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      expect.any(Array),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any; safe in test assertions
        env: expect.objectContaining({ M3L_RUN_PARAMETERS: "{}" }),
      }),
    );
  });
});

describe("createSpawnExecutor — stdout/stderr line piping", () => {
  test("calls onLine for each non-empty stdout line, skipping blank lines", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );
    const onLine = vi.fn();

    const resultPromise = executor.execute(baseExecuteOptions({ onLine }));

    fakeChild.stdout.write("line one\n\nline two\n");
    fakeChild.stdout.end();
    await flush();
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(
      onLine.mock.calls.map((call: readonly unknown[]) => call[0]),
    ).toEqual(["line one", "line two"]);
  });

  test("calls onLine for each non-empty stderr line", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );
    const onLine = vi.fn();

    const resultPromise = executor.execute(baseExecuteOptions({ onLine }));

    fakeChild.stderr.write("uh oh\nsecond problem\n");
    fakeChild.stderr.end();
    await flush();
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(
      onLine.mock.calls.map((call: readonly unknown[]) => call[0]),
    ).toEqual(["uh oh", "second problem"]);
  });
});

describe("createSpawnExecutor — abort (SIGTERM then SIGKILL)", () => {
  test("on abort: sends SIGTERM and reports killRequested=true, exitCode=0 on clean signal death", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );
    const controller = new AbortController();

    const resultPromise = executor.execute(
      baseExecuteOptions({ signal: controller.signal }),
    );

    controller.abort();
    await flush();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    fakeChild.emit("close", null, "SIGTERM");
    const info = await resultPromise;

    expect(info.killRequested).toBe(true);
    expect(info.exitCode).toBe(0);
  });

  test("sends SIGKILL after killTimeoutMs elapses without the child exiting", async () => {
    let scheduled:
      { readonly callback: () => void; readonly delayMs: number } | undefined;
    const timerImpl = vi.fn((callback: () => void, delayMs?: number) => {
      scheduled = { callback, delayMs: delayMs ?? 0 };
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl, timerImpl },
    );
    const controller = new AbortController();

    const resultPromise = executor.execute(
      baseExecuteOptions({ signal: controller.signal }),
    );

    controller.abort();
    await flush();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(timerImpl).toHaveBeenCalledWith(expect.any(Function), 5000);

    if (scheduled === undefined) throw new Error("timerImpl was not scheduled");
    scheduled.callback();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGKILL");

    fakeChild.emit("close", null, "SIGKILL");
    const info = await resultPromise;
    expect(info.killRequested).toBe(true);
  });

  test("sends SIGTERM immediately when signal is already aborted before execute() is called", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE execute() is called

    const resultPromise = executor.execute(
      baseExecuteOptions({ signal: controller.signal }),
    );

    // give the synchronous pre-aborted branch a tick to fire
    await flush();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    fakeChild.emit("close", null, "SIGTERM");
    const info = await resultPromise;
    expect(info.killRequested).toBe(true);
  });

  test("sends SIGKILL after killTimeoutMs elapses when signal is pre-aborted before execute() is called", async () => {
    let scheduled:
      { readonly callback: () => void; readonly delayMs: number } | undefined;
    const timerImpl = vi.fn((callback: () => void, delayMs?: number) => {
      scheduled = { callback, delayMs: delayMs ?? 0 };
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl, timerImpl },
    );
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE execute() is called

    const resultPromise = executor.execute(
      baseExecuteOptions({ signal: controller.signal }),
    );

    // give the synchronous pre-aborted branch a tick to fire
    await flush();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(timerImpl).toHaveBeenCalledWith(expect.any(Function), 5000);

    if (scheduled === undefined) throw new Error("timerImpl was not scheduled");
    scheduled.callback();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGKILL");

    fakeChild.emit("close", null, "SIGKILL");
    const info = await resultPromise;
    expect(info.killRequested).toBe(true);
  });
});

describe("createSpawnExecutor — spawn error event", () => {
  test("propagates a child 'error' event as a thrown error", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(baseExecuteOptions());

    const spawnError = new Error("spawn ENOENT");
    fakeChild.emit("error", spawnError);

    let thrown: unknown;
    try {
      await resultPromise;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("createSpawnExecutor — return type", () => {
  test("returns an M3LRunExecutor", () => {
    const executor = createSpawnExecutor({ killTimeoutMs: 1000 });
    expectTypeOf(executor).toMatchTypeOf<M3LRunExecutor>();
  });
});

/** Builds a minimal, structurally-valid fake `M3LCommandModule` for in-process tests. */
function createFakeCommandModule(
  execute: Core.M3LCommandModule<object>["execute"],
): Core.M3LCommandModule<object> {
  return {
    name: "fake-command",
    version: "1.0.0",
    configParameters: [],
    execute,
  };
}

describe("createInProcessExecutor — outcome mapping", () => {
  test.each<[Core.M3LCommandOutcome, boolean, boolean, M3LSpawnExitInfo]>([
    [
      { status: "success" },
      false,
      false,
      { exitCode: 0, killRequested: false, dryRun: false },
    ],
    [
      { status: "success" },
      true,
      false,
      { exitCode: 0, killRequested: false, dryRun: true },
    ],
    [
      { status: "dry-run" },
      false,
      false,
      { exitCode: 0, killRequested: false, dryRun: true },
    ],
    [
      { status: "interrupted" },
      false,
      true,
      { exitCode: 130, killRequested: true, dryRun: false },
    ],
    [
      { status: "interrupted" },
      false,
      false,
      { exitCode: 130, killRequested: false, dryRun: false },
    ],
    [
      { status: "partial", recovered: 3 },
      false,
      false,
      { exitCode: 2, killRequested: false, dryRun: false },
    ],
    [
      { status: "failure", error: new Error("boom") },
      false,
      false,
      { exitCode: 1, killRequested: false, dryRun: false },
    ],
  ])(
    "maps %o (dryRun=%s, aborted=%s) to %o",
    async (outcome, dryRun, aborted, expected) => {
      const commandModule = createFakeCommandModule(() =>
        Promise.resolve(outcome),
      );
      const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
      const executor = createInProcessExecutor({ importImpl });
      const controller = new AbortController();
      if (aborted) controller.abort();

      const info = await executor.execute(
        baseExecuteOptions({ dryRun, signal: controller.signal }),
      );

      expect(info).toEqual(expected);
    },
  );
});

describe("createInProcessExecutor — output routing", () => {
  test("routes output.info(text) to onLine", async () => {
    const onLine = vi.fn();
    const commandModule = createFakeCommandModule((_parameters, context) => {
      context.output.info("hello from info");
      return Promise.resolve({ status: "success" });
    });
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute(baseExecuteOptions({ onLine }));

    expect(onLine).toHaveBeenCalledWith("hello from info");
  });

  test("routes output.error(text) to onLine", async () => {
    const onLine = vi.fn();
    const commandModule = createFakeCommandModule((_parameters, context) => {
      context.output.error("something went wrong");
      return Promise.resolve({ status: "success" });
    });
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute(baseExecuteOptions({ onLine }));

    expect(onLine).toHaveBeenCalledWith("something went wrong");
  });

  test("routes output.heading(text) to onLine", async () => {
    const onLine = vi.fn();
    const commandModule = createFakeCommandModule((_parameters, context) => {
      context.output.heading("Section");
      return Promise.resolve({ status: "success" });
    });
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute(baseExecuteOptions({ onLine }));

    expect(onLine).toHaveBeenCalledWith("Section");
  });

  test("builds an M3LCommandOutput with colorEnabled: false", async () => {
    const executeSpy = vi.fn(
      (
        _parameters: object,
        _context: Core.M3LCommandContext,
      ): Promise<Core.M3LCommandOutcome> =>
        Promise.resolve({ status: "success" }),
    );
    const commandModule = createFakeCommandModule(executeSpy);
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute(baseExecuteOptions());

    const callArgs = executeSpy.mock.calls[0];
    if (callArgs === undefined) throw new Error("execute was not called");
    const [, context] = callArgs;
    expect(context.output.colorEnabled).toBe(false);
  });
});

describe("createInProcessExecutor — logger and signal wiring", () => {
  test("passes a Core.M3LLogger instance as context.logger", async () => {
    const executeSpy = vi.fn(
      (
        _parameters: object,
        _context: Core.M3LCommandContext,
      ): Promise<Core.M3LCommandOutcome> =>
        Promise.resolve({ status: "success" }),
    );
    const commandModule = createFakeCommandModule(executeSpy);
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute(baseExecuteOptions());

    const callArgs = executeSpy.mock.calls[0];
    if (callArgs === undefined) throw new Error("execute was not called");
    const [, context] = callArgs;
    expect(context.logger).toBeInstanceOf(Core.M3LLogger);
  });

  test("forwards the caller's signal and parameters to execute()", async () => {
    const controller = new AbortController();
    const executeSpy = vi.fn(
      (
        _parameters: object,
        _context: Core.M3LCommandContext,
      ): Promise<Core.M3LCommandOutcome> =>
        Promise.resolve({ status: "success" }),
    );
    const commandModule = createFakeCommandModule(executeSpy);
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute({
      scriptDir,
      parameters: { region: "us-east-1" },
      dryRun: false,
      signal: controller.signal,
      onLine: vi.fn(),
    });

    const callArgs = executeSpy.mock.calls[0];
    if (callArgs === undefined) throw new Error("execute was not called");
    const [parameters, context] = callArgs;
    expect(context.signal).toBe(controller.signal);
    expect(parameters).toEqual({ region: "us-east-1" });
  });
});

describe("createInProcessExecutor — dynamic import specifier", () => {
  test("imports path.join(scriptDir, 'dist/command.js') as the specifier", async () => {
    const commandModule = createFakeCommandModule(
      (): Promise<Core.M3LCommandOutcome> =>
        Promise.resolve({ status: "success" }),
    );
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({ importImpl });

    await executor.execute(baseExecuteOptions());

    expect(importImpl).toHaveBeenCalledWith(join(scriptDir, "dist/command.js"));
  });
});

describe("createInProcessExecutor — invalid command module", () => {
  test.each<[unknown, string]>([
    [{}, "no commandModule export at all"],
    [{ commandModule: { name: "x" } }, "commandModule missing required fields"],
  ])(
    "throws ERR_CONSOLE_INTERNAL when the imported module has %s (%s)",
    async (imported, _description) => {
      const importImpl = vi.fn(() => Promise.resolve(imported));
      const executor = createInProcessExecutor({ importImpl });

      let thrown: unknown;
      try {
        await executor.execute(baseExecuteOptions());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    },
  );
});

describe("createInProcessExecutor — importImpl rejection", () => {
  test("wraps a rejected importImpl as ERR_CONSOLE_INTERNAL with the original error as cause", async () => {
    const loadError = new Error("Cannot find module 'dist/command.js'");
    const importImpl = vi.fn(() => Promise.reject(loadError));
    const executor = createInProcessExecutor({ importImpl });

    let thrown: unknown;
    try {
      await executor.execute(baseExecuteOptions());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect((thrown as M3LConsoleError).cause).toBe(loadError);
  });
});

describe("createInProcessExecutor — return type", () => {
  test("returns an M3LRunExecutor", () => {
    const executor = createInProcessExecutor();
    expectTypeOf(executor).toMatchTypeOf<M3LRunExecutor>();
  });
});

describe("M3LLineSink", () => {
  test("is a function from string to void", () => {
    expectTypeOf<M3LLineSink>().toEqualTypeOf<(line: string) => void>();
  });
});
