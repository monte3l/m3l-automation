/**
 * Tests for src/lifecycle/drain.ts — `createDrainController` (m3l-console-server
 * lifecycle contract). `src/lifecycle/drain.ts` does not exist yet; this suite
 * is RED until the drain-controller implementation lands.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createDrainController } from "../src/lifecycle/drain.js";
import type { M3LDrainOutcome } from "../src/lifecycle/drain.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `fn`, captures any thrown value, and asserts it is an `M3LConsoleError` with `code`. */
function expectConsoleError(
  fn: () => unknown,
  code: M3LConsoleError["code"],
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LConsoleError);
  expect((thrown as M3LConsoleError).code).toBe(code);
}

describe("createDrainController — construction validation", () => {
  // Node coerces a setTimeout delay above 2_147_483_647 (its max 32-bit
  // signed timer bound) to 1ms and warns — so an unbounded/oversized drain
  // timeout would silently become an instant kill, the exact inverse of what
  // the caller asked for. `config/env.ts` bounding the env-sourced value does
  // not protect a programmatic caller of `createDrainController` directly, so
  // this constructor-level bound is not redundant with that one.
  test.each<[number]>([[0], [-5], [1.5], [Number.NaN], [2_147_483_648]])(
    "rejects an invalid timeoutMs of %s with ERR_CONSOLE_CONFIG_INVALID",
    (timeoutMs) => {
      expectConsoleError(
        () => createDrainController({ timeoutMs }),
        "ERR_CONSOLE_CONFIG_INVALID",
      );
    },
  );

  test("accepts the boundary timeoutMs of 2147483647 (Node's max 32-bit signed timer delay)", () => {
    expect(() =>
      createDrainController({ timeoutMs: 2_147_483_647 }),
    ).not.toThrow();
  });
});

describe("createDrainController — tracking in-flight work", () => {
  test("a fresh controller starts serving, with nothing in flight and an unaborted signal", () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    expect(controller.state).toBe("serving");
    expect(controller.inFlight).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  test("track() increments inFlight and its release fn decrements it", () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    const release = controller.track();
    expect(controller.inFlight).toBe(1);

    release();
    expect(controller.inFlight).toBe(0);
  });

  test("the release fn returned by track() is idempotent — a second call does not double-decrement", () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    const release = controller.track();
    expect(controller.inFlight).toBe(1);

    release();
    expect(controller.inFlight).toBe(0);

    // A double-decrement would drive inFlight negative and could resolve a
    // drain early while tracked work is still running.
    release();
    expect(controller.inFlight).toBe(0);
  });

  test("track() throws ERR_CONSOLE_UNAVAILABLE while draining", () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    void controller.drain();
    expect(controller.state).toBe("draining");

    expectConsoleError(() => controller.track(), "ERR_CONSOLE_UNAVAILABLE");
  });

  test("track() throws ERR_CONSOLE_UNAVAILABLE once drained", async () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    await controller.drain();
    expect(controller.state).toBe("drained");

    expectConsoleError(() => controller.track(), "ERR_CONSOLE_UNAVAILABLE");
  });
});

describe("createDrainController — draining", () => {
  test("drain() aborts signal before it starts waiting on the deadline", () => {
    const controller = createDrainController({ timeoutMs: 5_000 });
    let abortedDuringCall = false;
    controller.signal.addEventListener("abort", () => {
      abortedDuringCall = true;
    });

    // Deliberately not awaited: tracked work must observe cancellation
    // synchronously-or-immediately, before the deadline timer even starts.
    void controller.drain();

    expect(abortedDuringCall).toBe(true);
  });

  test("resolves promptly with nothing in flight", async () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    const outcome = await controller.drain();

    expect(outcome.graceful).toBe(true);
    expect(outcome.abandoned).toBe(0);
  });

  test("resolves graceful when in-flight work releases before the deadline", async () => {
    vi.useFakeTimers();
    const controller = createDrainController({ timeoutMs: 5_000 });

    const release = controller.track();
    const drainPromise = controller.drain();
    release();
    await vi.advanceTimersByTimeAsync(0);

    const outcome = await drainPromise;
    expect(outcome.graceful).toBe(true);
    expect(outcome.abandoned).toBe(0);
  });

  test("resolves ungraceful, without throwing, when in-flight work never releases", async () => {
    vi.useFakeTimers();
    const controller = createDrainController({ timeoutMs: 1_000 });

    controller.track();
    controller.track();
    const drainPromise = controller.drain();
    await vi.advanceTimersByTimeAsync(1_000);

    const outcome = await drainPromise;
    expect(outcome.graceful).toBe(false);
    expect(outcome.abandoned).toBe(2);
  });

  test("state transitions to draining then drained on the graceful path", async () => {
    const controller = createDrainController({ timeoutMs: 5_000 });

    const release = controller.track();
    const drainPromise = controller.drain();
    expect(controller.state).toBe("draining");

    release();
    await drainPromise;
    expect(controller.state).toBe("drained");
  });

  test("state transitions to draining then drained on the timed-out path", async () => {
    vi.useFakeTimers();
    const controller = createDrainController({ timeoutMs: 1_000 });

    controller.track();
    const drainPromise = controller.drain();
    expect(controller.state).toBe("draining");

    await vi.advanceTimersByTimeAsync(1_000);
    await drainPromise;
    expect(controller.state).toBe("drained");
  });

  test("drain() is idempotent — a second call returns the same outcome without starting a new timer", async () => {
    vi.useFakeTimers();
    const controller = createDrainController({ timeoutMs: 1_000 });

    controller.track();
    const firstPromise = controller.drain();
    const timerCountAfterFirst = vi.getTimerCount();

    const secondPromise = controller.drain();
    const timerCountAfterSecond = vi.getTimerCount();
    expect(timerCountAfterSecond).toBe(timerCountAfterFirst);

    await vi.advanceTimersByTimeAsync(1_000);
    const [firstOutcome, secondOutcome]: [M3LDrainOutcome, M3LDrainOutcome] =
      await Promise.all([firstPromise, secondPromise]);

    expect(secondOutcome).toEqual(firstOutcome);
  });

  test("durationMs is derived from the injected now, not the wall clock", async () => {
    vi.useFakeTimers();
    let current = 0;
    const controller = createDrainController({
      timeoutMs: 5_000,
      now: () => current,
    });

    controller.track();
    const drainPromise = controller.drain();
    // Simulate 250ms of injected-clock elapsed while 5000ms of fake-timer
    // (deadline) time passes below — durationMs must track the former.
    current = 250;
    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await drainPromise;
    expect(outcome.durationMs).toBe(250);
  });
});
