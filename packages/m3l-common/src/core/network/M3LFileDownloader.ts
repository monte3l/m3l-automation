/**
 * `core/network/M3LFileDownloader` — streams an HTTP response body directly
 * to a file on disk, without buffering it in memory.
 *
 * @packageDocumentation
 */

import { createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { M3LError } from "../errors/index.js";
import { M3LHttpClientError } from "./M3LHttpClientError.js";
import type { M3LHttpClient } from "./M3LHttpClient.js";

/**
 * Constructor options for {@link M3LFileDownloader}.
 *
 * @example
 * ```ts
 * import { M3LHttpClient } from "@m3l-automation/m3l-common/core";
 * import type { M3LFileDownloaderOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LFileDownloaderOptions = {
 *   httpClient: new M3LHttpClient(),
 * };
 * ```
 */
export interface M3LFileDownloaderOptions {
  /** The `M3LHttpClient` instance used to issue the download request. */
  readonly httpClient: M3LHttpClient;
}

/**
 * Strips the query string and fragment from `url` before it reaches
 * `M3LHttpClientError`'s message or context — mirrors `M3LHttpClient`'s own
 * sanitizer for the same reason: a credential passed as a query parameter or
 * a URL fragment (e.g. a presigned-URL signature) must never round-trip
 * through a thrown error. Userinfo is not handled here: by the time this
 * function runs, `this.#httpClient.requestStream()` has already resolved
 * and started streaming, which means its own `#resolveUrl` (which rejects a
 * userinfo-bearing URL upfront, before this catch block can ever run) has
 * already proven `url` carries none.
 */
function sanitizeRequestUrl(url: string): string {
  const boundaryMatch = /[?#]/.exec(url);
  return boundaryMatch === null ? url : url.slice(0, boundaryMatch.index);
}

/**
 * Downloads a URL directly to a file, streaming the response body through
 * `node:stream/promises`'s `pipeline` instead of buffering the whole
 * response in memory first.
 *
 * Composes with an injected {@link M3LHttpClient} (via
 * {@link M3LHttpClient.requestStream}) rather than opening its own
 * connection, so it inherits that client's base URL, headers, timeout, and
 * proxy configuration. Because `requestStream` throws before any file write
 * begins, a failed request (non-2xx status, network failure, or timeout)
 * leaves no file at the destination path — there is nothing to clean up.
 *
 * @example
 * ```ts
 * import { M3LFileDownloader, M3LHttpClient } from "@m3l-automation/m3l-common/core";
 *
 * const downloader = new M3LFileDownloader({ httpClient: new M3LHttpClient() });
 * await downloader.download(
 *   "https://example.com/report.csv",
 *   "./data/output/report.csv",
 * );
 * ```
 */
export class M3LFileDownloader {
  readonly #httpClient: M3LHttpClient;

  /**
   * Creates a new `M3LFileDownloader`.
   *
   * @param options - `httpClient` is the `M3LHttpClient` instance this
   *   downloader issues requests through.
   */
  constructor(options: M3LFileDownloaderOptions) {
    this.#httpClient = options.httpClient;
  }

  /**
   * Downloads `url` and streams the response body to `destinationPath`.
   *
   * @param url - The request URL, resolved against the injected
   *   `M3LHttpClient`'s configured `baseUrl` exactly like its other request
   *   methods.
   * @param destinationPath - The filesystem path the response body is
   *   streamed to. Any existing file at this path is overwritten.
   * @returns A promise that resolves once the file has been fully written.
   * @throws {@link M3LHttpClientError} on a non-2xx response, a network
   *   failure, or a timeout — no partial file is left at `destinationPath`
   *   because the failure occurs before the write stream opens.
   *
   * @example
   * ```ts
   * import { M3LFileDownloader, M3LHttpClient } from "@m3l-automation/m3l-common/core";
   *
   * const downloader = new M3LFileDownloader({ httpClient: new M3LHttpClient() });
   * await downloader.download("https://example.com/file.bin", "./file.bin");
   * ```
   */
  async download(url: string, destinationPath: string): Promise<void> {
    const { body } = await this.#httpClient.requestStream({
      method: "GET",
      path: url,
    });

    try {
      await pipeline(
        Readable.fromWeb(body),
        createWriteStream(destinationPath),
      );
    } catch (cause) {
      // Best-effort, synchronous cleanup: a delete failure must never mask
      // the original pipeline failure, so any thrown error is swallowed
      // here. Deliberately synchronous (rmSync, not the async rm()) so the
      // cleanup completes within the same tick as the rejection below —
      // an awaited async delete would let the returned promise settle one
      // real I/O turn later than the caller may be prepared to observe.
      try {
        rmSync(destinationPath, { force: true });
      } catch {
        // ignore — best-effort only
      }
      // The stream may already carry a typed failure (e.g. the timeout
      // normalization M3LHttpClient applies while draining the body) —
      // re-throw it unchanged instead of double-wrapping.
      if (cause instanceof M3LError) throw cause;
      const safeUrl = sanitizeRequestUrl(url);
      throw new M3LHttpClientError(
        `failed writing the response from ${safeUrl} to ${destinationPath}`,
        {
          failure: { reason: "network" },
          context: { url: safeUrl, destinationPath },
          cause,
        },
      );
    }
  }
}
