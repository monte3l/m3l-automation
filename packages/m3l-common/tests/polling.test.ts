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

import { M3LError } from "../src/core/errors/index.js";
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
      test.each([429, 500, 502, 503, 504])(
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

      test("exhausting at maxAttempts:2 emits the final poll:wait before poll:exhausted", async () => {
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

        expect(events).toEqual([
          { name: "poll:attempt", payload: { attempt: 1, maxAttempts: 2 } },
          { name: "poll:wait", payload: { attempt: 1, delayMs: 10 } },
          { name: "poll:attempt", payload: { attempt: 2, maxAttempts: 2 } },
          { name: "poll:wait", payload: { attempt: 2, delayMs: 10 } },
          { name: "poll:exhausted", payload: { attempts: 2 } },
        ]);
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
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
});
