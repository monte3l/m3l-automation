import * as fsp from "node:fs/promises";
import type * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import { batchRequest } from "../src/steps/batch-request.js";
import {
  stubInput,
  stubOutputStreams,
  writtenJsonlRecords,
} from "./support/fsFakes.js";
import {
  buildConfig,
  createFakeHttpClient,
  createFakeRequestSigner,
} from "./support/httpFakes.js";

/**
 * Contract: docs/reference/scripts/api-gateway-client.md `batch-request`
 * row. Guard-resolves `input` (throws `_CONFIG` when missing); runs
 * `destructive-gate` ONCE up front when the configured `method` is
 * mutating; streams `input` JSONL request-parameter records, resolves auth
 * headers per record, and fans each record through
 * `M3LConcurrencyPool(maxInFlight).runEach(...)`; successful responses
 * append to `output`; per-request failures (original record + normalized
 * error info) append to `paths.resolveOutput("failed.jsonl")`. A
 * best-effort writer `close()` on the error path never masks the original
 * throw.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("batchRequest", () => {
  test("runs the destructive-gate exactly once up front for a mutating verb, regardless of record count", async () => {
    stubInput(
      [
        JSON.stringify({ path: "/items/1" }),
        JSON.stringify({ path: "/items/2" }),
        JSON.stringify({ path: "/items/3" }),
      ].join("\n"),
    );
    stubOutputStreams();
    const request = vi.fn().mockResolvedValue({ ok: true });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "POST",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
      maxInFlight: 4,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-1",
      httpClient,
      signer: undefined,
      prompt,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  test("a non-mutating verb (GET) never gates", async () => {
    stubInput(JSON.stringify({ path: "/items/1" }));
    stubOutputStreams();
    const httpClient = createFakeHttpClient();
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-2",
      httpClient,
      signer: undefined,
      prompt,
    });

    expect(confirm).not.toHaveBeenCalled();
  });

  test("throws ERR_API_GATEWAY_CLIENT_CONFIG when 'input' is missing, never gating or calling httpClient.request", async () => {
    stubInput("");
    stubOutputStreams();
    const httpClient = createFakeHttpClient();
    const config = buildConfig({
      method: "POST",
      auth: "none",
      baseUrl: "https://api.example.test",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");

    let thrown: unknown;
    try {
      await batchRequest({
        config,
        paths,
        logger,
        correlationId: "run-3",
        httpClient,
        signer: undefined,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_API_GATEWAY_CLIENT_CONFIG",
    );
    expect(confirm).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  test("a malformed JSONL line is a per-record skip (logged); surviving records still dispatch", async () => {
    stubInput(
      [
        JSON.stringify({ path: "/items/1" }),
        "not-json",
        JSON.stringify({ path: "/items/2" }),
      ].join("\n"),
    );
    stubOutputStreams();
    const request = vi.fn().mockResolvedValue({ ok: true });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");
    const prompt = new Core.M3LPrompt();

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-4",
      httpClient,
      signer: undefined,
      prompt,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalled();
  });

  test("a source-level failure (the input file cannot be read) rejects the whole run, never treated as a per-record skip", async () => {
    const sourceFailure = new Error("EACCES: permission denied");
    vi.spyOn(fsp, "readFile").mockRejectedValue(sourceFailure);
    stubOutputStreams();
    const httpClient = createFakeHttpClient();
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    let thrown: unknown;
    try {
      await batchRequest({
        config,
        paths,
        logger,
        correlationId: "run-5",
        httpClient,
        signer: undefined,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(sourceFailure);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  test("successful responses are appended to 'output'", async () => {
    stubInput(
      [
        JSON.stringify({ path: "/items/1" }),
        JSON.stringify({ path: "/items/2" }),
      ].join("\n"),
    );
    const { streams } = stubOutputStreams();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: "1" })
      .mockResolvedValueOnce({ id: "2" });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
      output: "responses.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-6",
      httpClient,
      signer: undefined,
      prompt,
    });

    const written = streams.flatMap((stream) => writtenJsonlRecords(stream));
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "1" }),
        expect.objectContaining({ id: "2" }),
      ]),
    );
  });

  test("a per-request failure appends the original record + normalized error info to failed.jsonl, without aborting surviving records", async () => {
    stubInput(
      [
        JSON.stringify({ path: "/items/1" }),
        JSON.stringify({ path: "/items/2" }),
      ].join("\n"),
    );
    const { streams } = stubOutputStreams();
    const httpFailure = new Core.M3LHttpClientError(
      "request to https://api.example.test/items/2 failed with status 500",
      { failure: { reason: "status", status: 500 } },
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: "1" })
      .mockRejectedValueOnce(httpFailure);
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
      output: "responses.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-7",
      httpClient,
      signer: undefined,
      prompt,
    });

    expect(request).toHaveBeenCalledTimes(2);
    const failedStream = streams.find((stream) =>
      stream.content().includes('"path":"/items/2"'),
    );
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      const [failedRecord] = writtenJsonlRecords(failedStream);
      expect(failedRecord).toEqual(
        expect.objectContaining({ path: "/items/2" }),
      );
    }
    const successStream = streams.find((stream) =>
      stream.content().includes('"id":"1"'),
    );
    expect(successStream).toBeDefined();
  });

  test("a writer.close() failure does not mask the original source-level rejection", async () => {
    const sourceFailure = new Error("input stream aborted");
    vi.spyOn(fsp, "readFile").mockRejectedValue(sourceFailure);
    const { streams } = stubOutputStreams();
    const httpClient = createFakeHttpClient();
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    let thrown: unknown;
    try {
      const runPromise = batchRequest({
        config,
        paths,
        logger,
        correlationId: "run-8",
        httpClient,
        signer: undefined,
        prompt,
      });
      // Arm every writer opened so far to fail on close — regardless of
      // which one (output/failed) the implementation created first, its
      // close() failure must never mask the original readFile rejection.
      for (const stream of streams) {
        stream.armCloseFailure(new Error("simulated close failure"));
      }
      await runPromise;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(sourceFailure);
  });

  test("bounds concurrent httpClient.request calls to 'maxInFlight' via M3LConcurrencyPool", async () => {
    vi.useFakeTimers();
    try {
      const lines = [1, 2, 3, 4].map((n) =>
        JSON.stringify({ path: `/items/${String(n)}` }),
      );
      stubInput(lines.join("\n"));
      stubOutputStreams();

      let active = 0;
      let maxActive = 0;
      const request = vi.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        active -= 1;
        return { ok: true };
      });
      const httpClient = createFakeHttpClient({ request });
      const config = buildConfig({
        method: "GET",
        auth: "none",
        baseUrl: "https://api.example.test",
        input: "in.jsonl",
        maxInFlight: 2,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();

      const runPromise = batchRequest({
        config,
        paths,
        logger,
        correlationId: "run-9",
        httpClient,
        signer: undefined,
        prompt,
      });

      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(5);
      await runPromise;

      expect(request).toHaveBeenCalledTimes(4);
      expect(maxActive).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failedWriter.append() failure for one record is logged as a warning, not thrown — surviving records still complete", async () => {
    stubInput(
      [
        JSON.stringify({ path: "/items/1" }),
        JSON.stringify({ path: "/items/2" }),
        JSON.stringify({ path: "/items/3" }),
      ].join("\n"),
    );
    const { streams } = stubOutputStreams();
    const request = vi
      .fn()
      .mockImplementation((options: Core.M3LHttpRequestOptions) => {
        if (options.path === "/items/1") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(
          new Core.M3LHttpClientError("request failed", {
            failure: { reason: "status", status: 500 },
          }),
        );
      });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");
    const prompt = new Core.M3LPrompt();

    const runPromise = batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-10",
      httpClient,
      signer: undefined,
      prompt,
    });

    const [failedStream] = streams;
    expect(failedStream).toBeDefined();
    if (failedStream === undefined) {
      throw new Error("test setup: expected a failed.jsonl stream to exist");
    }
    const originalWrite = failedStream.write.bind(failedStream);
    let triggered = false;
    vi.spyOn(failedStream, "write").mockImplementation((chunk, cb) => {
      const text = chunk.toString();
      if (!triggered && text.includes('"path":"/items/2"')) {
        triggered = true;
        queueMicrotask(() => {
          cb?.(new Error("simulated disk full"));
        });
        return true;
      }
      return originalWrite(chunk, cb);
    });

    await runPromise;

    expect(request).toHaveBeenCalledTimes(3);
    expect(
      warning.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes(
            "failed to append a per-record failure to 'failed.jsonl'",
          ),
      ),
    ).toBe(true);

    const written = writtenJsonlRecords(failedStream);
    expect(written).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/items/3" })]),
    );
    expect(
      written.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>).path === "/items/2",
      ),
    ).toBe(false);
  });

  test("a failedWriter.close() failure does not prevent outputWriter.close() from completing", async () => {
    stubInput(JSON.stringify({ path: "/items/1" }));
    const { streams } = stubOutputStreams();
    const request = vi.fn().mockResolvedValue({ id: "1" });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
      output: "responses.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");
    const prompt = new Core.M3LPrompt();

    const runPromise = batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-11",
      httpClient,
      signer: undefined,
      prompt,
    });

    const [outputStream, failedStream] = streams;
    expect(outputStream).toBeDefined();
    expect(failedStream).toBeDefined();
    if (outputStream === undefined || failedStream === undefined) {
      throw new Error(
        "test setup: expected both an output and a failed.jsonl stream",
      );
    }
    failedStream.armCloseFailure(
      new Error("simulated failed-writer close failure"),
    );
    const outputEnd = vi.spyOn(outputStream, "end");

    await runPromise;

    expect(outputEnd).toHaveBeenCalled();
    expect(
      warning.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("failed to close the 'failed.jsonl' writer"),
      ),
    ).toBe(true);
  });

  test("an outputWriter.close() failure does not prevent failedWriter.close() from completing", async () => {
    stubInput(JSON.stringify({ path: "/items/1" }));
    const { streams } = stubOutputStreams();
    const request = vi.fn().mockResolvedValue({ id: "1" });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
      output: "responses.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");
    const prompt = new Core.M3LPrompt();

    const runPromise = batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-12",
      httpClient,
      signer: undefined,
      prompt,
    });

    const [outputStream, failedStream] = streams;
    expect(outputStream).toBeDefined();
    expect(failedStream).toBeDefined();
    if (outputStream === undefined || failedStream === undefined) {
      throw new Error(
        "test setup: expected both an output and a failed.jsonl stream",
      );
    }
    outputStream.armCloseFailure(
      new Error("simulated output-writer close failure"),
    );
    const failedEnd = vi.spyOn(failedStream, "end");

    await runPromise;

    expect(failedEnd).toHaveBeenCalled();
    expect(
      warning.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("failed to close the 'output' writer"),
      ),
    ).toBe(true);
  });

  test("a record whose absolute 'path' resolves to a different origin than 'baseUrl' is rejected as 'path-origin-mismatch' before resolving auth headers or dispatching", async () => {
    stubInput(JSON.stringify({ path: "https://attacker.example/exfiltrate" }));
    const { streams } = stubOutputStreams();
    const httpClient = createFakeHttpClient();
    const signedHeaders = vi.fn();
    const signer = createFakeRequestSigner({ signedHeaders });
    const config = buildConfig({
      method: "GET",
      auth: "iam",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-13",
      httpClient,
      signer,
      prompt,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
    expect(httpClient.request).not.toHaveBeenCalled();
    expect(signedHeaders).not.toHaveBeenCalled();

    const [failedStream] = streams;
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      const [failedRecord] = writtenJsonlRecords(failedStream);
      expect(failedRecord).toEqual(
        expect.objectContaining({
          path: "https://attacker.example/exfiltrate",
        }),
      );
      const error = (failedRecord as Record<string, unknown>).error;
      expect(error).toEqual(
        expect.objectContaining({ reason: "path-origin-mismatch" }),
      );
    }
  });

  test.each([
    ["a relative path", "/items/9"],
    ["a same-origin absolute URL", "https://api.example.test/items/9"],
  ])("%s is not rejected and dispatches normally", async (_label, path) => {
    stubInput(JSON.stringify({ path }));
    stubOutputStreams();
    const request = vi.fn().mockResolvedValue({ ok: true });
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-14",
      httpClient,
      signer: undefined,
      prompt,
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  test("a successful response that fails to append to 'output' is written to failed.jsonl tagged 'output-write-failed'", async () => {
    stubInput(JSON.stringify({ path: "/items/1" }));
    const { streams } = stubOutputStreams();
    const circularResponse: Record<string, unknown> = { id: "1" };
    circularResponse.self = circularResponse;
    const request = vi.fn().mockResolvedValue(circularResponse);
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      auth: "none",
      baseUrl: "https://api.example.test",
      input: "in.jsonl",
      output: "responses.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await batchRequest({
      config,
      paths,
      logger,
      correlationId: "run-15",
      httpClient,
      signer: undefined,
      prompt,
    });

    const failedStream = streams.find((stream) =>
      stream.content().includes('"path":"/items/1"'),
    );
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      const [failedRecord] = writtenJsonlRecords(failedStream);
      const error = (failedRecord as Record<string, unknown>).error;
      expect(error).toEqual(
        expect.objectContaining({ reason: "output-write-failed" }),
      );
    }
  });
});
