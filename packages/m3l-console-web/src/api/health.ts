import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";

/** Payload returned by the console-server's `/health` endpoint. */
export interface M3LHealthPayload {
  readonly status: "ok";
  readonly uptimeMs: number;
}

function isM3LHealthPayload(data: unknown): data is M3LHealthPayload {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    candidate["status"] === "ok" && typeof candidate["uptimeMs"] === "number"
  );
}

/**
 * Fetches the console-server's health status.
 *
 * @example
 * ```ts
 * import { fetchHealth } from "@m3l-automation/m3l-console-web/api/health.js";
 *
 * const result = await fetchHealth();
 * if (result.ok) {
 *   console.log(`uptime: ${result.data.uptimeMs}ms`);
 * }
 * ```
 */
export async function fetchHealth(): Promise<
  M3LConsoleFetchResult<M3LHealthPayload>
> {
  const result = await fetchConsoleJson<M3LHealthPayload>("/health");
  if (result.ok && !isM3LHealthPayload(result.data)) {
    return {
      ok: false,
      error: {
        kind: "malformed-body",
        message: "unexpected /health response shape",
      },
    };
  }
  return result;
}
