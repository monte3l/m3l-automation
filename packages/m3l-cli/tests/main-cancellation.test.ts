import { afterEach, describe, expect, test, vi } from "vitest";

import { runCli } from "../src/main.js";
import type { M3LCliRunOptions } from "../src/main.js";
import { M3LCliError } from "../src/cli/errors.js";
import { runList } from "../src/commands/list.js";
import { runRun } from "../src/commands/run.js";
import { resolveWorkspaceRoot } from "../src/discovery/discover.js";
import { createCancellationScope } from "../src/run/cancellation.js";

/**
 * Contract: `src/main.ts` — `runCli` installs a parent-survival cancellation
 * scope (U11 SF-2, ADR-0049) at the top of every dispatch. The scope
 * suppresses Node's default SIGINT/SIGTERM kill so teardown (history
 * recording, envelope emission, flow run records) can complete. `dispose()`
 * must be called in a `finally` — not just in the `try` — so listeners are
 * always removed after the dispatch settles, preventing accumulation across
 * repeated `runCli` calls.
 */

vi.mock("../src/commands/list.js", () => ({ runList: vi.fn() }));
vi.mock("../src/commands/run.js", () => ({ runRun: vi.fn() }));
vi.mock("../src/discovery/discover.js", () => ({
  resolveWorkspaceRoot: vi.fn(),
}));
vi.mock("../src/run/cancellation.js", () => ({
  createCancellationScope: vi.fn(),
}));

const runListMock = vi.mocked(runList);
const runRunMock = vi.mocked(runRun);
const resolveWorkspaceRootMock = vi.mocked(resolveWorkspaceRoot);
const createCancellationScopeMock = vi.mocked(createCancellationScope);

// Provide a safe default so every runCli call has a usable scope.
// Individual tests that need to inspect the scope override this with their
// own disposeSpy / controller.
createCancellationScopeMock.mockReturnValue({
  signal: new AbortController().signal,
  dispose: vi.fn(),
});

afterEach(() => {
  runListMock.mockReset();
  runRunMock.mockReset();
  resolveWorkspaceRootMock.mockReset();
  createCancellationScopeMock.mockReset();
  // Restore the safe default after every reset.
  createCancellationScopeMock.mockReturnValue({
    signal: new AbortController().signal,
    dispose: vi.fn(),
  });
});

function buildOptions(): M3LCliRunOptions {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
    env: {},
    cwd: "/workspace",
  };
}

// U11 SF-2: runCli installs the parent-survival scope (cancellation.ts).
//
// The scope's only purpose is survival: registering any SIGINT/SIGTERM
// listener suppresses Node's default kill, so teardown (history recording,
// envelope emission, flow run records) can complete before the process exits.
// dispose() is called in a `finally` so listeners never accumulate across
// repeated runCli calls (e.g. in tests). ADR-0049.
describe("runCli — parent-survival cancellation scope (U11 SF-2)", () => {
  test("installs a cancellation scope exactly once per runCli invocation", async () => {
    runListMock.mockResolvedValue(0);
    const disposeSpy = vi.fn();
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: disposeSpy,
    });

    await runCli(["list"], buildOptions());

    expect(createCancellationScopeMock).toHaveBeenCalledTimes(1);
  });

  test("dispose() is called after a normal dispatch resolves (MUTATION TEST baseline)", async () => {
    // MUTATION TEST baseline: without `finally { scope.dispose() }` this
    // fails on the happy path. The throw-path test below is the discriminating
    // case that proves `finally` rather than an end-of-try placement.
    runListMock.mockResolvedValue(0);
    const disposeSpy = vi.fn();
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: disposeSpy,
    });

    await runCli(["list"], buildOptions());

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("dispose() is called even when dispatch throws and runCli takes its reportError path (MUTATION TEST discriminating)", async () => {
    // MUTATION TEST: removing `finally { scope.dispose() }` from runCli and
    // placing dispose() only inside the `try` block means it is NOT called
    // when dispatch throws (the catch path is taken instead). This assertion
    // therefore FAILS under that mutation — proving the `finally` is wired.
    //
    // Pre-fix proof: the pre-fix code had `scope.dispose()` only in the `try`
    // block. Under that code, this test FAILS because `dispose()` is skipped
    // when the catch branch runs. The moment `finally { scope.dispose() }` is
    // introduced, the test becomes green — confirming the guard is wired.
    runListMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_UNKNOWN_SCRIPT", "boom"),
    );
    const disposeSpy = vi.fn();
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: disposeSpy,
    });

    // runCli never throws — it maps errors to exit codes via reportError.
    const code = await runCli(["list"], buildOptions());

    expect(code).not.toBe(0);
    // dispose() must still have been called (finally, not try-only).
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("scope covers teardown: dispose() is called AFTER dispatch resolves, not before (SF-2 ordering guard)", async () => {
    // The whole point of SF-2 is that dispatch (including history recording,
    // envelope emission, and flow run records) completes while the scope is
    // still active. dispose() must happen in `finally`, which runs only after
    // `await dispatch(...)` settles. This test pins that ordering.
    const callOrder: string[] = [];

    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockImplementation(() => {
      // Simulate: history write happens here, inside dispatch.
      callOrder.push("dispatch-and-teardown");
      return Promise.resolve(0);
    });
    const disposeSpy = vi.fn().mockImplementation(() => {
      callOrder.push("dispose");
    });
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: disposeSpy,
    });

    await runCli(["run", "my-script"], buildOptions());

    expect(callOrder).toEqual(["dispatch-and-teardown", "dispose"]);
    expect(callOrder.indexOf("dispatch-and-teardown")).toBeLessThan(
      callOrder.indexOf("dispose"),
    );
  });
});
