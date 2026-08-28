/**
 * Tests for `src/lifecycle/shutdown.ts`'s X4 slice 6 round 3b addition: the
 * `M3LShutdownDrainable` port and `runShutdownSequence`'s (via
 * `createShutdown`) concurrent run-drain wiring. No dedicated unit-test file
 * for `lifecycle/shutdown.ts` existed before this round — `tests/main.test.ts`
 * and `tests/main-store.test.ts` only exercise `createShutdown` indirectly
 * through `startConsole`'s `running.shutdown()`, and both files sit near
 * their `check:file-budget` ceiling — so this file unit-tests the port and
 * `createShutdown` directly against hand-built fakes, mirroring
 * `tests/main.test.ts`'s `FakeServer`/`setOnCloseCalled` pattern.
 *
 * RED until `lifecycle/shutdown.ts` exports `M3LShutdownDrainable`, widens
 * `M3LShutdownRuntime` with an optional `runs` field, and
 * `runShutdownSequence` starts the run drain alongside the HTTP drain.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createShutdown } from "../src/lifecycle/shutdown.js";
import type {
  M3LShutdownDisposable,
  M3LShutdownDrainable,
  M3LShutdownRuntime,
} from "../src/lifecycle/shutdown.js";
import type {
  M3LDrainController,
  M3LDrainOutcome,
} from "../src/lifecycle/drain.js";
import type { M3LListeningServer } from "../src/lifecycle/http-server.js";
import type { M3LConsoleRuntime } from "../src/main.js";
import type { M3LRunSubsystem } from "../src/runs/composition.js";

/** A stub, never-resolving `M3LDrainOutcome` fixture for controllable fakes. */
const DRAIN_OUTCOME: M3LDrainOutcome = {
  graceful: true,
  abandoned: 0,
  durationMs: 0,
};

/**
 * A controllable fake `M3LDrainController` whose `drain()` records every
 * call into `calls` and does not settle until `resolve()` is invoked —
 * lets a test observe exactly when `drain()` was CALLED versus when it
 * SETTLED, which is what distinguishes "started concurrently" from "ran
 * sequentially after".
 */
function createControllableDrainController(): {
  readonly controller: M3LDrainController;
  readonly calls: number;
  resolve: () => void;
} {
  const state = { calls: 0 };
  let resolveFn: ((outcome: M3LDrainOutcome) => void) | undefined;
  const controller: M3LDrainController = {
    signal: new AbortController().signal,
    state: "serving",
    inFlight: 0,
    track: () => () => undefined,
    drain: () => {
      state.calls += 1;
      return new Promise<M3LDrainOutcome>((resolve) => {
        resolveFn = resolve;
      });
    },
  };
  return {
    controller,
    get calls() {
      return state.calls;
    },
    resolve: () => {
      resolveFn?.(DRAIN_OUTCOME);
    },
  };
}

/** A controllable fake `M3LListeningServer` whose `close()` does not settle until `resolve()` is invoked. */
function createControllableServer(): {
  readonly server: M3LListeningServer;
  readonly calls: number;
  resolve: () => void;
} {
  const state = { calls: 0 };
  let resolveFn: (() => void) | undefined;
  const server: M3LListeningServer = {
    host: "127.0.0.1",
    port: 48651,
    close: () => {
      state.calls += 1;
      return new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
    },
  };
  return {
    server,
    get calls() {
      return state.calls;
    },
    resolve: () => {
      resolveFn?.();
    },
  };
}

/** A controllable fake `M3LShutdownDrainable` whose `drain()` does not settle until `resolve()` is invoked. */
function createControllableDrainable(): {
  readonly drainable: M3LShutdownDrainable;
  readonly calls: number;
  resolve: () => void;
} {
  const state = { calls: 0 };
  let resolveFn: (() => void) | undefined;
  const drainable: M3LShutdownDrainable = {
    drain: () => {
      state.calls += 1;
      return new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
    },
  };
  return {
    drainable,
    get calls() {
      return state.calls;
    },
    resolve: () => {
      resolveFn?.();
    },
  };
}

/** A recording `M3LShutdownDisposable` fake — counts `close()` calls. */
function createRecordingDisposable(): {
  readonly disposable: M3LShutdownDisposable;
  readonly closeCallCount: number;
} {
  const state = { closeCalls: 0 };
  return {
    disposable: {
      close: () => {
        state.closeCalls += 1;
      },
    },
    get closeCallCount() {
      return state.closeCalls;
    },
  };
}

describe("createShutdown — runs.drain() is invoked when runtime.runs is supplied", () => {
  test("the run drain is called exactly once by the time the shutdown sequence settles", async () => {
    const httpDrain = createControllableDrainController();
    const server = createControllableServer();
    const runsDrain = createControllableDrainable();
    const { disposable } = createRecordingDisposable();
    const runtime: M3LShutdownRuntime = {
      drain: httpDrain.controller,
      logger: new Core.M3LLogger([]),
      runs: runsDrain.drainable,
    };

    const shutdown = createShutdown(
      runtime,
      server.server,
      disposable,
      () => undefined,
      () => undefined,
    );
    const settled = shutdown();
    httpDrain.resolve();
    server.resolve();
    runsDrain.resolve();
    await settled;

    expect(runsDrain.calls).toBe(1);
  });
});

