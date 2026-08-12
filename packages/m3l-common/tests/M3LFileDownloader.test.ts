/**
 * Tests for `core/network/M3LFileDownloader` (RED phase — module not yet
 * implemented).
 *
 * Contract source: hub-locked spec for the "zero-dep-primitives" change set
 * (PR 3.3), no `docs/reference/core/network.md` entry exists yet for this
 * addition.
 *
 * Exports under test: `M3LFileDownloader`.
 *
 * Key behavioral contracts:
 *  - Composes with the EXISTING `M3LHttpClient` (constructor-injected, no
 *    new `undici` dispatcher opened independently) to stream an HTTP
 *    response body directly to a file on disk via `node:stream/promises`'s
 *    `pipeline`.
 *  - A request failure (non-2xx status, or a network-level failure) surfaces
 *    as the SAME `M3LHttpClientError` (or a sibling `M3LError` subclass)
 *    `M3LHttpClient` already throws — no parallel error hierarchy.
 *
 * Mocking strategy: `undici`'s `fetch` is mocked at the module level (same
 * boundary `tests/network.test.ts` already uses for `M3LHttpClient`), so a
 * real `M3LHttpClient` instance is constructed and injected — the downloader
 * is exercised exactly the way it will compose with the client in
 * production, without opening a real socket.
 *
 * Judgment calls (flagged for the implementer):
 *  - `M3LFileDownloader` takes `{ httpClient: M3LHttpClient }` in its
 *    constructor (dependency injection — no options bag duplicates
 *    `M3LHttpClientOptions`) and exposes `download(url, destinationPath):
 *    Promise<void>`. `M3LHttpClient`'s current public surface (`get`,
 *    `getAbortable`, `request`, `requestAbortable`) only ever returns a
 *    parsed body (JSON or text) — there is no existing method that exposes
 *    the raw streaming `Response`/body. Implementing "stream to disk without
 *    buffering the whole response" therefore likely requires ADDING a new
 *    method to `M3LHttpClient` (or an equivalent seam) that exposes the raw
 *    response stream; this test file deliberately mocks at the `undici
 *    fetch` boundary (not at any hypothetical new `M3LHttpClient` method)
 *    so it stays agnostic to that internal design choice.
 *  - "no partial/corrupt file lingering on failure" is asserted as: the
 *    destination path does not exist after a rejected `download()` call.
 *    No existing convention for this was found elsewhere in the codebase
 *    (`M3LFileLoggerHandler` is append-only, not download-then-fail), so
 *    this is a fresh contract, not a mirrored one — flagging in case the
 *    implementer intends a different failure-cleanup story.
 *  - The "streaming, not buffering" assertion described in the task (assert
 *    on chunk-by-chunk writes rather than one giant buffer) is SKIPPED: no
 *    established pattern for this exists elsewhere in the test suite, and
 *    inventing one against an unmocked `node:fs` write stream would be
 *    fragile. The happy-path test below instead proves multi-chunk response
 *    bodies concatenate correctly, which exercises (without proving
 *    non-buffering of) the streaming path.
 */

import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

vi.mock("undici", () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn(),
}));

// Make 'node:fs' configurable so vi.spyOn can intercept createWriteStream —
// only the stalled-transfer timeout test below installs a spy; every other
// test in this file writes to the REAL temp dir, and the spread-actual
// factory preserves that behavior unless a test explicitly overrides it.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LHttpClient,
  M3LHttpClientError,
} from "../src/core/network/index.js";
import { M3LFileDownloader } from "../src/core/network/M3LFileDownloader.js";

const mockFetch = vi.mocked(undiciFetch);

