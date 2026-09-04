/**
 * `telemetry/duration` — {@link toValidDurationMs}, the total normaliser
 * shared by every call site that turns a raw `now() - startedAt` reading
 * into a value `M3LTelemetryRecorder` can safely record. Extracted from
 * `http/finish-request.ts`'s private `toValidLatencyMs` (X8 slice 2b) so
 * `runs/orchestrator.ts` (X8 slice 3a) can reuse the exact same clamp instead
 * of duplicating it.
 *
 * @packageDocumentation
 */

/**
 * The floor a normalised elapsed-time sample is clamped to — the rollup
 * repository behind `M3LTelemetryRecorder` documents its duration/latency
 * columns as non-negative safe integers and rejects anything else.
 */
const DURATION_MS_FLOOR = 0;

/**
 * The ceiling a normalised elapsed-time sample is clamped to.
 *
 * `Number.isFinite(1e300)` is `true`, so the non-finite guard alone does not
 * prevent values that exceed `Number.MAX_SAFE_INTEGER`. The rollup repository's
 * `requireValidMeasure` rejects any value that is not a non-negative safe
 * integer, and `M3LTelemetryRecorder`'s contract is never-throws, meaning the
 * rejection is swallowed as a logged error and the row is silently dropped.
 * Clamping to `MAX_SAFE_INTEGER` rather than to `0` preserves the information
 * that the duration was very large ("a very long run") rather than making it
 * appear instantaneous.
 */
const DURATION_MS_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * Turns a raw elapsed-milliseconds reading into a value the telemetry
 * repository can never reject. The returned value is always a non-negative
 * safe integer in the range `[0, Number.MAX_SAFE_INTEGER]`.
 *
 * Two failure modes are normalised:
 *
 * - **Backward clock** — `Date.now()` (or an injected clock) can step
 *   BACKWARDS — NTP correction, VM resume, a suspended laptop — producing a
 *   negative or non-integer `rawElapsedMs`. `M3LTelemetryRecorder`'s contract
 *   is never-throws (see `telemetry/port.ts`), so an invalid value isn't
 *   rejected loudly at the call site; it is rejected internally by the rollup
 *   repository and swallowed by the store-backed recorder's fan-out as a
 *   logged error, silently dropping the sample while the observed operation
 *   still reports success. Normalising here — total, no throw — keeps that
 *   sample alive.
 *
 * - **Non-safe-integer overflow** — very large finite values such as `1e300`
 *   satisfy `Number.isFinite` but exceed `Number.MAX_SAFE_INTEGER`. The rollup
 *   repository's `requireValidMeasure` rejects them just as it rejects
 *   negatives, so without a ceiling clamp the row would be silently dropped
 *   via the same swallowed-rejection path. The ceiling is applied after
 *   `Math.round` because `Math.round(1e300) === 1e300`.
 *
 * @param rawElapsedMs - An elapsed-time reading, typically `now() - startedAt`
 * from two reads of the same clock. May be negative, fractional, non-finite,
 * or larger than `Number.MAX_SAFE_INTEGER` if the clock stepped backward or
 * the inputs are otherwise degenerate.
 * @returns A non-negative safe integer in `[0, Number.MAX_SAFE_INTEGER]`, safe
 * to pass as a telemetry sample's duration/latency field — a value the
 * telemetry repository can never reject.
 * @example
 * ```ts
 * import { toValidDurationMs } from "@m3l-automation/m3l-console-server/telemetry/duration.js";
 *
 * const startedAt = Date.now();
 * // ... work happens, and the clock steps backward via NTP correction ...
 * const durationMs = toValidDurationMs(Date.now() - startedAt);
 * // durationMs is always a non-negative safe integer, never NaN, negative,
 * // or larger than Number.MAX_SAFE_INTEGER.
 * ```
 */
export function toValidDurationMs(rawElapsedMs: number): number {
  if (!Number.isFinite(rawElapsedMs)) {
    return DURATION_MS_FLOOR;
  }
  // Round first, then clamp: Math.round(1e300) === 1e300, so the ceiling must
  // be applied after rounding, not before.
  const rounded = Math.max(DURATION_MS_FLOOR, Math.round(rawElapsedMs));
  return Math.min(rounded, DURATION_MS_CEILING);
}
