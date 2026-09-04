/**
 * `http/routes/telemetry` — X8 slice 4a's REST surface: `GET /api/v1/telemetry`
 * lists raw rollup buckets from `console_telemetry_rollup`, most-recent-first,
 * filtered by the caller's query params. No derived/aggregate metric layer —
 * the response is `reader.list(...)`'s result verbatim, a bare JSON array,
 * mirroring `http/routes/runs.ts`'s own `GET /api/v1/runs` convention.
 *
 * `http/` may never import `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this module
 * declares its own narrow local port ({@link M3LTelemetryReaderPort}),
 * mirroring `store/telemetry-repository-types.ts`'s
 * `M3LConsoleTelemetryRepository.list` field for field — the same
 * declared-not-imported trick `http/routes/runs.ts`'s `M3LRunReaderPort`
 * uses. `main.ts` passing the real repository straight through, with no
 * adapter, is the compiler-checked proof that it satisfies the port
 * structurally.
 *
 * The `?granularity=`/`?metric=` vocabularies are likewise duplicated from
 * `store/telemetry-repository-types.ts`'s `M3LTelemetryGranularity`/
 * `M3LTelemetryMetric` unions, for the same zone reason — this module cannot
 * import either type. Both are exported as {@link GRANULARITY_VALUES} and
 * {@link METRIC_VALUES} so `tests/routes-telemetry.test.ts` (which, unlike
 * this module, is free to import both sides) can drift-guard the duplication.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

/** The status this module's single route returns on success. */
const STATUS_OK = 200;
/** The page size `GET /api/v1/telemetry` uses when `?limit=` is omitted — same default as `runs.ts`. */
const DEFAULT_LIST_LIMIT = 50;
/**
 * The largest `?limit=` `GET /api/v1/telemetry` accepts — a deliberate
 * divergence from `runs.ts`/`sessions.ts`, which accept any positive integer
 * because those tables are bounded by real operator activity. The rollup
 * table is not: three granularity tiers times five metrics times the
 * dimension cross-product, and nothing calls `prune()` until slice 5a (it
 * exists at `store/telemetry-repository-types.ts`). An uncapped `?limit=`
 * would be an unbounded response body today, so this cap exists here and
 * only here — do not "normalise" it back to match its siblings.
 */
export const MAX_LIST_LIMIT = 1000;
/** The longest caller-supplied query-param value ever echoed into an error message. */
const MAX_ECHOED_VALUE_LENGTH = 32;

/**
 * Matches a raw query-param value that is _entirely_ ASCII digits — no
 * surrounding whitespace, no sign, no decimal point, no exponent, no hex
 * prefix, and not empty. Bare `Number(raw)` is far looser than the documented
 * "positive integer" / "non-negative safe integer" contracts: it accepts
 * `"0x10"` (16), `" 5 "` (5), `"+5"` (5), `"1e3"` (1000), `"1000.0"` (1000),
 * and — worst of all — `""` (0), which would silently accept an
 * explicitly-empty `?fromMs=`/`?toMs=` as "from the epoch" instead of
 * rejecting it. Requiring this shape before coercion closes all of those at
 * once; the existing range checks ({@link Number.isSafeInteger}, `>= 0`,
 * `> 0`, {@link MAX_LIST_LIMIT}) still run afterward, unchanged.
 */
const DIGIT_SHAPE_PATTERN = /^\d+$/;

/**
 * The accepted `?granularity=` vocabulary — duplicated verbatim, in the same
 * order, from `store/telemetry-repository-types.ts`'s
 * `M3LTelemetryGranularity` union (`http/` may not import `store/`; see this
 * module's own TSDoc). Exported so `tests/routes-telemetry.test.ts` can
 * assert the duplication has not drifted.
 *
 * @example
 * ```ts
 * import { GRANULARITY_VALUES } from "@m3l-automation/m3l-console-server/http/routes/telemetry.js";
 *
 * GRANULARITY_VALUES.includes("hour"); // true
 * ```
 */
export const GRANULARITY_VALUES = ["minute", "hour", "day"] as const;

/** The set backing {@link isAcceptedGranularity}'s O(1) membership check. */
const GRANULARITY_SET: ReadonlySet<string> = new Set(GRANULARITY_VALUES);

