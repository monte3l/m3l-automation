/**
 * Tests for core/polling submodule (RED phase — module not yet implemented).
 *
 * Contract source: docs/reference/core/polling.md plus two hub-ratified
 * decisions for this change set:
 *   1. Exhaustion / failure / retry-exhaustion error classes are INTERNAL
 *      (unexported). They are thrown as M3LError subclass instances but are not
 *      importable, so those paths assert `instanceof M3LError` + a truthy
 *      `.code`, never a specific exported subclass name. Public export count is
 *      exactly 13.
 *   2. httpRetryAfterClassifier: 429 + transient 5xx (500/502/503/504) →
 *      "retriable"; recognizable non-retriable HTTP status (400/404) → "fatal";
 *      foreign / non-HTTP error → "unknown"; when the error carries
 *      retryAfterMs → { decision: "retriable", delayMs: retryAfterMs }.
 *
 * Exports under test (13 VALUE exports): M3LPoller, M3LRetryRunner,
 *   M3LBackoff, M3LPollingPolicies (classes); M3LPollCheckFn, M3LPollDecision,
 *   M3LRetryClassifier, M3LRetryDecision, M3LRetryAdvice (types);
 *   combineClassifiers (fn); awsThrottlingClassifier, awsNetworkClassifier,
 *   httpRetryAfterClassifier (consts). The module also surfaces type-only
 *   telemetry exports (the poller/retry event maps and their 11 payload
 *   types) — these are excluded from the 13-value count above.
 *
 * Latitude honoured (implementer decides internal shape):
 *   - M3LPollCheckFn tolerates async OR sync checks.
 *   - Backoff strategy object shape is opaque; only assert it constructs.
 *   - Poller bound field name is NOT hard-coded; exhaustion is driven by
 *     repeated `continue` decisions with fake timers until the poll rejects.
 *     Where a bound must be passed, `maxAttempts` is used as an ASSUMPTION to
 *     verify against the implementation.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";
import type { M3LPollerOptions } from "../src/core/polling/M3LPoller.js";
import type { M3LRetryRunnerOptions } from "../src/core/polling/M3LRetryRunner.js";
// `M3LPollFailureError` is internal (private to `core/polling`, no barrel
// export — see the file banner above), so it is imported directly from its
// path, mirroring the existing precedent in `tests/script.test.ts` and
// `tests/prompt.test.ts` for whitebox-covering an internal helper the public
// surface cannot fully reach. Its optional `context` constructor param is
// never exercised by `M3LPoller`'s own two call sites (neither passes one),
// so both constructor branches are covered directly here instead of relying
// on the public API to happen to reach them.
import { delay } from "../src/internal/polling/delay.js";
import { M3LPollFailureError } from "../src/internal/polling/errors.js";
import {
  awsNetworkClassifier,
  awsThrottlingClassifier,
  combineClassifiers,
  httpRetryAfterClassifier,
  M3LBackoff,
  M3LPoller,
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../src/core/polling/index.js";
import type {
  M3LPollAttemptPayload,
  M3LPollCheckFn,
  M3LPollDecision,
  M3LPollerEventMap,
  M3LPollExhaustedPayload,
  M3LPollSuccessPayload,
  M3LPollWaitPayload,
  M3LRetryAdvice,
  M3LRetryAttemptPayload,
  M3LRetryClassifier,
  M3LRetryDecision,
  M3LRetryEventMap,
  M3LRetryExhaustedPayload,
  M3LRetryFatalPayload,
  M3LRetryScheduledPayload,
  M3LRetrySuccessPayload,
} from "../src/core/polling/index.js";

/**
 * Drive a promise to settlement while flushing all pending timers, so backoff
 * delays resolve without real wall-clock waits. Loops advancing fake timers
 * until the promise settles (poll/retry loops schedule the next timer only
 * after the current one fires, so a single advance is not enough).
 */
