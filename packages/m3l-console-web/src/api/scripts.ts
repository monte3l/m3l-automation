import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";

/** Summary of one discoverable script, as returned by `GET /api/v1/scripts`. */
export interface M3LScriptSummary {
  readonly name: string;
  readonly description: string;
  readonly hasCommandModule: boolean;
  readonly executionMode: string;
}

/** One operation a script parameter can be scoped to. */
export interface M3LScriptOperation {
  readonly name: string;
  readonly description: string;
  readonly requiredParameters: readonly string[];
}

/** One parameter accepted by a script, as declared in its manifest. */
export interface M3LScriptParameter {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: string | null;
  readonly description: string;
  readonly secret: boolean;
  readonly operations: readonly M3LScriptOperation[];
}

/**
 * Full detail for one script, as returned by
 * `GET /api/v1/scripts/:name`. Extends {@link M3LScriptSummary} with its
 * parameter and operation vocabulary.
 */
export interface M3LScriptDetail extends M3LScriptSummary {
  readonly parameters: readonly M3LScriptParameter[];
  readonly operations: readonly M3LScriptOperation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validates that `value` is an array and every element satisfies
 * `predicate` — the shared array-of-records check used by every field
 * below that stores a nested array (`operations`, `parameters`), so the
 * per-element predicate is defined exactly once regardless of how many
 * call sites reuse it.
 */
function isArrayOf<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] {
  return Array.isArray(value) && value.every(predicate);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isArrayOf(
    value,
    (entry): entry is string => typeof entry === "string",
  );
}

function isM3LScriptSummary(value: unknown): value is M3LScriptSummary {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["description"] === "string" &&
    typeof value["hasCommandModule"] === "boolean" &&
    typeof value["executionMode"] === "string"
  );
}

function isM3LScriptOperation(value: unknown): value is M3LScriptOperation {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["description"] === "string" &&
    isStringArray(value["requiredParameters"])
  );
}

function isM3LScriptParameter(value: unknown): value is M3LScriptParameter {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    isStringArray(value["aliases"]) &&
    typeof value["type"] === "string" &&
    typeof value["required"] === "boolean" &&
    (typeof value["defaultValue"] === "string" ||
      value["defaultValue"] === null) &&
    typeof value["description"] === "string" &&
    typeof value["secret"] === "boolean" &&
    isArrayOf(value["operations"], isM3LScriptOperation)
  );
}

function isM3LScriptDetail(value: unknown): value is M3LScriptDetail {
  if (!isM3LScriptSummary(value)) {
    return false;
  }
  const candidate = value as unknown as Record<string, unknown>;
  return (
    isArrayOf(candidate["parameters"], isM3LScriptParameter) &&
    isArrayOf(candidate["operations"], isM3LScriptOperation)
  );
}

/**
 * Fetches the list of discoverable scripts.
 *
 * @example
 * ```ts
 * import { fetchScripts } from "@m3l-automation/m3l-console-web/api/scripts.js";
 *
 * const result = await fetchScripts();
 * if (result.ok) {
 *   console.log(result.data.map((script) => script.name));
 * }
 * ```
 */
export async function fetchScripts(): Promise<
  M3LConsoleFetchResult<readonly M3LScriptSummary[]>
> {
  const result =
    await fetchConsoleJson<readonly M3LScriptSummary[]>("/api/v1/scripts");
  if (result.ok && !isArrayOf(result.data, isM3LScriptSummary)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/scripts response shape",
      },
    };
  }
  return result;
}

/**
 * Fetches full detail for one script, URL-encoding `name` into the path.
 *
 * @example
 * ```ts
 * import { fetchScript } from "@m3l-automation/m3l-console-web/api/scripts.js";
 *
 * const result = await fetchScript("json-etl");
 * if (result.ok) {
 *   console.log(result.data.parameters.length);
 * }
 * ```
 */
export async function fetchScript(
  name: string,
): Promise<M3LConsoleFetchResult<M3LScriptDetail>> {
  const result = await fetchConsoleJson<M3LScriptDetail>(
    `/api/v1/scripts/${encodeURIComponent(name)}`,
  );
  if (result.ok && !isM3LScriptDetail(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /api/v1/scripts/:name response shape",
      },
    };
  }
  return result;
}
