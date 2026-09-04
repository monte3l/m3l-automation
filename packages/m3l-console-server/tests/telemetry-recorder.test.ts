/**
 * Tests for src/telemetry-recorder.ts — `createStoreTelemetryRecorder`, the
 * store-backed `M3LTelemetryRecorder` adapter (`src/telemetry/port.ts`) that
 * fans every sample out to all three rollup granularity tiers
 * (`minute`/`hour`/`day`) via `M3LConsoleTelemetryRepository.recordAll`, from
 * a single clock read per call.
 *
 * RED: `../src/telemetry-recorder.ts` and `../src/telemetry/port.ts` do not
 * exist yet — every import below is expected to fail to resolve until the
 * implementer lands both modules. `../src/store/telemetry-repository.js` is
 * already shipped and real (X8 slice 1) — this file drives it for real via
 * `telemetryBucketStartMs`, against a hand-written fake
 * `M3LConsoleTelemetryRepository` that captures every `recordAll` argument.
 *
 * The logger side follows the sanctioned test-double pattern used across
 * this package (`tests/access-log.test.ts`, `tests/runs-orchestrator-audit.test.ts`):
 * `Core.M3LLogger` is a class with `#private` fields, so it is nominally
 * typed and cannot be satisfied by a hand-written object literal. Tests here
 * build a REAL `Core.M3LLogger` over a capturing `Core.M3LLoggerHandler` and
 * assert on the captured `Core.M3LLogEvent`s, never on a spy.
 */
import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { telemetryBucketStartMs } from "../src/store/telemetry-repository.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryMeasurement,
} from "../src/store/telemetry-repository.js";
import { createStoreTelemetryRecorder } from "../src/telemetry-recorder.js";
import type {
  M3LTelemetryHttpRequestSample,
  M3LTelemetryPolicyDecisionSample,
  M3LTelemetryRecorder,
  M3LTelemetryRunFinishedSample,
  M3LTelemetrySseStreamSample,
  M3LTelemetryStoreHealthSample,
} from "../src/telemetry/port.js";

/**
 * A fixed clock reading used across most tests: an arbitrary non-negative
 * safe integer, deliberately NOT aligned to any granularity boundary so the
 * per-tier `telemetryBucketStartMs` floor is actually exercised.
 */
const FIXED_NOW = 1_700_003_723_456;

/**
 * A second clock reading, ~90 days after {@link FIXED_NOW} — far enough that
 * every granularity tier's bucket differs from the one derived from
 * `FIXED_NOW`. Used to prove a recorder method reads the clock exactly ONCE:
 * if it read twice, at least one tier would land in a bucket derived from
 * this value instead.
 */
const DIFFERENT_NOW = FIXED_NOW + 90 * 24 * 60 * 60 * 1000;

/** A legal `httpRequest` sample. */
const HTTP_REQUEST_SAMPLE: M3LTelemetryHttpRequestSample = {
  route: "/api/v1/runs",
  outcome: "2xx",
  latencyMs: 42,
};

/** A legal `runFinished` sample with the optional `operation` populated. */
const RUN_FINISHED_SAMPLE_FULL: M3LTelemetryRunFinishedSample = {
  script: "example-export",
  operation: "export",
  outcome: "succeeded",
  durationMs: 1234,
};

/** A legal `runFinished` sample with the optional `operation` omitted entirely. */
const RUN_FINISHED_SAMPLE_MINIMAL: M3LTelemetryRunFinishedSample = {
  script: "example-export",
  outcome: "succeeded",
  durationMs: 1234,
};

/** A legal `sseStream` sample. */
const SSE_STREAM_SAMPLE: M3LTelemetrySseStreamSample = {
  outcome: "closed",
};

/** A legal `policyDecision` sample. */
const POLICY_DECISION_SAMPLE: M3LTelemetryPolicyDecisionSample = {
  posture: "enforce",
  outcome: "denied",
};

/** A legal `storeHealth` sample. */
const STORE_HEALTH_SAMPLE: M3LTelemetryStoreHealthSample = {
  sizeBytes: 4_096,
};

/**
 * A hand-written fake `M3LConsoleTelemetryRepository` that captures every
 * `recordAll` argument in `calls`, in call order. `record` throws — the
 * recorder must fan out through a single `recordAll` call, never three
 * separate `record` calls (see `../docs` / the PR 2a contract, point 3).
 * `recordAllImpl` lets a test control `recordAll`'s return/throw behavior.
 */
