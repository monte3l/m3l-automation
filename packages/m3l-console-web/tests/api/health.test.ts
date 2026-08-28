import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  M3LConsoleFetchError,
  M3LConsoleFetchResult,
} from "../../src/api/client.js";
import { fetchConsoleJson } from "../../src/api/client.js";
import type { M3LHealthPayload } from "../../src/api/health.js";
import { fetchHealth } from "../../src/api/health.js";

vi.mock("../../src/api/client.js", () => ({
  fetchConsoleJson: vi.fn(),
}));

const mockedFetchConsoleJson = vi.mocked(fetchConsoleJson);

afterEach(() => {
  mockedFetchConsoleJson.mockReset();
});

describe("fetchHealth", () => {
  test("calls fetchConsoleJson with exactly /health", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { status: "ok", uptimeMs: 42 },
    });

    await fetchHealth();

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith("/health");
  });

  test("resolves to the ok result the mock returns, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LHealthPayload> = {
      ok: true,
      data: { status: "ok", uptimeMs: 42 },
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchHealth()).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "network",
      message: "connection refused",
    };
    const errorResult: M3LConsoleFetchResult<M3LHealthPayload> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchHealth()).resolves.toEqual(errorResult);
  });
});
