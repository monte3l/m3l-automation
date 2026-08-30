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
 * The documented fallback rendered for a timestamp `new Date` cannot
 * represent — a not-yet-happened nullable field, or a value outside the
 * representable range (see {@link isRepresentableEpochMs}).
 */
const FALLBACK = "—";

/**
 * The ECMAScript spec (and, following it, the `Date` constructor) only
 * represents times within 8.64e15 milliseconds of the epoch in either
 * direction — 100,000,000 days. `new Date(ms).toISOString()` throws a
 * `RangeError` for any `ms` outside `[-8.64e15, 8.64e15]`, and for `NaN`/
 * `±Infinity`. The check lives here (in the formatter) rather than in the
 * run-shape guard in `api/runs.ts`, because that guard only validates that a
 * decoded field is `typeof === "number"` — every finite-or-not numeric
 * value is a structurally valid `number` and must be accepted at that
 * boundary; it is specifically *formatting* an out-of-range number that is
 * unsafe, so the fallback belongs at the point where the unsafe `Date`
 * conversion would otherwise happen.
 */
const MAX_REPRESENTABLE_EPOCH_MS = 8.64e15;

function isRepresentableEpochMs(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_REPRESENTABLE_EPOCH_MS;
}

/**
 * Formats an epoch-millisecond timestamp as an ISO-8601 string, falling
 * back to an em dash for a value `new Date` cannot represent (non-finite,
 * or beyond the ±8.64e15 ms range) rather than letting the `RangeError`
 * propagate into a rendering component.
 *
 * @example
 * ```ts
 * formatTimestampMs(1_700_000_000_000);
 * // => "2023-11-14T22:13:20.000Z"
 * formatTimestampMs(Number.POSITIVE_INFINITY); // => "—"
 * ```
 */
export function formatTimestampMs(ms: number): string {
  return isRepresentableEpochMs(ms) ? new Date(ms).toISOString() : FALLBACK;
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
  return ms === null ? FALLBACK : formatTimestampMs(ms);
}
