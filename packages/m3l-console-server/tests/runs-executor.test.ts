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
import { mapSpawnOutcome } from "../src/runs/outcome.js";
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
    readonly correlationId: string;
    readonly onLine: M3LLineSink;
  }> = {},
): {
  scriptDir: string;
  parameters: Record<string, string>;
  dryRun: boolean;
  signal: AbortSignal;
  correlationId: string;
  onLine: M3LLineSink;
} {
  return {
    scriptDir,
    parameters: {},
    dryRun: false,
    signal: new AbortController().signal,
    correlationId: "corr-base",
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

describe("createSpawnExecutor — env (correlation)", () => {
  // MIRRORED LITERAL GUARD. `m3l-common`'s
  // `internal/script/correlationId.ts` READS `M3L_CORRELATION_ID` as the
  // tier below an explicit option — that is what makes a spawned run join
  // the launching request's trace. This asserts the exact spelling, so a
  // rename on either side fails here instead of silently breaking
  // correlation across the process boundary. Its twin lives in
  // `m3l-common`'s `tests/script-correlation.test.ts`.
  test("passes the run's correlation id as M3L_CORRELATION_ID", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute({
      ...baseExecuteOptions(),
      correlationId: "corr-spawned",
    });
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      expect.any(Array),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any; safe in test assertions
        env: expect.objectContaining({ M3L_CORRELATION_ID: "corr-spawned" }),
      }),
    );
  });

  test("sets M3L_CORRELATION_ID alongside M3L_RUN_PARAMETERS, not instead of it", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute({
      ...baseExecuteOptions(),
      parameters: { region: "eu-west-1" },
      correlationId: "corr-both",
    });
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "node",
      expect.any(Array),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any; safe in test assertions
        env: expect.objectContaining({
          M3L_CORRELATION_ID: "corr-both",
          M3L_RUN_PARAMETERS: JSON.stringify({ region: "eu-west-1" }),
        }),
      }),
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
  // NOTE: each `expected` below carries an `outcome` field equal to the
  // command's own reported `status` — a sweep required by the fix under
  // test (M3LSpawnExitInfo gains an optional `outcome`, and the in-process
  // executor sets it from `M3LCommandOutcome.status` for every status, not
  // just "interrupted"/"partial"). Before the fix, `expected` here carried
  // no `outcome` key at all; see the row below flagged "regression guard"
  // for the specific PR #721 review finding this corrects.
  test.each<[Core.M3LCommandOutcome, boolean, boolean, M3LSpawnExitInfo]>([
    [
      { status: "success" },
      false,
      false,
      { exitCode: 0, killRequested: false, dryRun: false, outcome: "success" },
    ],
    [
      { status: "success" },
      true,
      false,
      { exitCode: 0, killRequested: false, dryRun: true, outcome: "success" },
    ],
    [
      { status: "dry-run" },
      false,
      false,
      { exitCode: 0, killRequested: false, dryRun: true, outcome: "dry-run" },
    ],
    [
      { status: "interrupted" },
      false,
      true,
      {
        exitCode: 130,
        killRequested: true,
        dryRun: false,
        outcome: "interrupted",
      },
    ],
    // Regression guard (PR #721 review): a hosted command self-reports
    // "interrupted" without the caller's signal being aborted
    // (killRequested: false). Before the fix, `expected` here had NO
    // `outcome` key — it only asserted the raw, information-losing exit
    // info {exitCode: 130, killRequested: false, dryRun: false}, which
    // `mapSpawnOutcome` then degrades to "failure" (see
    // runs-executor-outcome round-trip test below). The corrected
    // expectation adds `outcome: "interrupted"` so the fidelity survives
    // the round trip.
    [
      { status: "interrupted" },
      false,
      false,
      {
        exitCode: 130,
        killRequested: false,
        dryRun: false,
        outcome: "interrupted",
      },
    ],
    [
      { status: "partial", recovered: 3 },
      false,
      false,
      { exitCode: 2, killRequested: false, dryRun: false, outcome: "partial" },
    ],
    [
      { status: "failure", error: new Error("boom") },
      false,
      false,
      { exitCode: 1, killRequested: false, dryRun: false, outcome: "failure" },
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

describe("createInProcessExecutor — outcome field fidelity (PR #721 regression)", () => {
  // Enumerates all five `Core.M3LCommandOutcome` statuses (not a sample):
  // asserts both that the in-process executor sets `M3LSpawnExitInfo.outcome`
  // to the command's own status, AND that piping the returned exit info back
  // through `mapSpawnOutcome` reproduces that same status — the round-trip
  // fidelity the defect broke for "interrupted"/"partial" specifically.
  test.each<Core.M3LCommandOutcome>([
    { status: "success" },
    { status: "dry-run" },
    { status: "interrupted" },
    { status: "partial", recovered: 3 },
    { status: "failure", error: new Error("boom") },
  ])(
    "sets outcome to the command's own status %o, and mapSpawnOutcome round-trips it",
    async (outcome) => {
      const commandModule = createFakeCommandModule(() =>
        Promise.resolve(outcome),
      );
      const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
      const executor = createInProcessExecutor({ importImpl });

      const info = await executor.execute(baseExecuteOptions());

      expect(info.outcome).toBe(outcome.status);
      expect(mapSpawnOutcome(info)).toBe(outcome.status);
    },
  );
});

describe("createSpawnExecutor — does not set outcome (regression guard)", () => {
  test("a spawned process's exit info has no explicit outcome — mapSpawnOutcome keeps deriving from exit codes", async () => {
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const executor = createSpawnExecutor(
      { killTimeoutMs: 5000 },
      { spawnImpl },
    );

    const resultPromise = executor.execute(baseExecuteOptions());
    fakeChild.emit("close", 0, null);
    const info = await resultPromise;

    expect(info.outcome).toBeUndefined();
    expect(mapSpawnOutcome(info)).toBe("success");
  });

  // Extends the guard above rather than replacing it: a clean, unsignaled
  // exit (signal === null on the "close" event) must leave `outcome` absent
  // regardless of the exit code, so mapSpawnOutcome's own exit-code
  // derivation rules (not the signal-driven branch under test elsewhere in
  // this file) are what decide "success" vs "failure".
  test.each<[number, Core.M3LRunOutcome]>([
    [0, "success"],
    [1, "failure"],
  ])(
    "a clean exit(%i, null) with no signal leaves outcome undefined and maps to %s",
    async (exitCode, expectedOutcome) => {
      const fakeChild = createFakeChild();
      const spawnImpl = vi.fn(() => fakeChild);
      const executor = createSpawnExecutor(
        { killTimeoutMs: 5000 },
        { spawnImpl },
      );

      const resultPromise = executor.execute(baseExecuteOptions());
      fakeChild.emit("close", exitCode, null);
      const info = await resultPromise;

      expect(info.outcome).toBeUndefined();
      expect(mapSpawnOutcome(info)).toBe(expectedOutcome);
    },
  );
});

describe("createSpawnExecutor — externally-initiated signal kill (PR #721 regression)", () => {
  // PR #721 re-review defect: `awaitSpawnedChild`'s "close" listener declared
  // the Node child-process signature `(code: number | null, signal: string |
  // null)` but only bound `code`, discarding `signal` entirely and collapsing
  // a null exit code to 0. Node emits close(null, "SIGKILL") when a child
  // dies from an externally-initiated signal (kernel OOM, operator `kill`, a
  // supervisor's own SIGTERM) that this executor never requested — before
  // the fix, that case resolved as {exitCode: 0, killRequested: false},
  // which `mapSpawnOutcome` maps to "success": a killed run recorded as
  // successful. The fix must report `outcome: "interrupted"` whenever a
  // signal is present, and must NOT flip `killRequested` to true merely
  // because a signal arrived — only an actual abort() from this executor's
  // own signal may set that flag honestly.
  //
  // NOTE: the existing fake child already supports emitting a second "close"
  // argument (see the abort describe block above, e.g.
  // `fakeChild.emit("close", null, "SIGTERM")` for a self-requested kill) —
  // so no fake changes were needed to reproduce this. What was missing is
  // that no existing test asserted anything about `outcome` for a
  // signal-closed child with NO abort requested; every existing signal-close
  // assertion pairs the signal with `killRequested: true` because the test
  // itself called `controller.abort()` first.
  test.each(["SIGKILL", "SIGTERM", "SIGABRT"])(
    "a child closed by an unrequested %s reports outcome: 'interrupted', and mapSpawnOutcome agrees",
    async (signal) => {
      const fakeChild = createFakeChild();
      const spawnImpl = vi.fn(() => fakeChild);
      const executor = createSpawnExecutor(
        { killTimeoutMs: 5000 },
        { spawnImpl },
      );

      // No controller.abort() anywhere in this test: the executor never
      // asked for this kill.
      const resultPromise = executor.execute(baseExecuteOptions());
      fakeChild.emit("close", null, signal);
      const info = await resultPromise;

      expect(info.outcome).toBe("interrupted");
      expect(mapSpawnOutcome(info)).toBe("interrupted");
    },
  );

  test.each(["SIGKILL", "SIGTERM", "SIGABRT"])(
    "a child closed by an unrequested %s does NOT set killRequested: true",
    async (signal) => {
      const fakeChild = createFakeChild();
      const spawnImpl = vi.fn(() => fakeChild);
      const executor = createSpawnExecutor(
        { killTimeoutMs: 5000 },
        { spawnImpl },
      );

      const resultPromise = executor.execute(baseExecuteOptions());
      fakeChild.emit("close", null, signal);
      const info = await resultPromise;

      // Guards against "fixing" the defect by lying on this field: no abort
      // was requested by this executor, so killRequested must stay false
      // even though the process did, in fact, die from a signal.
      expect(info.killRequested).toBe(false);
    },
  );

  test("when this executor DID request the kill, a signal-closed child still reports killRequested: true and outcome: 'interrupted'", async () => {
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
    expect(info.outcome).toBe("interrupted");
    expect(mapSpawnOutcome(info)).toBe("interrupted");
  });
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

  test("forwards the run's correlation id onto the command context", async () => {
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

    await executor.execute(
      baseExecuteOptions({ correlationId: "corr-in-process" }),
    );

    const callArgs = executeSpy.mock.calls[0];
    if (callArgs === undefined) throw new Error("execute was not called");
    const [, context] = callArgs;
    expect(context.correlationId).toBe("corr-in-process");
  });

  // The SECOND channel, and a separate assertion on purpose: the context
  // half tells the command its id, the logger half stamps every event the
  // run emits. Seeding only one of them still loses half the trail.
  test("seeds the run's logger with the same correlation id", async () => {
    // `M3LLogger` surfaces its correlation id only on dispatched events, so
    // the assertion goes through an injected handler and the command's own
    // use of `context.logger`. The seeding under test is the production
    // constructor call, not anything this test supplies.
    const events: Core.M3LLogEvent[] = [];
    const handler: Core.M3LLoggerHandler = {
      handle: (event) => {
        events.push(event);
      },
      reset: () => {
        events.length = 0;
      },
    };
    const commandModule = createFakeCommandModule(
      (
        _parameters: object,
        context: Core.M3LCommandContext,
      ): Promise<Core.M3LCommandOutcome> => {
        context.logger.info("a line the run logged");
        return Promise.resolve({ status: "success" });
      },
    );
    const importImpl = vi.fn(() => Promise.resolve({ commandModule }));
    const executor = createInProcessExecutor({
      importImpl,
      logHandlers: [handler],
    });

    await executor.execute(
      baseExecuteOptions({ correlationId: "corr-for-the-logger" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.correlationId).toBe("corr-for-the-logger");
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
      correlationId: "corr-inline",
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