function createFakeTelemetryRepository(
  recordAllImpl: (
    measurements: readonly M3LTelemetryMeasurement[],
  ) => number = (measurements) => measurements.length,
): {
  readonly repository: M3LConsoleTelemetryRepository;
  readonly calls: (readonly M3LTelemetryMeasurement[])[];
} {
  const calls: (readonly M3LTelemetryMeasurement[])[] = [];
  const repository: M3LConsoleTelemetryRepository = {
    record: () => {
      throw new Error(
        "createStoreTelemetryRecorder must fan out via recordAll, never record",
      );
    },
    recordAll: (measurements) => {
      calls.push(measurements);
      return recordAllImpl(measurements);
    },
    list: () => [],
    count: () => 0,
    prune: () => 0,
  };
  return { repository, calls };
}

/**
 * Builds a real `Core.M3LLogger` over a capturing `Core.M3LLoggerHandler` —
 * the sanctioned test-double pattern for `M3LLogger` (see this file's own
 * header comment).
 */
function buildLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events };
}

/** Builds a clock function that returns `FIXED_NOW` on its first call and `DIFFERENT_NOW` on every later call, plus a read counter. */
function createSingleReadClock(): {
  readonly now: () => number;
  readCount: number;
} {
  const state = { readCount: 0 };
  const now = (): number => {
    state.readCount += 1;
    return state.readCount === 1 ? FIXED_NOW : DIFFERENT_NOW;
  };
  return {
    now,
    get readCount(): number {
      return state.readCount;
    },
  };
}

/** One row of the per-method table driving the shared assertions below. */
interface MethodCase {
  readonly methodName: string;
  readonly metric: M3LTelemetryMeasurement["metric"];
  readonly invoke: (recorder: M3LTelemetryRecorder) => void;
}

const METHOD_CASES: readonly MethodCase[] = [
  {
    methodName: "httpRequest",
    metric: "http.request",
    invoke: (recorder) => recorder.httpRequest(HTTP_REQUEST_SAMPLE),
  },
  {
    methodName: "runFinished",
    metric: "run.finished",
    invoke: (recorder) => recorder.runFinished(RUN_FINISHED_SAMPLE_FULL),
  },
  {
    methodName: "sseStream",
    metric: "sse.stream",
    invoke: (recorder) => recorder.sseStream(SSE_STREAM_SAMPLE),
  },
  {
    methodName: "policyDecision",
    metric: "policy.decision",
    invoke: (recorder) => recorder.policyDecision(POLICY_DECISION_SAMPLE),
  },
  {
    methodName: "storeHealth",
    metric: "store.health",
    invoke: (recorder) => recorder.storeHealth(STORE_HEALTH_SAMPLE),
  },
];

describe("createStoreTelemetryRecorder — fan-out to all three granularity tiers", () => {
  test.each(METHOD_CASES)(
    "$methodName sends exactly one recordAll call with 3 measurements (minute, hour, day), all derived from a single clock read",
    ({ invoke, metric }) => {
      const clock = createSingleReadClock();
      const { repository, calls } = createFakeTelemetryRepository();
      const { logger } = buildLogger();
      const recorder = createStoreTelemetryRecorder({
        telemetry: repository,
        logger,
        now: clock.now,
      });

      invoke(recorder);

      expect(clock.readCount).toBe(1);
      expect(calls).toHaveLength(1);

      const measurements = calls[0];
      if (measurements === undefined) {
        throw new Error("expected exactly one recordAll call");
      }
      expect(measurements).toHaveLength(3);

      const [minute, hour, day] = measurements;
      if (minute === undefined || hour === undefined || day === undefined) {
        throw new Error("expected minute, hour, and day measurements");
      }

      expect([minute.granularity, hour.granularity, day.granularity]).toEqual([
        "minute",
        "hour",
        "day",
      ]);
      expect([minute.metric, hour.metric, day.metric]).toEqual([
        metric,
        metric,
        metric,
      ]);
      expect(minute.bucketStartMs).toBe(
        telemetryBucketStartMs(FIXED_NOW, "minute"),
      );
      expect(hour.bucketStartMs).toBe(
        telemetryBucketStartMs(FIXED_NOW, "hour"),
      );
      expect(day.bucketStartMs).toBe(telemetryBucketStartMs(FIXED_NOW, "day"));
    },
  );
});

