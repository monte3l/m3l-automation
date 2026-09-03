import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";
import { encodePathSegment } from "../internal/path-segment.js";

/**
 * The closed vocabulary of session statuses the console server can report.
 * A runtime array (not just a type) so this module's own shape guard can
 * validate a decoded `status` value against it without re-declaring the
 * list. Not exported — it is referenced only within this file (the derived
 * {@link M3LSessionStatus} type is the public vocabulary surface).
 */
const M3L_SESSION_STATUSES = ["open", "closed"] as const;

/** One of the closed set of session statuses in {@link M3L_SESSION_STATUSES}. */
export type M3LSessionStatus = (typeof M3L_SESSION_STATUSES)[number];

/**
 * One session record, as returned by `GET /api/v1/sessions`,
 * `GET /api/v1/sessions/:id`, and `POST /api/v1/sessions`. Modeled as a
 * discriminated union on `status` rather than a single interface with an
 * optional `closedAtMs` — an open session cannot carry a `closedAtMs` at
 * all, and a closed one always must, so the invariant is expressed at the
 * type level instead of left to a runtime check callers could forget.
 */
export type M3LSessionRecord =
  | {
      readonly id: string;
      readonly operator: string;
      readonly correlationId: string;
      readonly status: "open";
      readonly createdAtMs: number;
      readonly updatedAtMs: number;
      readonly closedAtMs?: never;
    }
  | {
      readonly id: string;
      readonly operator: string;
      readonly correlationId: string;
      readonly status: "closed";
      readonly createdAtMs: number;
      readonly updatedAtMs: number;
      readonly closedAtMs: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isM3LSessionStatus(value: unknown): value is M3LSessionStatus {
  return (
    typeof value === "string" &&
    (M3L_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Checks the fields every session record carries regardless of status —
 * split out from {@link isM3LSessionRecord} purely to keep that guard's
 * cyclomatic complexity down.
 */
function hasRequiredSessionFields(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["operator"] === "string" &&
    typeof candidate["correlationId"] === "string" &&
    isM3LSessionStatus(candidate["status"]) &&
    typeof candidate["createdAtMs"] === "number" &&
    typeof candidate["updatedAtMs"] === "number"
  );
}

function isM3LSessionRecord(value: unknown): value is M3LSessionRecord {
  if (!isRecord(value) || !hasRequiredSessionFields(value)) {
    return false;
  }
  if (value["status"] === "closed") {
    return typeof value["closedAtMs"] === "number";
  }
  return !("closedAtMs" in value);
}

/**
 * Fetches the list of session records.
 *
 * @example
 * ```ts
 * import { fetchSessions } from "@m3l-automation/m3l-console-web/api/sessions.js";
 *
 * const result = await fetchSessions();
 * if (result.ok) {
 *   console.log(result.data.map((session) => session.status));
 * }
 * ```
 */
export async function fetchSessions(): Promise<
  M3LConsoleFetchResult<readonly M3LSessionRecord[]>
> {
  const result =
    await fetchConsoleJson<readonly M3LSessionRecord[]>("/api/v1/sessions");
  if (
    result.ok &&
    (!Array.isArray(result.data) || !result.data.every(isM3LSessionRecord))
  ) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/sessions response shape",
      },
    };
  }
  return result;
}

/**
 * Fetches one session record by id, URL-encoding `id` into the path.
 *
 * `id` is external input — it flows from `location.hash` through the
 * router, which only rejects empty and `/`-containing values — so it is
 * encoded via {@link encodePathSegment} rather than interpolated raw.
 *
 * @example
 * ```ts
 * import { fetchSession } from "@m3l-automation/m3l-console-web/api/sessions.js";
 *
 * const result = await fetchSession("0193f0c2-1234-7abc-9def-000000000000");
 * if (result.ok) {
 *   console.log(result.data.status);
 * }
 * ```
 */
export async function fetchSession(
  id: string,
): Promise<M3LConsoleFetchResult<M3LSessionRecord>> {
  const result = await fetchConsoleJson<M3LSessionRecord>(
    `/api/v1/sessions/${encodePathSegment(id)}`,
  );
  if (result.ok && !isM3LSessionRecord(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/sessions/:id response shape",
      },
    };
  }
  return result;
}

