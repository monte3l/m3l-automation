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
 * Turns a raw elapsed-milliseconds reading into a value the telemetry
 * repository can never reject. `Date.now()` (or an injected clock) can step
 * BACKWARDS — NTP correction, VM resume, a suspended laptop — producing a
 * negative or non-integer `rawElapsedMs`. `M3LTelemetryRecorder`'s contract
 * is never-throws (see `telemetry/port.ts`), so an invalid value isn't
 * rejected loudly at the call site; it is rejected internally by the rollup
 * repository and swallowed by the store-backed recorder's fan-out as a
 * logged warning, silently dropping the sample while the observed operation
 * still reports success. Normalising here — total, no throw — keeps that
 * sample alive: non-finite collapses to the floor, a fractional value rounds
 * to the nearest integer, and anything still negative clamps to the floor.
 *
 * @param rawElapsedMs - An elapsed-time reading, typically `now() - startedAt`
 * from two reads of the same clock. May be negative, fractional, or
 * non-finite if the clock stepped backward or the inputs are otherwise
 * degenerate.
 * @returns A non-negative integer safe to pass as a telemetry sample's
 * duration/latency field.
 * @example
 * ```ts
 * import { toValidDurationMs } from "@m3l-automation/m3l-console-server/telemetry/duration.js";
 *
 * const startedAt = Date.now();
 * // ... work happens, and the clock steps backward via NTP correction ...
 * const durationMs = toValidDurationMs(Date.now() - startedAt);
 * // durationMs is always a non-negative integer, never NaN or negative.
 * ```
 */
export function toValidDurationMs(rawElapsedMs: number): number {
  if (!Number.isFinite(rawElapsedMs)) {
    return DURATION_MS_FLOOR;
  }
  return Math.max(DURATION_MS_FLOOR, Math.round(rawElapsedMs));
}