describe("createStoreTelemetryRecorder — field mapping", () => {
  test("httpRequest maps latencyMs to valueMs and carries no valueBytes", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.httpRequest(HTTP_REQUEST_SAMPLE);

    const measurements = calls[0];
    const minute = measurements?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect(minute.metric).toBe("http.request");
    if (minute.metric !== "http.request") return;
    expect(minute.valueMs).toBe(HTTP_REQUEST_SAMPLE.latencyMs);
    expect(minute.route).toBe(HTTP_REQUEST_SAMPLE.route);
    expect(minute.outcome).toBe(HTTP_REQUEST_SAMPLE.outcome);
  });

  test("runFinished maps durationMs to valueMs and carries the operation when supplied", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.runFinished(RUN_FINISHED_SAMPLE_FULL);

    const minute = calls[0]?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect(minute.metric).toBe("run.finished");
    if (minute.metric !== "run.finished") return;
    expect(minute.valueMs).toBe(RUN_FINISHED_SAMPLE_FULL.durationMs);
    expect(minute.script).toBe(RUN_FINISHED_SAMPLE_FULL.script);
    expect(minute.operation).toBe(RUN_FINISHED_SAMPLE_FULL.operation);
  });

  test("runFinished with operation omitted sends no operation key at all (exactOptionalPropertyTypes)", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.runFinished(RUN_FINISHED_SAMPLE_MINIMAL);

    const minute = calls[0]?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect("operation" in minute).toBe(false);
  });

  test("sseStream carries no measure at all", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.sseStream(SSE_STREAM_SAMPLE);

    const minute = calls[0]?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect(minute.metric).toBe("sse.stream");
    if (minute.metric !== "sse.stream") return;
    expect(minute.valueMs).toBeUndefined();
    expect(minute.valueBytes).toBeUndefined();
    expect(minute.outcome).toBe(SSE_STREAM_SAMPLE.outcome);
  });

  /**
   * This is the layer that actually decides whether a measure leaks onto an
   * `sse.stream` row: `buildSseStreamMeasurement` is a total filter that
   * builds a fresh measurement from `sample.outcome` alone, before anything
   * reaches the repository. `tests/telemetry-sse-e2e.test.ts`'s NULL-measure
   * assertions look similar but are vacuous for this regression — the real
   * repository's `SQL_UPSERT_COUNTER` binds NULL literals unconditionally
   * for a counter metric and never reads a measure field off the
   * measurement, so a regression here would still persist as NULL and would
   * never be caught there. This test inspects the measurement object itself,
   * captured via `recordAll`, before any SQL literal can mask a regression.
   *
   * `Object.keys`/`Object.hasOwn`, never `toHaveProperty` — `not.toHaveProperty`
   * falls back to the `in` operator and walks the prototype chain, which
   * would make this assertion unfailable.
   */
  test("sseStream measurements' own keys carry no measure field on any granularity tier", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.sseStream(SSE_STREAM_SAMPLE);

    const measurements = calls[0];
    if (measurements === undefined) {
      throw new Error("expected exactly one recordAll call");
    }
    expect(measurements).toHaveLength(3);
    for (const measurement of measurements) {
      expect(Object.keys(measurement).sort()).toEqual(
        ["bucketStartMs", "granularity", "metric", "outcome"].sort(),
      );
      expect(Object.hasOwn(measurement, "valueMs")).toBe(false);
      expect(Object.hasOwn(measurement, "valueBytes")).toBe(false);
    }
  });

  test("policyDecision carries no measure at all", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.policyDecision(POLICY_DECISION_SAMPLE);

    const minute = calls[0]?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect(minute.metric).toBe("policy.decision");
    if (minute.metric !== "policy.decision") return;
    expect(minute.valueMs).toBeUndefined();
    expect(minute.valueBytes).toBeUndefined();
    expect(minute.posture).toBe(POLICY_DECISION_SAMPLE.posture);
  });

  test("storeHealth maps sizeBytes to valueBytes", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.storeHealth(STORE_HEALTH_SAMPLE);

    const minute = calls[0]?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect(minute.metric).toBe("store.health");
    if (minute.metric !== "store.health") return;
    expect(minute.valueBytes).toBe(STORE_HEALTH_SAMPLE.sizeBytes);
  });
});