/**
 * Creates a new (open) session via `POST /api/v1/sessions`. The request
 * carries no body — a session starts empty and is populated by later step
 * launches — so no `body` key is passed to {@link fetchConsoleJson} at all.
 *
 * @example
 * ```ts
 * import { createSession } from "@m3l-automation/m3l-console-web/api/sessions.js";
 *
 * const result = await createSession();
 * if (result.ok) {
 *   console.log(result.data.id);
 * }
 * ```
 */
export async function createSession(): Promise<
  M3LConsoleFetchResult<M3LSessionRecord>
> {
  const result = await fetchConsoleJson<M3LSessionRecord>("/api/v1/sessions", {
    method: "POST",
  });
  if (result.ok && !isM3LSessionRecord(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected POST /api/v1/sessions response shape",
      },
    };
  }
  return result;
}

/**
 * The closed vocabulary of session step statuses the console server can
 * report. See {@link M3L_SESSION_STATUSES} for why this is a runtime array
 * rather than just a type.
 */
const M3L_SESSION_STEP_STATUSES = [
  "queued",
  "running",
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
] as const;

/** One of the closed set of step statuses in {@link M3L_SESSION_STEP_STATUSES}. */
export type M3LSessionStepStatus = (typeof M3L_SESSION_STEP_STATUSES)[number];

/**
 * The closed vocabulary of terminal step outcomes the console server can
 * report — a subset of {@link M3LSessionStepStatus} excluding the
 * non-terminal `"queued"`/`"running"` values.
 */
const M3L_SESSION_STEP_OUTCOMES = [
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
] as const;

/** One of the closed set of step outcomes in {@link M3L_SESSION_STEP_OUTCOMES}. */
export type M3LSessionStepOutcome = (typeof M3L_SESSION_STEP_OUTCOMES)[number];

/**
 * One step summary within a session, as returned by
 * `GET /api/v1/sessions/:id/steps`. `parameters` stays `unknown` — the
 * shape depends on the step's `operation` and this guard cannot (and must
 * not pretend to) know it.
 */
export interface M3LSessionStepSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly operation: string;
  readonly parameters: unknown;
  readonly runId: string | null;
  readonly status: M3LSessionStepStatus;
  readonly queuedAtMs: number;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly outcome: M3LSessionStepOutcome | null;
  readonly failureMessage: string | null;
  readonly hasResult: boolean;
  /**
   * Never present on this list-route shape — step output must never leak
   * through the list route. Mirrors the server's own
   * `sessions/service-reads.ts` `M3LSessionStepSummary`
   * (`Omit<M3LSessionStepRecord, "resultRef"> & { hasResult: boolean; resultRef?: never }`)
   * and this file's own `closedAtMs?: never` / `answer?: never` markers: a
   * type-level ban that documents the invariant and catches accidental
   * object-literal construction, without the runtime guard needing to check
   * for its absence.
   */
  readonly resultRef?: never;
}

function isM3LSessionStepStatus(value: unknown): value is M3LSessionStepStatus {
  return (
    typeof value === "string" &&
    (M3L_SESSION_STEP_STATUSES as readonly string[]).includes(value)
  );
}

function isNullableSessionStepOutcome(
  value: unknown,
): value is M3LSessionStepOutcome | null {
  return (
    value === null ||
    (typeof value === "string" &&
      (M3L_SESSION_STEP_OUTCOMES as readonly string[]).includes(value))
  );
}

/**
 * Checks the non-nullable identity/classification fields every step summary
 * carries — split out from {@link isM3LSessionStepSummary} purely to keep
 * that guard's cyclomatic complexity down; these fields are validated no
 * differently than the nullable ones in {@link hasNullableStepFields}.
 */
function hasRequiredStepFields(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["sessionId"] === "string" &&
    typeof candidate["ordinal"] === "number" &&
    typeof candidate["operation"] === "string" &&
    isM3LSessionStepStatus(candidate["status"]) &&
    typeof candidate["queuedAtMs"] === "number" &&
    typeof candidate["hasResult"] === "boolean"
  );
}

/**
 * Checks the fields that serialise as `null` rather than being absent —
 * `runId`, `startedAtMs`, `endedAtMs`, `outcome`, `failureMessage`.
 */
function hasNullableStepFields(candidate: Record<string, unknown>): boolean {
  return (
    isNullableString(candidate["runId"]) &&
    isNullableNumber(candidate["startedAtMs"]) &&
    isNullableNumber(candidate["endedAtMs"]) &&
    isNullableSessionStepOutcome(candidate["outcome"]) &&
    isNullableString(candidate["failureMessage"])
  );
}

