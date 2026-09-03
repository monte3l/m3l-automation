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
    "$methodName: a recordAll failure is caught, logged via logger.warning exactly once naming the metric, and never rethrown",
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

      const warnings = events.filter(
        (event) => event.category === Core.M3LLogEventCategory.WARNING,
      );
      expect(warnings).toHaveLength(1);
      const [warning] = warnings;
      if (warning === undefined) {
        throw new Error("expected exactly one warning event");
      }
      expect(JSON.stringify(warning)).toContain(metric);
    },
  );

  test("a thrown M3LConsoleError carrying context.recordedCount surfaces that count in the warn payload", () => {
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

    const warnings = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    const [warning] = warnings;
    if (warning === undefined) {
      throw new Error("expected exactly one warning event");
    }
    expect(JSON.stringify(warning)).toContain(String(recordedCount));
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