/**
 * The accepted `?metric=` vocabulary — duplicated verbatim, in the same
 * order, from `store/telemetry-repository-types.ts`'s `M3LTelemetryMetric`
 * union (`http/` may not import `store/`; see this module's own TSDoc).
 * Exported so `tests/routes-telemetry.test.ts` can assert the duplication
 * has not drifted.
 *
 * @example
 * ```ts
 * import { METRIC_VALUES } from "@m3l-automation/m3l-console-server/http/routes/telemetry.js";
 *
 * METRIC_VALUES.includes("http.request"); // true
 * ```
 */
export const METRIC_VALUES = [
  "http.request",
  "run.finished",
  "sse.stream",
  "policy.decision",
  "store.health",
] as const;

/** The set backing {@link isAcceptedMetric}'s O(1) membership check. */
const METRIC_SET: ReadonlySet<string> = new Set(METRIC_VALUES);

/** `true` when `value` is a member of {@link GRANULARITY_VALUES}. */
function isAcceptedGranularity(
  value: string,
): value is (typeof GRANULARITY_VALUES)[number] {
  return GRANULARITY_SET.has(value);
}

/** `true` when `value` is a member of {@link METRIC_VALUES}. */
function isAcceptedMetric(
  value: string,
): value is (typeof METRIC_VALUES)[number] {
  return METRIC_SET.has(value);
}

/** Truncates a caller-supplied value to {@link MAX_ECHOED_VALUE_LENGTH} before it reaches a response body. */
function truncateEchoed(raw: string): string {
  return raw.slice(0, MAX_ECHOED_VALUE_LENGTH);
}

/**
 * One list query — mirrors `store/telemetry-repository-types.ts`'s
 * `M3LTelemetryQuery`.
 */
interface TelemetryListQuery {
  readonly granularity: (typeof GRANULARITY_VALUES)[number];
  readonly metric?: (typeof METRIC_VALUES)[number];
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly limit: number;
}

/**
 * The local reader port this module depends on — mirrors
 * `store/telemetry-repository-types.ts`'s
 * `M3LConsoleTelemetryRepository.list` field for field, so the real
 * repository satisfies it structurally without an `http -> store` import.
 *
 * @example
 * ```ts
 * const reader: M3LTelemetryReaderPort = {
 *   list: () => [],
 * };
 * ```
 */
export interface M3LTelemetryReaderPort {
  /** Lists rollup buckets matching `query`, most-recent-first. */
  list(query: TelemetryListQuery): readonly unknown[];
}

/**
 * Validates and returns the required `?granularity=` query parameter.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is absent or not a member of {@link GRANULARITY_VALUES}. The
 *   rejected value is never echoed unbounded into the message — this is
 *   caller-supplied query input reaching a response body — so it is
 *   truncated to {@link MAX_ECHOED_VALUE_LENGTH} characters first.
 */
function parseGranularity(
  raw: string | null,
): (typeof GRANULARITY_VALUES)[number] {
  if (raw === null) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "missing 'granularity' query parameter",
    );
  }
  if (!isAcceptedGranularity(raw)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid 'granularity' query parameter: '${truncateEchoed(raw)}'`,
    );
  }
  return raw;
}

/**
 * Validates the optional `?metric=` query parameter against
 * {@link METRIC_VALUES}, returning `undefined` when it was absent.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is present but not a recognised metric, truncated per
 *   {@link parseGranularity}'s same rationale.
 */
function parseMetric(
  raw: string | null,
): (typeof METRIC_VALUES)[number] | undefined {
  if (raw === null) return undefined;
  if (!isAcceptedMetric(raw)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid 'metric' query parameter: '${truncateEchoed(raw)}'`,
    );
  }
  return raw;
}

/**
 * Validates an optional millisecond-timestamp query parameter named `field`,
 * returning `undefined` when it was absent.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is present but not digit-shaped per {@link DIGIT_SHAPE_PATTERN}, or
 *   is digit-shaped but not a non-negative safe integer, truncated per
 *   {@link parseGranularity}'s same rationale.
 */
