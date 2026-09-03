/**
 * `telemetry-recorder` — {@link createStoreTelemetryRecorder}, the
 * store-backed {@link "./telemetry/port.js".M3LTelemetryRecorder} adapter
 * (X8 telemetry recorder port, PR 2a).
 *
 * This module is deliberately zone-free: it sits directly under `src/`,
 * like `main.ts` and `subsystems.ts`, rather than inside any
 * `CONSOLE_SERVER_LAYERS` zone directory (`bin/check-eslint-zones.mjs`),
 * because it needs to import from both `telemetry/` (the port it
 * implements) and `store/` (the repository it fans measurements out to) —
 * an import combination no single zone directory is allowed to make. That
 * is also why `http/handler.ts` and `stream/event-stream.ts` cannot build
 * this adapter themselves: `bin/check-eslint-zones.mjs` forbids `http` and
 * `stream` from importing `store` at all, which is the entire reason the
 * port in `telemetry/port.ts` exists. Consequently, **only `main.ts` may
 * import this module** — no zoned file is permitted to.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "./errors/console-error.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryGranularity,
  M3LTelemetryMeasurement,
} from "./store/telemetry-repository.js";
import { telemetryBucketStartMs } from "./store/telemetry-repository.js";
import type {
  M3LTelemetryHttpRequestSample,
  M3LTelemetryPolicyDecisionSample,
  M3LTelemetryRecorder,
  M3LTelemetryRunFinishedSample,
  M3LTelemetrySseStreamSample,
  M3LTelemetryStoreHealthSample,
} from "./telemetry/port.js";

/**
 * Options for {@link createStoreTelemetryRecorder}.
 */
