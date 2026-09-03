/**
 * Tests for `core/polling`'s `pollDetailed`/`runDetailed` sibling methods
 * (RED phase — ADR-0086, U11 slice 5). The methods and their four result
 * types (`M3LPollAttemptEntry`, `M3LRetryAttemptEntry`,
 * `M3LPollDetailedResult<T>`, `M3LRetryDetailedResult<T>`) do not exist yet;
 * this file is deliberately separate from `tests/polling.test.ts` (zero
 * headroom against its file-budget baseline) and
 * `tests/polling-no-progress.test.ts` (26 bytes of headroom).
 *
 * Contract source: the hub's brief, itself derived from ADR-0086 and the
 * maintainer's settled envelope shape. An earlier draft of the brief stated
 * `entries.length === attempts` for both classes, which could not hold given
 * `M3LRetryAttemptEntry.classification`'s required-field contract (the
 * succeeding attempt is never classified). That was raised and the
 * maintainer settled a third, symmetric shape, recorded here as the
 * authoritative contract:
 *
 * `entries` covers only attempts that were followed by a wait — identical
 * rule for both `M3LPollDetailedResult` and `M3LRetryDetailedResult`. The
 * attempt that ultimately succeeds never gets an entry on either type, so
 * `entries.length === attempts - 1` (and `0` on a first-try success).
 * `delayMs` is therefore REQUIRED on both entry types, not optional: every
 * entry that exists, by construction, was followed by a sleep.
 *
 * This is verified against the source, not just asserted: `M3LPoller`'s
 * `#continueAttempt` skips the sleep only when
 * `attempt >= this.#maxAttempts - 1` — the ceiling-exhausting attempt, which
 * always throws `M3LPollExhaustedError` and never reaches a successful
 * result. `M3LRetryRunner`'s `#scheduleRetry` is reached only when
 * `attempt < lastAttempt` (`lastAttempt = maxAttempts - 1`); the
 * `attempt >= lastAttempt` branch always throws the original error instead.
 * So on any call that resolves a value, every entry's attempt did sleep —
 * there is no path where a non-final attempt of a successful call skips it.
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
// Internal, whitebox-only imports — both classes are private to
// `core/polling` (never re-exported through the barrel; see the file banner
// in `tests/polling.test.ts` for the same precedent), so a specific-subclass
// assertion is only possible by importing directly from their source path.
import {
  M3LPollExhaustedError,
  M3LPollFailureError,
} from "../src/internal/polling/errors.js";
import {
  M3LBackoff,
  M3LPoller,
  M3LRetryRunner,
} from "../src/core/polling/index.js";
import type {
  M3LPollAttemptEntry,
  M3LPollCheckFn,
  M3LPollDetailedResult,
  M3LRetryAdvice,
  M3LRetryAttemptEntry,
  M3LRetryClassifier,
  M3LRetryDecision,
  M3LRetryDetailedResult,
} from "../src/core/polling/index.js";

/**
 * Drive a promise to settlement while flushing all pending timers, so backoff
 * delays resolve without real wall-clock waits. Copied from `polling.test.ts`
 * (same convention, kept file-local so this file has no cross-file import).
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

describe("core/polling detailed results (ADR-0086)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("type-level contract: detailed result envelope shapes", () => {
    test("M3LPollAttemptEntry: attempt plus REQUIRED delayMs (every entry was followed by a sleep)", () => {
      expectTypeOf<M3LPollAttemptEntry>().toEqualTypeOf<{
        readonly attempt: number;
        readonly delayMs: number;
      }>();
    });

    test("M3LRetryAttemptEntry: attempt, classification narrowed to the raw-verdict union, REQUIRED delayMs", () => {
      // Narrowed from `string` (two reviewers flagged the wider type
      // discarded a guarantee the runtime already enforces:
      // `ResolvedRetryAction`'s retry arm — the only arm ever pushed into
      // `entries` — and the public `retry:scheduled` event both already
      // carry exactly this union).
      expectTypeOf<M3LRetryAttemptEntry>().toEqualTypeOf<{
        readonly attempt: number;
        readonly classification: "retriable" | "unknown";
        readonly delayMs: number;
      }>();
    });

    test("M3LRetryAttemptEntry.classification rejects a non-member literal — pins the narrowing against a future widening back to string", () => {
      expectTypeOf<"fatal">().not.toMatchTypeOf<
        M3LRetryAttemptEntry["classification"]
      >();
      expectTypeOf<"retriable">().toMatchTypeOf<
        M3LRetryAttemptEntry["classification"]
      >();
    });

    test("M3LPollDetailedResult<T> carries T through value and a readonly entries array", () => {
      expectTypeOf<M3LPollDetailedResult<string>>().toEqualTypeOf<{
        readonly value: string;
        readonly attempts: number;
        readonly entries: readonly M3LPollAttemptEntry[];
      }>();
      expectTypeOf<M3LPollDetailedResult<string>["entries"]>().toEqualTypeOf<
        readonly M3LPollAttemptEntry[]
      >();
      expectTypeOf<
        M3LPollDetailedResult<number>["value"]
      >().toEqualTypeOf<number>();
    });

    test("M3LRetryDetailedResult<T> carries T through value and a readonly entries array", () => {
      expectTypeOf<M3LRetryDetailedResult<string>>().toEqualTypeOf<{
        readonly value: string;
        readonly attempts: number;
        readonly entries: readonly M3LRetryAttemptEntry[];
      }>();
      expectTypeOf<M3LRetryDetailedResult<string>["entries"]>().toEqualTypeOf<
        readonly M3LRetryAttemptEntry[]
      >();
      expectTypeOf<
        M3LRetryDetailedResult<number>["value"]
      >().toEqualTypeOf<number>();
    });
  });

  describe("M3LPoller.pollDetailed", () => {
    test("resolves the succeeding value with attempts=1 and zero entries on a 1st-attempt success (no attempt was ever followed by a wait)", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(37) });

      const result = await settleWithTimers(
        poller.pollDetailed<string>(() => ({
          type: "success",
          value: "first-try",
        })),
      );

      expect(result.value).toBe("first-try");
      expect(result.attempts).toBe(1);
      expect(result.entries).toHaveLength(0);
    });

    test("resolves type is Promise<M3LPollDetailedResult<T>>", () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(1) });
      const detailedResult = poller.pollDetailed<number>(() => ({
        type: "success",
        value: 1,
      }));
      expectTypeOf(detailedResult).toEqualTypeOf<
        Promise<M3LPollDetailedResult<number>>
      >();
      void detailedResult.catch(() => undefined);
    });

    test("Nth-attempt success: entries.length === attempts - 1, entries[i].attempt === i+1, every entry carries the backoff delayMs that followed it", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(37) });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls++;
        if (calls < 3) return { type: "continue" };
        return { type: "success", value: "third-try" };
      };

      const result = await settleWithTimers(poller.pollDetailed(check));

      expect(result.value).toBe("third-try");
      expect(result.attempts).toBe(3);
      // Only the two continue attempts got entries — the succeeding 3rd
      // attempt never does, on either type, per the decided contract.
      expect(result.entries).toHaveLength(2);
      result.entries.forEach((entry, i) => {
        expect(entry.attempt).toBe(i + 1);
        expect(entry.delayMs).toBe(37);
      });
    });

    test("Nth-attempt success with DISTINCT per-attempt delays: entries[i].delayMs pins the specific value for attempt i, not a shared constant", async () => {
      // A `M3LBackoff.constant(...)` strategy returns the same number for
      // every attempt, so an off-by-one in which attempt's delay gets
      // recorded is invisible against it. `exponential` gives a different
      // delay per 0-based attempt index (`min(capMs, startMs * 2^attempt)`),
      // so this test can actually distinguish "recorded this attempt's
      // delay" from "recorded the previous/next attempt's delay".
      const poller = new M3LPoller({
        backoff: M3LBackoff.exponential(10, 100_000),
        maxAttempts: 10,
      });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls++;
        if (calls < 4) return { type: "continue" };
        return { type: "success", value: "fourth-try" };
      };

      const result = await settleWithTimers(poller.pollDetailed(check));

      expect(result.attempts).toBe(4);
      expect(result.entries).toHaveLength(3);
      // attempt indices 0,1,2 → startMs * 2^0, 2^1, 2^2 = 10, 20, 40.
      expect(result.entries[0]).toEqual({ attempt: 1, delayMs: 10 });
      expect(result.entries[1]).toEqual({ attempt: 2, delayMs: 20 });
      expect(result.entries[2]).toEqual({ attempt: 3, delayMs: 40 });
    });

    test("boundary: success exactly on the last allowed attempt — every continue entry still carries delayMs, and none exists for the succeeding attempt", async () => {
      // maxAttempts=3, continues on attempts 1 and 2 (neither is the
      // exhausting boundary — #continueAttempt's early return only fires
      // for attempt index maxAttempts-1, i.e. attempt 3), succeeds on 3.
      // NOTE: success never reaches that early-return branch at all (it
      // always throws instead of returning), so this exercises the exact
      // same code path as the preceding Nth-attempt-success test — it is
      // not a distinct boundary case from the implementation's side. Kept
      // as a named regression pin on the specific "uses the full budget"
      // shape, not as evidence of extra coverage.
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(11),
        maxAttempts: 3,
      });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls++;
        if (calls < 3) return { type: "continue" };
        return { type: "success", value: "used-full-budget" };
      };

      const result = await settleWithTimers(poller.pollDetailed(check));

      expect(result.attempts).toBe(3);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({ attempt: 1, delayMs: 11 });
      expect(result.entries[1]).toEqual({ attempt: 2, delayMs: 11 });
    });
    test("terminal failure decision: rejects with M3LPollFailureError, context.attempt is the failing 1-based attempt", async () => {
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 5,
      });
      let calls = 0;
      const check: M3LPollCheckFn<string> = () => {
        calls++;
        if (calls < 2) return { type: "continue" };
        return { type: "failure" };
      };

      let thrown: unknown;
      try {
        await settleWithTimers(poller.pollDetailed(check));
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(M3LPollFailureError);
      expect((thrown as M3LPollFailureError).context).toEqual({ attempt: 2 });
    });

    test("exhaustion: rejects with M3LPollExhaustedError, context.attempts is the configured bound", async () => {
      const poller = new M3LPoller({
        backoff: M3LBackoff.constant(10),
        maxAttempts: 4,
      });
      const check: M3LPollCheckFn<string> = () => ({ type: "continue" });

      let thrown: unknown;
      try {
        await settleWithTimers(poller.pollDetailed(check));
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(M3LPollExhaustedError);
      expect((thrown as M3LPollExhaustedError).context).toEqual({
        attempts: 4,
      });
    });

    describe("ADR-0049 abort contract", () => {
      test("already-aborted signal: rejects with ERR_OPERATION_ABORTED (origin caller, retryable false) without invoking the check", async () => {
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
            poller.pollDetailed(check as unknown as M3LPollCheckFn<string>),
          );
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        expect((thrown as M3LError).origin).toBe("caller");
        expect((thrown as M3LError).retryable).toBe(false);
        expect(check).not.toHaveBeenCalled();
      });

      test("abort during backoff delay: rejects promptly with ERR_OPERATION_ABORTED, never sleeps out the remaining delay", async () => {
        const controller = new AbortController();
        const poller = new M3LPoller({
          backoff: M3LBackoff.constant(60_000),
          signal: controller.signal,
          maxAttempts: 10,
        });
        let checkCount = 0;
        const check: M3LPollCheckFn<string> = () => {
          checkCount++;
          return { type: "continue" };
        };

        const pollPromise = poller.pollDetailed(check);
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

        await vi.advanceTimersByTimeAsync(0);
        expect(checkCount).toBe(1);

        controller.abort();
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toBe(true);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        expect(checkCount).toBe(1);
      });
    });
  });

  describe("M3LRetryRunner.runDetailed", () => {
    test("resolves the succeeding value with attempts=1 and zero entries on a 1st-attempt success (no attempt was ever followed by a wait)", async () => {
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(45),
      });

      const result = await settleWithTimers(
        runner.runDetailed(() => Promise.resolve("first-try")),
      );

      expect(result.value).toBe("first-try");
      expect(result.attempts).toBe(1);
      expect(result.entries).toHaveLength(0);
    });

    test("resolves type is Promise<M3LRetryDetailedResult<T>>", () => {
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(1),
      });
      const detailedResult = runner.runDetailed<number>(() =>
        Promise.resolve(1),
      );
      expectTypeOf(detailedResult).toEqualTypeOf<
        Promise<M3LRetryDetailedResult<number>>
      >();
      void detailedResult.catch(() => undefined);
    });

    test("Nth-attempt success: entries record each failed attempt's RAW classification sequence and the backoff delayMs that followed it", async () => {
      let callIndex = 0;
      // Different raw verdicts across attempts, proving the sequence is
      // recorded per-attempt rather than a single captured value.
      const classifier: M3LRetryClassifier = vi.fn(
        (): M3LRetryDecision | M3LRetryAdvice => {
          callIndex++;
          if (callIndex === 1) return "retriable";
          return { decision: "unknown" };
        },
      );
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(45),
        unknownDecision: "retriable",
      });
      let attempts = 0;
      const op = (): Promise<string> => {
        attempts++;
        if (attempts < 3) return Promise.reject(new Error(`fail-${attempts}`));
        return Promise.resolve("third-try");
      };

      const result = await settleWithTimers(runner.runDetailed(op));

      expect(result.value).toBe("third-try");
      expect(result.attempts).toBe(3);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({
        attempt: 1,
        classification: "retriable",
        delayMs: 45,
      });
      expect(result.entries[1]).toEqual({
        attempt: 2,
        classification: "unknown",
        delayMs: 45,
      });
    });

    test("Nth-attempt success with DISTINCT per-attempt delays: entries[i].delayMs pins the specific value for attempt i, not a shared constant", async () => {
      // Same rationale as the M3LPoller sibling test above: a
      // `M3LBackoff.constant(...)` strategy cannot distinguish "recorded
      // this attempt's delay" from "recorded a neighbouring attempt's".
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.exponential(10, 100_000),
        maxAttempts: 10,
      });
      let attempts = 0;
      const op = (): Promise<string> => {
        attempts++;
        if (attempts < 4) return Promise.reject(new Error(`fail-${attempts}`));
        return Promise.resolve("fourth-try");
      };

      const result = await settleWithTimers(runner.runDetailed(op));

      expect(result.attempts).toBe(4);
      expect(result.entries).toHaveLength(3);
      // attempt indices 0,1,2 → startMs * 2^0, 2^1, 2^2 = 10, 20, 40.
      expect(result.entries[0]).toEqual({
        attempt: 1,
        classification: "retriable",
        delayMs: 10,
      });
      expect(result.entries[1]).toEqual({
        attempt: 2,
        classification: "retriable",
        delayMs: 20,
      });
      expect(result.entries[2]).toEqual({
        attempt: 3,
        classification: "retriable",
        delayMs: 40,
      });
    });

    test("fatal classification: rejects with the ORIGINAL error, unchanged and identity-equal — never softened into a returned envelope", async () => {
      const classifier: M3LRetryClassifier = () => "fatal";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
      });
      const original = new Error("fatal op failure");
      const op = (): Promise<never> => Promise.reject(original);

      let thrown: unknown;
      try {
        await settleWithTimers(runner.runDetailed(op));
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBe(original);
    });

    test("exhaustion: rejects with the last attempt's ORIGINAL error, unchanged and identity-equal", async () => {
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
        maxAttempts: 2,
      });
      const errorOne = new Error("attempt-1-error");
      const errorTwo = new Error("attempt-2-error");
      let attempts = 0;
      const op = (): Promise<never> => {
        attempts++;
        return Promise.reject(attempts === 1 ? errorOne : errorTwo);
      };

      let thrown: unknown;
      try {
        await settleWithTimers(runner.runDetailed(op));
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBe(errorTwo);
    });

    describe("ADR-0049 abort contract", () => {
      test("already-aborted signal: rejects with ERR_OPERATION_ABORTED (origin caller, retryable false) without invoking the operation or the classifier", async () => {
        const controller = new AbortController();
        controller.abort();
        const classifier = vi
          .fn<(err: unknown) => M3LRetryDecision>()
          .mockReturnValue("retriable");
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
          await settleWithTimers(runner.runDetailed(op));
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        expect((thrown as M3LError).origin).toBe("caller");
        expect((thrown as M3LError).retryable).toBe(false);
        expect(op).not.toHaveBeenCalled();
        expect(classifier).not.toHaveBeenCalled();
      });

      test("abort while an attempt is in flight: NOT reclassified even by an always-retriable classifier — rejects ERR_OPERATION_ABORTED, never retries", async () => {
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

        const runPromise = runner.runDetailed(op);
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

        // Attempt 1 runs; the classifier is consulted for its transient error.
        await vi.advanceTimersByTimeAsync(0);
        expect(opCallCount).toBe(1);

        // Abort during the 60s backoff the "retriable" verdict scheduled.
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toBe(true);
        expect((thrown as M3LError).code).toBe("ERR_OPERATION_ABORTED");
        // Never retried: only the one call total.
        expect(opCallCount).toBe(1);
        // The classifier was consulted once for the transient error but was
        // never handed the abort error — abort bypasses the classifier
        // entirely (checked first in the catch block, per ADR-0049).
        const callsWithAbortCode = classifier.mock.calls.filter(
          ([err]) =>
            err instanceof M3LError && err.code === "ERR_OPERATION_ABORTED",
        );
        expect(callsWithAbortCode).toHaveLength(0);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });
    });
  });

  describe("poll()/run() unchanged — bare-value regression guard", () => {
    test("M3LPoller.poll still resolves the bare value, not an envelope", async () => {
      const poller = new M3LPoller({ backoff: M3LBackoff.constant(10) });
      const result = await settleWithTimers(
        poller.poll<string>(() => ({ type: "success", value: "bare-poll" })),
      );
      expect(result).toBe("bare-poll");
      expectTypeOf(result).toEqualTypeOf<string>();
    });

    test("M3LRetryRunner.run still resolves the bare value, not an envelope", async () => {
      const classifier: M3LRetryClassifier = () => "retriable";
      const runner = new M3LRetryRunner({
        classifier,
        backoff: M3LBackoff.constant(10),
      });
      const result = await settleWithTimers(
        runner.run(() => Promise.resolve("bare-run")),
      );
      expect(result).toBe("bare-run");
      expectTypeOf(result).toEqualTypeOf<string>();
    });
  });
});
