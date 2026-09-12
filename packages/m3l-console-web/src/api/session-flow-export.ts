import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";
import { encodePathSegment } from "../internal/path-segment.js";

/**
 * Request body for {@link exportSessionAsFlow}. `description` is omitted
 * entirely (never sent as `undefined`) when the caller has none to supply —
 * mirrors the server's own `parseFlowExportBody` conditional-spread
 * convention (`http/routes/session-flow-export.ts`).
 */
export interface M3LSessionFlowExportRequest {
  readonly name: string;
  readonly description?: string;
  readonly overwrite?: boolean;
}

/** One step within a written flow document — see {@link M3LSessionFlowWriteResult}. */
export interface M3LSessionFlowStepResult {
  readonly stepId: string;
  readonly ordinal: number;
  readonly flowStepId: string;
  readonly script: string;
  readonly outcome: string | null;
  readonly parameterReferences: Readonly<Record<string, string | null>>;
}

/**
 * The result of successfully exporting a session as a flow document — see
 * {@link exportSessionAsFlow}.
 */
export interface M3LSessionFlowWriteResult {
  readonly name: string;
  readonly yaml: string;
  readonly steps: readonly M3LSessionFlowStepResult[];
  readonly decisionsDropped: number;
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isParameterReferences(
  value: unknown,
): value is Readonly<Record<string, string | null>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => typeof entry === "string" || entry === null,
    )
  );
}

/**
 * Checks the fields every flow step result carries — split out from
 * {@link isM3LSessionFlowWriteResult} purely to keep that guard's
 * cyclomatic complexity down.
 */
function isM3LSessionFlowStepResult(
  value: unknown,
): value is M3LSessionFlowStepResult {
  return (
    isRecord(value) &&
    typeof value["stepId"] === "string" &&
    typeof value["ordinal"] === "number" &&
    typeof value["flowStepId"] === "string" &&
    typeof value["script"] === "string" &&
    isNullableString(value["outcome"]) &&
    isParameterReferences(value["parameterReferences"])
  );
}

function isM3LSessionFlowWriteResult(
  value: unknown,
): value is M3LSessionFlowWriteResult {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["yaml"] === "string" &&
    Array.isArray(value["steps"]) &&
    value["steps"].every(isM3LSessionFlowStepResult) &&
    typeof value["decisionsDropped"] === "number" &&
    typeof value["path"] === "string"
  );
}

/**
 * Exports one session's recorded steps as a flow document via
 * `POST /api/v1/sessions/:id/flow-export`, URL-encoding `sessionId` into the
 * path and sending `request` as the request body unchanged.
 *
 * @example
 * ```ts
 * import { exportSessionAsFlow } from "@m3l-automation/m3l-console-web/api/session-flow-export.js";
 *
 * const result = await exportSessionAsFlow(
 *   "0193f0c2-1234-7abc-9def-000000000000",
 *   { name: "dlq-reconcile" },
 * );
 * if (result.ok) {
 *   console.log(result.data.path);
 * }
 * ```
 */
export async function exportSessionAsFlow(
  sessionId: string,
  request: M3LSessionFlowExportRequest,
): Promise<M3LConsoleFetchResult<M3LSessionFlowWriteResult>> {
  const result = await fetchConsoleJson<M3LSessionFlowWriteResult>(
    `/api/v1/sessions/${encodePathSegment(sessionId)}/flow-export`,
    { method: "POST", body: request },
  );
  if (result.ok && !isM3LSessionFlowWriteResult(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message:
          "unexpected POST /api/v1/sessions/:id/flow-export response shape",
      },
    };
  }
  return result;
}