export interface M3LStoreTelemetryRecorderOptions {
  /** The rollup repository every sample is fanned out to. */
  readonly telemetry: M3LConsoleTelemetryRepository;
  /** Where a dropped fan-out is reported (see the module doc). */
  readonly logger: Core.M3LLogger;
  /** Clock seam; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The three rollup granularity tiers every sample fans out to, finest
 * first — so a partial `recordAll` failure (see
 * `store/telemetry-repository.ts`'s own docs on its no-transaction
 * semantics) still leaves the tier a monitoring page reads.
 */
const GRANULARITIES: readonly M3LTelemetryGranularity[] = [
  "minute",
  "hour",
  "day",
];

/**
 * Placeholder substituted for the dropped failure's message when reading it
 * throws. A fixed literal, never derived from `cause` — the point of
 * {@link safeGetErrorMessage} is that `cause` cannot be trusted enough to
 * read anything else off it once its `.message` accessor has already
 * proven hostile.
 */
const UNREADABLE_ERROR_MESSAGE = "[unreadable error message]";

/**
 * `Core.getErrorMessage`, guarded against a `cause` whose own `.message`
 * getter throws (an `Error` subclass, or a post-construction
 * `Object.defineProperty` override) — mirroring
 * `core/logging/M3LLogger.ts`'s `safeGetErrorMessage`. `reportDroppedFanOut`
 * runs from inside {@link fanOut}'s own `catch`; a classifier used on that
 * path must never itself throw (see `store/failures.ts`'s
 * `readStringProperty`/`readNumberProperty` for the same rule applied to
 * property reads), or the drop report itself escapes to the caller,
 * defeating the recorder's never-throws contract. Falls back to a fixed
 * placeholder rather than propagating.
 */
function safeGetErrorMessage(cause: unknown): string {
  try {
    return Core.getErrorMessage(cause);
  } catch {
    return UNREADABLE_ERROR_MESSAGE;
  }
}

/**
 * Reports a dropped fan-out through `logger.warning`, naming the metric and
 * the underlying failure's code/message, plus `context.recordedCount` when
 * the caught value is an {@link M3LConsoleError} carrying one
 * (`store/telemetry-repository.ts`'s `recordAll` attaches it) AND that
 * value is actually a `number` — `context` is typed `unknown`, and
 * `M3LConsoleRuntimeOptions.telemetry` is injectable, so a supplied
 * `recordAll` can throw an `M3LConsoleError` whose `recordedCount` is
 * anything at all, and this payload has no redaction coverage to fall back
 * on. The raw value is read into a local exactly once and that LOCAL is
 * narrowed and logged, so a hostile getter cannot return something
 * different on a second read. Never logs caller-supplied sample data
 * beyond the dimension names already destined for the rollup table.
 */
function reportDroppedFanOut(
  logger: Core.M3LLogger,
  metric: string,
  cause: unknown,
): void {
  const recordedCountValue =
    cause instanceof M3LConsoleError
      ? cause.context["recordedCount"]
      : undefined;
  const recordedCount =
    typeof recordedCountValue === "number" ? recordedCountValue : undefined;
  const data: Record<string, unknown> = {
    metric,
    message: safeGetErrorMessage(cause),
    ...(cause instanceof M3LConsoleError && { code: cause.code }),
    ...(recordedCount !== undefined && { recordedCount }),
  };
  logger.warning(`telemetry fan-out dropped for metric '${metric}'`, data);
}

/**
 * Fans one sample out to all three granularity tiers through a single
 * `telemetry.recordAll` call. Takes the clock FUNCTION rather than an
 * already-read `atMs`: reading the clock happens exactly once, inside this
 * function's own `try`, so a throwing `now` is caught by the same guard as
 * a throwing `recordAll` instead of propagating out of the caller's scope
 * before the `try` is even entered — JS evaluates call arguments in the
 * caller's own scope, which is what made the previous
 * `fanOut(..., now(), ...)` call shape unsafe and let a throwing clock
 * escape the recorder's never-throws contract. That single reading then
 * derives every tier's `bucketStartMs`, so the three tiers can never
 * straddle a boundary. Catches everything and reports through
 * {@link reportDroppedFanOut} rather than rethrowing.
 */
function fanOut(
  telemetry: M3LConsoleTelemetryRepository,
  logger: Core.M3LLogger,
  metric: string,
  now: () => number,
  build: (
    bucketStartMs: number,
    granularity: M3LTelemetryGranularity,
  ) => M3LTelemetryMeasurement,
): void {
  try {
    const atMs = now();
    const measurements = GRANULARITIES.map((granularity) =>
      build(telemetryBucketStartMs(atMs, granularity), granularity),
    );
    telemetry.recordAll(measurements);
  } catch (cause) {
    reportDroppedFanOut(logger, metric, cause);
  }
}

/** Maps an `httpRequest` sample onto one `"http.request"` measurement. */
function buildHttpRequestMeasurement(
  sample: M3LTelemetryHttpRequestSample,
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): M3LTelemetryMeasurement {
  return {
    metric: "http.request",
    granularity,
    bucketStartMs,
    route: sample.route,
    outcome: sample.outcome,
    valueMs: sample.latencyMs,
  };
}

/** Maps a `runFinished` sample onto one `"run.finished"` measurement. */
function buildRunFinishedMeasurement(
  sample: M3LTelemetryRunFinishedSample,
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): M3LTelemetryMeasurement {
  return {
    metric: "run.finished",
    granularity,
    bucketStartMs,
    script: sample.script,
    ...(sample.operation !== undefined && { operation: sample.operation }),
    outcome: sample.outcome,
    valueMs: sample.durationMs,
  };
}

/** Maps an `sseStream` sample onto one `"sse.stream"` measurement — a pure counter, no measure. */
function buildSseStreamMeasurement(
  sample: M3LTelemetrySseStreamSample,
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): M3LTelemetryMeasurement {
  return {
    metric: "sse.stream",
    granularity,
    bucketStartMs,
    ...(sample.outcome !== undefined && { outcome: sample.outcome }),
  };
}

/** Maps a `policyDecision` sample onto one `"policy.decision"` measurement — a pure counter, no measure. */
function buildPolicyDecisionMeasurement(
  sample: M3LTelemetryPolicyDecisionSample,
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): M3LTelemetryMeasurement {
  return {
    metric: "policy.decision",
    granularity,
    bucketStartMs,
    posture: sample.posture,
    ...(sample.outcome !== undefined && { outcome: sample.outcome }),
  };
}

/** Maps a `storeHealth` sample onto one `"store.health"` measurement. */
function buildStoreHealthMeasurement(
  sample: M3LTelemetryStoreHealthSample,
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): M3LTelemetryMeasurement {
  return {
    metric: "store.health",
    granularity,
    bucketStartMs,
    valueBytes: sample.sizeBytes,
  };
}

/**
 * Builds a {@link M3LTelemetryRecorder} backed by a
 * {@link M3LConsoleTelemetryRepository}: every method reads the clock
 * exactly once, builds one {@link M3LTelemetryMeasurement} per granularity
 * tier (`minute`, `hour`, `day`, in that order) from that single reading,
 * and fans them out through one `telemetry.recordAll` call — never three
 * separate `record` calls. A failure of any kind is caught, reported
 * through `logger.warning` (see {@link reportDroppedFanOut}), and never
 * rethrown: this recorder honors the same "never fails the caller" contract
 * as the port it implements (`telemetry/port.ts`).
 *
 * @param options - The backing repository, logger, and optional clock seam.
 * @returns A {@link M3LTelemetryRecorder} whose methods never throw.
 * @example
 * ```ts
 * import { createStoreTelemetryRecorder } from "@m3l-automation/m3l-console-server/telemetry-recorder";
 *
 * const telemetry = createStoreTelemetryRecorder({
 *   telemetry: telemetryRepository,
 *   logger,
 * });
 * // Safe to call from any request path — never throws.
 * telemetry.httpRequest({ route: "/api/v1/runs", outcome: "2xx", latencyMs: 12 });
 * ```
 */
export function createStoreTelemetryRecorder(
  options: M3LStoreTelemetryRecorderOptions,
): M3LTelemetryRecorder {
  const { telemetry, logger, now = Date.now } = options;

  return {
    httpRequest: (sample) =>
      fanOut(telemetry, logger, "http.request", now, (bucketStartMs, g) =>
        buildHttpRequestMeasurement(sample, bucketStartMs, g),
      ),
    runFinished: (sample) =>
      fanOut(telemetry, logger, "run.finished", now, (bucketStartMs, g) =>
        buildRunFinishedMeasurement(sample, bucketStartMs, g),
      ),
    sseStream: (sample) =>
      fanOut(telemetry, logger, "sse.stream", now, (bucketStartMs, g) =>
        buildSseStreamMeasurement(sample, bucketStartMs, g),
      ),
    policyDecision: (sample) =>
      fanOut(telemetry, logger, "policy.decision", now, (bucketStartMs, g) =>
        buildPolicyDecisionMeasurement(sample, bucketStartMs, g),
      ),
    storeHealth: (sample) =>
      fanOut(telemetry, logger, "store.health", now, (bucketStartMs, g) =>
        buildStoreHealthMeasurement(sample, bucketStartMs, g),
      ),
  };
}
