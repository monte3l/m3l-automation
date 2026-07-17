import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { destructiveGate } from "./destructive-gate.js";
import { resolveAuthHeaders } from "./resolve-auth-headers.js";

/**
 * `single-request` — runs the `request` command: exactly one HTTP call per
 * run, confirm-gated when `method` is mutating.
 */

/** HTTP verbs `destructive-gate` confirms before dispatch; GET/HEAD are never gated. */
const MUTATING_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Reads a required string parameter (`path`/`method`), throwing when it is
 * missing (never declared `required: true` for `path` — F1b — so per-command
 * requiredness is guard-checked here) or was stored as a non-string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"`.
 */
function readRequiredString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required for 'request'`, {
      code: "ERR_API_GATEWAY_CLIENT_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Reads an optional string parameter, treating an empty string as unset. */
function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrows `value` to a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerces a response body into a JSONL-appendable record, wrapping a non-object body. */
function toJsonlRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : { value };
}

/** Resolves `path` against `baseUrl` (per `new URL(path, baseUrl)`) when configured. */
function buildRequestUrl(path: string, baseUrl: string | undefined): string {
  return baseUrl === undefined ? path : new URL(path, baseUrl).toString();
}

/**
 * Writes `response` to the configured `output` (a no-op when unset). A
 * `writer.close()` failure is swallowed only while it would mask an
 * original `append()` failure; on the happy path it propagates normally.
 */
async function writeResponseIfConfigured(
  config: Core.M3LConfig,
  paths: Core.M3LPaths,
  response: unknown,
): Promise<void> {
  const output = readOptionalString(config, "output");
  if (output === undefined) return;

  const exporter = new Core.M3LJSONListExporter<Record<string, unknown>>({
    filePath: paths.resolveOutput(output),
    format: "jsonl",
  });
  const writer = exporter.exportStream();
  try {
    await writer.append(toJsonlRecord(response));
  } catch (cause) {
    try {
      await writer.close();
    } catch {
      // best-effort: a close failure must not mask the original error
    }
    throw cause;
  }
  await writer.close();
}

/**
 * Runs the `request` command: guard-resolves `path`, runs `destructive-gate`
 * when `method` is mutating, resolves the auth headers for this one request,
 * dispatches it via the injected `httpClient`, and writes the response to
 * `output` when configured.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   script-constructed `Core.M3LHttpClient`, the optional
 *   `AWS.M3LRequestSigner`, and the interactive-prompt facade.
 * @returns A promise that resolves once the request (and optional output
 *   write) completes.
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"` when
 *   `path` is missing, or `"ERR_API_GATEWAY_CLIENT_ABORTED"` when a mutating
 *   verb's confirmation is declined.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { singleRequest } from "./single-request.js";
 *
 * await singleRequest({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "api-gateway-client", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   httpClient: new Core.M3LHttpClient({ baseUrl: "https://api.example.com" }),
 *   signer: undefined,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function singleRequest(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly httpClient: Core.M3LHttpClient;
  readonly signer: AWS.M3LRequestSigner | undefined;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const method = readRequiredString(
    deps.config,
    "method",
  ) as Core.M3LHttpMethod;
  const path = readRequiredString(deps.config, "path");
  const body = readOptionalString(deps.config, "body");
  const baseUrl = readOptionalString(deps.config, "baseUrl");
  const yes = deps.config.get("yes") === true;

  const url = buildRequestUrl(path, baseUrl);

  if (MUTATING_METHODS.includes(method)) {
    await destructiveGate({
      prompt: deps.prompt,
      logger: deps.logger,
      description: `${method} ${url}`,
      yes,
    });
  }

  const headers = await resolveAuthHeaders({
    config: deps.config,
    signer: deps.signer,
    method,
    url,
    ...(body !== undefined && { body }),
  });

  const response = await deps.httpClient.request<unknown>({
    method,
    path,
    headers,
    ...(body !== undefined && { body }),
  });

  await writeResponseIfConfigured(deps.config, deps.paths, response);

  deps.logger.step(
    `api-gateway-client request ${deps.correlationId} complete`,
    { method, path },
  );
}
