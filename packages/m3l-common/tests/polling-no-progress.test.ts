/**
 * Tests for A5 — no-progress detection on `M3LPoller` / `M3LRetryRunner`
 * (RED phase — the `progress` option does not exist yet on either primitive).
 *
 * Contract source: docs/reference/core/polling.md, "No-progress detection"
 * section, plus the `poll:no-progress` / `retry:no-progress` event rows and
 * their payload interfaces; docs/reference/core/errors.md's `ERR_NO_PROGRESS`
 * row.
 *
 * This is a companion file to `tests/polling.test.ts` (already 2200+ lines) —
 * see that file for the established harness conventions this file replicates
 * (`settleWithTimers`, event recorders, the signal-precedence pattern).
 *
 * AMBIGUITY NOTE (flagged per instructions, not resolved by invention): the
 * doc says "The first sample establishes a baseline. Each later sample equal
 * to the previous one ... increments a stall counter ... When the counter
 * reaches maxStalledAttempts, the call rejects." Read literally, the baseline
 * sample itself does not increment the counter, so tripping requires
 * `maxStalledAttempts + 1` total witness samples (and thus check/operation
 * invocations), with the tripping attempt being the `(maxStalledAttempts +
 * 1)`-th. Tests below assert this reading explicitly where the exact count
 * matters (documented inline) but otherwise capture the actual invocation
 * count dynamically rather than re-deriving the formula, so a
 * one-off-different (but still literal) implementer reading only fails the
 * few tests that pin the formula, not the whole suite.
 *
 * NAMING DISCREPANCY (verified against source, not assumed from the prior
 * report): the error-registration helpers are `classifyErrorCode` and
 * `isM3LErrorCode` from `core/errors/catalog.ts` — there is no
 * `getM3LErrorClassification` export anywhere in `src/`. Both are re-exported
 * through `core/errors/index.ts` (`export * from "./catalog.js"`), which is
 * itself re-exported through `core/index.ts`, so they are reachable from the
 * public barrel; this file imports them the same way the existing
 * `tests/errors.test.ts` does (directly from `catalog.js`), which is the
 * established precedent for reaching catalog-only helpers.
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
  classifyErrorCode,
  isM3LErrorCode,
} from "../src/core/errors/catalog.js";
import {
  M3L_ERROR_CODES,
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";
import type { M3LPollerOptions } from "../src/core/polling/M3LPoller.js";
import type { M3LRetryRunnerOptions } from "../src/core/polling/M3LRetryRunner.js";
import {
  awsThrottlingClassifier,
  M3LBackoff,
  M3LPoller,
  M3LRetryRunner,
} from "../src/core/polling/index.js";
import type {
  M3LPollCheckFn,
  M3LPollerEventMap,
  M3LPollNoProgressPayload,
  M3LRetryClassifier,
  M3LRetryEventMap,
  M3LRetryNoProgressPayload,
} from "../src/core/polling/index.js";

/**
 * Drive a promise to settlement while flushing all pending timers, so backoff
 * delays resolve without real wall-clock waits. Replicated from
 * `tests/polling.test.ts` (see its banner for the rationale).
 */