describe("createStoreTelemetryRecorder — drop-and-log on a repository failure", () => {
  test.each(METHOD_CASES)(
    "$methodName: a recordAll failure is caught, logged via logger.error exactly once naming the metric, never at logger.warning, and never rethrown",
    ({ invoke, metric }) => {
      const { repository } = createFakeTelemetryRepository(() => {
        throw new Error("recordAll boom");
      });
      const { logger, events } = buildLogger();
      const recorder = createStoreTelemetryRecorder({
        telemetry: repository,
        logger,
        now: () => FIXED_NOW,
      });

      expect(() => invoke(recorder)).not.toThrow();

      const drops = events.filter(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      );
      expect(drops).toHaveLength(1);
      const [drop] = drops;
      if (drop === undefined) {
        throw new Error("expected exactly one error event");
      }
      expect(JSON.stringify(drop)).toContain(metric);

      // A drop logged at BOTH levels would still satisfy the assertions
      // above; pin the absence of the old WARNING level too, or a recorder
      // that logs at both severities would still pass.
      const warningEvents = events.filter(
        (event) => event.category === Core.M3LLogEventCategory.WARNING,
      );
      expect(warningEvents).toHaveLength(0);
    },
  );

  test("a thrown M3LConsoleError carrying context.recordedCount surfaces that count in the error payload", () => {
    const recordedCount = 2;
    const thrown = new M3LConsoleError(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      "console telemetry repository recordAll failed",
      { context: { recordedCount } },
    );
    const { repository } = createFakeTelemetryRepository(() => {
      throw thrown;
    });
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    expect(() => recorder.httpRequest(HTTP_REQUEST_SAMPLE)).not.toThrow();

    const drops = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    const [drop] = drops;
    if (drop === undefined) {
      throw new Error("expected exactly one error event");
    }
    expect(JSON.stringify(drop)).toContain(String(recordedCount));
  });
});

describe("createStoreTelemetryRecorder — clock defaulting", () => {
  test("now omitted defaults to Date.now: the recorded bucket falls inside a [before, after] bracket", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
    });

    const before = Date.now();
    recorder.httpRequest(HTTP_REQUEST_SAMPLE);
    const after = Date.now();

    const minute = calls[0]?.[0];
    if (minute === undefined) throw new Error("expected a minute measurement");
    expect(minute.bucketStartMs).toBeGreaterThanOrEqual(
      telemetryBucketStartMs(before, "minute"),
    );
    expect(minute.bucketStartMs).toBeLessThanOrEqual(
      telemetryBucketStartMs(after, "minute"),
    );
  });
});

/**
 * [KNOWN BUG — defect 1] every recorder method calls
 * `fanOut(telemetry, logger, "<metric>", now(), ...)`: JS evaluates
 * arguments in the caller's own scope, so `now()` runs BEFORE `fanOut`'s own
 * `try` is entered. A `now` that throws therefore propagates straight out
 * of the recorder method, into the caller — breaking the "never throws"
 * contract stated in this module's own header and in `telemetry/port.ts`
 * (the deliberate inverse of `audit/port.ts`; see `runs/audit.ts:14-19`).
 * The recorder must catch a throwing clock read too, and still report the
 * drop through `logger.error` naming the metric.
 */
describe("createStoreTelemetryRecorder — [KNOWN BUG] a throwing clock read must not escape", () => {
  test.each(METHOD_CASES)(
    "$methodName: a throwing `now` does not escape the method and is still reported via logger.error naming the metric",
    ({ invoke, metric }) => {
      const { repository } = createFakeTelemetryRepository();
      const { logger, events } = buildLogger();
      const recorder = createStoreTelemetryRecorder({
        telemetry: repository,
        logger,
        now: () => {
          throw new Error("clock read failed");
        },
      });

      expect(() => invoke(recorder)).not.toThrow();

      const drops = events.filter(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      );
      expect(drops).toHaveLength(1);
      const [drop] = drops;
      if (drop === undefined) {
        throw new Error("expected exactly one error event");
      }
      expect(JSON.stringify(drop)).toContain(metric);
    },
  );
});

