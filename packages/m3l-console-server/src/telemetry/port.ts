/**
 * `telemetry/port` — {@link M3LTelemetryRecorder}, the seam call sites in
 * zones that may not reach `store/` (`http/`, `stream/`, `runs/`) record
 * measurements through, plus the five sample shapes it accepts.
 *
 * Deliberately the inverse of `audit/port.ts`'s human-action trail, whose
 * `record` is async and REJECTS on failure: that port records what a HUMAN
 * asked for, so an action that cannot be audited is refused. This recorder
 * observes machine measurements — request latency, run duration, stream and
 * policy-decision counts, store size — and every method returns `void` and
 * never throws, the same `src/runs/audit.ts:14-19` stance: a metric that
 * cannot be recorded must never become a request or launch failure mode.
 *
 * None of the five sample shapes below carries an `atMs` field, on purpose.
 * The recorder that implements this port owns the clock (its factory takes
 * `now`), so a call site can never report a misaligned or fabricated bucket
 * — `console_telemetry_rollup` has an alignment `CHECK` and `record` throws
 * `ERR_CONSOLE_BAD_REQUEST` on a misaligned value. A later slice that needs a
 * historical/backfilled timestamp adds an explicit override then.
 *
 * The field names below are the CALL SITE's vocabulary (`latencyMs`,
 * `durationMs`, `sizeBytes`), not the storage schema's (`valueMs`,
 * `valueBytes`). The store-backed adapter maps between them — that is the
 * point of the port: `http/` and friends never learn the rollup table's
 * column names.
 *
 * `route`, `script`, `outcome` and `posture` below are plain `string`s
 * bounded by nothing at the type level, but every one of them becomes part
 * of a permanent primary key in `console_telemetry_rollup`. For
 * `http.request`, `route` and `outcome` are now bounded at the call site:
 * `src/http/handler.ts` supplies either a matched route PATTERN from
 * `M3LRouter.lookup` or one of three named constants (`"(not-found)"`,
 * `"(method-not-allowed)"`, `"(unrouted)"`), and `src/http/finish-request.ts`
 * maps the response status to one of six status classes (`"1xx"`..`"5xx"`,
 * `"other"`). The other three metrics' string dimensions
 * (`M3LTelemetryRunFinishedSample.script`/`operation`/`outcome`,
 * `M3LTelemetrySseStreamSample.outcome`,
 * `M3LTelemetryPolicyDecisionSample.posture`/`outcome`) remain **unenforced
 * preconditions today**, pending slices 3a-3c. In every case the port itself
 * never throws (see above), so it cannot reject a caller that passes the
 * wrong thing — bounding a value is the call site's duty, not the port's.
 *
 * @packageDocumentation
 */

/**
 * A single HTTP request's outcome and latency, as `http/handler.ts` observes
 * it.
 *
 * @example
 * ```ts
 * import type { M3LTelemetryHttpRequestSample } from "@m3l-automation/m3l-console-server/telemetry/port.js";
 *
 * const sample: M3LTelemetryHttpRequestSample = {
 *   route: "/api/v1/runs",
 *   outcome: "2xx",
 *   latencyMs: 42,
 * };
 * ```
 */
export interface M3LTelemetryHttpRequestSample {
  /**
   * The matched route, e.g. `/api/v1/runs`. Non-empty. MUST be the matched
   * route PATTERN — what {@link "../http/router.js".M3LRouter.lookup}
   * returns as `route.path` on a `"matched"` lookup — never the raw request
   * target, a path parameter's captured value, or a query string. This
   * value becomes part of a durable primary key in
   * `console_telemetry_rollup`; ADR-0070's display-vs-persist rule limits
   * persistent records to names, references and allow-listed scalars, and a
   * raw request target (e.g. `/api/v1/runs?token=...`) is caller-supplied
   * free text, not one of those.
   */
  readonly route: string;
  /**
   * The response outcome bucket, e.g. `"2xx"`. Non-empty. MUST be a
   * bounded, enumerable identifier, never caller-supplied free text — see
   * {@link M3LTelemetryHttpRequestSample.route} for why.
   */
  readonly outcome: string;
  /** Request latency in milliseconds. Non-negative safe integer. */
  readonly latencyMs: number;
}