/** Minimal shape the implementation relies on from a `fetch` Response. */
interface FakeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Builds a web `ReadableStream` that yields each of `chunks` as a separate enqueue. */
function streamFromChunks(
  chunks: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Builds a fake fetch Response carrying a streaming body. Cast at the one boundary undici's concrete Response class requires. */
function makeStreamingResponse(options: {
  readonly status: number;
  readonly chunks: readonly string[];
}): UndiciResponse {
  const { status, chunks } = options;
  const fake: FakeResponse = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(): string | null {
        return null;
      },
    },
    body: streamFromChunks(chunks),
    json(): Promise<unknown> {
      return Promise.resolve(chunks.join(""));
    },
    text(): Promise<string> {
      return Promise.resolve(chunks.join(""));
    },
  };
  return fake as unknown as UndiciResponse;
}

/**
 * Builds a web `ReadableStream` that enqueues each of `chunks`, then errors
 * instead of closing — simulates a mid-stream network failure AFTER headers
 * (and at least one chunk) have already been accepted successfully.
 */
function streamThatErrorsAfterChunks(
  chunks: readonly string[],
  error: Error,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.error(error);
    },
  });
}

/** Builds a fake fetch Response whose body errors mid-stream (see {@link streamThatErrorsAfterChunks}). */
function makeMidStreamFailureResponse(options: {
  readonly status: number;
  readonly chunks: readonly string[];
  readonly error: Error;
}): UndiciResponse {
  const { status, chunks, error } = options;
  const fake: FakeResponse = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(): string | null {
        return null;
      },
    },
    body: streamThatErrorsAfterChunks(chunks, error),
    json(): Promise<unknown> {
      return Promise.resolve(chunks.join(""));
    },
    text(): Promise<string> {
      return Promise.resolve(chunks.join(""));
    },
  };
  return fake as unknown as UndiciResponse;
}

/**
 * Builds a fake fetch Response whose body enqueues one chunk then NEVER
 * closes — simulates a stalled transfer (network hang after headers). If
 * `signal` is provided, the stream errors once that signal aborts, so a
 * caller that correctly wires the request's `AbortController` into the
 * ongoing stream read can still observe a bounded failure.
 */
function makeStalledStreamingResponse(
  signal: AbortSignal | undefined,
): UndiciResponse {
  const fake: FakeResponse = {
    status: 200,
    ok: true,
    headers: {
      get(): string | null {
        return null;
      },
    },
    body: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("partial-chunk"));
        if (signal !== undefined) {
          if (signal.aborted) {
            controller.error(new Error("aborted before stream start"));
            return;
          }
          signal.addEventListener("abort", () => {
            controller.error(new Error("aborted mid-stream"));
          });
        }
        // Deliberately never calls controller.close() or controller.error()
        // on its own — the transfer stalls until (and unless) something
        // external (the configured timeout) intervenes.
      },
    }),
    json(): Promise<unknown> {
      return Promise.resolve("");
    },
    text(): Promise<string> {
      return Promise.resolve("");
    },
  };
  return fake as unknown as UndiciResponse;
}

let workDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-file-downloader-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("M3LFileDownloader.download", () => {
  test("streams a mocked response body to the destination file", async () => {
    mockFetch.mockResolvedValue(
      makeStreamingResponse({
        status: 200,
        chunks: ["chunk-one-", "chunk-two-", "chunk-three"],
      }),
    );
    const httpClient = new M3LHttpClient();
    const downloader = new M3LFileDownloader({ httpClient });
    const destinationPath = path.join(workDir, "downloaded.bin");

    await downloader.download("https://example.com/file.bin", destinationPath);

    const written = await readFile(destinationPath, "utf8");
    expect(written).toBe("chunk-one-chunk-two-chunk-three");
  });

  test("rejects with M3LHttpClientError on a non-2xx status and leaves no file at the destination", async () => {
    mockFetch.mockResolvedValue(
      makeStreamingResponse({ status: 404, chunks: ["not found"] }),
    );
    const httpClient = new M3LHttpClient();
    const downloader = new M3LFileDownloader({ httpClient });
    const destinationPath = path.join(workDir, "should-not-exist.bin");

    let thrown: unknown;
    try {
      await downloader.download(
        "https://example.com/missing.bin",
        destinationPath,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    expect((thrown as M3LHttpClientError).failure.reason).toBe("status");
    await expect(access(destinationPath)).rejects.toThrow();
  });

  test("rejects with M3LHttpClientError, chaining the underlying cause, on a network-level failure", async () => {
    const networkFailure = new Error("socket hang up");
    mockFetch.mockRejectedValue(networkFailure);
    const httpClient = new M3LHttpClient();
    const downloader = new M3LFileDownloader({ httpClient });
    const destinationPath = path.join(workDir, "should-not-exist-either.bin");

    let thrown: unknown;
    try {
      await downloader.download(
        "https://example.com/file.bin",
        destinationPath,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    expect((thrown as M3LHttpClientError).cause).toBe(networkFailure);
    await expect(access(destinationPath)).rejects.toThrow();
  });

  test("download() resolves to void", () => {
    expectTypeOf<M3LFileDownloader["download"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
  });

  // ---------------------------------------------------------------------
  // Bug 1 (CRITICAL) — a mid-stream pipeline() failure (AFTER headers and
  // at least one chunk were already accepted) must be normalized into the
  // typed M3LError hierarchy AND must not leave a corrupt partial file on
  // disk. Uses the REAL filesystem (no fs mocking) specifically so the
  // "no partial file left behind" half of the contract is verified against
  // real `fs` semantics, matching the two existing failure tests above.
  // ---------------------------------------------------------------------
  test("rejects with a typed M3LError (not a raw/untyped error) and leaves no partial file when the response body errors mid-stream after already emitting a chunk", async () => {
    const midStreamFailure = new Error("connection reset");
    mockFetch.mockResolvedValue(
      makeMidStreamFailureResponse({
        status: 200,
        chunks: ["first-chunk-written-before-the-drop-"],
        error: midStreamFailure,
      }),
    );
    const httpClient = new M3LHttpClient();
    const downloader = new M3LFileDownloader({ httpClient });
    const destinationPath = path.join(
      workDir,
      "corrupt-on-mid-stream-failure.bin",
    );

    let thrown: unknown;
    try {
      await downloader.download(
        "https://example.com/flaky.bin",
        destinationPath,
      );
    } catch (error) {
      thrown = error;
    }

    // Conservative assertion: the implementer's exact M3LError subclass
    // (M3LHttpClientError or a sibling in the same hierarchy) is their call —
    // this only pins down that the failure is normalized, not raw/untyped.
    expect(thrown).toBeInstanceOf(M3LError);
    await expect(access(destinationPath)).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // Write-side failure — a WRITE-side pipeline() failure (createWriteStream
  // cannot open its target, unrelated to the response body itself) must
  // still be normalized into an M3LHttpClientError. The response body reads
  // cleanly (so its `cause` is a raw Node error, not already an M3LError),
  // exercising the wrap branch below `if (cause instanceof M3LError) throw
  // cause;` — the only reachable route to it, since a read-side stream
  // failure is always pre-normalized to an M3LError by
  // M3LHttpClient's `#wrapStreamWithTimeoutCleanup` before download() ever
  // sees it.
  // ---------------------------------------------------------------------
  test("rejects with M3LHttpClientError, chaining the raw cause, when the write side fails independently of the response body", async () => {
    mockFetch.mockResolvedValue(
      makeStreamingResponse({ status: 200, chunks: ["fine-on-the-read-side"] }),
    );
    const httpClient = new M3LHttpClient();
    const downloader = new M3LFileDownloader({ httpClient });
    // The parent directory does not exist, so createWriteStream's underlying
    // fd open fails with ENOENT — a write-side failure with nothing to do
    // with the response body.
    const destinationPath = path.join(workDir, "no-such-subdir", "file.bin");

    let thrown: unknown;
    try {
      await downloader.download(
        "https://example.com/file.bin",
        destinationPath,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    expect((thrown as M3LHttpClientError).failure.reason).toBe("network");
    expect((thrown as M3LHttpClientError).cause).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // Security — a write-side failure must not leak a sensitive query string
  // (e.g. an S3 presigned-URL signature or a `?token=...`) into the thrown
  // error's `message` or `context.url`. Mirrors the truncate-at-`?` fix
  // already applied at M3LHttpClient's three throw sites; this is the
  // fourth site, inside M3LFileDownloader.download()'s write-failure catch.
  // ---------------------------------------------------------------------
  test("does not leak the query string into the thrown error's message or context.url when the write side fails", async () => {
    mockFetch.mockResolvedValue(
      makeStreamingResponse({ status: 200, chunks: ["fine-on-the-read-side"] }),
    );
    const httpClient = new M3LHttpClient();
    const downloader = new M3LFileDownloader({ httpClient });
    // The parent directory does not exist, so createWriteStream's underlying
    // fd open fails with ENOENT — a write-side failure with nothing to do
    // with the response body.
    const destinationPath = path.join(workDir, "no-such-subdir", "file.bin");

    let thrown: unknown;
    try {
      await downloader.download(
        "https://example.com/file.bin?token=super-secret",
        destinationPath,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    const httpError = thrown as M3LHttpClientError;
    expect(httpError.context?.["url"]).toBe("https://example.com/file.bin");
    expect(httpError.message).not.toContain("super-secret");
    expect(httpError.message).not.toContain("token");
    expect(httpError.message).not.toContain("?");
  });

  // ---------------------------------------------------------------------
  // Bug 2 (HIGH) — the configured timeout must bound the WHOLE streaming
  // transfer, not just header acquisition. A response body that stalls
  // (never closes, never errors on its own) after headers arrive must still
  // cause download() to reject once the timeout elapses, instead of hanging
  // forever.
  //
  // Mocks fs.createWriteStream with an in-memory `Writable` sink (never
  // opens a real file descriptor): under the CURRENT bug, the timer is
  // cleared before the body is ever read, so this stream truly never
  // settles — a real `createWriteStream` destination would leave a real,
  // permanently-open file handle for the remainder of the test run. The
  // in-memory sink keeps the "hang" scenario safe to assert against without
  // risking the test process itself failing to exit.
  // ---------------------------------------------------------------------
  test("rejects with a timeout M3LHttpClientError instead of hanging forever when the response body stream stalls after headers are received", async () => {
    vi.useFakeTimers();
    const fakeSink = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      },
    });
    const createWriteStreamSpy = vi
      .spyOn(fs, "createWriteStream")
      .mockReturnValue(fakeSink as unknown as WriteStream);

    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: unknown, options?: unknown) => {
      capturedSignal = (
        options as { readonly signal?: AbortSignal } | undefined
      )?.signal;
      return Promise.resolve(makeStalledStreamingResponse(capturedSignal));
    });

    const httpClient = new M3LHttpClient({ timeout: 50 });
    const downloader = new M3LFileDownloader({ httpClient });
    const destinationPath = path.join(workDir, "stalled-download.bin");

    let settled: "resolved" | "rejected" | undefined;
    let rejection: unknown;
    void downloader
      .download("https://example.com/slow.bin", destinationPath)
      .then(
        () => {
          settled = "resolved";
        },
        (error: unknown) => {
          settled = "rejected";
          rejection = error;
        },
      );

    await vi.advanceTimersByTimeAsync(50);
    // Flush any remaining microtask hops between the timer firing and the
    // abort propagating through the stream -> pipeline() -> download() chain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe("rejected");
    expect(rejection).toBeInstanceOf(M3LHttpClientError);
    expect((rejection as M3LHttpClientError).reason).toBe("timeout");

    createWriteStreamSpy.mockRestore();
    vi.useRealTimers();
  });
});