/**
 * [KNOWN BUG — defect 2] `reportDroppedFanOut` reads `Core.getErrorMessage(cause)`
 * directly, unguarded. `packages/m3l-common/src/core/logging/M3LLogger.ts`
 * wraps that exact call in a `safeGetErrorMessage` helper precisely because
 * a caught value's own `.message` getter can throw (an `Error` subclass, or
 * a post-construction `Object.defineProperty` override) — and when it does,
 * `reportDroppedFanOut` throws from inside `fanOut`'s own `catch` block,
 * escaping to the caller. This constructs exactly that hostile value: a
 * real `Error` whose `message` accessor is overridden, post-construction,
 * to throw.
 */
describe("createStoreTelemetryRecorder — [KNOWN BUG] a hostile `message` getter on the dropped cause must not escape", () => {
  test("a recordAll failure whose thrown value has a throwing `message` getter does not escape and still reports the drop naming the metric", () => {
    const thrown = new Error("placeholder — never actually read");
    Object.defineProperty(thrown, "message", {
      get(): string {
        throw new Error("reading .message itself throws");
      },
    });
    const { repository } = createFakeTelemetryRepository(() => {
      throw thrown;
    });
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    expect(() => recorder.httpRequest(HTTP_REQUEST_SAMPLE)).not.toThrow();

    const drops = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(drops).toHaveLength(1);
    const [drop] = drops;
    if (drop === undefined) {
      throw new Error("expected exactly one error event");
    }
    expect(JSON.stringify(drop)).toContain("http.request");
  });
});

// ---------------------------------------------------------------------------
// Per-field read-count and tier-divergence fixtures (KNOWN BUG — defect 3)
// ---------------------------------------------------------------------------

/**
 * Builds a getter-backed value that counts how many times it has been read.
 * Used by the read-count fixtures below to prove each recorder method reads
 * every sample field exactly once per call, regardless of how many
 * granularity tiers `fanOut` fans the sample out to.
 */
function createReadCounter<T>(value: T): {
  readonly get: () => T;
  readonly count: () => number;
} {
  let count = 0;
  return {
    get: (): T => {
      count += 1;
      return value;
    },
    count: (): number => count,
  };
}

/**
 * A sequence of distinct, individually valid dimension strings. Every entry
 * independently passes `store/telemetry-validation.ts`'s guards (non-empty,
 * distinct) even though these tests drive the hand-written FAKE repository
 * (`createFakeTelemetryRepository`), which performs no validation itself —
 * keeping every value independently valid means a failure below is provably
 * a tier divergence, never a fixture a real repository would reject anyway.
 * Six entries, not three: a conditional-spread field (`run.finished`'s
 * `operation`, `sse.stream`'s and `policy.decision`'s `outcome`) is read
 * TWICE per tier today (an existence check, then the spread value), so a
 * three-tier fan-out can consume up to six reads of one field.
 */
const STRING_SEQUENCE = ["a1", "a2", "a3", "a4", "a5", "a6"] as const;

/** The numeric counterpart of {@link STRING_SEQUENCE} — distinct non-negative safe integers. */
const NUMBER_SEQUENCE = [10, 20, 30, 40, 50, 60] as const;

/**
 * Builds a getter-backed value that yields the next entry of `values` on
 * each read, throwing once the fixture is under-provisioned rather than
 * silently recycling a value — a recycled value could mask a real
 * divergence as a coincidental match.
 */
function createSequenceCounter<T>(values: readonly T[]): () => T {
  let index = 0;
  return (): T => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error(
        "createSequenceCounter exhausted — extend the fixture sequence",
      );
    }
    return value;
  };
}

/** Asserts no `logger.error` drop was recorded — i.e. the fan-out was accepted, not rejected. */
function expectNoDrop(events: readonly Core.M3LLogEvent[]): void {
  const drops = events.filter(
    (event) => event.category === Core.M3LLogEventCategory.ERROR,
  );
  expect(drops).toHaveLength(0);
}