describe("createShutdown — the run drain starts CONCURRENTLY with the HTTP drain, not after it settles", () => {
  test("runs.drain() has already been called before the HTTP drain's own promise settles", async () => {
    const httpDrain = createControllableDrainController();
    const server = createControllableServer();
    const runsDrain = createControllableDrainable();
    const { disposable } = createRecordingDisposable();
    const runtime: M3LShutdownRuntime = {
      drain: httpDrain.controller,
      logger: new Core.M3LLogger([]),
      runs: runsDrain.drainable,
    };

    const shutdown = createShutdown(
      runtime,
      server.server,
      disposable,
      () => undefined,
      () => undefined,
    );
    const settled = shutdown();

    // Nothing has been awaited yet — `runShutdownSequence`'s synchronous
    // portion (every `.drain()`/`.close()` call) has already run to
    // completion by this point. If the implementation instead awaited the
    // HTTP drain before ever calling `runs.drain()` (a sequential ordering
    // that would leave a run outliving the drain window — the exact
    // ECONNRESET-for-watchers failure this design avoids), `runsDrain.calls`
    // would still be `0` here, since the HTTP drain never resolves without
    // an explicit `httpDrain.resolve()` call.
    expect(runsDrain.calls).toBe(1);
    expect(httpDrain.calls).toBe(1);
    expect(server.calls).toBe(1);

    httpDrain.resolve();
    server.resolve();
    runsDrain.resolve();
    await settled;
  });
});

describe("createShutdown — the disposable closes only after all three (HTTP drain, listener close, run drain) settle", () => {
  test("close() is not called while the run drain is still pending, even after the HTTP drain and listener close have both resolved", async () => {
    const httpDrain = createControllableDrainController();
    const server = createControllableServer();
    const runsDrain = createControllableDrainable();
    // NOT destructured: `closeCallCount` is a getter, so keeping the object
    // reference (rather than pulling the getter's snapshot value out via
    // destructuring) is what lets later assertions observe subsequent calls.
    const recordingDisposable = createRecordingDisposable();
    const runtime: M3LShutdownRuntime = {
      drain: httpDrain.controller,
      logger: new Core.M3LLogger([]),
      runs: runsDrain.drainable,
    };

    const shutdown = createShutdown(
      runtime,
      server.server,
      recordingDisposable.disposable,
      () => undefined,
      () => undefined,
    );
    const settled = shutdown();

    httpDrain.resolve();
    server.resolve();
    // Flush the microtask queue several times so any promise chain that
    // depends only on the HTTP drain and the listener close (and not on the
    // still-pending run drain) has every opportunity to run.
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }
    expect(recordingDisposable.closeCallCount).toBe(0);

    runsDrain.resolve();
    await settled;
    expect(recordingDisposable.closeCallCount).toBe(1);
  });
});

describe("createShutdown — runtime.runs absent (the common case today) still works unchanged", () => {
  test("close() runs once both the HTTP drain and the listener close settle, with no runs field supplied", async () => {
    const httpDrain = createControllableDrainController();
    const server = createControllableServer();
    // See the sibling test above for why this is not destructured.
    const recordingDisposable = createRecordingDisposable();
    const runtime: M3LShutdownRuntime = {
      drain: httpDrain.controller,
      logger: new Core.M3LLogger([]),
    };

    const shutdown = createShutdown(
      runtime,
      server.server,
      recordingDisposable.disposable,
      () => undefined,
      () => undefined,
    );
    const settled = shutdown();

    httpDrain.resolve();
    server.resolve();
    const outcome = await settled;

    expect(recordingDisposable.closeCallCount).toBe(1);
    expect(outcome).toEqual(DRAIN_OUTCOME);
  });
});

describe("createShutdown — type conformance", () => {
  test("M3LConsoleRuntime structurally satisfies M3LShutdownRuntime, including the new optional 'runs' field", () => {
    expectTypeOf<M3LConsoleRuntime>().toExtend<M3LShutdownRuntime>();
    // Forces `M3LConsoleRuntime` to actually declare `runs` (rather than
    // merely happening to satisfy `M3LShutdownRuntime` because `runs` is
    // optional there too) — this is the RED-driving assertion for
    // `main.ts`'s own widening, pinned here because it is this file's
    // `M3LShutdownRuntime.runs` field the widening exists to satisfy.
    expectTypeOf<M3LConsoleRuntime["runs"]>().toEqualTypeOf<
      M3LRunSubsystem | undefined
    >();
  });

  test("M3LRunSubsystem structurally satisfies M3LShutdownDrainable without either module importing the other", () => {
    expectTypeOf<M3LRunSubsystem>().toExtend<M3LShutdownDrainable>();
  });
});
