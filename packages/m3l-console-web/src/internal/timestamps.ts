/**
 * `internal/timestamps` — the single shared timestamp-formatting helper
 * used by every read-view component that renders a server-supplied
 * millisecond timestamp. Private to this package: never re-exported from a
 * public entry point.
 *
 * This slice is read-only, so timestamps render as plain ISO-8601 strings
 * rather than a relative ("2 minutes ago") format — relative formatting adds
 * a moving part (a clock, a re-render interval) this slice has no need for.
 *
 * @packageDocumentation
 */

/**
 * Formats an epoch-millisecond timestamp as an ISO-8601 string.
 *
 * @example
 * ```ts
 * formatTimestampMs(1_700_000_000_000);
 * // => "2023-11-14T22:13:20.000Z"
 * ```
 */
export function formatTimestampMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Formats a nullable epoch-millisecond timestamp, rendering `null` (a run
 * field that has not happened yet, e.g. a queued run's `startedAtMs`) as an
 * em dash rather than throwing on `new Date(null)`.
 *
 * @example
 * ```ts
 * formatNullableTimestampMs(null); // => "—"
 * formatNullableTimestampMs(1_700_000_000_000);
 * // => "2023-11-14T22:13:20.000Z"
 * ```
 */
export function formatNullableTimestampMs(ms: number | null): string {
  return ms === null ? "—" : formatTimestampMs(ms);
}