describe("createStoreTelemetryRecorder — [KNOWN BUG — defect 3] every sample field must be read exactly once per call", () => {
  /**
   * `fanOut` (`src/telemetry-recorder.ts:150-158`) maps `build` over all
   * three `GRANULARITIES` from a single `sample` closed over by the
   * caller's method, so every builder body (`:161-235`) re-reads each
   * `sample.<field>` once per tier: 3 reads for a plain field, 6 for a
   * conditional-spread optional field (`sample.field !== undefined &&
   * { field: sample.field }` reads the getter twice per tier). This is why
   * `route`/`script`/`outcome`/`posture` — the rollup's PRIMARY KEY
   * dimensions — must be read exactly ONCE: a caller-supplied accessor that
   * changes value between reads can otherwise make one recorder call
   * persist three rows with different primary keys (see the tier-divergence
   * `describe` block below).
   */
  test("httpRequest: route, outcome and latencyMs are each read exactly once (observed today: 3 reads each)", () => {
    const route = createReadCounter("a1");
    const outcome = createReadCounter("2xx");
    const latencyMs = createReadCounter(10);
    const sample: M3LTelemetryHttpRequestSample = {
      get route(): string {
        return route.get();
      },
      get outcome(): string {
        return outcome.get();
      },
      get latencyMs(): number {
        return latencyMs.get();
      },
    };
    const { repository } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.httpRequest(sample);

    expect(route.count()).toBe(1); // observed today: 3 (once per granularity tier)
    expect(outcome.count()).toBe(1); // observed today: 3
    expect(latencyMs.count()).toBe(1); // observed today: 3
  });

  test("runFinished: script, operation, outcome and durationMs are each read exactly once (observed today: 3 reads, 6 for the conditional-spread `operation`)", () => {
    const script = createReadCounter("example-export");
    const operation = createReadCounter("export");
    const outcome = createReadCounter("succeeded");
    const durationMs = createReadCounter(1234);
    const sample: M3LTelemetryRunFinishedSample = {
      get script(): string {
        return script.get();
      },
      get operation(): string {
        return operation.get();
      },
      get outcome(): string {
        return outcome.get();
      },
      get durationMs(): number {
        return durationMs.get();
      },
    };
    const { repository } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.runFinished(sample);

    expect(script.count()).toBe(1); // observed today: 3
    expect(operation.count()).toBe(1); // observed today: 6 (conditional-spread: existence check + value, per tier)
    expect(outcome.count()).toBe(1); // observed today: 3
    expect(durationMs.count()).toBe(1); // observed today: 3
  });

  test("sseStream: outcome is read exactly once (observed today: 6 — conditional-spread, existence check + value, per tier)", () => {
    const outcome = createReadCounter("closed");
    const sample: M3LTelemetrySseStreamSample = {
      get outcome(): string {
        return outcome.get();
      },
    };
    const { repository } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.sseStream(sample);

    expect(outcome.count()).toBe(1); // observed today: 6
  });

  test("policyDecision: posture and outcome are each read exactly once (observed today: 3 for posture, 6 for the conditional-spread outcome)", () => {
    const posture = createReadCounter("enforce");
    const outcome = createReadCounter("denied");
    const sample: M3LTelemetryPolicyDecisionSample = {
      get posture(): string {
        return posture.get();
      },
      get outcome(): string {
        return outcome.get();
      },
    };
    const { repository } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.policyDecision(sample);

    expect(posture.count()).toBe(1); // observed today: 3
    expect(outcome.count()).toBe(1); // observed today: 6
  });

  test("storeHealth: sizeBytes is read exactly once (observed today: 3)", () => {
    const sizeBytes = createReadCounter(4_096);
    const sample: M3LTelemetryStoreHealthSample = {
      get sizeBytes(): number {
        return sizeBytes.get();
      },
    };
    const { repository } = createFakeTelemetryRepository();
    const { logger } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.storeHealth(sample);

    expect(sizeBytes.count()).toBe(1); // observed today: 3
  });
});

