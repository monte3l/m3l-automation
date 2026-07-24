/**
 * `internal/diagnostics/runDirectoryName` — the single source of truth for
 * the per-run, filesystem-safe directory segment both stage-9 archival
 * (`core/script/M3LScript.ts`) and the run report
 * (`core/diagnostics/run-report.ts`) derive from a run's `startedAt`
 * timestamp, so the two land under one co-located
 * `<outputDir>/<runDirectoryName(startedAt)>/` directory (ADR-0035 phase 5,
 * A5 part 1).
 *
 * Private: not re-exported through any public barrel.
 *
 * @packageDocumentation
 */

/**
 * `date.toISOString()`, falling back to the Unix epoch on a hostile `Date`
 * (e.g. `new Date(NaN)`, whose `toISOString()` throws a `RangeError`) —
 * never throws.
 *
 * @param date - The date to format.
 * @returns The ISO-8601 string, or the epoch's ISO-8601 string on failure.
 *
 * @example
 * ```ts
 * // Internal-only: illustrative shape, not part of the public API.
 * const iso = safeToISOString(new Date(NaN)); // "1970-01-01T00:00:00.000Z"
 * ```
 */
export function safeToISOString(date: Date): string {
  try {
    return date.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Derives the per-run directory segment for `startedAt`: its ISO-8601
 * timestamp with every `:` replaced by `-`, since a colon is unsafe (or
 * outright illegal, on Windows) in a path segment. Never throws — a hostile
 * `Date` degrades to the epoch's sanitized timestamp via
 * {@link safeToISOString} rather than propagating.
 *
 * @param startedAt - The run's start time.
 * @returns The filesystem-safe directory segment.
 *
 * @example
 * ```ts
 * // Internal-only: illustrative shape, not part of the public API.
 * const dir = runDirectoryName(new Date("2026-07-24T10:14:02.000Z"));
 * // "2026-07-24T10-14-02.000Z"
 * ```
 */
export function runDirectoryName(startedAt: Date): string {
  return safeToISOString(startedAt).replaceAll(":", "-");
}
