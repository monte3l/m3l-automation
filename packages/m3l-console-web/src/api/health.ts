import type { M3LConsoleFetchResult } from "./client.js";
import { fetchConsoleJson } from "./client.js";

/** Payload returned by the console-server's `/health` endpoint. */
export interface M3LHealthPayload {
  readonly status: "ok";
  readonly uptimeMs: number;
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
  return fetchConsoleJson<M3LHealthPayload>("/health");
}