async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  // Capture the settlement synchronously so the rejection is never left
  // dangling while we advance timers. `Promise.allSettled` attaches its own
  // handler eagerly, so V8 never flags an unhandled rejection during the loop.
  const settledOutcome = Promise.allSettled([promise]).then((results) => {
    settled = true;
    return results[0];
  });
  // Guard against an infinite loop if the primitive never terminates.
  for (let i = 0; i < 1000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  const outcome = await settledOutcome;
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

describe("core/polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("type-level contract", () => {
    test("M3LPollDecision is a discriminated union with the documented members", () => {
      expectTypeOf<M3LPollDecision<number>>().toEqualTypeOf<
        | { type: "success"; value: number }
        | { type: "failure" }
        | { type: "continue" }
      >();
    });

    test("M3LRetryDecision is the literal union", () => {
      expectTypeOf<M3LRetryDecision>().toEqualTypeOf<
        "retriable" | "fatal" | "unknown"
      >();
    });

    test("M3LRetryAdvice is a discriminated union; delayMs lives only on the retriable arm", () => {
      // Every arm carries a `decision`, and together they cover M3LRetryDecision.
      expectTypeOf<M3LRetryAdvice>().toExtend<{
        decision: M3LRetryDecision;
      }>();
      expectTypeOf<
        M3LRetryAdvice["decision"]
      >().toEqualTypeOf<M3LRetryDecision>();

      // Only the "retriable" arm exposes an optional server-driven delayMs.
      expectTypeOf<
        Extract<M3LRetryAdvice, { decision: "retriable" }>["delayMs"]
      >().toEqualTypeOf<number | undefined>();

      // The fatal/unknown arm has no delayMs key at all.
      expectTypeOf<
        Extract<M3LRetryAdvice, { decision: "fatal" | "unknown" }>
      >().not.toHaveProperty("delayMs");
    });

    test("M3LRetryClassifier maps unknown to a decision or advice", () => {
      expectTypeOf<M3LRetryClassifier>().toEqualTypeOf<
        (err: unknown) => M3LRetryDecision | M3LRetryAdvice
      >();
    });

    test("M3LPollCheckFn returns a decision or a promise of one", () => {
      // Sync and async checks both satisfy the type.
      expectTypeOf<() => M3LPollDecision<string>>().toExtend<
        M3LPollCheckFn<string>
      >();
      expectTypeOf<() => Promise<M3LPollDecision<string>>>().toExtend<
        M3LPollCheckFn<string>
      >();
    });

    test("M3LPoller.poll resolves Promise<T>; M3LRetryRunner.run resolves Promise<T>", () => {
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(1),
      });
      const runner = new M3LRetryRunner({
        classifier: awsThrottlingClassifier,
      });
      // Invoke the methods (never awaited — type-level only) so the reference is
      // bound, avoiding @typescript-eslint/unbound-method on a bare method ref.
      const pollResult = poller.poll<number>(() => ({
        type: "success",
        value: 1,
      }));
      const runResult = runner.run<number>(() => Promise.resolve(1));
      expectTypeOf(pollResult).toEqualTypeOf<Promise<number>>();
      expectTypeOf(runResult).toEqualTypeOf<Promise<number>>();
      // Attach handlers so these live promises never dangle as unhandled.
      void pollResult.catch(() => undefined);
      void runResult.catch(() => undefined);
    });
  });

  describe("M3LBackoff strategies construct both primitives", () => {
    test.each([
      ["exponential", () => M3LBackoff.exponential(100, 5_000)],
      ["exponentialJittered", () => M3LBackoff.exponentialJittered(100, 5_000)],
      ["constant", () => M3LBackoff.constant(100)],
    ])("%s is accepted by both M3LPoller and M3LRetryRunner", (_name, make) => {
      const backoff = make();
      expect(() => new M3LPoller({ backoff })).not.toThrow();
      expect(
        () =>
          new M3LRetryRunner({
            classifier: awsThrottlingClassifier,
            backoff,
          }),
      ).not.toThrow();
    });
  });

  describe("M3LBackoff delay schedules (driven through M3LPoller)", () => {
    /**
     * The delay argument of every `setTimeout` scheduled during the poll loop,
     * in order. `internal/polling/delay` calls the global `setTimeout(fn, ms)`
     * once per `continue` decision, so `call[1]` is the computed backoff delay.
     */
    const captureDelays = (calls: readonly (readonly unknown[])[]): number[] =>
      calls.map((call) => (typeof call[1] === "number" ? call[1] : 0));

    test("exponential grows as min(capMs, startMs * 2 ** attempt), attempt 0-based", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      // start=100, cap=5_000 → schedule: 100, 200, 400, 800, 1600, 3200, then
      // capped at 5000. Drive 8 `continue` waits then succeed.
      const poller = new M3LPoller({
        backoff: M3LBackoff.exponential(100, 5_000),
        maxAttempts: 20,
      });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls += 1;
        if (calls <= 8) return { type: "continue" };
        return { type: "success", value: "ok" };
      };

      await expect(settleWithTimers(poller.poll(check))).resolves.toBe("ok");

      const delays = captureDelays(setTimeoutSpy.mock.calls);
      expect(delays).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000]);
    });

    test("exponentialJittered stays within [startMs, capMs] and follows the decorrelated seed with Math.random pinned", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      // start=100, cap=5_000, random=0.5:
      //  wait 0: prev=undefined→100; candidate = 100 + 0.5*(100*3 - 100) = 200
      //  wait 1: prev=200;          candidate = 100 + 0.5*(600 - 100)   = 350
      //  wait 2: prev=350;          candidate = 100 + 0.5*(1050 - 100)  = 575
      const poller = new M3LPoller({
        backoff: M3LBackoff.exponentialJittered(100, 5_000),
        maxAttempts: 20,
      });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls += 1;
        if (calls <= 3) return { type: "continue" };
        return { type: "success", value: "ok" };
      };

      await expect(settleWithTimers(poller.poll(check))).resolves.toBe("ok");

      const delays = captureDelays(setTimeoutSpy.mock.calls);
      expect(delays).toEqual([200, 350, 575]);
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(100);
        expect(d).toBeLessThanOrEqual(5_000);
      }
    });

    test("exponentialJittered is capped at capMs even as the seed grows", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      // random=1 pushes candidate to the upper bound (prev*3) each step, so it
      // saturates at the cap quickly. Assert every wait respects the cap.
      const poller = new M3LPoller({
        backoff: M3LBackoff.exponentialJittered(100, 500),
        maxAttempts: 20,
      });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls += 1;
        if (calls <= 5) return { type: "continue" };
        return { type: "success", value: "ok" };
      };

      await expect(settleWithTimers(poller.poll(check))).resolves.toBe("ok");

      const delays = captureDelays(setTimeoutSpy.mock.calls);
      expect(delays).toHaveLength(5);
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(100);
        expect(d).toBeLessThanOrEqual(500);
      }
      // Later waits should be pinned at the cap once the seed exceeds it.
      expect(delays.at(-1)).toBe(500);
    });
  });

  describe("M3LBackoff invalid-option guards reject non-positive/non-finite values", () => {
    const makers: readonly [string, (v: number) => unknown][] = [
      ["exponential(startMs)", (v) => M3LBackoff.exponential(v, 5_000)],
      ["exponential(capMs)", (v) => M3LBackoff.exponential(100, v)],
      [
        "exponentialJittered(startMs)",
        (v) => M3LBackoff.exponentialJittered(v, 5_000),
      ],
      [
        "exponentialJittered(capMs)",
        (v) => M3LBackoff.exponentialJittered(100, v),
      ],
      ["constant(delayMs)", (v) => M3LBackoff.constant(v)],
    ];

    for (const [label, make] of makers) {
      test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        `${label} throws an M3LError for %d`,
        (value) => {
          let thrown: unknown;
          try {
            make(value);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(M3LError);
          expect((thrown as M3LError).code).toBeTruthy();
        },
      );
    }
  });

  describe("constructor maxAttempts guard rejects non-positive-integer bounds", () => {
    test.each([0, -1, 1.5, Number.NaN])(
      "new M3LPoller({ maxAttempts: %d }) throws an M3LError",
      (maxAttempts) => {
        let thrown: unknown;
        try {
          new M3LPoller({ backoff: M3LBackoff.constant(10), maxAttempts });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBeTruthy();
      },
    );

    test.each([0, -1, 1.5, Number.NaN])(
      "new M3LRetryRunner({ maxAttempts: %d }) throws an M3LError",
      (maxAttempts) => {
        let thrown: unknown;
        try {
          new M3LRetryRunner({
            classifier: awsThrottlingClassifier,
            maxAttempts,
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBeTruthy();
      },
    );
  });

  describe("M3LPoller poll decisions (B5)", () => {
    test("success resolves with the provided value", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
      const check: M3LPollCheckFn<string> = () => ({
        type: "success",
        value: "done",
      });
      await expect(settleWithTimers(poller.poll(check))).resolves.toBe("done");
    });

    test("failure rejects with an M3LError carrying a truthy code (internal class)", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
      const check: M3LPollCheckFn<string> = () => ({ type: "failure" });

      let thrown: unknown;
      try {
        await settleWithTimers(poller.poll(check));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBeTruthy();
    });

    test("continue loops until a terminal decision resolves the value", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
      let calls = 0;
      const check: M3LPollCheckFn<number> = () => {
        calls += 1;
        if (calls < 3) return { type: "continue" };
        return { type: "success", value: calls };
      };
      await expect(settleWithTimers(poller.poll(check))).resolves.toBe(3);
    });

    test("async checks are supported", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
      const check: M3LPollCheckFn<string> = () =>
        Promise.resolve({ type: "success", value: "async" });
      await expect(settleWithTimers(poller.poll(check))).resolves.toBe("async");
    });

    test("exhausting the bound while still 'continue' rejects with an M3LError", async () => {
      // ASSUMPTION: the poll bound is named `maxAttempts`. Verify against impl;
      // if the field differs, the construction narrows the loop another way.
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 3,
      });
      const check: M3LPollCheckFn<number> = () => ({ type: "continue" });

      let thrown: unknown;
      try {
        await settleWithTimers(poller.poll(check));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBeTruthy();
    });

    test("maxAttempts:1 exhausts on the very first 'continue' without ever backing off", async () => {
      // Boundary: the smallest legal bound. The single attempt must still run
      // (the check IS invoked once) but any 'continue' decision exhausts
      // immediately — there is no second attempt to wait for.
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 1,
      });
      let calls = 0;
      const check: M3LPollCheckFn<number> = () => {
        calls += 1;
        return { type: "continue" };
      };

      let thrown: unknown;
      try {
        await settleWithTimers(poller.poll(check));
      } catch (error) {
        thrown = error;
      }
      expect(calls).toBe(1);
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
      expect((thrown as M3LError).message).toContain("1 attempts");
      expect((thrown as M3LError).context).toEqual({ attempts: 1 });
    });

    test("an unrecognized decision.type at runtime is rejected by the exhaustiveness guard, not silently accepted", async () => {
      // TypeScript's M3LPollDecision union cannot express this at the type
      // level, so the invalid decision is smuggled in via an
      // unknown-mediated cast on the whole check fn (matching the repo's
      // established pattern for exercising a runtime exhaustiveness guard —
      // see json.test.ts's "ERR_JSON_DETECT_DEPTH" bogus-depth case).
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
      const bogusCheck = (() => ({
        type: "retry-later",
      })) as unknown as M3LPollCheckFn<number>;

      let thrown: unknown;
      try {
        await settleWithTimers(poller.poll(bogusCheck));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_FAILURE");
      expect((thrown as M3LError).message).toContain("unhandled poll decision");
    });
  });

  describe("M3LRetryRunner", () => {
    test("resolves the operation result when it succeeds first try", async () => {
      const runner = new M3LRetryRunner({
        classifier: awsThrottlingClassifier,
        backoff: M3LBackoff.constant(10),
      });
      await expect(
        settleWithTimers(runner.run(() => Promise.resolve(42))),
      ).resolves.toBe(42);
    });

    test("constructs with only a classifier (backoff optional with a default)", () => {
      expect(
        () => new M3LRetryRunner({ classifier: awsThrottlingClassifier }),
      ).not.toThrow();
    });

    test("retriable errors are re-run after backoff until success", async () => {
      // Classifier always says retriable; op fails twice then succeeds.
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
      });
      let attempts = 0;
      const op = (): Promise<string> => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error("transient"));
        return Promise.resolve("ok");
      };
      await expect(settleWithTimers(runner.run(op))).resolves.toBe("ok");
      expect(attempts).toBe(3);
    });

    test("fatal decision propagates the ORIGINAL thrown error unchanged", async () => {
      const classifier: M3LRetryClassifier = () => "fatal";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
      });
      const original = new Error("nope");
      await expect(
        settleWithTimers(runner.run(() => Promise.reject(original))),
      ).rejects.toBe(original);
    });

    describe("unknownDecision (B2)", () => {
      test("default 'fatal' stops and propagates an unclassified error", async () => {
        const classifier: M3LRetryClassifier = () => "unknown";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
        });
        const original = new Error("unclassified");
        let attempts = 0;
        const op = (): Promise<never> => {
          attempts += 1;
          return Promise.reject(original);
        };
        await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
        expect(attempts).toBe(1);
      });

      test("'retriable' retries an otherwise-unknown error", async () => {
        const classifier: M3LRetryClassifier = () => "unknown";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          unknownDecision: "retriable",
        });
        let attempts = 0;
        const op = (): Promise<string> => {
          attempts += 1;
          if (attempts < 2) return Promise.reject(new Error("x"));
          return Promise.resolve("recovered");
        };
        await expect(settleWithTimers(runner.run(op))).resolves.toBe(
          "recovered",
        );
        expect(attempts).toBe(2);
      });
    });

    test("delayMs advice overrides the configured backoff for that attempt (B3)", async () => {
      // Backoff would be 10_000ms; advice says wait only 50ms. Assert the retry
      // happens after 50ms, i.e. before the configured backoff would elapse.
      const classifier: M3LRetryClassifier = () => ({
        decision: "retriable",
        delayMs: 50,
      });
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10_000),
      });
      let attempts = 0;
      const op = (): Promise<string> => {
        attempts += 1;
        if (attempts < 2) return Promise.reject(new Error("retry-after"));
        return Promise.resolve("done");
      };

      const promise = runner.run(op);
      // Advance less than the configured backoff but at least the advice delay.
      await vi.advanceTimersByTimeAsync(50);
      // The second attempt should have fired within the advice window.
      expect(attempts).toBe(2);
      await expect(promise).resolves.toBe("done");
    });
  });

  describe("per-call backoff isolation (B1)", () => {
    test("two concurrent poll() calls on one instance keep independent state", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });

      let callsA = 0;
      let callsB = 0;
      const checkA: M3LPollCheckFn<string> = () => {
        callsA += 1;
        if (callsA < 2) return { type: "continue" };
        return { type: "success", value: "A" };
      };
      const checkB: M3LPollCheckFn<string> = () => {
        callsB += 1;
        if (callsB < 4) return { type: "continue" };
        return { type: "success", value: "B" };
      };

      const both = Promise.all([poller.poll(checkA), poller.poll(checkB)]);
      await expect(settleWithTimers(both)).resolves.toEqual(["A", "B"]);
      // Independent attempt counters — no shared instance-level counter.
      expect(callsA).toBe(2);
      expect(callsB).toBe(4);
    });

    test("two concurrent run() calls on one instance keep independent state", async () => {
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
      });

      let attemptsA = 0;
      let attemptsB = 0;
      const opA = (): Promise<string> => {
        attemptsA += 1;
        if (attemptsA < 2) return Promise.reject(new Error("a"));
        return Promise.resolve("A");
      };
      const opB = (): Promise<string> => {
        attemptsB += 1;
        if (attemptsB < 4) return Promise.reject(new Error("b"));
        return Promise.resolve("B");
      };

      const both = Promise.all([runner.run(opA), runner.run(opB)]);
      await expect(settleWithTimers(both)).resolves.toEqual(["A", "B"]);
      expect(attemptsA).toBe(2);
      expect(attemptsB).toBe(4);
    });
  });

  describe("combineClassifiers (B4)", () => {
    test("first non-'unknown' decision wins in order", () => {
      const first: M3LRetryClassifier = () => "retriable";
      const second: M3LRetryClassifier = () => "fatal";
      const combined = combineClassifiers(first, second);
      expect(combined(new Error("x"))).toBe("retriable");

      const reversed = combineClassifiers(second, first);
      expect(reversed(new Error("x"))).toBe("fatal");
    });

    test("an 'unknown'-returning classifier is skipped in favor of a later opinion", () => {
      const abstain: M3LRetryClassifier = () => "unknown";
      const decide: M3LRetryClassifier = () => "retriable";
      const combined = combineClassifiers(abstain, decide);
      expect(combined(new Error("x"))).toBe("retriable");
    });

    test("all-'unknown' collapses to 'unknown'", () => {
      const a: M3LRetryClassifier = () => "unknown";
      const b: M3LRetryClassifier = () => "unknown";
      expect(combineClassifiers(a, b)(new Error("x"))).toBe("unknown");
    });

    test("the combined classifier is pure — same input, same output, no throw", () => {
      const combined = combineClassifiers(
        awsThrottlingClassifier,
        awsNetworkClassifier,
      );
      const err = new Error("boom");
      expect(combined(err)).toBe(combined(err));
    });
  });

  describe("built-in classifiers", () => {
    describe("awsThrottlingClassifier", () => {
      test.each([
        "ThrottlingException",
        "TooManyRequestsException",
        "RequestLimitExceeded",
        "ProvisionedThroughputExceededException",
      ])("recognizes throttling error name %s as retriable", (name) => {
        const err = Object.assign(new Error("throttled"), { name });
        expect(awsThrottlingClassifier(err)).toBe("retriable");
      });

      test.each([500, 502, 503, 504])(
        "recognizes transient status %i as retriable",
        (status) => {
          const err = Object.assign(new Error("server"), {
            $metadata: { httpStatusCode: status },
            statusCode: status,
          });
          expect(awsThrottlingClassifier(err)).toBe("retriable");
        },
      );

      test("returns 'unknown' (not 'fatal') for unrelated errors", () => {
        expect(awsThrottlingClassifier(new Error("random"))).toBe("unknown");
      });

      test("does not throw on a foreign non-Error value (B6)", () => {
        expect(() => awsThrottlingClassifier("a string")).not.toThrow();
        expect(awsThrottlingClassifier("a string")).toBe("unknown");
      });
    });

    describe("awsNetworkClassifier", () => {
      test.each([
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "ENOTFOUND",
      ])("classifies network code %s as retriable", (code) => {
        const err = Object.assign(new Error("net"), { code });
        expect(awsNetworkClassifier(err)).toBe("retriable");
      });

      test("returns 'unknown' for non-network errors", () => {
        expect(awsNetworkClassifier(new Error("nope"))).toBe("unknown");
      });

      test("does not throw on a foreign value (B6)", () => {
        expect(() => awsNetworkClassifier({ not: "an error" })).not.toThrow();
        expect(awsNetworkClassifier({ not: "an error" })).toBe("unknown");
      });
    });

    describe("httpRetryAfterClassifier", () => {
      test.each([429, 408, 500, 502, 503, 504])(
        "status %i is retriable",
        (status) => {
          const err = Object.assign(new Error("http"), { status });
          const advice = httpRetryAfterClassifier(err);
          const decision =
            typeof advice === "string" ? advice : advice.decision;
          expect(decision).toBe("retriable");
        },
      );

      test.each([400, 404])("non-retriable status %i is fatal", (status) => {
        const err = Object.assign(new Error("http"), { status });
        const advice = httpRetryAfterClassifier(err);
        const decision = typeof advice === "string" ? advice : advice.decision;
        expect(decision).toBe("fatal");
      });

      test("a foreign / non-HTTP error is 'unknown'", () => {
        const advice = httpRetryAfterClassifier(new Error("no status here"));
        const decision = typeof advice === "string" ? advice : advice.decision;
        expect(decision).toBe("unknown");
      });

      test("returns retriable advice with delayMs when the error carries retryAfterMs", () => {
        const err = Object.assign(new Error("rate"), {
          status: 429,
          retryAfterMs: 1234,
        });
        const advice = httpRetryAfterClassifier(err);
        expect(advice).toMatchObject({
          decision: "retriable",
          delayMs: 1234,
        });
      });

      test("does not throw on a foreign value (B6)", () => {
        expect(() => httpRetryAfterClassifier(42)).not.toThrow();
      });
    });
  });

  describe("M3LPollingPolicies", () => {
    test("awsThrottling() composes into a valid M3LRetryRunner ctor arg", () => {
      expect(
        () => new M3LRetryRunner(M3LPollingPolicies.awsThrottling()),
      ).not.toThrow();
    });

    test.each([
      ["athenaQuery", () => M3LPollingPolicies.athenaQuery()],
      ["cloudWatchLogsQuery", () => M3LPollingPolicies.cloudWatchLogsQuery()],
      ["httpDownload", () => M3LPollingPolicies.httpDownload()],
      ["sqsBatchSend", () => M3LPollingPolicies.sqsBatchSend()],
    ])("%s returns a non-empty options object", (_name, make) => {
      const options = make();
      expect(options).toBeTypeOf("object");
      expect(options).not.toBeNull();
      expect(Object.keys(options).length).toBeGreaterThan(0);
    });
  });

  describe("telemetry events", () => {
    /**
     * Collects every event a handler observes, in emission order, as a small
     * discriminated record so a single `toEqual` assertion pins both the event
     * name and its exact payload shape (no proxy/length-only assertions).
     */
    interface RecordedEvent<TName extends string, TPayload> {
      readonly name: TName;
      readonly payload: TPayload;
    }

    type RecordedPollEvent =
      | RecordedEvent<"poll:attempt", M3LPollAttemptPayload>
      | RecordedEvent<"poll:wait", M3LPollWaitPayload>
      | RecordedEvent<"poll:success", M3LPollSuccessPayload>
      | RecordedEvent<"poll:exhausted", M3LPollExhaustedPayload>;

    type RecordedRetryEvent =
      | RecordedEvent<"retry:attempt", M3LRetryAttemptPayload>
      | RecordedEvent<"retry:scheduled", M3LRetryScheduledPayload>
      | RecordedEvent<"retry:success", M3LRetrySuccessPayload>
      | RecordedEvent<"retry:fatal", M3LRetryFatalPayload>
      | RecordedEvent<"retry:exhausted", M3LRetryExhaustedPayload>;

    /** Subscribe to every poller event and collect them into an ordered array. */
    function recordPollerEvents(poller: M3LPoller): RecordedPollEvent[] {
      const events: RecordedPollEvent[] = [];
      poller.on("poll:attempt", (payload) => {
        events.push({ name: "poll:attempt", payload });
      });
      poller.on("poll:wait", (payload) => {
        events.push({ name: "poll:wait", payload });
      });
      poller.on("poll:success", (payload) => {
        events.push({ name: "poll:success", payload });
      });
      poller.on("poll:exhausted", (payload) => {
        events.push({ name: "poll:exhausted", payload });
      });
      return events;
    }

    /** Subscribe to every retry-runner event and collect them into an ordered array. */
    function recordRetryEvents(runner: M3LRetryRunner): RecordedRetryEvent[] {
      const events: RecordedRetryEvent[] = [];
      runner.on("retry:attempt", (payload) => {
        events.push({ name: "retry:attempt", payload });
      });
      runner.on("retry:scheduled", (payload) => {
        events.push({ name: "retry:scheduled", payload });
      });
      runner.on("retry:success", (payload) => {
        events.push({ name: "retry:success", payload });
      });
      runner.on("retry:fatal", (payload) => {
        events.push({ name: "retry:fatal", payload });
      });
      runner.on("retry:exhausted", (payload) => {
        events.push({ name: "retry:exhausted", payload });
      });
      return events;
    }

    describe("M3LPoller event ordering", () => {
      test("succeeding on attempt 3 emits attempt/wait pairs then a single success", async () => {
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          maxAttempts: 5,
        });
        const events = recordPollerEvents(poller);

        let calls = 0;
        const check: M3LPollCheckFn<string> = () => {
          calls += 1;
          if (calls < 3) return { type: "continue" };
          return { type: "success", value: "done" };
        };

        await expect(settleWithTimers(poller.poll(check))).resolves.toBe(
          "done",
        );

        expect(events).toEqual([
          { name: "poll:attempt", payload: { attempt: 1, maxAttempts: 5 } },
          { name: "poll:wait", payload: { attempt: 1, delayMs: 10 } },
          { name: "poll:attempt", payload: { attempt: 2, maxAttempts: 5 } },
          { name: "poll:wait", payload: { attempt: 2, delayMs: 10 } },
          { name: "poll:attempt", payload: { attempt: 3, maxAttempts: 5 } },
          { name: "poll:success", payload: { attempt: 3 } },
        ]);
      });

      test("exhausting at maxAttempts:2 skips the final poll:wait — only one backoff before poll:exhausted", async () => {
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          maxAttempts: 2,
        });
        const events = recordPollerEvents(poller);
        const check: M3LPollCheckFn<number> = () => ({ type: "continue" });

        let thrown: unknown;
        try {
          await settleWithTimers(poller.poll(check));
        } catch (error) {
          thrown = error;
        }

        // The last attempt (attempt 2) is the one that exhausts the bound, so
        // it must give up immediately — no `poll:wait` is emitted for it, and
        // only ONE backoff interval (attempt 1's) is ever slept.
        expect(events).toEqual([
          { name: "poll:attempt", payload: { attempt: 1, maxAttempts: 2 } },
          { name: "poll:wait", payload: { attempt: 1, delayMs: 10 } },
          { name: "poll:attempt", payload: { attempt: 2, maxAttempts: 2 } },
          { name: "poll:exhausted", payload: { attempts: 2 } },
        ]);
        expect(
          events.filter((event) => event.name === "poll:wait"),
        ).toHaveLength(1);
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
      });

      test("exhausting at maxAttempts:1 never emits poll:wait — the sole attempt is already the last", async () => {
        // Boundary: the smallest legal bound. There is no "earlier" attempt to
        // back off from, so poll:wait must never fire at all.
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          maxAttempts: 1,
        });
        const events = recordPollerEvents(poller);
        const check: M3LPollCheckFn<number> = () => ({ type: "continue" });

        let thrown: unknown;
        try {
          await settleWithTimers(poller.poll(check));
        } catch (error) {
          thrown = error;
        }

        expect(events).toEqual([
          { name: "poll:attempt", payload: { attempt: 1, maxAttempts: 1 } },
          { name: "poll:exhausted", payload: { attempts: 1 } },
        ]);
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
      });

      test("an exhausting poll sleeps exactly maxAttempts - 1 backoff intervals, never one per attempt", async () => {
        // Behavioral proof beyond the event sequence: the underlying delay
        // primitive (`setTimeout`) must be scheduled one fewer time than the
        // number of attempts, because the final attempt gives up immediately
        // instead of backing off.
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const maxAttempts = 4;
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          maxAttempts,
        });
        const check: M3LPollCheckFn<number> = () => ({ type: "continue" });

        let thrown: unknown;
        try {
          await settleWithTimers(poller.poll(check));
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
        expect(setTimeoutSpy.mock.calls).toHaveLength(maxAttempts - 1);
      });
    });

    describe("M3LRetryRunner event ordering", () => {
      test("succeeding on attempt 3 emits attempt/scheduled pairs then a final attempt and retry:success", async () => {
        const classifier: M3LRetryClassifier = () => "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 5,
        });
        const events = recordRetryEvents(runner);

        let attempts = 0;
        const op = (): Promise<string> => {
          attempts += 1;
          if (attempts < 3) return Promise.reject(new Error("transient"));
          return Promise.resolve("ok");
        };

        await expect(settleWithTimers(runner.run(op))).resolves.toBe("ok");

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 5 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 1, delayMs: 10, classification: "retriable" },
          },
          { name: "retry:attempt", payload: { attempt: 2, maxAttempts: 5 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 2, delayMs: 10, classification: "retriable" },
          },
          { name: "retry:attempt", payload: { attempt: 3, maxAttempts: 5 } },
          { name: "retry:success", payload: { attempt: 3 } },
        ]);
      });

      test("a fatal classification on attempt 2 emits retry:fatal and rejects with the original error", async () => {
        const classifier: M3LRetryClassifier = (err) =>
          err instanceof Error && err.message === "fatal-now"
            ? "fatal"
            : "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 5,
        });
        const events = recordRetryEvents(runner);

        let attempts = 0;
        const original = new Error("fatal-now");
        const op = (): Promise<never> => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("transient"));
          return Promise.reject(original);
        };

        await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 5 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 1, delayMs: 10, classification: "retriable" },
          },
          { name: "retry:attempt", payload: { attempt: 2, maxAttempts: 5 } },
          {
            name: "retry:fatal",
            payload: { attempt: 2, classification: "fatal" },
          },
        ]);
      });

      test("exhausting at maxAttempts:2 emits retry:exhausted on the final attempt, not retry:scheduled", async () => {
        const classifier: M3LRetryClassifier = () => "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 2,
        });
        const events = recordRetryEvents(runner);

        const original = new Error("always fails");
        const op = (): Promise<never> => Promise.reject(original);

        await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 2 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 1, delayMs: 10, classification: "retriable" },
          },
          { name: "retry:attempt", payload: { attempt: 2, maxAttempts: 2 } },
          { name: "retry:exhausted", payload: { attempts: 2 } },
        ]);
      });

      test("a server-driven advice.delayMs override is emitted verbatim on retry:scheduled and does not perturb the following attempt's backoff delay", async () => {
        // Attempt 1 fails with a server-driven override (999ms), distinct from
        // the configured backoff (constant 10ms). Attempt 2 fails with a plain
        // retriable decision, so its retry:scheduled must report the normal
        // backoff delay (10ms), unaffected by the prior one-off override.
        const serverDelayMs = 999;
        let call = 0;
        const classifier: M3LRetryClassifier = () => {
          call += 1;
          if (call === 1) {
            return { decision: "retriable", delayMs: serverDelayMs };
          }
          return "retriable";
        };
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 5,
        });
        const events = recordRetryEvents(runner);

        let attempts = 0;
        const op = (): Promise<string> => {
          attempts += 1;
          if (attempts < 3) return Promise.reject(new Error("transient"));
          return Promise.resolve("ok");
        };

        await expect(settleWithTimers(runner.run(op))).resolves.toBe("ok");

        const scheduledEvents = events.filter(
          (event) => event.name === "retry:scheduled",
        );
        expect(scheduledEvents).toEqual([
          {
            name: "retry:scheduled",
            payload: {
              attempt: 1,
              delayMs: serverDelayMs,
              classification: "retriable",
            },
          },
          {
            name: "retry:scheduled",
            payload: { attempt: 2, delayMs: 10, classification: "retriable" },
          },
        ]);
      });

      test.each([
        [
          "retriable" as const,
          "retry:scheduled" as const,
          "retry:fatal" as const,
        ],
      ])(
        "classification carries the raw 'unknown' advice, not the resolved unknownDecision (%s)",
        async (unknownDecision, expectedEvent, unexpectedEvent) => {
          const classifier: M3LRetryClassifier = () => "unknown";
          const runner = new M3LRetryRunner({
            classifier,
            backoff: M3LBackoff.constant(10),
            unknownDecision,
            maxAttempts: 5,
          });
          const events = recordRetryEvents(runner);

          let attempts = 0;
          const op = (): Promise<string> => {
            attempts += 1;
            if (attempts < 2) return Promise.reject(new Error("x"));
            return Promise.resolve("recovered");
          };

          await expect(settleWithTimers(runner.run(op))).resolves.toBe(
            "recovered",
          );

          const scheduled = events.find(
            (event) => event.name === expectedEvent,
          );
          expect(scheduled).toBeDefined();
          expect(scheduled?.payload).toMatchObject({
            classification: "unknown",
          });
          expect(events.some((event) => event.name === unexpectedEvent)).toBe(
            false,
          );
        },
      );

      test("classification carries raw 'unknown' resolved to fatal on retry:fatal", async () => {
        const classifier: M3LRetryClassifier = () => "unknown";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          unknownDecision: "fatal",
          maxAttempts: 5,
        });
        const events = recordRetryEvents(runner);
        const original = new Error("unclassified");

        await expect(
          settleWithTimers(runner.run(() => Promise.reject(original))),
        ).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 5 } },
          {
            name: "retry:fatal",
            payload: { attempt: 1, classification: "unknown" },
          },
        ]);
      });

      test.each([0, -1, Number.NaN])(
        "an invalid advice.delayMs (%p) rejects with the assertPositive guard error, not the original op error, and never emits retry:scheduled",
        async (badDelay) => {
          const classifier: M3LRetryClassifier = () => ({
            decision: "retriable",
            delayMs: badDelay,
          });
          const runner = new M3LRetryRunner({
            classifier,
            backoff: M3LBackoff.constant(10),
            maxAttempts: 2,
          });
          const events = recordRetryEvents(runner);
          const original = new Error("op failure, never reached by caller");

          let thrown: unknown;
          try {
            await settleWithTimers(runner.run(() => Promise.reject(original)));
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(M3LError);
          expect(thrown).not.toBe(original);
          expect((thrown as M3LError).code).toBe("ERR_POLLING_INVALID_OPTION");
          expect(events.some((event) => event.name === "retry:scheduled")).toBe(
            false,
          );
        },
      );

      test("a fatal advice given in OBJECT form ({ decision: 'fatal' }) rejects with the original error and emits retry:fatal", async () => {
        const classifier: M3LRetryClassifier = () => ({ decision: "fatal" });
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 5,
        });
        const events = recordRetryEvents(runner);
        const original = new Error("fatal via object advice");

        await expect(
          settleWithTimers(runner.run(() => Promise.reject(original))),
        ).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 5 } },
          {
            name: "retry:fatal",
            payload: { attempt: 1, classification: "fatal" },
          },
        ]);
      });

      test("an 'unknown' advice given in OBJECT form ({ decision: 'unknown' }) resolves per unknownDecision and reports raw classification 'unknown' on retry:scheduled", async () => {
        const classifier: M3LRetryClassifier = () => ({
          decision: "unknown",
        });
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          unknownDecision: "retriable",
          maxAttempts: 5,
        });
        const events = recordRetryEvents(runner);

        let attempts = 0;
        const op = (): Promise<string> => {
          attempts += 1;
          if (attempts < 2) return Promise.reject(new Error("x"));
          return Promise.resolve("recovered");
        };

        await expect(settleWithTimers(runner.run(op))).resolves.toBe(
          "recovered",
        );

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 5 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 1, delayMs: 10, classification: "unknown" },
          },
          { name: "retry:attempt", payload: { attempt: 2, maxAttempts: 5 } },
          { name: "retry:success", payload: { attempt: 2 } },
        ]);
      });

      test("a fatal classification on the LAST attempt emits retry:fatal, never retry:exhausted (fatal is checked before exhaustion)", async () => {
        let call = 0;
        const classifier: M3LRetryClassifier = () => {
          call += 1;
          return call === 1 ? "retriable" : "fatal";
        };
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 2,
        });
        const events = recordRetryEvents(runner);
        const original = new Error("fatal lands on the final attempt");
        const op = (): Promise<never> => Promise.reject(original);

        await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 2 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 1, delayMs: 10, classification: "retriable" },
          },
          { name: "retry:attempt", payload: { attempt: 2, maxAttempts: 2 } },
          {
            name: "retry:fatal",
            payload: { attempt: 2, classification: "fatal" },
          },
        ]);
        expect(events.some((event) => event.name === "retry:exhausted")).toBe(
          false,
        );
      });

      test("maxAttempts:1 with unknownDecision 'fatal' emits retry:fatal, never retry:exhausted, even though the sole attempt is also the last", async () => {
        const classifier: M3LRetryClassifier = () => "unknown";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          unknownDecision: "fatal",
          maxAttempts: 1,
        });
        const events = recordRetryEvents(runner);
        const original = new Error(
          "unknown resolved to fatal on the only attempt",
        );

        await expect(
          settleWithTimers(runner.run(() => Promise.reject(original))),
        ).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 1 } },
          {
            name: "retry:fatal",
            payload: { attempt: 1, classification: "unknown" },
          },
        ]);
      });

      test("maxAttempts:2 with unknownDecision 'retriable' schedules attempt 1 (classification 'unknown') then exhausts on attempt 2", async () => {
        const classifier: M3LRetryClassifier = () => "unknown";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          unknownDecision: "retriable",
          maxAttempts: 2,
        });
        const events = recordRetryEvents(runner);
        const original = new Error("always unknown");
        const op = (): Promise<never> => Promise.reject(original);

        await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 2 } },
          {
            name: "retry:scheduled",
            payload: { attempt: 1, delayMs: 10, classification: "unknown" },
          },
          { name: "retry:attempt", payload: { attempt: 2, maxAttempts: 2 } },
          { name: "retry:exhausted", payload: { attempts: 2 } },
        ]);
      });

      test("maxAttempts:1 with a retriable classification exhausts immediately: no retry:scheduled event and no setTimeout call", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const classifier: M3LRetryClassifier = () => "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          maxAttempts: 1,
        });
        const events = recordRetryEvents(runner);
        const original = new Error(
          "always retriable, but only one attempt allowed",
        );
        const op = (): Promise<never> => Promise.reject(original);

        await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);

        expect(events).toEqual([
          { name: "retry:attempt", payload: { attempt: 1, maxAttempts: 1 } },
          { name: "retry:exhausted", payload: { attempts: 1 } },
        ]);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        setTimeoutSpy.mockRestore();
      });

      test("Math.random pinned: a plain retriable classification (no delayMs advice) follows the same decorrelated-jitter progression as M3LPoller", async () => {
        const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
        try {
          const classifier: M3LRetryClassifier = () => "retriable";
          const runner = new M3LRetryRunner({
            classifier,
            backoff: M3LBackoff.exponentialJittered(100, 5_000),
            maxAttempts: 4,
          });
          const events = recordRetryEvents(runner);
          const op = (): Promise<never> =>
            Promise.reject(new Error("always fails"));

          await settleWithTimers(runner.run(op)).catch(() => undefined);

          const delays: number[] = [];
          for (const event of events) {
            if (event.name === "retry:scheduled") {
              delays.push(event.payload.delayMs);
            }
          }
          // start=100, cap=5_000, random=0.5, same seed sequence as the pinned
          // M3LPoller exponentialJittered test above: 200, 350, 575.
          expect(delays).toEqual([200, 350, 575]);
        } finally {
          randomSpy.mockRestore();
        }
      });

      test("Math.random pinned: a server-driven delayMs override on attempt 1 does not seed prevDelay for attempt 2's decorrelated-jitter backoff", async () => {
        const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
        try {
          let call = 0;
          const classifier: M3LRetryClassifier = () => {
            call += 1;
            if (call === 1) {
              return { decision: "retriable" as const, delayMs: 999 };
            }
            return "retriable";
          };
          const runner = new M3LRetryRunner({
            classifier,
            backoff: M3LBackoff.exponentialJittered(100, 5_000),
            maxAttempts: 4,
          });
          const events = recordRetryEvents(runner);
          const op = (): Promise<never> =>
            Promise.reject(new Error("always fails"));

          await settleWithTimers(runner.run(op)).catch(() => undefined);

          const delays: number[] = [];
          for (const event of events) {
            if (event.name === "retry:scheduled") {
              delays.push(event.payload.delayMs);
            }
          }
          // Attempt 1's 999ms is the server override, verbatim. Attempts 2 and 3
          // must match P8a's first two values (200, 350) exactly — if the
          // override had seeded prevDelay instead of leaving it untouched,
          // attempt 2's delay would jump to roughly
          // 100 + 0.5*(999*3 - 100) ≈ 1548.5, far above 200.
          expect(delays).toEqual([999, 200, 350]);
        } finally {
          randomSpy.mockRestore();
        }
      });
    });

    describe("outcome invariance — a throwing handler never changes the resolved value or error", () => {
      test("a poll:success handler that throws does not change the resolved value", async () => {
        const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
        poller.on("poll:success", () => {
          throw new Error("handler boom");
        });
        const check: M3LPollCheckFn<string> = () => ({
          type: "success",
          value: "unaffected",
        });

        await expect(settleWithTimers(poller.poll(check))).resolves.toBe(
          "unaffected",
        );
      });

      test("a poll:exhausted handler that throws does not change the rejection", async () => {
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          maxAttempts: 1,
        });
        poller.on("poll:exhausted", () => {
          throw new Error("handler boom");
        });
        const check: M3LPollCheckFn<number> = () => ({ type: "continue" });

        let thrown: unknown;
        try {
          await settleWithTimers(poller.poll(check));
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
      });

      test("a retry:fatal handler that throws does not change the identity of the rejected error", async () => {
        const classifier: M3LRetryClassifier = () => "fatal";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
        });
        runner.on("retry:fatal", () => {
          throw new Error("handler boom");
        });
        const original = new Error("nope");

        await expect(
          settleWithTimers(runner.run(() => Promise.reject(original))),
        ).rejects.toBe(original);
      });
    });

    describe("off() unsubscribes a handler", () => {
      test("a handler removed via off no longer receives events", async () => {
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          maxAttempts: 5,
        });
        const received: M3LPollAttemptPayload[] = [];
        const handler = (payload: M3LPollAttemptPayload): void => {
          received.push(payload);
        };
        poller.on("poll:attempt", handler);

        let calls = 0;
        const check: M3LPollCheckFn<string> = () => {
          calls += 1;
          if (calls === 1) {
            // Unsubscribe after observing the first attempt, before the second
            // attempt fires.
            poller.off("poll:attempt", handler);
          }
          if (calls < 2) return { type: "continue" };
          return { type: "success", value: "done" };
        };

        await expect(settleWithTimers(poller.poll(check))).resolves.toBe(
          "done",
        );

        expect(received).toEqual([{ attempt: 1, maxAttempts: 5 }]);
      });
    });

    describe("type-level contract — event maps and payloads", () => {
      test("M3LPollAttemptPayload is the exact readonly shape", () => {
        expectTypeOf<M3LPollAttemptPayload>().toEqualTypeOf<{
          readonly attempt: number;
          readonly maxAttempts: number;
        }>();
      });

      test("M3LPollWaitPayload is the exact readonly shape", () => {
        expectTypeOf<M3LPollWaitPayload>().toEqualTypeOf<{
          readonly attempt: number;
          readonly delayMs: number;
        }>();
      });

      test("M3LPollSuccessPayload is the exact readonly shape (no error/message field)", () => {
        expectTypeOf<M3LPollSuccessPayload>().toEqualTypeOf<{
          readonly attempt: number;
        }>();
      });

      test("M3LPollExhaustedPayload is the exact readonly shape (no error/message field)", () => {
        expectTypeOf<M3LPollExhaustedPayload>().toEqualTypeOf<{
          readonly attempts: number;
        }>();
      });

      test("M3LRetryAttemptPayload is the exact readonly shape", () => {
        expectTypeOf<M3LRetryAttemptPayload>().toEqualTypeOf<{
          readonly attempt: number;
          readonly maxAttempts: number;
        }>();
      });

      test("M3LRetryScheduledPayload is the exact readonly shape (no error/message field)", () => {
        expectTypeOf<M3LRetryScheduledPayload>().toEqualTypeOf<{
          readonly attempt: number;
          readonly delayMs: number;
          readonly classification: "retriable" | "unknown";
        }>();
      });

      test("M3LRetrySuccessPayload is the exact readonly shape (no error/message field)", () => {
        expectTypeOf<M3LRetrySuccessPayload>().toEqualTypeOf<{
          readonly attempt: number;
        }>();
      });

      test("M3LRetryFatalPayload is the exact readonly shape (no error/message field)", () => {
        expectTypeOf<M3LRetryFatalPayload>().toEqualTypeOf<{
          readonly attempt: number;
          readonly classification: "fatal" | "unknown";
        }>();
      });

      test("M3LRetryExhaustedPayload is the exact readonly shape (no error/message field)", () => {
        expectTypeOf<M3LRetryExhaustedPayload>().toEqualTypeOf<{
          readonly attempts: number;
        }>();
      });

      test("M3LPollerEventMap wires each key to its documented payload", () => {
        expectTypeOf<
          M3LPollerEventMap["poll:attempt"]
        >().toEqualTypeOf<M3LPollAttemptPayload>();
        expectTypeOf<
          M3LPollerEventMap["poll:wait"]
        >().toEqualTypeOf<M3LPollWaitPayload>();
        expectTypeOf<
          M3LPollerEventMap["poll:success"]
        >().toEqualTypeOf<M3LPollSuccessPayload>();
        expectTypeOf<
          M3LPollerEventMap["poll:exhausted"]
        >().toEqualTypeOf<M3LPollExhaustedPayload>();
      });

      test("M3LRetryEventMap wires each key to its documented payload", () => {
        expectTypeOf<
          M3LRetryEventMap["retry:attempt"]
        >().toEqualTypeOf<M3LRetryAttemptPayload>();
        expectTypeOf<
          M3LRetryEventMap["retry:scheduled"]
        >().toEqualTypeOf<M3LRetryScheduledPayload>();
        expectTypeOf<
          M3LRetryEventMap["retry:success"]
        >().toEqualTypeOf<M3LRetrySuccessPayload>();
        expectTypeOf<
          M3LRetryEventMap["retry:fatal"]
        >().toEqualTypeOf<M3LRetryFatalPayload>();
        expectTypeOf<
          M3LRetryEventMap["retry:exhausted"]
        >().toEqualTypeOf<M3LRetryExhaustedPayload>();
      });

      test("classification is narrowed per payload — never the full M3LRetryDecision", () => {
        expectTypeOf<
          M3LRetryScheduledPayload["classification"]
        >().toEqualTypeOf<"retriable" | "unknown">();
        expectTypeOf<M3LRetryFatalPayload["classification"]>().toEqualTypeOf<
          "fatal" | "unknown"
        >();
      });

      test("on() infers the handler payload type per event key", () => {
        const runner = new M3LRetryRunner({
          classifier: awsThrottlingClassifier,
          backoff: M3LBackoff.constant(10),
        });
        runner.on("retry:scheduled", (payload) => {
          expectTypeOf(payload).toEqualTypeOf<M3LRetryScheduledPayload>();
        });
        runner.on("retry:success", (payload) => {
          expectTypeOf(payload).toEqualTypeOf<M3LRetrySuccessPayload>();
        });

        const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
        poller.on("poll:wait", (payload) => {
          expectTypeOf(payload).toEqualTypeOf<M3LPollWaitPayload>();
        });
      });

      test("emit is not part of the public surface", () => {
        const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
        // @ts-expect-error emit is protected on M3LEventEmitterBase
        poller.emit("poll:success", { attempt: 1 });

        const runner = new M3LRetryRunner({
          classifier: awsThrottlingClassifier,
          backoff: M3LBackoff.constant(10),
        });
        // @ts-expect-error emit is protected on M3LEventEmitterBase
        runner.emit("retry:attempt", { attempt: 1, maxAttempts: 1 });
      });

      test("on() rejects an unknown event key", () => {
        const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
        // @ts-expect-error "poll:bogus" is not a key of M3LPollerEventMap
        poller.on("poll:bogus", () => {
          /* noop */
        });
      });

      test("on() rejects a cross-map event key (retry event on a poller)", () => {
        const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
        // @ts-expect-error "retry:attempt" belongs to M3LRetryEventMap, not M3LPollerEventMap
        poller.on("retry:attempt", () => {
          /* noop */
        });
      });
    });
  });

  // ===========================================================================
  // Cooperative cancellation (ADR-0049)
  //
  // M3LPollerOptions and M3LRetryRunnerOptions gain `signal?: AbortSignal`.
  // When a signal is provided:
  //   - An already-aborted signal rejects immediately without invoking the
  //     check or operation.
  //   - A never-aborted signal changes nothing — behavior is identical to
  //     absent.
  //   - An abort during a backoff delay rejects promptly (does not sleep out
  //     the remaining delay).
  //   - M3LRetryRunner checks the signal BEFORE its classifier, so no
  //     classifier may reclassify the abort as retriable.
  //   - Abort listeners are cleaned up on both settle paths (timer-fired and
  //     aborted), so long runs do not accumulate listeners.
  // ===========================================================================
  describe("cooperative cancellation (ADR-0049)", () => {
    // ---------------------------------------------------------------------------
    // Type-level contract — signal is optional AbortSignal | undefined on both
    // option interfaces.
    //
    // M3LPollerOptions and M3LRetryRunnerOptions are not re-exported from the
    // barrel (intentionally opaque); import them from their source files to assert
    // the signal field. toMatchTypeOf is used (not toEqualTypeOf) because the
    // interfaces carry other required/optional fields; we only assert the signal
    // field shape here.
    // ---------------------------------------------------------------------------
    describe("type-level: signal field on option interfaces", () => {
      test("M3LPollerOptions.signal is optional and typed AbortSignal | undefined", () => {
        expectTypeOf<M3LPollerOptions["signal"]>().toEqualTypeOf<
          AbortSignal | undefined
        >();
      });

      test("M3LRetryRunnerOptions.signal is optional and typed AbortSignal | undefined", () => {
        expectTypeOf<M3LRetryRunnerOptions["signal"]>().toEqualTypeOf<
          AbortSignal | undefined
        >();
      });
    });

    describe("M3LPoller cooperative cancellation", () => {
      // (a) absent signal — behavior identical to today
      test("(a) absent signal: success resolves with value (no change from baseline)", async () => {
        const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
        await expect(
          settleWithTimers(
            poller.poll<string>(() => ({ type: "success", value: "baseline" })),
          ),
        ).resolves.toBe("baseline");
      });

      // (b) never-aborted signal — same result as absent
      test("(b) never-aborted signal: same resolved value and attempt count as absent signal", async () => {
        const controller = new AbortController(); // never aborted
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          signal: controller.signal,
        });

        let callCount = 0;
        const check: M3LPollCheckFn<string> = () => {
          callCount++;
          if (callCount < 3) return { type: "continue" };
          return { type: "success", value: "with-signal" };
        };

        await expect(settleWithTimers(poller.poll(check))).resolves.toBe(
          "with-signal",
        );
        expect(callCount).toBe(3); // same attempt count as if no signal were provided
      });

      // (c) already-aborted signal — rejects immediately, check never called
      test("(c) already-aborted signal: rejects with ERR_OPERATION_ABORTED without invoking the check", async () => {
        const controller = new AbortController();
        controller.abort();

        const check = vi.fn<() => { type: "success"; value: string }>(() => ({
          type: "success",
          value: "should-not-reach",
        }));
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(10),
          signal: controller.signal,
        });

        let thrown: unknown;
        try {
          await settleWithTimers(
            poller.poll(check as unknown as M3LPollCheckFn<string>),
          );
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        expect(check).not.toHaveBeenCalled();
      });

      // (d) abort mid-wait during backoff delay — rejects promptly, does NOT sleep
      // out the remaining delay. The proof: we only advance 0ms of fake time after
      // aborting; if the implementation sleeps the delay, `settled` stays false and
      // the assertion fails cleanly (no hanging, no timeout needed).
      test("(d) abort during backoff delay rejects promptly — does not sleep out the remaining delay", async () => {
        const controller = new AbortController();
        // Use a very long delay so we can prove it was NOT slept.
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(60_000),
          signal: controller.signal,
          maxAttempts: 10,
        });

        let checkCount = 0;
        const check: M3LPollCheckFn<string> = () => {
          checkCount++;
          // Always continue so a backoff delay is always scheduled.
          return { type: "continue" };
        };

        const pollPromise = poller.poll(check);

        // Track settlement without blocking the test (avoids hanging in RED).
        let settled = false;
        let thrown: unknown;
        void pollPromise.then(
          () => {
            settled = true;
          },
          (e: unknown) => {
            settled = true;
            thrown = e;
          },
        );

        // Flush microtasks: the first check runs and the 60s delay starts.
        await vi.advanceTimersByTimeAsync(0);
        expect(checkCount).toBe(1);

        // Abort while the 60s delay is pending.
        controller.abort();

        // Flush microtasks from the abort event (abort → delay rejects → poll rejects).
        await vi.advanceTimersByTimeAsync(0);

        // Must have settled already — zero timer advancement was needed.
        // In RED: settled is false (delay still pending 60s) → assertion fails cleanly.
        expect(settled).toBe(true);
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        // No second check ran — abort happened before the next attempt.
        expect(checkCount).toBe(1);
      });

      // (f) no listener accumulation — timer-settled path
      test("(f) abort listener is added and removed for each delay (timer-settled path — no accumulation)", async () => {
        const controller = new AbortController();
        const signal = controller.signal;
        const addSpy = vi.spyOn(signal, "addEventListener");
        const removeSpy = vi.spyOn(signal, "removeEventListener");

        try {
          const poller = new M3LPoller({
            backoff: M3LBackoff.constant(10),
            signal,
            maxAttempts: 10,
          });

          // 4 continues then success → 4 delays, each adds then removes one listener.
          let calls = 0;
          const check: M3LPollCheckFn<string> = () => {
            calls++;
            if (calls <= 4) return { type: "continue" };
            return { type: "success", value: "done" };
          };

          await expect(settleWithTimers(poller.poll(check))).resolves.toBe(
            "done",
          );

          const abortAdds = addSpy.mock.calls.filter(
            (args) => args[0] === "abort",
          ).length;
          const abortRemoves = removeSpy.mock.calls.filter(
            (args) => args[0] === "abort",
          ).length;

          // At least one listener was added (proves signal was wired up at all).
          // In RED: 0 (no signal support) → fails here with expected > 0.
          expect(abortAdds).toBeGreaterThan(0);
          // Each listener added must have a corresponding remove (no accumulation).
          expect(abortRemoves).toBe(abortAdds);
        } finally {
          addSpy.mockRestore();
          removeSpy.mockRestore();
        }
      });

      // (f) no listener accumulation — abort-settled path
      test("(f) abort listener is removed when the delay is aborted (not only when timer fires)", async () => {
        const controller = new AbortController();
        const signal = controller.signal;
        const removeSpy = vi.spyOn(signal, "removeEventListener");

        try {
          const poller = new M3LPoller({
            backoff: M3LBackoff.constant(60_000),
            signal,
            maxAttempts: 10,
          });

          const check: M3LPollCheckFn<string> = () => ({ type: "continue" });

          const pollPromise = poller.poll(check);
          let settled = false;
          let thrown: unknown;
          void pollPromise.then(
            () => {
              settled = true;
            },
            (e: unknown) => {
              settled = true;
              thrown = e;
            },
          );

          await vi.advanceTimersByTimeAsync(0); // first check runs
          controller.abort();
          await vi.advanceTimersByTimeAsync(0); // abort propagates

          expect(settled).toBe(true); // RED: false → fails first (see test d)
          expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");

          // The abort-path listener cleanup: removeEventListener called for "abort".
          const abortRemoves = removeSpy.mock.calls.filter(
            (args) => args[0] === "abort",
          ).length;
          expect(abortRemoves).toBeGreaterThan(0);
        } finally {
          removeSpy.mockRestore();
        }
      });
    });

    describe("M3LRetryRunner cooperative cancellation", () => {
      // (a) absent signal — behavior identical to today
      test("(a) absent signal: resolves when operation succeeds (no change from baseline)", async () => {
        const runner = new M3LRetryRunner({
          classifier: awsThrottlingClassifier,
          backoff: M3LBackoff.constant(10),
        });
        await expect(
          settleWithTimers(runner.run(() => Promise.resolve(99))),
        ).resolves.toBe(99);
      });

      // (b) never-aborted signal — same result as absent
      test("(b) never-aborted signal: same resolved value and attempt count as absent signal", async () => {
        const controller = new AbortController(); // never aborted
        const classifier: M3LRetryClassifier = () => "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          signal: controller.signal,
        });

        let attempts = 0;
        const op = (): Promise<string> => {
          attempts++;
          if (attempts < 3) return Promise.reject(new Error("transient"));
          return Promise.resolve("with-signal");
        };

        await expect(settleWithTimers(runner.run(op))).resolves.toBe(
          "with-signal",
        );
        expect(attempts).toBe(3); // same count as without signal
      });

      // (c) already-aborted signal — rejects immediately, op never called
      test("(c) already-aborted signal: rejects with ERR_OPERATION_ABORTED without invoking the operation", async () => {
        const controller = new AbortController();
        controller.abort();

        const classifier: M3LRetryClassifier = () => "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          signal: controller.signal,
        });
        const op = vi
          .fn<() => Promise<never>>()
          .mockRejectedValue(new Error("should-not-reach"));

        let thrown: unknown;
        try {
          await settleWithTimers(runner.run(op));
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        expect(op).not.toHaveBeenCalled();
      });

      // (d) abort mid-wait during backoff delay
      test("(d) abort during backoff delay rejects promptly — does not sleep out the remaining delay", async () => {
        const controller = new AbortController();
        const classifier: M3LRetryClassifier = () => "retriable";
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(60_000),
          signal: controller.signal,
          maxAttempts: 10,
        });

        let opCallCount = 0;
        const op = (): Promise<never> => {
          opCallCount++;
          return Promise.reject(new Error("transient"));
        };

        const runPromise = runner.run(op);
        let settled = false;
        let thrown: unknown;
        void runPromise.then(
          () => {
            settled = true;
          },
          (e: unknown) => {
            settled = true;
            thrown = e;
          },
        );

        // Flush microtasks: attempt 1 runs, fails, classified retriable, 60s delay starts.
        await vi.advanceTimersByTimeAsync(0);
        expect(opCallCount).toBe(1);

        // Abort while the 60s delay is pending.
        controller.abort();
        await vi.advanceTimersByTimeAsync(0); // flush abort microtasks

        // Must settle without advancing 60s.
        // In RED: settled is false → assertion fails cleanly.
        expect(settled).toBe(true);
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        // Operation was NOT retried (abort beats the scheduler).
        expect(opCallCount).toBe(1);
      });

      // (e) retriable-always classifier with abort — proves "no classifier may
      // reclassify the abort" structurally (ADR-0049). Covers two variants:
      //   1. classifier is never called with the abort error (mid-wait abort)
      //   2. already-aborted signal with retriable classifier (op + classifier never called)
      test("(e) abort propagates as ERR_OPERATION_ABORTED even when classifier always returns 'retriable' — operation is not retried", async () => {
        const controller = new AbortController();
        const classifier = vi
          .fn<(err: unknown) => M3LRetryDecision>()
          .mockReturnValue("retriable");
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(60_000),
          signal: controller.signal,
          maxAttempts: 10,
        });

        let opCallCount = 0;
        const op = (): Promise<never> => {
          opCallCount++;
          return Promise.reject(new Error("transient"));
        };

        const runPromise = runner.run(op);
        let settled = false;
        let thrown: unknown;
        void runPromise.then(
          () => {
            settled = true;
          },
          (e: unknown) => {
            settled = true;
            thrown = e;
          },
        );

        // Attempt 1 runs and the retriable classifier is called for the transient error.
        await vi.advanceTimersByTimeAsync(0);
        expect(opCallCount).toBe(1);

        // Abort during the 60s backoff.
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);

        // Settled promptly with ERR_OPERATION_ABORTED.
        // In RED: settled is false → fails cleanly.
        expect(settled).toBe(true);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        // Operation was never retried — only one call total.
        expect(opCallCount).toBe(1);
        // The classifier was called for attempt 1's transient error but NEVER with
        // the abort error — the abort bypasses the classifier entirely.
        const callsWithAbortCode = classifier.mock.calls.filter(
          ([err]) =>
            err instanceof M3LError && err.code === "ERR_OPERATION_ABORTED",
        );
        expect(callsWithAbortCode).toHaveLength(0);
      });

      test("(e variant) already-aborted signal with retriable-always classifier: classifier is never called at all", async () => {
        const controller = new AbortController();
        controller.abort();

        const classifier = vi
          .fn<(err: unknown) => M3LRetryDecision>()
          .mockReturnValue("retriable");
        const runner = new M3LRetryRunner({
          classifier,
          backoff: M3LBackoff.constant(10),
          signal: controller.signal,
          maxAttempts: 10,
        });
        const op = vi
          .fn<() => Promise<never>>()
          .mockRejectedValue(new Error("transient"));

        let thrown: unknown;
        try {
          await settleWithTimers(runner.run(op));
        } catch (e) {
          thrown = e;
        }

        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        // Signal checked before op or classifier — neither is called.
        expect(op).not.toHaveBeenCalled();
        expect(classifier).not.toHaveBeenCalled();
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });
    });
  }); // close describe("cooperative cancellation (ADR-0049)")
}); // close describe("core/polling")

