import type * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import { singleRequest } from "../src/steps/single-request.js";
import { stubOutputStreams, writtenJsonlRecords } from "./support/fsFakes.js";
import { buildConfig, createFakeHttpClient } from "./support/httpFakes.js";

/**
 * Contract: docs/reference/scripts/api-gateway-client.md `single-request`
 * row. Guard-resolves `path` (throws `_CONFIG` when missing); runs
 * `destructive-gate` when `method` is mutating (`POST`/`PUT`/`PATCH`/
 * `DELETE`; `GET`/`HEAD` are not gated); resolves auth headers for the one
 * request; builds the `M3LHttpRequestOptions` and calls
 * `httpClient.request()`; writes the response to `output` when configured.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("singleRequest", () => {
  describe("destructive-gate for mutating verbs", () => {
    test("a mutating verb (POST) prompts, and a decline throws ERR_API_GATEWAY_CLIENT_ABORTED without calling httpClient.request", async () => {
      stubOutputStreams();
      const httpClient = createFakeHttpClient();
      const config = buildConfig({
        method: "POST",
        path: "/items",
        auth: "none",
        yes: false,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();
      vi.spyOn(prompt, "confirm").mockResolvedValue(false);

      let thrown: unknown;
      try {
        await singleRequest({
          config,
          paths,
          logger,
          correlationId: "run-1",
          httpClient,
          signer: undefined,
          prompt,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_API_GATEWAY_CLIENT_ABORTED",
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test("a mutating verb (POST) proceeds to httpClient.request once confirmed", async () => {
      stubOutputStreams();
      const httpClient = createFakeHttpClient();
      const config = buildConfig({
        method: "POST",
        path: "/items",
        auth: "none",
        yes: false,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      await singleRequest({
        config,
        paths,
        logger,
        correlationId: "run-2",
        httpClient,
        signer: undefined,
        prompt,
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
      expect(httpClient.request).toHaveBeenCalledTimes(1);
    });

    test("yes=true bypasses the prompt entirely for a mutating verb", async () => {
      stubOutputStreams();
      const httpClient = createFakeHttpClient();
      const config = buildConfig({
        method: "DELETE",
        path: "/items/1",
        auth: "none",
        yes: true,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();
      const confirm = vi.spyOn(prompt, "confirm");

      await singleRequest({
        config,
        paths,
        logger,
        correlationId: "run-3",
        httpClient,
        signer: undefined,
        prompt,
      });

      expect(confirm).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
      expect(httpClient.request).toHaveBeenCalledTimes(1);
    });

    test("a non-mutating verb (GET) is never gated, even with yes=false and no prompt configured", async () => {
      stubOutputStreams();
      const httpClient = createFakeHttpClient();
      const config = buildConfig({
        method: "GET",
        path: "/health",
        auth: "none",
        yes: false,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();
      const confirm = vi.spyOn(prompt, "confirm");

      await singleRequest({
        config,
        paths,
        logger,
        correlationId: "run-4",
        httpClient,
        signer: undefined,
        prompt,
      });

      expect(confirm).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
      expect(httpClient.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("M3LHttpRequestOptions construction", () => {
    test("a GET with no body sends the resolved method/path with empty (auth: none) headers", async () => {
      stubOutputStreams();
      const request = vi.fn().mockResolvedValue({ ok: true });
      const httpClient = createFakeHttpClient({ request });
      const config = buildConfig({
        method: "GET",
        path: "/items",
        auth: "none",
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();

      await singleRequest({
        config,
        paths,
        logger,
        correlationId: "run-5",
        httpClient,
        signer: undefined,
        prompt,
      });

      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/items",
          headers: {},
        }),
      );
    });

    test("a POST with a body and an api-key auth sends the body verbatim plus the x-api-key header", async () => {
      stubOutputStreams();
      const request = vi.fn().mockResolvedValue({ ok: true });
      const httpClient = createFakeHttpClient({ request });
      const config = buildConfig({
        method: "POST",
        path: "/items",
        body: '{"name":"widget"}',
        auth: "api-key",
        apiKey: "s3cr3t-key",
        yes: true,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();

      await singleRequest({
        config,
        paths,
        logger,
        correlationId: "run-6",
        httpClient,
        signer: undefined,
        prompt,
      });

      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/items",
          headers: { "x-api-key": "s3cr3t-key" },
          body: '{"name":"widget"}',
        }),
      );
    });
  });

  test("writes the resolved response to 'output' when configured", async () => {
    const { streams } = stubOutputStreams();
    const responseBody = { id: "42", name: "widget" };
    const request = vi.fn().mockResolvedValue(responseBody);
    const httpClient = createFakeHttpClient({ request });
    const config = buildConfig({
      method: "GET",
      path: "/items/42",
      auth: "none",
      output: "responses.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await singleRequest({
      config,
      paths,
      logger,
      correlationId: "run-7",
      httpClient,
      signer: undefined,
      prompt,
    });

    expect(streams.length).toBeGreaterThan(0);
    const written = streams.flatMap((stream) => writtenJsonlRecords(stream));
    expect(written).toEqual(
      expect.arrayContaining([expect.objectContaining(responseBody)]),
    );
  });

  test("throws ERR_API_GATEWAY_CLIENT_CONFIG when 'path' is missing, never calling httpClient.request", async () => {
    stubOutputStreams();
    const httpClient = createFakeHttpClient();
    const config = buildConfig({ method: "GET", auth: "none" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    let thrown: unknown;
    try {
      await singleRequest({
        config,
        paths,
        logger,
        correlationId: "run-8",
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
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to Core.M3LHttpClient; property is a vi.fn(), never called unbound
    expect(httpClient.request).not.toHaveBeenCalled();
  });
});
