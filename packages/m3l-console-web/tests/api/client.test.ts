import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchConsoleJson } from "../../src/api/client.js";

interface SamplePayload {
  readonly some: string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchConsoleJson", () => {
  test("returns ok data when fetch resolves with a 2xx JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ some: "payload" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchConsoleJson<SamplePayload>("/widgets/1"),
    ).resolves.toEqual({
      ok: true,
      data: { some: "payload" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/widgets/1",
      expect.anything() as unknown,
    );
  });

  test("returns a network error when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    await expect(
      fetchConsoleJson<SamplePayload>("/widgets/1"),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "network",
        message: expect.any(String) as string,
      },
    });
  });

  test("network error carries a non-empty message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    const result = await fetchConsoleJson<SamplePayload>("/widgets/1");
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  test("maps a console error envelope body to an http error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () =>
          Promise.resolve({
            error: {
              code: "ERR_CONSOLE_NOT_FOUND",
              message: "route not found",
              status: 404,
              correlationId: "corr-1",
            },
          }),
      }),
    );

    await expect(fetchConsoleJson<SamplePayload>("/missing")).resolves.toEqual({
      ok: false,
      error: {
        kind: "http",
        message: "route not found",
        status: 404,
        code: "ERR_CONSOLE_NOT_FOUND",
        correlationId: "corr-1",
      },
    });
  });

  test("maps a console error envelope's optional origin and retryable fields through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: () =>
          Promise.resolve({
            error: {
              code: "ERR_CONSOLE_UPSTREAM",
              message: "upstream unavailable",
              status: 503,
              correlationId: "corr-2",
              origin: "external",
              retryable: true,
            },
          }),
      }),
    );

    await expect(fetchConsoleJson<SamplePayload>("/upstream")).resolves.toEqual(
      {
        ok: false,
        error: {
          kind: "http",
          message: "upstream unavailable",
          status: 503,
          code: "ERR_CONSOLE_UPSTREAM",
          correlationId: "corr-2",
          origin: "external",
          retryable: true,
        },
      },
    );
  });

  test("round-trips a retryable value of 'situational'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: () =>
          Promise.resolve({
            error: {
              code: "ERR_CONSOLE_RATE_LIMITED",
              message: "rate limited",
              status: 429,
              correlationId: "corr-3",
              retryable: "situational",
            },
          }),
      }),
    );

    const result = await fetchConsoleJson<SamplePayload>("/rate-limited");
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.retryable).toBe("situational");
  });

  test("drops an invalid origin but keeps the rest of a well-formed envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () =>
          Promise.resolve({
            error: {
              code: "ERR_CONSOLE_BAD_ORIGIN",
              message: "bad origin",
              status: 500,
              correlationId: "corr-4",
              origin: "nonsense",
            },
          }),
      }),
    );

    const result = await fetchConsoleJson<SamplePayload>("/bad-origin");
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.code).toBe("ERR_CONSOLE_BAD_ORIGIN");
    expect(result.error.correlationId).toBe("corr-4");
    expect(result.error.message).toBe("bad origin");
    expect(result.error.origin).toBeUndefined();
  });

  test("drops an invalid retryable but keeps the rest of a well-formed envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () =>
          Promise.resolve({
            error: {
              code: "ERR_CONSOLE_BAD_RETRYABLE",
              message: "bad retryable",
              status: 500,
              correlationId: "corr-5",
              retryable: 2,
            },
          }),
      }),
    );

    const result = await fetchConsoleJson<SamplePayload>("/bad-retryable");
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.code).toBe("ERR_CONSOLE_BAD_RETRYABLE");
    expect(result.error.correlationId).toBe("corr-5");
    expect(result.error.message).toBe("bad retryable");
    expect(result.error.retryable).toBeUndefined();
  });

  test("falls back to status text when the body is not the envelope shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("not json")),
      }),
    );

    const result = await fetchConsoleJson<SamplePayload>("/broken");
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "http",
        status: 500,
      },
    });
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.message.length).toBeGreaterThan(0);
    expect(result.error.code).toBeUndefined();
    expect(result.error.correlationId).toBeUndefined();
  });

  test("returns a malformed-body error when a 2xx body fails to parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError("bad json")),
      }),
    );

    const result = await fetchConsoleJson<SamplePayload>("/widgets/1");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.kind).toBe("malformed-body");
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  test("never rejects across every failure mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));

    await expect(
      fetchConsoleJson<SamplePayload>("/widgets/1"),
    ).resolves.toMatchObject({ ok: false });
  });
});
