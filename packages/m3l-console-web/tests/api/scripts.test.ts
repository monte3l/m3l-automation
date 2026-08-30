import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  M3LConsoleFetchError,
  M3LConsoleFetchResult,
} from "../../src/api/client.js";
import { fetchConsoleJson } from "../../src/api/client.js";
import type {
  M3LScriptDetail,
  M3LScriptSummary,
} from "../../src/api/scripts.js";
import { fetchScript, fetchScripts } from "../../src/api/scripts.js";

vi.mock("../../src/api/client.js", () => ({
  fetchConsoleJson: vi.fn(),
}));

const mockedFetchConsoleJson = vi.mocked(fetchConsoleJson);

afterEach(() => {
  mockedFetchConsoleJson.mockReset();
});

// Every script currently resolves as "spawn" — nothing under scripts/ ships
// a dist/command.js, so a fixture built around "in-process" would not be
// representative of the real server today.
const jsonEtlSummary: M3LScriptSummary = {
  name: "json-etl",
  description:
    "JSON and NDJSON file ETL: extract fields, filter records, export to json, jsonl, csv, or html",
  hasCommandModule: true,
  executionMode: "spawn",
};

const jsonEtlDetail: M3LScriptDetail = {
  ...jsonEtlSummary,
  parameters: [
    {
      name: "input",
      aliases: [],
      type: "STRING",
      required: true,
      defaultValue: null,
      description: "",
      secret: false,
      operations: [],
    },
  ],
  operations: [],
};

describe("fetchScripts", () => {
  test("calls fetchConsoleJson with exactly /api/v1/scripts", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: [] });

    await fetchScripts();

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith("/api/v1/scripts");
  });

  test("resolves to the ok result with a well-formed list, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LScriptSummary[]> = {
      ok: true,
      data: [jsonEtlSummary],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchScripts()).resolves.toEqual(okResult);
  });

  test("resolves to an empty list unchanged — an empty scripts directory is not malformed", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LScriptSummary[]> = {
      ok: true,
      data: [],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchScripts()).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "network",
      message: "connection refused",
    };
    const errorResult: M3LConsoleFetchResult<readonly M3LScriptSummary[]> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchScripts()).resolves.toEqual(errorResult);
  });

  test("downgrades a non-array ok body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: {} });

    await expect(fetchScripts()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades an array whose second element is malformed to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [
        jsonEtlSummary,
        { name: "broken", description: "", hasCommandModule: true },
        // ^ missing executionMode — a per-element check must catch this
        // even though the first element is well-formed.
      ],
    });

    await expect(fetchScripts()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades an element with a wrong-typed field to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [{ ...jsonEtlSummary, hasCommandModule: "true" }],
    });

    await expect(fetchScripts()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});

describe("fetchScript", () => {
  test("calls fetchConsoleJson with the encoded script name in the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: jsonEtlDetail });

    await fetchScript("json-etl");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      "/api/v1/scripts/json-etl",
    );
  });

  test("URL-encodes a name containing characters that would otherwise split the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: jsonEtlDetail });

    await fetchScript("weird/name");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/scripts/${encodeURIComponent("weird/name")}`,
    );
  });

  test("resolves to the ok result with a well-formed detail, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LScriptDetail> = {
      ok: true,
      data: jsonEtlDetail,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchScript("json-etl")).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
    };
    const errorResult: M3LConsoleFetchResult<M3LScriptDetail> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchScript("json-etl")).resolves.toEqual(errorResult);
  });

  test("passes a secret parameter's masked defaultValue through untouched", async () => {
    const detailWithSecret: M3LScriptDetail = {
      ...jsonEtlDetail,
      parameters: [
        {
          name: "apiKey",
          aliases: [],
          type: "STRING",
          required: true,
          defaultValue: "********",
          description: "",
          secret: true,
          operations: [],
        },
      ],
    };
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: detailWithSecret,
    });

    const result = await fetchScript("json-etl");

    expect(result).toEqual({ ok: true, data: detailWithSecret });
    if (result.ok) {
      expect(result.data.parameters[0]?.defaultValue).toBe("********");
    }
  });

  test("downgrades a non-object ok body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: null });

    await expect(fetchScript("json-etl")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a detail missing the parameters array to a malformed-body error", async () => {
    const { parameters: _parameters, ...withoutParameters } = jsonEtlDetail;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: withoutParameters,
    });

    await expect(fetchScript("json-etl")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a detail whose second parameter element is malformed to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: {
        ...jsonEtlDetail,
        parameters: [
          jsonEtlDetail.parameters[0],
          { name: "broken" }, // missing every other required field
        ],
      },
    });

    await expect(fetchScript("json-etl")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a detail whose operations array has a malformed second element to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: {
        ...jsonEtlDetail,
        operations: [
          { name: "extract", description: "", requiredParameters: [] },
          { name: "broken" }, // missing description/requiredParameters
        ],
      },
    });

    await expect(fetchScript("json-etl")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});