function parseMsField(field: string, raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!DIGIT_SHAPE_PATTERN.test(raw)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid '${field}' query parameter: '${truncateEchoed(raw)}'`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid '${field}' query parameter: '${truncateEchoed(raw)}'`,
    );
  }
  return parsed;
}

/**
 * Validates and returns the `?limit=` query parameter, defaulting to
 * {@link DEFAULT_LIST_LIMIT} when omitted, capped at {@link MAX_LIST_LIMIT}.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is present but not digit-shaped per {@link DIGIT_SHAPE_PATTERN}, or
 *   is digit-shaped but not a positive integer, or exceeds
 *   {@link MAX_LIST_LIMIT}, truncated per {@link parseGranularity}'s same
 *   rationale.
 */
function parseListLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIST_LIMIT;
  if (!DIGIT_SHAPE_PATTERN.test(raw)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid 'limit' query parameter: '${truncateEchoed(raw)}'`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid 'limit' query parameter: '${truncateEchoed(raw)}'`,
    );
  }
  return parsed;
}

/**
 * Builds the {@link TelemetryListQuery} from `ctx`'s query params, each read
 * exactly once.
 *
 * This validation deliberately duplicates
 * `store/telemetry-repository-types.ts`'s identical `limit`/`fromMs`/`toMs`
 * checks, making the repository's copy unreachable through the HTTP path.
 * That is intentional, not dead duplication to delete: CLAUDE.md requires
 * validating external input at the public boundary, so a malformed query
 * becomes a `400` here rather than surfacing as a downstream throw; the
 * repository's own copy stays load-bearing for any non-HTTP caller that
 * skips this route entirely.
 */
function buildListQuery(ctx: M3LRequestContext): TelemetryListQuery {
  const granularity = parseGranularity(ctx.query.get("granularity"));
  const metric = parseMetric(ctx.query.get("metric"));
  const fromMs = parseMsField("fromMs", ctx.query.get("fromMs"));
  const toMs = parseMsField("toMs", ctx.query.get("toMs"));
  const limit = parseListLimit(ctx.query.get("limit"));
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "'fromMs' must not be greater than 'toMs'",
    );
  }
  return {
    granularity,
    limit,
    ...(metric !== undefined && { metric }),
    ...(fromMs !== undefined && { fromMs }),
    ...(toMs !== undefined && { toMs }),
  };
}

/** Builds the `GET /api/v1/telemetry` handler: the bare rollup-bucket list, query-filtered. */
function buildListHandler(reader: M3LTelemetryReaderPort): M3LConsoleHandler {
  return (ctx) => jsonResponse(STATUS_OK, reader.list(buildListQuery(ctx)));
}

/**
 * Constructor options for {@link createTelemetryRoutes}.
 *
 * A single-field options object even though `runs.ts`/`sessions.ts` carry
 * several fields at this level (and need `toRunsRouteOptions`/
 * `toSessionsRouteOptions` adapters to assemble them) — telemetry has
 * exactly one collaborator, so this stays as thin as `scripts.ts`'s
 * `ScriptRouteOptions { catalog }`. The shape matches every sibling route
 * module's constructor regardless.
 *
 * @example
 * ```ts
 * const options: TelemetryRouteOptions = {
 *   reader: { list: () => [] },
 * };
 * ```
 */
export interface TelemetryRouteOptions {
  /** The rollup-bucket reader port; `http/routes/built-in.ts` wraps the real repository. */
  readonly reader: M3LTelemetryReaderPort;
}

/**
 * Builds the X8 slice 4a telemetry route table: `GET /api/v1/telemetry`,
 * `auth: "required"` — a console operator only, never an unauthenticated
 * caller.
 *
 * @param options - See {@link TelemetryRouteOptions}.
 * @returns The single-route table.
 *
 * @example
 * ```ts
 * import { createTelemetryRoutes } from "@m3l-automation/m3l-console-server/http/routes/telemetry.js";
 *
 * const routes = createTelemetryRoutes({ reader: { list: () => [] } });
 * ```
 */
export function createTelemetryRoutes(
  options: TelemetryRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/telemetry",
      auth: "required",
      handler: buildListHandler(options.reader),
    },
  ];
}