// =============================================================================
// M3LPollFailureError — internal constructor's optional `context` param
//
// Whitebox-only: neither of `M3LPoller`'s own two throw sites passes a
// `context`, so the "with context" constructor branch is unreachable through
// the public API and must be exercised directly against the internal class.
// =============================================================================
describe("M3LPollFailureError (internal) — optional context", () => {
  test("constructed without context: context is an empty record, code is ERR_POLL_FAILURE, and it is an M3LError", () => {
    const error = new M3LPollFailureError("terminal failure");

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_POLL_FAILURE");
    expect(error.context).toEqual({});
  });

  test("constructed with context: context carries it verbatim", () => {
    const context = { attempt: 3, reason: "upstream rejected" };

    const error = new M3LPollFailureError("terminal failure", context);

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_POLL_FAILURE");
    expect(error.context).toEqual(context);
  });
});

// =============================================================================
// delay (internal) — already-aborted signal fast path
//
// `addEventListener("abort", ...)` on an ALREADY-aborted AbortSignal never
// fires because the abort event has already been dispatched. Without the
// fast path at line 41–43 of delay.ts, `delay(30_000, alreadyAbortedSignal)`
// would arm a timer, never receive the callback, sleep the full duration, and
// then RESOLVE — silently completing work that should have been cancelled.
// These tests pin the three facets of that fast path directly.
// =============================================================================
describe("delay (internal) — already-aborted signal fast path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("already-aborted signal: rejects with M3LOperationAbortedError carrying ERR_OPERATION_ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      await delay(30_000, controller.signal);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect((thrown as M3LOperationAbortedError).code).toBe(
      "ERR_OPERATION_ABORTED",
    );
  });

  test("already-aborted signal: rejects without arming a timer — no setTimeout is scheduled", async () => {
    const controller = new AbortController();
    controller.abort();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const promise = delay(30_000, controller.signal);

    // The rejection must resolve without advancing fake timers at all.
    // If a timer were armed we would need to advance them; the fact that
    // awaiting the promise (via the micro-task queue only) is sufficient
    // proves no timer was scheduled.
    await expect(promise).rejects.toBeInstanceOf(M3LOperationAbortedError);

    // Belt-and-suspenders: confirm setTimeout was never called on this path.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test("already-aborted signal: does not register an abort listener — fast path exits before addEventListener", async () => {
    const controller = new AbortController();
    controller.abort();

    const addListenerSpy = vi.spyOn(controller.signal, "addEventListener");

    await expect(delay(30_000, controller.signal)).rejects.toBeInstanceOf(
      M3LOperationAbortedError,
    );

    // If a future refactor deletes the fast path and relies on the abort
    // listener instead, this assertion catches it — an already-aborted signal
    // never fires the listener, so the delay would silently resolve.
    expect(addListenerSpy).not.toHaveBeenCalled();
  });
});
