/**
 * `http/respond` — builds and writes {@link M3LConsoleResponse}s.
 *
 * `writeResponse` is the single place a response actually reaches the wire;
 * every handler and middleware in this package returns a plain
 * {@link M3LConsoleResponse} value rather than touching `node:http`'s
 * `ServerResponse` directly.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from "node:http";

import { Core } from "@m3l-automation/m3l-common";

/** The `content-type` header value every {@link jsonResponse} sets. */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * A framework-agnostic HTTP response value. Handlers and middleware build
 * and pass these around; only {@link writeResponse} ever touches the
 * underlying `node:http` `ServerResponse`.
 *
 * @example
 * ```ts
 * const response: M3LConsoleResponse = {
 *   status: 200,
 *   headers: { "content-type": "text/plain" },
 *   body: "ok",
 * };
 * ```
 */
export interface M3LConsoleResponse {
  /** The HTTP status code. */
  readonly status: number;
  /** Response headers, not including `content-length` (added by {@link writeResponse}). */
  readonly headers: Readonly<Record<string, string>>;
  /** The serialized response body. */
  readonly body: string;
}

/**
 * Builds an {@link M3LConsoleResponse} whose body is `payload` serialized
 * with `Core.safeJsonStringify`, with a fixed JSON `content-type` header
 * (`application/json; charset=utf-8`) merged alongside any caller-supplied
 * `headers`.
 *
 * @param status - The HTTP status code.
 * @param payload - The value to serialize as the JSON body.
 * @param headers - Additional headers to merge in; `content-type` here is
 *   overridden by the fixed JSON content type.
 * @returns The resulting {@link M3LConsoleResponse}.
 *
 * @example
 * ```ts
 * const response = jsonResponse(200, { ok: true });
 * ```
 */
export function jsonResponse(
  status: number,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
): M3LConsoleResponse {
  return {
    status,
    headers: { ...headers, "content-type": JSON_CONTENT_TYPE },
    body: Core.safeJsonStringify(payload),
  };
}

/**
 * Writes `response` onto `res`: sets its status and headers, adds
 * `content-length` (the UTF-8 byte length of the body, not its string
 * length — a multi-byte body would otherwise get a wrong, too-small
 * `content-length`), and echoes `correlationId` under
 * `x-correlation-id`. A no-op when `res.writableEnded` or `res.headersSent`
 * is already `true` — a drained or aborted connection must not throw
 * `ERR_HTTP_HEADERS_SENT` out of the request listener.
 *
 * @param res - The underlying `node:http` response.
 * @param response - The response to write.
 * @param correlationId - The request's correlation id, echoed as a header.
 *
 * @example
 * ```ts
 * import type { ServerResponse } from "node:http";
 *
 * function reply(res: ServerResponse, correlationId: string): void {
 *   writeResponse(res, jsonResponse(200, { ok: true }), correlationId);
 * }
 * ```
 */
export function writeResponse(
  res: ServerResponse,
  response: M3LConsoleResponse,
  correlationId: string,
): void {
  if (res.writableEnded || res.headersSent) return;

  res.writeHead(response.status, {
    ...response.headers,
    "x-correlation-id": correlationId,
    "content-length": String(Buffer.byteLength(response.body, "utf8")),
  });
  res.end(response.body);
}
