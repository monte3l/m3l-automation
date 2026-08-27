/**
 * `http/request-validation` — transport-level request validation that
 * rejects a request before it is ever dispatched, split out of
 * `handler.ts` purely for file-size budget reasons (mirrors the test split:
 * `tests/handler-validation.test.ts` already separates this concern —
 * "requests rejected at the seam, before routing ever runs" — from
 * `tests/handler.test.ts`'s request-pipeline mechanics).
 *
 * @packageDocumentation
 */

import type { IncomingMessage } from "node:http";

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * `rawHeaders` interleaves names and values as
 * `[name, value, name, value, ...]`, so scanning for field-line names steps
 * by two rather than iterating one entry at a time.
 */
const RAW_HEADER_STRIDE = 2;

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` when `rawHeaders` carries more than one
 * `Host` field-line, per RFC 9110 §7.2 ("a server MUST respond with a 400...
 * status code to any request message that contains more than one Host
 * header field"). MEASURED on a real `node:http` server (Node v26.7.0):
 * `req.headers` collapses a duplicate `Host` down to the FIRST value, so a
 * request sending the loopback host first and an attacker host second was
 * served 200 — the second value was invisible to every downstream check,
 * including the origin guard. `rawHeaders` is the only place a duplicate is
 * still observable: it is the flat, alternating
 * `[name, value, name, value, ...]` list Node never collapses, so this steps
 * by 2. Matching is case-insensitive (`Host` and `host` name the same field)
 * and this is a malformed-framing check, not a content check — it rejects
 * even when both values happen to be loopback.
 *
 * `rawHeaders` is typed as always present on a real `IncomingMessage`, but
 * is accepted here as possibly `undefined` and treated as "nothing to
 * check" rather than thrown on: a real socket-backed request always
 * populates it, so an absent value only ever occurs in a lightweight test
 * double that never claimed to model wire-level duplicate framing in the
 * first place — this guard exists to catch a real duplicate, not to reject
 * a caller that has no rawHeaders to offer.
 */
function assertSingleHostHeader(
  rawHeaders: readonly string[] | undefined,
): void {
  if (rawHeaders === undefined) return;
  let hostFieldLines = 0;
  for (let index = 0; index < rawHeaders.length; index += RAW_HEADER_STRIDE) {
    if (rawHeaders[index]?.toLowerCase() === "host") hostFieldLines += 1;
  }
  if (hostFieldLines > 1) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request carries more than one Host header field-line",
    );
  }
}

/**
 * Coerces Node's header map to the plain string map `createRequestContext`
 * expects, first rejecting a duplicate `Host` field-line that `headers`
 * itself cannot represent (see {@link assertSingleHostHeader}).
 *
 * @param headers - The inbound `IncomingMessage.headers` map.
 * @param rawHeaders - The inbound `IncomingMessage.rawHeaders` flat list.
 * @returns The coerced, plain string header map.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `rawHeaders` carries more than one `Host` field-line.
 *
 * @example
 * ```ts
 * import type { IncomingMessage } from "node:http";
 *
 * function coerce(req: IncomingMessage): Readonly<Record<string, string | undefined>> {
 *   return toHeaderMap(req.headers, req.rawHeaders);
 * }
 * ```
 */
export function toHeaderMap(
  headers: IncomingMessage["headers"],
  rawHeaders: readonly string[] | undefined,
): Readonly<Record<string, string | undefined>> {
  assertSingleHostHeader(rawHeaders);
  // `IncomingHttpHeaders` types every value as `string | string[] | undefined`
  // only to accommodate a handful of headers (`set-cookie`) that never occur
  // on an inbound server request; every header this package reads
  // (`x-correlation-id`) is always a single string in practice.
  return headers as unknown as Readonly<Record<string, string | undefined>>;
}
