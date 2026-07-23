/**
 * `internal/logging/levels` — the severity-rank table backing `minLevel`
 * floor comparisons (ADR-0035 phase 3).
 *
 * Not exported from any barrel — `internal/` is private API, freely
 * changeable without a semver bump.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";
import type { M3LLogEventCategory } from "../../core/logging/M3LLogEventCategory.js";

/**
 * The severity rank of each {@link M3LLogEventCategory}, used only to compare
 * a candidate event's category against an `M3LLoggerOptions.minLevel` /
 * per-handler `minLevel` floor.
 *
 * Deliberately annotated `Record<M3LLogEventCategory, number>` rather than
 * `as const` — adding a future category to `M3LLogEventCategory` without also
 * ranking it here is then a **compile** error, not a silent runtime gap.
 *
 * The categories are presentational groupings, not a severity ladder in
 * their own right, so several ranks are deliberately tied
 * (`text`/`step`/`info`/`section`/`header` all rank `1`) — ranks exist solely
 * to give `passesFloor` a total order to compare against, per
 * `docs/reference/core/logging.md`.
 *
 * Not exported — this file's only consumers of the rank table are
 * {@link assertValidFloor} and {@link passesFloor}, both defined here; an
 * external `export` with no external consumer is exactly what `pnpm knip`
 * flags as dead surface.
 */
const CATEGORY_RANK: Record<M3LLogEventCategory, number> = {
  debug: 0,
  text: 1,
  step: 1,
  info: 1,
  section: 1,
  header: 1,
  success: 2,
  warning: 3,
  error: 4,
  fatal: 5,
};

/**
 * Validates a `minLevel` value at **construction** time, not per-event.
 *
 * `passesFloor`'s rank comparison indexes `CATEGORY_RANK` by `minLevel`; an
 * unranked value (typo, stale string literal surviving a refactor) makes that
 * lookup `undefined`, and every subsequent numeric comparison against
 * `undefined` coerces to `NaN` — which is never `>=` anything, so *every*
 * event including `FATAL` is silently dropped with no throw and no stderr
 * diagnostic. Validating once, eagerly, at the call site that owns the value
 * (the `M3LLogger` constructor, each handler constructor) turns a silent
 * wiring mistake into an immediate, loud failure instead of a production
 * logging blackout discovered only in hindsight.
 *
 * @param value - The candidate floor, or `undefined` for "no floor".
 * @param source - The constructor/class name to name in the thrown message.
 * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when `value` is
 *   defined but is not one of the ranked {@link M3LLogEventCategory} members.
 */
export function assertValidFloor(
  value: M3LLogEventCategory | undefined,
  source: string,
): void {
  if (value === undefined) return;
  if (!(value in CATEGORY_RANK)) {
    throw new M3LError(
      `${source}: minLevel must be undefined or one of ${JSON.stringify(
        Object.keys(CATEGORY_RANK),
      )}, got ${JSON.stringify(value)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
}

/**
 * Returns whether `category` clears the `minLevel` floor: `true` when
 * `minLevel` is `undefined` (no floor — everything passes), otherwise
 * whether `category`'s rank is at or above `minLevel`'s rank.
 *
 * Every construction site validates `minLevel` via {@link assertValidFloor}
 * before it ever reaches here, so `minLevel` should always be ranked by the
 * time this runs. This function still reads the rank into a local and
 * handles a miss explicitly (rejecting rather than deriving a `NaN`
 * comparison) as defence in depth — it must never be the one thing standing
 * between a bad value and a silently-empty log stream.
 *
 * @param category - The candidate event's category.
 * @param minLevel - The configured floor, or `undefined` for no floor.
 * @returns Whether the event should be admitted.
 */
export function passesFloor(
  category: M3LLogEventCategory,
  minLevel: M3LLogEventCategory | undefined,
): boolean {
  if (minLevel === undefined) return true;
  const floorRank: number | undefined = CATEGORY_RANK[minLevel];
  if (floorRank === undefined) return false;
  return CATEGORY_RANK[category] >= floorRank;
}
