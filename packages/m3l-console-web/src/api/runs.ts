import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";
import { encodePathSegment } from "../internal/path-segment.js";

/**
 * The closed vocabulary of run statuses the console server can report.
 * A runtime array (not just a type) so this module's own shape guard can
 * validate a decoded `status` value against it without re-declaring the
 * list. Not exported — it is referenced only within this file (the derived
 * {@link M3LRunStatus} type is the public vocabulary surface).
 */
const M3L_RUN_STATUSES = [
  "queued",
  "running",
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
] as const;

/** One of the closed set of run statuses in {@link M3L_RUN_STATUSES}. */
export type M3LRunStatus = (typeof M3L_RUN_STATUSES)[number];

/**
 * One run record, as returned by `GET /api/v1/runs` and
 * `GET /api/v1/runs/:id`. The stored field for the script name is `script`
 * — the launch *request* body uses `scriptName`, but the persisted record
 * does not.
 */
export interface M3LRunRecord {
  readonly id: string;
  readonly script: string;
  readonly status: M3LRunStatus;
  readonly dryRun: boolean;
  readonly executionMode: string;
  /**
   * Caller-supplied JSON the server persists and echoes back verbatim —
   * this stays `unknown` rather than a guessed shape, since the guard below
   * cannot (and must not pretend to) know what a launch request contained.
   */
  readonly parameters: unknown;
  readonly operator: string;
  readonly correlationId: string;
  readonly queuedAtMs: number;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly outcome: string | null;
  readonly exitCode: number | null;
  readonly failureMessage: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isM3LRunStatus(value: unknown): value is M3LRunStatus {
  return (
    typeof value === "string" &&
    (M3L_RUN_STATUSES as readonly string[]).includes(value)
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/**
 * Checks the non-nullable identity/classification fields every run record
 * carries — split out from {@link isM3LRunRecord} purely to keep each
 * guard's cyclomatic complexity down; these fields are validated no
 * differently than the nullable ones in {@link hasNullableRunFields}.
 */
function hasRequiredRunFields(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["script"] === "string" &&
    isM3LRunStatus(candidate["status"]) &&
    typeof candidate["dryRun"] === "boolean" &&
    typeof candidate["executionMode"] === "string" &&
    typeof candidate["operator"] === "string" &&
    typeof candidate["correlationId"] === "string" &&
    typeof candidate["queuedAtMs"] === "number"
  );
}

/**
 * Checks the fields that serialise as `null` rather than being absent —
 * `startedAtMs`, `endedAtMs`, `outcome`, `exitCode`, `failureMessage`.
 */
function hasNullableRunFields(candidate: Record<string, unknown>): boolean {
  return (
    isNullableNumber(candidate["startedAtMs"]) &&
    isNullableNumber(candidate["endedAtMs"]) &&
    isNullableString(candidate["outcome"]) &&
    isNullableNumber(candidate["exitCode"]) &&
    isNullableString(candidate["failureMessage"])
  );
}

function isM3LRunRecord(value: unknown): value is M3LRunRecord {
  return (
    isRecord(value) &&
    hasRequiredRunFields(value) &&
    hasNullableRunFields(value)
  );
}

/**
 * Fetches the list of run records.
 *
 * @example
 * ```ts
 * import { fetchRuns } from "@m3l-automation/m3l-console-web/api/runs.js";
 *
 * const result = await fetchRuns();
 * if (result.ok) {
 *   console.log(result.data.map((run) => run.status));
 * }
 * ```
 */
export async function fetchRuns(): Promise<
  M3LConsoleFetchResult<readonly M3LRunRecord[]>
> {
  const result =
    await fetchConsoleJson<readonly M3LRunRecord[]>("/api/v1/runs");
  if (
    result.ok &&
    (!Array.isArray(result.data) || !result.data.every(isM3LRunRecord))
  ) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/runs response shape",
      },
    };
  }
  return result;
}