/**
 * A single run's terminal outcome and duration, as the orchestrator observes
 * it once a run finishes.
 */
export interface M3LTelemetryRunFinishedSample {
  /**
   * The script that ran. MUST be a bounded, enumerable identifier, never
   * caller-supplied free text — see
   * {@link M3LTelemetryHttpRequestSample.route} for why.
   */
  readonly script: string;
  /** The operation within the script, when the script has more than one. */
  readonly operation?: string | undefined;
  /**
   * The run's terminal outcome, e.g. `"succeeded"` or `"failed"`. MUST be a
   * bounded, enumerable identifier, never caller-supplied free text — see
   * {@link M3LTelemetryHttpRequestSample.route} for why.
   */
  readonly outcome: string;
  /** Run duration in milliseconds. */
  readonly durationMs: number;
}

/**
 * An SSE stream lifecycle event, as `http/stream-writer.ts` observes it. A
 * pure counter — carries no measurement.
 */
export interface M3LTelemetrySseStreamSample {
  /**
   * The stream's terminal outcome, when one is known, e.g. `"closed"`. MUST
   * be a bounded, enumerable identifier, never caller-supplied free text —
   * see {@link M3LTelemetryHttpRequestSample.route} for why.
   */
  readonly outcome?: string | undefined;
}

/**
 * A policy-enforcement decision, as the auth/policy layer observes it. A
 * pure counter — carries no measurement.
 */
export interface M3LTelemetryPolicyDecisionSample {
  /**
   * The policy posture in effect, e.g. `"enforce"` or `"monitor"`. MUST be
   * a bounded, enumerable identifier, never caller-supplied free text — see
   * {@link M3LTelemetryHttpRequestSample.route} for why.
   */
  readonly posture: string;
  /**
   * The decision's outcome, when one is known, e.g. `"denied"`. MUST be a
   * bounded, enumerable identifier, never caller-supplied free text — see
   * {@link M3LTelemetryHttpRequestSample.route} for why.
   */
  readonly outcome?: string | undefined;
}

/**
 * A store-size health sample. Carries no `outcome`: the v9 DDL forbids one
 * for this metric (`src/store/migrations/telemetry.ts`).
 */
export interface M3LTelemetryStoreHealthSample {
  /** The store's on-disk size in bytes. */
  readonly sizeBytes: number;
}

/**
 * The telemetry-recording port. Every method returns `void` and never
 * throws — see the module doc for why, and how that differs from
 * {@link "../audit/port.js".M3LHumanActionAuditPort}.
 *
 * @example
 * ```ts
 * import type { M3LTelemetryRecorder } from "@m3l-automation/m3l-console-server/telemetry/port.js";
 *
 * function onRequestFinished(
 *   telemetry: M3LTelemetryRecorder,
 *   latencyMs: number,
 * ): void {
 *   // Never throws, never rejects — safe to call from any request path.
 *   telemetry.httpRequest({ route: "/api/v1/runs", outcome: "2xx", latencyMs });
 * }
 * ```
 */
export interface M3LTelemetryRecorder {
  /** Records one HTTP request's outcome and latency. */
  httpRequest(sample: M3LTelemetryHttpRequestSample): void;
  /** Records one run's terminal outcome and duration. */
  runFinished(sample: M3LTelemetryRunFinishedSample): void;
  /** Records one SSE stream lifecycle event. */
  sseStream(sample: M3LTelemetrySseStreamSample): void;
  /** Records one policy-enforcement decision. */
  policyDecision(sample: M3LTelemetryPolicyDecisionSample): void;
  /** Records one store-size health sample. */
  storeHealth(sample: M3LTelemetryStoreHealthSample): void;
}