async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const settledOutcome = Promise.allSettled([promise]).then((results) => {
    settled = true;
    return results[0];
  });
  for (let i = 0; i < 1000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  const outcome = await settledOutcome;
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

/** Capture a thrown/rejected value without letting the assertion hide it. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  try {
    await settleWithTimers(promise);
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

describe("core/polling — no-progress detection (A5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("M3LPoller — core behaviour", () => {
    test("a witness pinned to one constant value trips the guard, rejecting with ERR_NO_PROGRESS", async () => {
      const maxStalledAttempts = 3;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: {
          witness: () => "same",
          maxStalledAttempts,
        },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      // Doc-literal reading: baseline sample + maxStalledAttempts later-equal
      // samples trip the guard, i.e. maxStalledAttempts + 1 total invocations.
      expect(calls).toBe(maxStalledAttempts + 1);
    });

    test("the check is invoked strictly fewer times than maxAttempts when the guard trips", async () => {
      const maxAttempts = 50;
      const maxStalledAttempts = 3;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      // The whole point of this item: the loop must not burn every remote
      // call before giving up.
      expect(calls).toBeLessThan(maxAttempts);
    });

    test("the thrown error carries context.attempts and context.stalledAttempts", async () => {
      const maxStalledAttempts = 4;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      const error = thrown as M3LError;
      expect(error.code).toBe("ERR_NO_PROGRESS");
      expect(error.context["stalledAttempts"]).toBe(maxStalledAttempts);
      expect(error.context["attempts"]).toBe(calls);
    });

    test("the rejection happens without sleeping the backoff for the tripping attempt", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const maxStalledAttempts = 3;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      // Naive expectation: one backoff sleep per continuing attempt (`calls`
      // of them). The guard must abandon the tripping attempt's own delay,
      // so the observed sleep count is one fewer.
      expect(setTimeoutSpy.mock.calls).toHaveLength(calls - 1);
    });

    test("a witness returning a different value every attempt never trips the guard — normal exhaustion happens instead", async () => {
      const maxAttempts = 6;
      let counter = 0;
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: {
          witness: () => {
            counter += 1;
            return counter;
          },
          maxStalledAttempts: 3,
        },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
    });

    test("reset on change: stalling for maxStalledAttempts-1, changing, then stalling again for maxStalledAttempts-1 never trips", async () => {
      const maxAttempts = 10;
      const maxStalledAttempts = 3;
      let witnessCalls = 0;
      const witness = (): string => {
        witnessCalls += 1;
        if (witnessCalls <= 3) return "a"; // baseline + 2 unchanged (maxStalledAttempts - 1)
        if (witnessCalls <= 6) return "b"; // change, then baseline + 2 unchanged again
        return `unique-${String(witnessCalls)}`; // always changes from here on
      };
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness, maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      // Must exhaust normally — the counter reset on each change, so it never
      // reached maxStalledAttempts.
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
    });

    test("the witness is not sampled on a success decision", async () => {
      const witness = vi.fn(() => "same");
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls += 1;
        if (calls < 3) return { type: "continue" };
        return { type: "success", value: "done" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 10,
        progress: { witness, maxStalledAttempts: 10 },
      });

      await expect(settleWithTimers(poller.poll(check))).resolves.toBe("done");
      // Sampled only on the two `continue` attempts (1, 2), never on the
      // success attempt (3).
      expect(witness).toHaveBeenCalledTimes(2);
    });

    test("the witness is not sampled on a terminal failure decision", async () => {
      const witness = vi.fn(() => "same");
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        if (calls < 3) return { type: "continue" };
        return { type: "failure" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 10,
        progress: { witness, maxStalledAttempts: 10 },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_FAILURE");
      expect(witness).toHaveBeenCalledTimes(2);
    });

    test("the witness is not sampled on the ceiling-exhausting attempt", async () => {
      const witness = vi.fn(() => "same");
      const maxAttempts = 3;
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness, maxStalledAttempts: 10 },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
      // Sampled on attempts 1 and 2 only — never on the 3rd (exhausting) one.
      expect(witness).toHaveBeenCalledTimes(maxAttempts - 1);
    });
  });

  describe("M3LRetryRunner — core behaviour", () => {
    test("a witness pinned to one constant value trips the guard, rejecting with ERR_NO_PROGRESS", async () => {
      const maxStalledAttempts = 3;
      let calls = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => {
        calls += 1;
        return Promise.reject(new Error("still failing"));
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(runner.run(op));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      expect(calls).toBe(maxStalledAttempts + 1);
    });

    test("the operation is invoked strictly fewer times than maxAttempts when the guard trips", async () => {
      const maxAttempts = 50;
      const maxStalledAttempts = 3;
      let calls = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => {
        calls += 1;
        return Promise.reject(new Error("still failing"));
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(runner.run(op));

      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      expect(calls).toBeLessThan(maxAttempts);
    });

    test("the thrown error carries context.attempts and context.stalledAttempts", async () => {
      const maxStalledAttempts = 4;
      let calls = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => {
        calls += 1;
        return Promise.reject(new Error("still failing"));
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(runner.run(op));

      const error = thrown as M3LError;
      expect(error.code).toBe("ERR_NO_PROGRESS");
      expect(error.context["stalledAttempts"]).toBe(maxStalledAttempts);
      expect(error.context["attempts"]).toBe(calls);
    });

    test("the rejection happens without sleeping the backoff for the tripping attempt", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const maxStalledAttempts = 3;
      let calls = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => {
        calls += 1;
        return Promise.reject(new Error("still failing"));
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(runner.run(op));

      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      expect(setTimeoutSpy.mock.calls).toHaveLength(calls - 1);
    });

    test("a witness returning a different value every attempt never trips the guard — original error propagates at exhaustion", async () => {
      const maxAttempts = 6;
      const original = new Error("still failing");
      let counter = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => Promise.reject(original);
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: {
          witness: () => {
            counter += 1;
            return counter;
          },
          maxStalledAttempts: 3,
        },
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
    });

    test("reset on change: stalling for maxStalledAttempts-1, changing, then stalling again for maxStalledAttempts-1 never trips", async () => {
      const maxAttempts = 10;
      const maxStalledAttempts = 3;
      const original = new Error("still failing");
      let witnessCalls = 0;
      const witness = (): string => {
        witnessCalls += 1;
        if (witnessCalls <= 3) return "a";
        if (witnessCalls <= 6) return "b";
        return `unique-${String(witnessCalls)}`;
      };
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => Promise.reject(original);
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness, maxStalledAttempts },
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
    });

    test("the witness is not sampled on the attempt where the operation resolves", async () => {
      const witness = vi.fn(() => "same");
      let calls = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<string> => {
        calls += 1;
        if (calls < 3) return Promise.reject(new Error("still failing"));
        return Promise.resolve("done");
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 10,
        progress: { witness, maxStalledAttempts: 10 },
      });

      await expect(settleWithTimers(runner.run(op))).resolves.toBe("done");
      // Sampled only on the two retried (failed) attempts, never the
      // successful 3rd.
      expect(witness).toHaveBeenCalledTimes(2);
    });

    test("the witness is not sampled on a fatally-classified attempt", async () => {
      const witness = vi.fn(() => "same");
      let calls = 0;
      const original = new Error("nope");
      const classifier: M3LRetryClassifier = () => {
        calls += 1;
        return calls < 3 ? "retriable" : "fatal";
      };
      const op = (): Promise<never> => Promise.reject(original);
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 10,
        progress: { witness, maxStalledAttempts: 10 },
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
      // Sampled on the two retried attempts only — never on the 3rd (fatal).
      expect(witness).toHaveBeenCalledTimes(2);
    });

    test("the witness is not sampled on the ceiling-exhausting attempt", async () => {
      const witness = vi.fn(() => "same");
      const maxAttempts = 3;
      const original = new Error("still failing");
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => Promise.reject(original);
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness, maxStalledAttempts: 10 },
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
      expect(witness).toHaveBeenCalledTimes(maxAttempts - 1);
    });
  });

  describe("absent a `progress` option, behaviour is unchanged (regression lock)", () => {
    // These assert TODAY's pre-existing behaviour explicitly, per the doc's
    // "absent a progress option, behaviour is unchanged" clause — they are a
    // regression lock, not proof the feature exists, and are expected to
    // stay green both before and after the option is implemented.

    test("M3LPoller with no progress option exhausts with ERR_POLL_EXHAUSTED after exactly maxAttempts invocations", async () => {
      const maxAttempts = 5;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
      expect(calls).toBe(maxAttempts);
    });

    test("M3LRetryRunner with no progress option exhausts and re-throws the original error unchanged", async () => {
      const maxAttempts = 5;
      let calls = 0;
      const original = new Error("still failing");
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => {
        calls += 1;
        return Promise.reject(original);
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts,
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
      expect(calls).toBe(maxAttempts);
    });
  });

  describe("precedence / ordering (both arms genuinely reachable)", () => {
    test("an abort observed on a stalled attempt rejects with ERR_OPERATION_ABORTED, not ERR_NO_PROGRESS", async () => {
      // Reachability proof: maxStalledAttempts is set so the counter reaches
      // its trigger point on the SAME attempt whose check() call also fires
      // the abort — so a naive implementation that checked no-progress before
      // re-checking the signal would incorrectly throw ERR_NO_PROGRESS here.
      const maxStalledAttempts = 3;
      const controller = new AbortController();
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        // On the call that would be the (maxStalledAttempts + 1)-th sample —
        // i.e. the one that trips the guard — abort first.
        if (calls === maxStalledAttempts + 1) {
          controller.abort();
        }
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        signal: controller.signal,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
      expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
    });

    test("M3LRetryRunner: a classifier returning 'fatal' on an attempt where the witness has also stalled to its trigger point throws the original error, not ERR_NO_PROGRESS", async () => {
      // Reachability proof: maxStalledAttempts is set so that, HAD the
      // classifier returned "retriable" instead of "fatal" on the 3rd
      // attempt, the witness (constant throughout) would have reached its
      // trip threshold on that very attempt. The fatal verdict must win
      // regardless — the guard is only ever consulted on an attempt that
      // would otherwise schedule a retry.
      const maxStalledAttempts = 3;
      const original = new Error("fatal now");
      let calls = 0;
      const classifier: M3LRetryClassifier = () => {
        calls += 1;
        return calls < 3 ? "retriable" : "fatal";
      };
      const op = (): Promise<never> => Promise.reject(original);
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
    });

    test("M3LPoller: exhaustion wins over no-progress on the attempt that exhausts the ceiling, even when the witness has been stalled throughout", async () => {
      // Reachability proof: maxStalledAttempts equals maxAttempts, so if the
      // witness WERE sampled on the final (exhausting) attempt, the counter
      // would reach its trigger point on that exact attempt. The existing
      // exhaustion error must win instead.
      const maxAttempts = 3;
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness: () => "same", maxStalledAttempts: maxAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
    });

    test("M3LRetryRunner: exhaustion wins over no-progress on the attempt that exhausts the ceiling, even when the witness has been stalled throughout", async () => {
      const maxAttempts = 3;
      const original = new Error("still failing");
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => Promise.reject(original);
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: { witness: () => "same", maxStalledAttempts: maxAttempts },
      });

      await expect(settleWithTimers(runner.run(op))).rejects.toBe(original);
    });
  });

  describe("constructor validation — maxStalledAttempts", () => {
    test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "new M3LPoller({ progress: { maxStalledAttempts: %s } }) throws ERR_POLLING_INVALID_OPTION",
      (maxStalledAttempts) => {
        let thrown: unknown;
        try {
          new M3LPoller({
            backoff: M3LBackoff.constant(10),
            progress: { witness: () => "x", maxStalledAttempts },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLLING_INVALID_OPTION");
      },
    );

    test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "new M3LRetryRunner({ progress: { maxStalledAttempts: %s } }) throws ERR_POLLING_INVALID_OPTION",
      (maxStalledAttempts) => {
        let thrown: unknown;
        try {
          new M3LRetryRunner({
            classifier: awsThrottlingClassifier,
            backoff: M3LBackoff.constant(10),
            progress: { witness: () => "x", maxStalledAttempts },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_POLLING_INVALID_OPTION");
      },
    );
  });

  describe("per-call isolation", () => {
    // Discriminator: witness is a SINGLE universal constant shared by both
    // concurrent calls (no caller-identity trick needed, which would race
    // across the microtask boundary between check() and witness sampling).
    // A correct per-call-frame counter requires each call's OWN
    // maxStalledAttempts + 1 samples to trip. A buggy shared/instance-level
    // counter would combine both calls' witness invocations into one counter
    // and trip markedly EARLIER than that — so asserting the exact per-call
    // invocation count at the moment of rejection is the proof of isolation.
    test("two concurrent poll() calls on one instance track stall counters independently", async () => {
      const maxStalledAttempts = 4;
      const witness = (): string => "K";
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness, maxStalledAttempts },
      });

      let callsA = 0;
      let callsB = 0;
      const checkA: M3LPollCheckFn<never> = () => {
        callsA += 1;
        return { type: "continue" };
      };
      const checkB: M3LPollCheckFn<never> = () => {
        callsB += 1;
        return { type: "continue" };
      };

      const results = await settleWithTimers(
        Promise.allSettled([poller.poll(checkA), poller.poll(checkB)]),
      );

      for (const result of results) {
        expect(result.status).toBe("rejected");
        const reason = (result as PromiseRejectedResult).reason as unknown;
        expect(reason).toBeInstanceOf(M3LError);
        expect((reason as M3LError).code).toBe("ERR_NO_PROGRESS");
      }
      expect(callsA).toBe(maxStalledAttempts + 1);
      expect(callsB).toBe(maxStalledAttempts + 1);
    });

    test("two concurrent run() calls on one instance track stall counters independently", async () => {
      const maxStalledAttempts = 4;
      const witness = (): string => "K";
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness, maxStalledAttempts },
      });

      let callsA = 0;
      let callsB = 0;
      const opA = (): Promise<never> => {
        callsA += 1;
        return Promise.reject(new Error("a"));
      };
      const opB = (): Promise<never> => {
        callsB += 1;
        return Promise.reject(new Error("b"));
      };

      const results = await settleWithTimers(
        Promise.allSettled([runner.run(opA), runner.run(opB)]),
      );

      for (const result of results) {
        expect(result.status).toBe("rejected");
        const reason = (result as PromiseRejectedResult).reason as unknown;
        expect(reason).toBeInstanceOf(M3LError);
        expect((reason as M3LError).code).toBe("ERR_NO_PROGRESS");
      }
      expect(callsA).toBe(maxStalledAttempts + 1);
      expect(callsB).toBe(maxStalledAttempts + 1);
    });
  });

  describe("Object.is edge semantics", () => {
    test("a witness returning NaN every attempt DOES trip the guard (Object.is(NaN, NaN) === true)", async () => {
      const maxStalledAttempts = 3;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => Number.NaN, maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      expect(calls).toBe(maxStalledAttempts + 1);
    });

    test("a witness alternating 0 and -0 does NOT trip the guard (Object.is(0, -0) === false)", async () => {
      const maxAttempts = 10;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts,
        progress: {
          witness: () => {
            calls += 1;
            return calls % 2 === 0 ? 0 : -0;
          },
          maxStalledAttempts: 3,
        },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      // Every consecutive pair is (0, -0) or (-0, 0), which Object.is treats
      // as changed, so the counter must keep resetting — never trips.
      expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
    });
  });

  describe("telemetry — poll:no-progress / retry:no-progress", () => {
    test("poll:no-progress is emitted exactly once, on the tripping attempt, with the documented payload", async () => {
      const maxStalledAttempts = 3;
      let calls = 0;
      const check: M3LPollCheckFn<never> = () => {
        calls += 1;
        return { type: "continue" };
      };
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const received: M3LPollNoProgressPayload[] = [];
      poller.on("poll:no-progress", (payload) => {
        received.push(payload);
      });

      const thrown = await captureRejection(poller.poll(check));

      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        attempt: calls,
        stalledAttempts: maxStalledAttempts,
      });
    });

    test("retry:no-progress is emitted exactly once, on the tripping attempt, with the documented payload", async () => {
      const maxStalledAttempts = 3;
      let calls = 0;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> => {
        calls += 1;
        return Promise.reject(new Error("still failing"));
      };
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const received: M3LRetryNoProgressPayload[] = [];
      runner.on("retry:no-progress", (payload) => {
        received.push(payload);
      });

      const thrown = await captureRejection(runner.run(op));

      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        attempt: calls,
        stalledAttempts: maxStalledAttempts,
      });
    });

    test("an instance with no subscriber behaves identically (emission is observability only)", async () => {
      const maxStalledAttempts = 3;
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
    });

    test("a throwing poll:no-progress handler does not change the rejected error", async () => {
      const maxStalledAttempts = 3;
      const check: M3LPollCheckFn<never> = () => ({ type: "continue" });
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });
      poller.on("poll:no-progress", () => {
        throw new Error("handler boom");
      });

      const thrown = await captureRejection(poller.poll(check));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
    });

    test("a throwing retry:no-progress handler does not change the rejected error", async () => {
      const maxStalledAttempts = 3;
      const classifier: M3LRetryClassifier = () => "retriable";
      const op = (): Promise<never> =>
        Promise.reject(new Error("still failing"));
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 50,
        progress: { witness: () => "same", maxStalledAttempts },
      });
      runner.on("retry:no-progress", () => {
        throw new Error("handler boom");
      });

      const thrown = await captureRejection(runner.run(op));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_NO_PROGRESS");
    });
  });

  describe("error registration — ERR_NO_PROGRESS", () => {
    test("ERR_NO_PROGRESS is a member of M3L_ERROR_CODES", () => {
      expect(
        (M3L_ERROR_CODES as readonly string[]).includes("ERR_NO_PROGRESS"),
      ).toBe(true);
    });

    test("isM3LErrorCode('ERR_NO_PROGRESS') is true", () => {
      expect(isM3LErrorCode("ERR_NO_PROGRESS")).toBe(true);
    });

    test("classifyErrorCode('ERR_NO_PROGRESS') returns { origin: 'external', retryable: false }", () => {
      expect(classifyErrorCode("ERR_NO_PROGRESS")).toEqual({
        origin: "external",
        retryable: false,
      });
    });
  });

  describe("type-level contract", () => {
    test("M3LPollerOptions.progress is optional", () => {
      expectTypeOf<M3LPollerOptions>().toHaveProperty("progress");
      const withoutProgress: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
      };
      expect(withoutProgress).toBeTruthy();
    });

    test("M3LRetryRunnerOptions.progress is optional", () => {
      expectTypeOf<M3LRetryRunnerOptions>().toHaveProperty("progress");
      const withoutProgress: M3LRetryRunnerOptions = {
        classifier: awsThrottlingClassifier,
      };
      expect(withoutProgress).toBeTruthy();
    });

    test("witness returns string | number | bigint | boolean", () => {
      const options: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        progress: {
          witness: () => "ok",
          maxStalledAttempts: 3,
        },
      };
      expect(options).toBeTruthy();

      const numeric: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        progress: {
          witness: () => 1,
          maxStalledAttempts: 3,
        },
      };
      expect(numeric).toBeTruthy();

      const big: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        progress: {
          witness: () => 1n,
          maxStalledAttempts: 3,
        },
      };
      expect(big).toBeTruthy();

      const bool: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        progress: {
          witness: () => true,
          maxStalledAttempts: 3,
        },
      };
      expect(bool).toBeTruthy();
    });

    // `witness` is typed to return only a primitive (`string | number | bigint
    // | boolean`), never an object: an object witness would compare unequal on
    // every call under `Object.is` (each invocation returns a fresh
    // reference), so the stall counter would never see two consecutive equal
    // samples and the guard would silently never fire — precisely the failure
    // this option exists to catch. The two tests below are the compile-time
    // proof of that constraint.
    test("a witness returning an object is a type error", () => {
      const options: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        progress: {
          // @ts-expect-error witness must return a primitive, not an object
          witness: () => ({ token: "x" }),
          maxStalledAttempts: 3,
        },
      };
      expect(options).toBeTruthy();
    });

    test("a witness returning void is a type error", () => {
      const options: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        progress: {
          // @ts-expect-error witness must return a primitive, not void
          witness: () => {
            /* no return */
          },
          maxStalledAttempts: 3,
        },
      };
      expect(options).toBeTruthy();
    });

    test("maxStalledAttempts is typed number", () => {
      expectTypeOf<
        NonNullable<M3LPollerOptions["progress"]>["maxStalledAttempts"]
      >().toBeNumber();
      expectTypeOf<
        NonNullable<M3LRetryRunnerOptions["progress"]>["maxStalledAttempts"]
      >().toBeNumber();
    });

    test("supplying witness without maxStalledAttempts is a type error", () => {
      const options: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        // @ts-expect-error maxStalledAttempts is required alongside witness
        progress: {
          witness: () => "ok",
        },
      };
      expect(options).toBeTruthy();
    });

    test("supplying maxStalledAttempts without witness is a type error", () => {
      const options: M3LPollerOptions = {
        backoff: M3LBackoff.constant(10),
        // @ts-expect-error witness is required alongside maxStalledAttempts
        progress: {
          maxStalledAttempts: 3,
        },
      };
      expect(options).toBeTruthy();
    });

    test("M3LPollNoProgressPayload and M3LRetryNoProgressPayload have the documented shape", () => {
      expectTypeOf<M3LPollNoProgressPayload>().toEqualTypeOf<{
        readonly attempt: number;
        readonly stalledAttempts: number;
      }>();
      expectTypeOf<M3LRetryNoProgressPayload>().toEqualTypeOf<{
        readonly attempt: number;
        readonly stalledAttempts: number;
      }>();
    });

    test("M3LPollerEventMap and M3LRetryEventMap carry the new no-progress keys", () => {
      expectTypeOf<
        M3LPollerEventMap["poll:no-progress"]
      >().toEqualTypeOf<M3LPollNoProgressPayload>();
      expectTypeOf<
        M3LRetryEventMap["retry:no-progress"]
      >().toEqualTypeOf<M3LRetryNoProgressPayload>();
    });
  });
});
