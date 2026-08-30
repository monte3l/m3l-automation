import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";

/**
 * The closed vocabulary of run statuses the console server can report.
 * Exported as a runtime array (not just a type) so callers — and this
 * module's own shape guard — can validate a decoded `status` value against
 * it without re-declaring the list.
 */
export const M3L_RUN_STATUSES = [
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
 * Fetches one run record by id.
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
  const result = await fetchConsoleJson<M3LRunRecord>(`/api/v1/runs/${id}`);
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
