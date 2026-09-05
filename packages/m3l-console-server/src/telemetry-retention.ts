/**
 * `telemetry-retention` — {@link pruneTelemetry}, the X8 telemetry rollup's
 * on-demand retention-policy driver (ADR-0070 slice 5a).
 *
 * This module is deliberately zone-free: it sits directly under `src/`,
 * like `main.ts` and `telemetry-recorder.ts`, rather than inside any
 * `CONSOLE_SERVER_LAYERS` zone directory (`bin/check-eslint-zones.mjs`),
 * because it needs to import from both `config/` (the resolved retention
 * policy) and `store/` (the repository it prunes through) — an import
 * combination no single zone directory is allowed to make (`config/`'s own
 * zone forbids importing `store/`).
 *
 * **This module schedules nothing.** ADR-0070 requires "an operator-run
 * cleanup command — never silent deletion": there is no timer, no
 * interval, and no call site in `main.ts`/`startConsole` here. The only
 * caller is the operator cleanup subcommand (a later slice) — invoking
 * this on demand is the entire point.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "./errors/console-error.js";
import type { M3LConsoleTelemetryConfig } from "./config/telemetry.js";
import { TELEMETRY_GRANULARITIES } from "./store/telemetry-validation.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryGranularity,
} from "./store/telemetry-repository.js";

/**
 * Every rollup granularity tier, in the store's own declared order — read
 * from `TELEMETRY_GRANULARITIES` (`store/telemetry-validation.ts`) rather
 * than hand-typed here, so a tier added to the store is walked by
 * {@link pruneTelemetry} automatically instead of being silently un-pruned
 * forever.
 *
 * The cast is provably sound, not merely assumed: `TELEMETRY_GRANULARITIES`
 * is typed `Readonly<Record<M3LTelemetryGranularity, true>>`, and a
 * `Record<Union, T>` mapped type forces its object literal to declare
 * exactly the union's members — no fewer (a missing-property error) and no
 * more (an excess-property check) — so `Object.keys` on it is provably a
 * permutation of the union. A fourth tier would fail
 * `telemetry-validation.ts`'s own declaration at compile time before this
 * cast could ever observe a diverging key.
 */
const GRANULARITIES = Object.keys(
  TELEMETRY_GRANULARITIES,
) as readonly M3LTelemetryGranularity[];

/**
 * Computes the cutoff for one granularity tier: buckets whose
 * `bucketStartMs` is strictly less than the returned value are eligible
 * for pruning.
 *
 * Pure — reads no clock itself, so it is independently testable and safe
 * to call with an already-read `nowMs`. Returns `nowMs - retentionMs[tier]`
 * unmodified, including when the result is negative (see
 * {@link pruneTelemetry}'s own docs for why a negative cutoff is safe) or,
 * given non-finite inputs, non-finite — {@link pruneTelemetry} is the layer
 * that guards against a non-finite result before it ever reaches the
 * repository.
 *
 * @param retentionMs - The resolved per-tier retention policy.
 * @param granularity - Which tier's cutoff to compute.
 * @param nowMs - The reference "now", in epoch milliseconds.
 * @returns `nowMs - retentionMs[granularity]`.
 *
 * @example
 * ```ts
 * import { telemetryPruneCutoffMs } from "@m3l-automation/m3l-console-server/telemetry-retention";
 *
 * telemetryPruneCutoffMs({ minute: 1_000, hour: 2_000, day: 3_000 }, "minute", 10_000);
 * // 9_000
 * ```
 */
export function telemetryPruneCutoffMs(
  retentionMs: M3LConsoleTelemetryConfig["retentionMs"],
  granularity: M3LTelemetryGranularity,
  nowMs: number,
): number {
  return nowMs - retentionMs[granularity];
}

/**
 * The result of one {@link pruneTelemetry} run: how many rows were deleted
 * per tier, plus the sum of all three. Each per-tier count is the
 * repository's own `prune` return value — never recomputed — so a caller
 * (e.g. the operator cleanup subcommand) reports real deletion counts.
 *
 * @example
 * ```ts
 * function describe(outcome: M3LTelemetryPruneOutcome): string {
 *   return `deleted ${String(outcome.total)} rows (minute ${String(outcome.minute)}, hour ${String(outcome.hour)}, day ${String(outcome.day)})`;
 * }
 * ```
 */
export interface M3LTelemetryPruneOutcome {
  /** Rows deleted from the minute tier. */
  readonly minute: number;
  /** Rows deleted from the hour tier. */
  readonly hour: number;
  /** Rows deleted from the day tier. */
  readonly day: number;
  /** Sum of the three tiers. */
  readonly total: number;
}

/**
 * Options for {@link pruneTelemetry}.
 *
 * @example
 * ```ts
 * const options: PruneTelemetryOptions = {
 *   repository,
 *   retentionMs: { minute: 1_000, hour: 2_000, day: 3_000 },
 * };
 * ```
 */
export interface PruneTelemetryOptions {
  /** The rollup repository pruned through. */
  readonly repository: M3LConsoleTelemetryRepository;
  /** The resolved per-tier retention policy (see `config/telemetry.ts`). */
  readonly retentionMs: M3LConsoleTelemetryConfig["retentionMs"];
  /** Clock seam; defaults to `Date.now`. */
  readonly nowMs?: () => number;
}

