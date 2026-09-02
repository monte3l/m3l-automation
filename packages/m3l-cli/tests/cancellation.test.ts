/**
 * Tests for `src/run/cancellation.ts` — `createCancellationScope` (U11,
 * contract A, slice 3).
 *
 * SAFETY INVARIANT — READ BEFORE EDITING:
 * The `killer` seam MUST remain injectable. The second-signal escalation test
 * (contract A item 3) proves that `process.kill` is called on the second
 * signal. If the implementation hard-wires a real `process.kill(process.pid,
 * …)` call and the test uses the real process, it **kills the Vitest worker**,
 * bringing down the entire test run. Keep the `killer` option injectable and
 * keep the tests below injecting a `vi.fn()` spy — never pass a real
 * `process.kill` callback here.
 *
 * RED phase: `src/run/cancellation.ts` does not exist yet — every import
 * below will fail to resolve. That is the expected failure for this phase.
 */

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createCancellationScope } from "../src/run/cancellation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake `process`-like EventEmitter usable as the injectable signal source. */
function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

// ---------------------------------------------------------------------------
// A1 — first signal aborts the AbortSignal, does NOT kill the process
// ---------------------------------------------------------------------------

describe("createCancellationScope — first signal aborts signal (A1)", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s: signal.aborted becomes true and the killer is not called",
    (signal) => {
      const killer = vi.fn();
      const emitter = createFakeProcess();
      const { signal: abortSignal, dispose } = createCancellationScope({
        emitter,
        killer,
      });

      expect(abortSignal.aborted).toBe(false);

      emitter.emit(signal);

      expect(abortSignal.aborted).toBe(true);
      expect(killer).not.toHaveBeenCalled();

      dispose();
    },
  );
});

// ---------------------------------------------------------------------------
// A2 — second signal escalates (calls the killer exactly once)
// ---------------------------------------------------------------------------

describe("createCancellationScope — second signal escalates (A2)", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s then %s: killer is called exactly once on the second signal",
    (signal) => {
      const killer = vi.fn();
      const emitter = createFakeProcess();
      const { signal: abortSignal, dispose } = createCancellationScope({
        emitter,
        killer,
      });

      emitter.emit(signal); // first — aborts
      emitter.emit(signal); // second — escalates

      expect(abortSignal.aborted).toBe(true);
      expect(killer).toHaveBeenCalledTimes(1);

      dispose();
    },
  );

  test("SIGINT then SIGTERM: second signal (different type) still escalates", () => {
    const killer = vi.fn();
    const emitter = createFakeProcess();
    const { dispose } = createCancellationScope({ emitter, killer });

    emitter.emit("SIGINT"); // first
    emitter.emit("SIGTERM"); // second — escalates regardless of signal type

    expect(killer).toHaveBeenCalledTimes(1);

    dispose();
  });

  test("SIGTERM then SIGINT: second signal (different type) still escalates", () => {
    const killer = vi.fn();
    const emitter = createFakeProcess();
    const { dispose } = createCancellationScope({ emitter, killer });

    emitter.emit("SIGTERM"); // first
    emitter.emit("SIGINT"); // second — escalates

    expect(killer).toHaveBeenCalledTimes(1);

    dispose();
  });
});

// ---------------------------------------------------------------------------
// A3 — third+ signal is a no-op after escalation
// ---------------------------------------------------------------------------

describe("createCancellationScope — aborting is one-way (A3)", () => {
  test("a third SIGINT after escalation does not invoke the killer again", () => {
    const killer = vi.fn();
    const emitter = createFakeProcess();
    const { signal: abortSignal, dispose } = createCancellationScope({
      emitter,
      killer,
    });

    emitter.emit("SIGINT"); // first — aborts
    emitter.emit("SIGINT"); // second — escalates

    const countAfterSecond = killer.mock.calls.length; // should be 1

    emitter.emit("SIGINT"); // third — no-op
    emitter.emit("SIGINT"); // fourth — no-op

    expect(abortSignal.aborted).toBe(true);
    expect(killer.mock.calls.length).toBe(countAfterSecond);

    dispose();
  });
});

// ---------------------------------------------------------------------------
// A4 — dispose() removes every listener it registered
//
// MUTATION TEST: if the implementation's dispose() does not call
// emitter.off() (or equivalent), the listenerCount assertions below will
// find listeners still registered and fail. Removing dispose() from the
// implementation's cleanup path is the exact mutation this test catches.
// ---------------------------------------------------------------------------

describe("createCancellationScope — dispose removes listeners (A4)", () => {
  test("dispose() removes SIGINT and SIGTERM listeners from the emitter", () => {
    const emitter = createFakeProcess();
    const { dispose } = createCancellationScope({ emitter });

    // Before dispose: the scope has registered at least one listener per signal
    expect(emitter.listenerCount("SIGINT")).toBeGreaterThan(0);
    expect(emitter.listenerCount("SIGTERM")).toBeGreaterThan(0);

    dispose();

    // MUTATION TEST: removing dispose() from the cleanup path keeps the
    // listeners registered and fails the assertions below.
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });

  test("a signal fired after dispose() does not abort the signal (listeners are gone)", () => {
    const emitter = createFakeProcess();
    const { signal: abortSignal, dispose } = createCancellationScope({
      emitter,
    });

    dispose();

    emitter.emit("SIGINT");

    // Listeners were removed, so the abort controller was never called
    expect(abortSignal.aborted).toBe(false);
  });

  test("a signal fired after dispose() does not invoke the killer (listeners are gone)", () => {
    const killer = vi.fn();
    const emitter = createFakeProcess();
    const { dispose } = createCancellationScope({ emitter, killer });

    dispose();

    emitter.emit("SIGINT");
    emitter.emit("SIGINT");

    expect(killer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A5 — dispose() is idempotent
// ---------------------------------------------------------------------------

describe("createCancellationScope — dispose is idempotent (A5)", () => {
  test("calling dispose() twice does not throw and does not add a negative listener count", () => {
    const emitter = createFakeProcess();
    const { dispose } = createCancellationScope({ emitter });

    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();

    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });

  test("calling dispose() many times does not trip MaxListenersExceededWarning (no listener count goes negative)", () => {
    const emitter = createFakeProcess();
    // Set a low max to make a warning obvious if double-remove adds listeners
    emitter.setMaxListeners(2);
    const { dispose } = createCancellationScope({ emitter });

    expect(() => {
      for (let i = 0; i < 10; i++) {
        dispose();
      }
    }).not.toThrow();

    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Default emitter (process) — contract only; no live SIGINT fired at process
// ---------------------------------------------------------------------------

describe("createCancellationScope — default emitter uses process", () => {
  test("calling createCancellationScope() with no options returns a scope with an unaborted signal", () => {
    // Cannot fire SIGINT at the real process in tests (that would kill the
    // Vitest worker or all sibling tests). We only assert the returned shape
    // and immediately dispose to avoid leaving listeners on process.
    const scope = createCancellationScope();

    expect(scope.signal.aborted).toBe(false);
    expect(typeof scope.dispose).toBe("function");

    scope.dispose(); // clean up real process listeners immediately
  });
});