function isM3LSessionStepSummary(
  value: unknown,
): value is M3LSessionStepSummary {
  return (
    isRecord(value) &&
    hasRequiredStepFields(value) &&
    hasNullableStepFields(value)
  );
}

/**
 * Fetches the ordered list of step summaries for one session, URL-encoding
 * `sessionId` into the path.
 *
 * @example
 * ```ts
 * import { fetchSessionSteps } from "@m3l-automation/m3l-console-web/api/sessions.js";
 *
 * const result = await fetchSessionSteps(
 *   "0193f0c2-1234-7abc-9def-000000000000",
 * );
 * if (result.ok) {
 *   console.log(result.data.map((step) => step.status));
 * }
 * ```
 */
export async function fetchSessionSteps(
  sessionId: string,
): Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>> {
  const result = await fetchConsoleJson<readonly M3LSessionStepSummary[]>(
    `/api/v1/sessions/${encodePathSegment(sessionId)}/steps`,
  );
  if (
    result.ok &&
    (!Array.isArray(result.data) || !result.data.every(isM3LSessionStepSummary))
  ) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/sessions/:id/steps response shape",
      },
    };
  }
  return result;
}

/**
 * One decision within a session, as returned by
 * `GET /api/v1/sessions/:id/decisions`. Modeled as a discriminated union on
 * `status` — a pending decision has never been answered, so `answer` and
 * `answeredAtMs` cannot exist yet; an answered one always carries both.
 * `options` stays `unknown` — the option set depends on the prompting step
 * and this guard cannot (and must not pretend to) know its shape; it may
 * also be `null` when the step imposes no closed option set.
 */
export type M3LSessionDecisionRecord =
  | {
      readonly id: string;
      readonly sessionId: string;
      readonly stepId: string;
      readonly prompt: string;
      readonly options: unknown;
      readonly createdAtMs: number;
      readonly status: "pending";
      readonly answer?: never;
      readonly answeredAtMs?: never;
    }
  | {
      readonly id: string;
      readonly sessionId: string;
      readonly stepId: string;
      readonly prompt: string;
      readonly options: unknown;
      readonly createdAtMs: number;
      readonly status: "answered";
      readonly answer: unknown;
      readonly answeredAtMs: number;
    };

const M3L_SESSION_DECISION_STATUSES = ["pending", "answered"] as const;

function isM3LSessionDecisionStatus(
  value: unknown,
): value is "pending" | "answered" {
  return (
    typeof value === "string" &&
    (M3L_SESSION_DECISION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Checks the fields every decision record carries regardless of status —
 * split out from {@link isM3LSessionDecisionRecord} purely to keep that
 * guard's cyclomatic complexity down.
 */
function hasRequiredDecisionFields(
  candidate: Record<string, unknown>,
): boolean {
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["sessionId"] === "string" &&
    typeof candidate["stepId"] === "string" &&
    typeof candidate["prompt"] === "string" &&
    "options" in candidate &&
    typeof candidate["createdAtMs"] === "number" &&
    isM3LSessionDecisionStatus(candidate["status"])
  );
}

function isM3LSessionDecisionRecord(
  value: unknown,
): value is M3LSessionDecisionRecord {
  if (!isRecord(value) || !hasRequiredDecisionFields(value)) {
    return false;
  }
  if (value["status"] === "answered") {
    return "answer" in value && typeof value["answeredAtMs"] === "number";
  }
  return !("answer" in value);
}

/**
 * Fetches the list of decisions raised within one session, URL-encoding
 * `sessionId` into the path.
 *
 * @example
 * ```ts
 * import { fetchSessionDecisions } from "@m3l-automation/m3l-console-web/api/sessions.js";
 *
 * const result = await fetchSessionDecisions(
 *   "0193f0c2-1234-7abc-9def-000000000000",
 * );
 * if (result.ok) {
 *   console.log(result.data.map((decision) => decision.status));
 * }
 * ```
 */
export async function fetchSessionDecisions(
  sessionId: string,
): Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>> {
  const result = await fetchConsoleJson<readonly M3LSessionDecisionRecord[]>(
    `/api/v1/sessions/${encodePathSegment(sessionId)}/decisions`,
  );
  if (
    result.ok &&
    (!Array.isArray(result.data) ||
      !result.data.every(isM3LSessionDecisionRecord))
  ) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/sessions/:id/decisions response shape",
      },
    };
  }
  return result;
}
