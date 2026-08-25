import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { resolveAuthHeaders } from "./resolve-auth-headers.js";

/**
 * `single-request` — runs the `request` command: exactly one HTTP call per
 * run, confirm-gated when `method` is mutating.
 */

/** HTTP verbs `Core.confirmDestructive` confirms before dispatch; GET/HEAD are never gated. */
const MUTATING_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

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
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: "ERR_API_GATEWAY_CLIENT_CONFIG",
  });
  const output = accessor.optionalNonEmptyString("output");
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
 * Runs the `request` command: guard-resolves `path`, runs
 * `Core.confirmDestructive` when `method` is mutating, resolves the auth
 * headers for this one request,
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
  readonly awsTarget: Core.M3LDestructiveTarget | undefined;
}): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_API_GATEWAY_CLIENT_CONFIG",
  });
  const method = accessor.requiredString(
    "method",
    "request",
  ) as Core.M3LHttpMethod;
  const path = accessor.requiredString("path", "request");
  const body = accessor.optionalNonEmptyString("body");
  const baseUrl = accessor.optionalNonEmptyString("baseUrl");
  const yes = deps.config.get("yes") === true;
  const yesSensitive = deps.config.get("yesSensitive") === true;

  const url = buildRequestUrl(path, baseUrl);

  if (MUTATING_METHODS.includes(method)) {
    await Core.confirmDestructive({
      prompt: deps.prompt,
      logger: deps.logger,
      description: `${method} ${url}`,
      yes,
      yesSensitive,
      code: "ERR_API_GATEWAY_CLIENT_ABORTED",
      ...(deps.awsTarget !== undefined && { target: deps.awsTarget }),
      isSensitiveTarget: (target) =>
        target.profile.toLowerCase().includes("prod"),
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
