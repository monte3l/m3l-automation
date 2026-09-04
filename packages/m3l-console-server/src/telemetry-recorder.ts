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
 * Reports a dropped fan-out through `logger.error`, naming the metric and
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
 *
 * The level is `error`, not `warning`: `M3L_CONSOLE_LOG_LEVEL` is
 * operator-configurable across six floors (`config/env.ts`'s
 * `LOG_LEVELS`, default `info`), so at an `error` or `fatal` floor a
 * `warning`-level drop report would be suppressed and a completely broken
 * telemetry table would be indistinguishable from a healthy one. This
 * matches the house precedent set by
 * {@link "./runs/events.js".createCompositeRunEventSink}'s run-event-sink
 * report,
 * {@link "./boot/audit-index.js".createIndexedHumanActionAuditPort}'s
 * index-write report, and `telemetry/store-size.ts`'s
 * `reportDeclinedMeasurement` — all never-throws ports swallowing a member
 * failure, all at `error`, for the identical reason: each marks a point
 * where a metric stops being recorded, and the same operator-configurable
 * `M3L_CONSOLE_LOG_LEVEL` floor that would suppress a `warning` here would
 * suppress one there too.
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
  logger.error(`telemetry fan-out dropped for metric '${metric}'`, data);
}

/**
 * Fans one sample out to all three granularity tiers through a single
 * `telemetry.recordAll` call. Takes the clock FUNCTION rather than an
 * already-read `atMs`, and the sample as a `snapshot` FUNCTION rather than
 * an already-read value, for the same reason: reading each happens exactly
 * once, inside this function's own `try`, so a throwing `now` — or a
 * throwing sample field getter — is caught by the same guard as a throwing
 * `recordAll` instead of propagating out of the caller's scope before the
 * `try` is even entered. JS evaluates call arguments in the caller's own
 * scope, which is what made the previous `fanOut(..., now(), ...)` call
 * shape unsafe and let a throwing clock escape the recorder's never-throws
 * contract; the same is true of a sample read at the call site.
 * Snapshotting the sample exactly once here, rather than in each recorder
 * method, also means the three tiers built from it below can never carry
 * divergent dimension values: `build` runs three times against the SAME
 * `sample` object, so `route`/`script`/`outcome`/`posture` (rollup PRIMARY
 * KEY columns) cannot differ across tiers even when a caller-supplied
 * accessor would otherwise return something different on each read. The
 * single clock reading then derives every tier's `bucketStartMs`, so the
 * three tiers can never straddle a boundary either. Catches everything and
 * reports through {@link reportDroppedFanOut} rather than rethrowing.
 */
function fanOut<TSample>(
  telemetry: M3LConsoleTelemetryRepository,
  logger: Core.M3LLogger,
  metric: string,
  now: () => number,
  snapshot: () => TSample,
  build: (
    sample: TSample,
    bucketStartMs: number,
    granularity: M3LTelemetryGranularity,
  ) => M3LTelemetryMeasurement,
): void {
  try {
    const atMs = now();
    const sample = snapshot();
    const measurements = GRANULARITIES.map((granularity) =>
      build(sample, telemetryBucketStartMs(atMs, granularity), granularity),
    );
    telemetry.recordAll(measurements);
  } catch (cause) {
    reportDroppedFanOut(logger, metric, cause);
  }
}

/**
 * Copies every field of an `httpRequest` sample exactly once. See
 * {@link fanOut} for why the copy must happen inside its own `try`, once
 * per recorder call, rather than at the recorder method's call site.
 */
function snapshotHttpRequest(
  sample: M3LTelemetryHttpRequestSample,
): M3LTelemetryHttpRequestSample {
  return {
    route: sample.route,
    outcome: sample.outcome,
    latencyMs: sample.latencyMs,
  };
}

/**
 * Copies every field of a `runFinished` sample exactly once, including the
 * optional `operation`. `M3LTelemetryRunFinishedSample.operation` is typed
 * `readonly operation?: string | undefined`, so under
 * `exactOptionalPropertyTypes` this may assign `sample.operation` directly
 * — including when it is `undefined` — without a conditional spread. See
 * {@link fanOut} for why the copy must happen inside its own `try`, once
 * per recorder call.
 */