describe("createStoreTelemetryRecorder — [KNOWN BUG — defect 3] the three granularity tiers must not diverge on a changing sample field", () => {
  /**
   * `fanOut` builds a fresh measurement per tier from the SAME `sample`
   * closure but does not snapshot each field once up front — see this
   * file's sibling `describe` block above. A caller-supplied sample whose
   * field is an accessor returning a changing sequence (a monotonic
   * counter, anything mutable read between calls) therefore lets the
   * minute/hour/day tiers persist three DIFFERENT primary-key rows from
   * what should be one logical measurement. Every sequence value below is
   * individually a legal column value (non-empty distinct string / distinct
   * non-negative safe integer) so a failure here is a genuine divergence
   * across tiers, never a validation drop — `expectNoDrop` confirms no
   * `logger.error` fired, i.e. the fan-out was accepted rather than
   * rejected.
   */
  test("httpRequest: route, outcome and latencyMs are identical across all three tiers and equal the first sequence value", () => {
    const route = createSequenceCounter(STRING_SEQUENCE);
    const outcome = createSequenceCounter(STRING_SEQUENCE);
    const latencyMs = createSequenceCounter(NUMBER_SEQUENCE);
    const sample: M3LTelemetryHttpRequestSample = {
      get route(): string {
        return route();
      },
      get outcome(): string {
        return outcome();
      },
      get latencyMs(): number {
        return latencyMs();
      },
    };
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.httpRequest(sample);

    expectNoDrop(events);
    const measurements = calls[0];
    if (measurements === undefined || measurements.length !== 3) {
      throw new Error(
        "expected exactly one recordAll call with 3 measurements",
      );
    }
    const [minute, hour, day] = measurements;
    if (minute === undefined || hour === undefined || day === undefined) {
      throw new Error("expected minute, hour, and day measurements");
    }
    expect([minute.metric, hour.metric, day.metric]).toEqual([
      "http.request",
      "http.request",
      "http.request",
    ]);
    if (
      minute.metric !== "http.request" ||
      hour.metric !== "http.request" ||
      day.metric !== "http.request"
    ) {
      return;
    }
    expect([minute.route, hour.route, day.route]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
    expect([minute.outcome, hour.outcome, day.outcome]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
    expect([minute.valueMs, hour.valueMs, day.valueMs]).toEqual([
      NUMBER_SEQUENCE[0],
      NUMBER_SEQUENCE[0],
      NUMBER_SEQUENCE[0],
    ]);
  });

  test("runFinished: script, operation, outcome and durationMs are identical across all three tiers and equal the first sequence value", () => {
    const script = createSequenceCounter(STRING_SEQUENCE);
    const operation = createSequenceCounter(STRING_SEQUENCE);
    const outcome = createSequenceCounter(STRING_SEQUENCE);
    const durationMs = createSequenceCounter(NUMBER_SEQUENCE);
    const sample: M3LTelemetryRunFinishedSample = {
      get script(): string {
        return script();
      },
      get operation(): string {
        return operation();
      },
      get outcome(): string {
        return outcome();
      },
      get durationMs(): number {
        return durationMs();
      },
    };
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.runFinished(sample);

    expectNoDrop(events);
    const measurements = calls[0];
    if (measurements === undefined || measurements.length !== 3) {
      throw new Error(
        "expected exactly one recordAll call with 3 measurements",
      );
    }
    const [minute, hour, day] = measurements;
    if (minute === undefined || hour === undefined || day === undefined) {
      throw new Error("expected minute, hour, and day measurements");
    }
    expect([minute.metric, hour.metric, day.metric]).toEqual([
      "run.finished",
      "run.finished",
      "run.finished",
    ]);
    if (
      minute.metric !== "run.finished" ||
      hour.metric !== "run.finished" ||
      day.metric !== "run.finished"
    ) {
      return;
    }
    expect([minute.script, hour.script, day.script]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
    expect([minute.operation, hour.operation, day.operation]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
    expect([minute.outcome, hour.outcome, day.outcome]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
    expect([minute.valueMs, hour.valueMs, day.valueMs]).toEqual([
      NUMBER_SEQUENCE[0],
      NUMBER_SEQUENCE[0],
      NUMBER_SEQUENCE[0],
    ]);
  });

  test("sseStream: outcome is identical across all three tiers and equals the first sequence value", () => {
    const outcome = createSequenceCounter(STRING_SEQUENCE);
    const sample: M3LTelemetrySseStreamSample = {
      get outcome(): string {
        return outcome();
      },
    };
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.sseStream(sample);

    expectNoDrop(events);
    const measurements = calls[0];
    if (measurements === undefined || measurements.length !== 3) {
      throw new Error(
        "expected exactly one recordAll call with 3 measurements",
      );
    }
    const [minute, hour, day] = measurements;
    if (minute === undefined || hour === undefined || day === undefined) {
      throw new Error("expected minute, hour, and day measurements");
    }
    expect([minute.metric, hour.metric, day.metric]).toEqual([
      "sse.stream",
      "sse.stream",
      "sse.stream",
    ]);
    if (
      minute.metric !== "sse.stream" ||
      hour.metric !== "sse.stream" ||
      day.metric !== "sse.stream"
    ) {
      return;
    }
    expect([minute.outcome, hour.outcome, day.outcome]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
  });

  test("policyDecision: posture and outcome are identical across all three tiers and equal the first sequence value", () => {
    const posture = createSequenceCounter(STRING_SEQUENCE);
    const outcome = createSequenceCounter(STRING_SEQUENCE);
    const sample: M3LTelemetryPolicyDecisionSample = {
      get posture(): string {
        return posture();
      },
      get outcome(): string {
        return outcome();
      },
    };
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.policyDecision(sample);

    expectNoDrop(events);
    const measurements = calls[0];
    if (measurements === undefined || measurements.length !== 3) {
      throw new Error(
        "expected exactly one recordAll call with 3 measurements",
      );
    }
    const [minute, hour, day] = measurements;
    if (minute === undefined || hour === undefined || day === undefined) {
      throw new Error("expected minute, hour, and day measurements");
    }
    expect([minute.metric, hour.metric, day.metric]).toEqual([
      "policy.decision",
      "policy.decision",
      "policy.decision",
    ]);
    if (
      minute.metric !== "policy.decision" ||
      hour.metric !== "policy.decision" ||
      day.metric !== "policy.decision"
    ) {
      return;
    }
    expect([minute.posture, hour.posture, day.posture]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
    expect([minute.outcome, hour.outcome, day.outcome]).toEqual([
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
      STRING_SEQUENCE[0],
    ]);
  });

  test("storeHealth: sizeBytes is identical across all three tiers and equals the first sequence value", () => {
    const sizeBytes = createSequenceCounter(NUMBER_SEQUENCE);
    const sample: M3LTelemetryStoreHealthSample = {
      get sizeBytes(): number {
        return sizeBytes();
      },
    };
    const { repository, calls } = createFakeTelemetryRepository();
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    recorder.storeHealth(sample);

    expectNoDrop(events);
    const measurements = calls[0];
    if (measurements === undefined || measurements.length !== 3) {
      throw new Error(
        "expected exactly one recordAll call with 3 measurements",
      );
    }
    const [minute, hour, day] = measurements;
    if (minute === undefined || hour === undefined || day === undefined) {
      throw new Error("expected minute, hour, and day measurements");
    }
    expect([minute.metric, hour.metric, day.metric]).toEqual([
      "store.health",
      "store.health",
      "store.health",
    ]);
    if (
      minute.metric !== "store.health" ||
      hour.metric !== "store.health" ||
      day.metric !== "store.health"
    ) {
      return;
    }
    expect([minute.valueBytes, hour.valueBytes, day.valueBytes]).toEqual([
      NUMBER_SEQUENCE[0],
      NUMBER_SEQUENCE[0],
      NUMBER_SEQUENCE[0],
    ]);
  });
});

describe("createStoreTelemetryRecorder — [REGRESSION PIN] a throwing sample field getter must not escape (passes today)", () => {
  /**
   * PASSES today: the field read happens inside the `build` closure that
   * `fanOut` (`src/telemetry-recorder.ts:150-158`) invokes from within its
   * own `try`, so a throwing getter is caught by the same `catch` that
   * guards a throwing `now`/`recordAll` (see the "[KNOWN BUG] a throwing
   * clock read" `describe` block above). The pending fix for defect 3 moves
   * each field's read to a single up-front snapshot step, taken once before
   * the three per-tier `build` calls — that snapshot step MUST stay inside
   * this same `try`, or this pin starts failing the moment the fix lands.
   * This is a regression pin, not a proof the defect is fixed: do NOT
   * convert it to `test.fails`.
   */
  test("httpRequest: a sample whose route getter throws does not escape the recorder and is reported once naming the metric", () => {
    const sample: M3LTelemetryHttpRequestSample = {
      get route(): string {
        throw new Error("route getter boom");
      },
      outcome: "2xx",
      latencyMs: 10,
    };
    const { repository } = createFakeTelemetryRepository();
    const { logger, events } = buildLogger();
    const recorder = createStoreTelemetryRecorder({
      telemetry: repository,
      logger,
      now: () => FIXED_NOW,
    });

    expect(() => recorder.httpRequest(sample)).not.toThrow();

    const drops = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(drops).toHaveLength(1);
    const [drop] = drops;
    if (drop === undefined) {
      throw new Error("expected exactly one error event");
    }
    expect(JSON.stringify(drop)).toContain("http.request");
  });
});