/**
 * Walks every rollup granularity tier exactly once, calling
 * `repository.prune({ granularity, beforeMs })` for each with the cutoff
 * {@link telemetryPruneCutoffMs} derives, and returns the per-tier deleted
 * counts plus their sum.
 *
 * **Schedules nothing.** This function is only ever invoked on demand — no
 * timer, interval, or scheduler lives here or anywhere this module reaches
 * (see this module's own `@packageDocumentation` for the ADR-0070
 * rationale).
 *
 * **Guards the retention values and the cutoff arithmetic.**
 * Each tier's `retentionMs` must be a positive integer (`>= 1`); a negative
 * or zero value yields a finite FUTURE cutoff that would delete every row in
 * that tier. This function validates all tiers in a pre-flight pass before
 * reading the clock or calling `repository.prune` for any tier — if any
 * tier's value is invalid, no pruning happens at all.
 *
 * Separately, `nowMs - retentionMs[tier]` can be non-finite if the clock is
 * absurd (e.g. `nowMs` returns `NaN`); this function also throws an
 * {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` before calling
 * `repository.prune` in that case — a non-finite `beforeMs` reaching the
 * repository would instead surface as `requireValidRangeBound`'s less
 * specific `ERR_CONSOLE_BAD_REQUEST`. A **negative but finite** cutoff, by
 * contrast, is passed through unchanged: every `bucket_start_ms` is a
 * non-negative safe integer (`store/telemetry-repository-types.ts`), so a
 * negative `beforeMs` simply matches no row — a safe no-op.
 *
 * **Preserves partial progress on a mid-walk failure.** If `repository.prune`
 * throws for some tier, every tier that already completed has already
 * deleted its rows — discarding those counts would leave a caller unable to
 * tell that, say, the minute tier is already pruned. The thrown
 * {@link M3LConsoleError} therefore chains the original thrown value as
 * `cause` (by identity — never re-wrapped or normalised) and carries every
 * completed tier's count at `context.partialCounts`. A tier that failed or
 * was never reached is **absent** from `partialCounts`, not present with
 * `0` — a `0` would be indistinguishable from "nothing was old enough to
 * delete", which is exactly the ambiguity this preserves against.
 *
 * @param options - See {@link PruneTelemetryOptions}.
 * @returns The {@link M3LTelemetryPruneOutcome}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when
 *   any tier's `retentionMs` is not a positive integer, when any tier's
 *   derived cutoff is non-finite (NaN clock), or when `repository.prune`
 *   itself throws for a tier.
 *
 * @example
 * ```ts
 * import { pruneTelemetry } from "@m3l-automation/m3l-console-server/telemetry-retention";
 *
 * const outcome = pruneTelemetry({
 *   repository,
 *   retentionMs: { minute: 172_800_000, hour: 2_678_400_000, day: 31_622_400_000 },
 * });
 * // { minute: 12, hour: 3, day: 0, total: 15 }
 * ```
 */
export function pruneTelemetry(
  options: PruneTelemetryOptions,
): M3LTelemetryPruneOutcome {
  const { repository, retentionMs, nowMs = Date.now } = options;

  // Pre-flight: validate every tier's retentionMs is a positive integer
  // before reading the clock or touching the repository. A negative value
  // would yield a finite FUTURE cutoff that deletes every row in that tier;
  // zero would do the same. This matches the siblings' `validateRetentionMs`
  // guard and ensures the invalid config is caught before any pruning happens.
  // (Config cannot currently produce such values — `config/telemetry.ts`
  // enforces integer >= 1 — but the guarantee belongs at this boundary, not
  // only at the caller.)
  for (const granularity of GRANULARITIES) {
    const tierMs = retentionMs[granularity];
    if (!Number.isInteger(tierMs) || tierMs < 1) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `telemetry retention window for granularity '${granularity}' must be a positive integer (got ${String(tierMs)})`,
        { context: { granularity } },
      );
    }
  }

  const now = nowMs();

  // Built up incrementally — a tier's key is only ever added once its own
  // `repository.prune` call has returned successfully — so a mid-walk
  // failure's `partialCounts` snapshot never contains a zero-filled entry
  // for a tier that failed or was never reached.
  const partialCounts: Partial<Record<M3LTelemetryGranularity, number>> = {};

  for (const granularity of GRANULARITIES) {
    const beforeMs = telemetryPruneCutoffMs(retentionMs, granularity, now);
    if (!Number.isFinite(beforeMs)) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `telemetry prune cutoff for granularity '${granularity}' is not finite`,
        { context: { granularity } },
      );
    }
    try {
      partialCounts[granularity] = repository.prune({ granularity, beforeMs });
    } catch (cause) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `telemetry prune failed for granularity '${granularity}'`,
        { cause, context: { partialCounts: { ...partialCounts } } },
      );
    }
  }

  // Provably total, not merely assumed — same argument as the
  // `GRANULARITIES` cast above: the loop just walked every member of
  // `GRANULARITIES` (the complete, compile-time-enforced vocabulary of
  // `M3LTelemetryGranularity`) and assigned `partialCounts[granularity]`
  // before continuing to the next iteration, and the only way to reach this
  // line without having done so for every tier is the `throw` above, which
  // exits the function entirely. So by the time control falls out of the
  // loop, `partialCounts` is guaranteed to hold every key — the `Partial<>`
  // was only ever a mid-walk-failure device, not a description of what this
  // line sees.
  const counts = partialCounts as Record<M3LTelemetryGranularity, number>;

  return {
    minute: counts.minute,
    hour: counts.hour,
    day: counts.day,
    total: counts.minute + counts.hour + counts.day,
  };
}