function snapshotRunFinished(
  sample: M3LTelemetryRunFinishedSample,
): M3LTelemetryRunFinishedSample {
  return {
    script: sample.script,
    operation: sample.operation,
    outcome: sample.outcome,
    durationMs: sample.durationMs,
  };
}

/**
 * Copies every field of an `sseStream` sample exactly once. See
 * {@link fanOut} for why the copy must happen inside its own `try`, once
 * per recorder call.
 */
function snapshotSseStream(
  sample: M3LTelemetrySseStreamSample,
): M3LTelemetrySseStreamSample {
  return {
    outcome: sample.outcome,
  };
}

/**
 * Copies every field of a `policyDecision` sample exactly once. See
 * {@link fanOut} for why the copy must happen inside its own `try`, once
 * per recorder call.
 */
function snapshotPolicyDecision(
  sample: M3LTelemetryPolicyDecisionSample,
): M3LTelemetryPolicyDecisionSample {
  return {
    posture: sample.posture,
    outcome: sample.outcome,
  };
}

/**
 * Copies every field of a `storeHealth` sample exactly once. See
 * {@link fanOut} for why the copy must happen inside its own `try`, once
 * per recorder call.
 */
function snapshotStoreHealth(
  sample: M3LTelemetryStoreHealthSample,
): M3LTelemetryStoreHealthSample {
  return {
    sizeBytes: sample.sizeBytes,
  };
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
  // Read-once local: the measurement union's `operation?: string |
  // undefined` still needs the conditional spread below, but reading
  // `sample.operation` into a local exactly once means this builder's
  // safety no longer depends on its caller having already snapshotted the
  // sample — a future call site that passes a raw sample back in cannot
  // silently reintroduce the double-read defect this file was fixed for.
  const operation: string | undefined = sample.operation;
  return {
    metric: "run.finished",
    granularity,
    bucketStartMs,
    script: sample.script,
    ...(operation !== undefined && { operation }),
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
  // Read-once local — see `buildRunFinishedMeasurement`'s `operation` local
  // for why: the conditional spread stays, but the caller no longer needs
  // to have snapshotted for this builder to read the field once.
  const outcome: string | undefined = sample.outcome;
  return {
    metric: "sse.stream",
    granularity,
    bucketStartMs,
    ...(outcome !== undefined && { outcome }),
  };
}

/** Maps a `policyDecision` sample onto one `"policy.decision"` measurement — a pure counter, no measure. */
function buildPolicyDecisionMeasurement(
  sample: M3LTelemetryPolicyDecisionSample,
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): M3LTelemetryMeasurement {
  // Read-once local — see `buildRunFinishedMeasurement`'s `operation` local
  // for why: the conditional spread stays, but the caller no longer needs
  // to have snapshotted for this builder to read the field once.
  const outcome: string | undefined = sample.outcome;
  return {
    metric: "policy.decision",
    granularity,
    bucketStartMs,
    posture: sample.posture,
    ...(outcome !== undefined && { outcome }),
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
 * {@link M3LConsoleTelemetryRepository}: every method reads the clock and
 * the sample exactly once each (see {@link fanOut}), builds one
 * {@link M3LTelemetryMeasurement} per granularity tier (`minute`, `hour`,
 * `day`, in that order) from that single sample/clock reading, and fans
 * them out through one `telemetry.recordAll` call — never three
 * separate `record` calls. A failure of any kind is caught, reported
 * through `logger.error` (see {@link reportDroppedFanOut}), and never
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
      fanOut(
        telemetry,
        logger,
        "http.request",
        now,
        () => snapshotHttpRequest(sample),
        buildHttpRequestMeasurement,
      ),
    runFinished: (sample) =>
      fanOut(
        telemetry,
        logger,
        "run.finished",
        now,
        () => snapshotRunFinished(sample),
        buildRunFinishedMeasurement,
      ),
    sseStream: (sample) =>
      fanOut(
        telemetry,
        logger,
        "sse.stream",
        now,
        () => snapshotSseStream(sample),
        buildSseStreamMeasurement,
      ),
    policyDecision: (sample) =>
      fanOut(
        telemetry,
        logger,
        "policy.decision",
        now,
        () => snapshotPolicyDecision(sample),
        buildPolicyDecisionMeasurement,
      ),
    storeHealth: (sample) =>
      fanOut(
        telemetry,
        logger,
        "store.health",
        now,
        () => snapshotStoreHealth(sample),
        buildStoreHealthMeasurement,
      ),
  };
}
