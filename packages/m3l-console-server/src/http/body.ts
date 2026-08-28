/**
 * `http/body` — streams and parses a JSON request body, enforcing a byte
 * cap WHILE streaming rather than after buffering the whole thing: a cap
 * checked only once the stream has already drained to `'end'` is not a cap
 * at all against a hostile or merely oversized client (X4 slice 7-pre).
 *
 * @packageDocumentation
 */

import type { IncomingMessage } from "node:http";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * Constructor options for {@link readJsonBody}.
 *
 * Both fields are required, with no library-supplied default: `http/` may
 * not import `config/` (ADR-0065 layering), so the 64 KiB default this
 * package actually runs with belongs to the caller
 * (`config/env.ts`'s `M3L_CONSOLE_MAX_BODY_BYTES`, threaded in via
 * `http/handler.ts`'s `maxBodyBytes` option) rather than being baked in here.
 *
 * @example
 * ```ts
 * const options: M3LReadJsonBodyOptions = {
 *   maxBytes: 65_536,
 *   signal: new AbortController().signal,
 * };
 * ```
 */
export interface M3LReadJsonBodyOptions {
  /** The maximum number of body bytes accepted before rejecting. */
  readonly maxBytes: number;
  /**
   * Aborts the read — a client disconnect or a server drain (ADR-0049).
   * `readJsonBody` rejects with `Core.M3LOperationAbortedError`, never an
   * `M3LConsoleError`, when this fires.
   */
  readonly signal: AbortSignal;
}

/** Matches `application/json`, optionally followed by `; parameter=value` pairs. */
const JSON_CONTENT_TYPE_PATTERN = /^application\/json\s*(;.*)?$/i;

/** `true` when `contentType` names the JSON media type (any parameters ignored). */
function isJsonContentType(contentType: string | undefined): boolean {
  return (
    contentType !== undefined &&
    JSON_CONTENT_TYPE_PATTERN.test(contentType.trim())
  );
}

/** Parses a `content-length` header value into a non-negative integer, or `undefined` when absent/malformed. */
function parseContentLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Builds the too-large rejection. Never names the actual observed size — only the configured cap. */
function bodyTooLargeError(maxBytes: number): M3LConsoleError {
  return new M3LConsoleError(
    "ERR_CONSOLE_BODY_TOO_LARGE",
    `request body exceeds the ${String(maxBytes)}-byte limit`,
  );
}

/** Builds the unsupported-media-type rejection. Never echoes the body or the raw content-type value. */
function unsupportedMediaTypeError(): M3LConsoleError {
  return new M3LConsoleError(
    "ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE",
    "request content-type must be application/json",
  );
}

/**
 * Streams `req`'s body, capping it at `options.maxBytes` while chunks
 * arrive — destroying `req` and rejecting the instant the running total
 * crosses the cap, never after draining to `'end'` first — and parses the
 * accumulated bytes as JSON once the stream ends within the cap. Resolves
 * `undefined` when the stream ends having delivered zero bytes (a body-less
 * request that could not be identified as such from `content-length` alone,
 * e.g. chunked transfer-encoding with no data).
 */
/**
 * Resolves/rejects the promise once the stream has ended within cap:
 * `undefined` for zero bytes, an unsupported-media-type rejection for a
 * non-empty body whose `contentType` is not JSON, or the parsed JSON value
 * (a bad-request rejection on a parse failure — never echoing the body).
 */
function settleCollectedBody(
  chunks: readonly Buffer[],
  contentType: string | undefined,
  resolve: (value: unknown) => void,
  reject: (reason: unknown) => void,
): void {
  if (chunks.length === 0) {
    resolve(undefined);
    return;
  }
  if (!isJsonContentType(contentType)) {
    reject(unsupportedMediaTypeError());
    return;
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    resolve(JSON.parse(raw) as unknown);
  } catch (cause) {
    reject(
      new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "request body is not valid JSON",
        { cause },
      ),
    );
  }
}

function streamAndParseBody(
  req: IncomingMessage,
  contentType: string | undefined,
  options: M3LReadJsonBodyOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      options.signal.removeEventListener("abort", onAbort);
      action();
    };

    function onAbort(): void {
      finish(() => {
        req.destroy();
        reject(new Core.M3LOperationAbortedError());
      });
    }

    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > options.maxBytes) {
        finish(() => {
          req.destroy();
          reject(bodyTooLargeError(options.maxBytes));
        });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      finish(() => {
        settleCollectedBody(chunks, contentType, resolve, reject);
      });
    }

    function onError(cause: unknown): void {
      finish(() => {
        reject(
          new M3LConsoleError(
            "ERR_CONSOLE_BAD_REQUEST",
            "failed reading request body",
            { cause },
          ),
        );
      });
    }

    options.signal.addEventListener("abort", onAbort, { once: true });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Reads and parses `req`'s body as JSON, resolving `undefined` when the
 * request carries none.
 *
 * The `content-length` header, when present, drives two synchronous
 * fast-path decisions before a single byte is read: `0` resolves
 * `undefined` immediately, and a value already above `options.maxBytes`
 * rejects immediately (the size cap and the content-type check both run
 * without ever touching the stream). A non-zero, in-cap `content-length`
 * also validates `content-type` synchronously, before reading. When
 * `content-length` is absent (or the header lies about the real payload
 * size), the cap is enforced WHILE streaming instead — see
 * {@link streamAndParseBody} — so neither a missing nor an understated
 * `content-length` can bypass the limit.
 *
 * @param req - The inbound request.
 * @param options - See {@link M3LReadJsonBodyOptions}.
 * @returns The parsed JSON value, or `undefined` for a body-less request.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BODY_TOO_LARGE"`
 *   when the body exceeds `options.maxBytes`.
 * @throws {@link M3LConsoleError} with code
 *   `"ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE"` when the request carries a
 *   non-empty body whose `content-type` is not `application/json`
 *   (parameters such as `; charset=utf-8` are accepted).
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   the body cannot be parsed as JSON, or the stream itself errors. The
 *   message never echoes the body — it is caller data (e.g. run-launch
 *   script parameters).
 * @throws {@link Core.M3LOperationAbortedError} when `options.signal` is (or
 *   becomes) aborted — a client disconnect or a server drain, never a
 *   malformed-request outcome.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { readJsonBody } from "@m3l-automation/m3l-console-server/http/body.js";
 *
 * createServer((req, res) => {
 *   void readJsonBody(req, {
 *     maxBytes: 65_536,
 *     signal: new AbortController().signal,
 *   }).then((body) => {
 *     res.end(JSON.stringify({ received: body }));
 *   });
 * });
 * ```
 */
export function readJsonBody(
  req: IncomingMessage,
  options: M3LReadJsonBodyOptions,
): Promise<unknown> {
  if (options.signal.aborted) {
    return Promise.reject(new Core.M3LOperationAbortedError());
  }

  const contentType = req.headers["content-type"];
  const contentLength = parseContentLength(req.headers["content-length"]);

  if (contentLength !== undefined) {
    if (contentLength === 0) return Promise.resolve(undefined);
    if (contentLength > options.maxBytes) {
      return Promise.reject(bodyTooLargeError(options.maxBytes));
    }
    if (!isJsonContentType(contentType)) {
      return Promise.reject(unsupportedMediaTypeError());
    }
  }

  return streamAndParseBody(req, contentType, options);
}