/**
 * Fetches one run record by id, URL-encoding `id` into the path.
 *
 * `id` is external input — it flows from `location.hash` through the
 * router, which only rejects empty and `/`-containing values — so it is
 * encoded via {@link encodePathSegment} rather than interpolated raw. See
 * that helper's TSDoc for why plain `encodeURIComponent` alone is not
 * enough to stop a `".."` id from resolving the request path up a level.
 *
 * @example
 * ```ts
 * import { fetchRun } from "@m3l-automation/m3l-console-web/api/runs.js";
 *
 * const result = await fetchRun("0193f0c2-1234-7abc-9def-000000000000");
 * if (result.ok) {
 *   console.log(result.data.status);
 * }
 * ```
 */
export async function fetchRun(
  id: string,
): Promise<M3LConsoleFetchResult<M3LRunRecord>> {
  const result = await fetchConsoleJson<M3LRunRecord>(
    `/api/v1/runs/${encodePathSegment(id)}`,
  );
  if (result.ok && !isM3LRunRecord(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/runs/:id response shape",
      },
    };
  }
  return result;
}

/**
 * Body of a `POST /api/v1/runs` launch request. `parameters` is a flat
 * string-valued map — the server coerces each value to the declared
 * parameter type. `confirmed: true` is required for any non-dry-run launch;
 * a `dryRun: true` request is exempt. This is a discriminated union rather
 * than two independent booleans specifically so the combination
 * `dryRun: false` with `confirmed: false` — a shape the server always
 * rejects with a 409 — cannot be constructed at all; the invariant moves
 * from a runtime 409 to a compile error.
 */
export type M3LRunLaunchRequest = {
  readonly scriptName: string;
  readonly parameters: Readonly<Record<string, string>>;
} & (
  | { readonly dryRun: true; readonly confirmed?: false }
  | { readonly dryRun: false; readonly confirmed: true }
);

/**
 * The subset of {@link M3LRunStatus} a freshly-launched run can report — a
 * launch either enters the queue or starts running immediately, so it
 * cannot already be terminal.
 */
const M3L_RUN_HANDLE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly M3LRunStatus[];

/**
 * Handle returned by a successful `POST /api/v1/runs` launch (201). The
 * field is `scriptName` here — the persisted {@link M3LRunRecord} uses
 * `script` instead. The two shapes are deliberately distinct; see that
 * interface's TSDoc.
 */
export interface M3LRunHandle {
  readonly id: string;
  readonly scriptName: string;
  readonly status: (typeof M3L_RUN_HANDLE_STATUSES)[number];
  readonly dryRun: boolean;
  readonly executionMode: string;
}

function isM3LRunHandleStatus(value: unknown): value is M3LRunHandle["status"] {
  return (
    typeof value === "string" &&
    (M3L_RUN_HANDLE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Type guard for {@link M3LRunHandle}. Exported (rather than kept module-
 * private like this file's other guards) so `api/sessions.ts`'s
 * `addSessionStep` can validate the `handle` field of its response body
 * without duplicating this guard's field checks.
 *
 * @example
 * ```ts
 * import { isM3LRunHandle } from "@m3l-automation/m3l-console-web/api/runs.js";
 *
 * if (isM3LRunHandle(candidate)) {
 *   console.log(candidate.scriptName);
 * }
 * ```
 */
export function isM3LRunHandle(value: unknown): value is M3LRunHandle {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["scriptName"] === "string" &&
    isM3LRunHandleStatus(value["status"]) &&
    typeof value["dryRun"] === "boolean" &&
    typeof value["executionMode"] === "string"
  );
}

/**
 * Launches a run via `POST /api/v1/runs`.
 *
 * @example
 * ```ts
 * import { launchRun } from "@m3l-automation/m3l-console-web/api/runs.js";
 *
 * const result = await launchRun({
 *   scriptName: "json-etl",
 *   parameters: { input: "a.json" },
 *   dryRun: true,
 * });
 * if (result.ok) {
 *   console.log(result.data.id);
 * }
 * ```
 */
export async function launchRun(
  request: M3LRunLaunchRequest,
): Promise<M3LConsoleFetchResult<M3LRunHandle>> {
  const result = await fetchConsoleJson<M3LRunHandle>("/api/v1/runs", {
    method: "POST",
    body: request,
  });
  if (result.ok && !isM3LRunHandle(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected POST /api/v1/runs response shape",
      },
    };
  }
  return result;
}
