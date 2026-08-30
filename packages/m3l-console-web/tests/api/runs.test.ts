import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  M3LConsoleFetchError,
  M3LConsoleFetchResult,
} from "../../src/api/client.js";
import { fetchConsoleJson } from "../../src/api/client.js";
import type { M3LRunRecord, M3LRunStatus } from "../../src/api/runs.js";
import { fetchRun, fetchRuns } from "../../src/api/runs.js";

vi.mock("../../src/api/client.js", () => ({
  fetchConsoleJson: vi.fn(),
}));

const mockedFetchConsoleJson = vi.mocked(fetchConsoleJson);

afterEach(() => {
  mockedFetchConsoleJson.mockReset();
});

// Nullable run fields serialise as null, never as absent keys — every
// fixture below spells them out rather than omitting them, so a guard that
// only checks `key in candidate` (instead of the value) cannot slip through.
const pendingRun: M3LRunRecord = {
  id: "0193f0c2-1111-7abc-9def-000000000001",
  script: "json-etl",
  status: "queued",
  dryRun: false,
  executionMode: "spawn",
  parameters: { input: "a.json" },
  operator: "boot-operator",
  correlationId: "corr-1",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: null,
  endedAtMs: null,
  outcome: null,
  exitCode: null,
  failureMessage: null,
};

const completedRun: M3LRunRecord = {
  id: "0193f0c2-2222-7abc-9def-000000000002",
  script: "sqs-etl",
  status: "success",
  dryRun: false,
  executionMode: "spawn",
  parameters: { queueUrl: "https://sqs.example/queue" },
  operator: "boot-operator",
  correlationId: "corr-2",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: 1_700_000_001_000,
  endedAtMs: 1_700_000_002_000,
  outcome: "success",
  exitCode: 0,
  failureMessage: null,
};

describe("fetchRuns", () => {
  test("calls fetchConsoleJson with exactly /api/v1/runs", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: [] });

    await fetchRuns();

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith("/api/v1/runs");
  });

  test("resolves to the ok result with well-formed records, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LRunRecord[]> = {
      ok: true,
      data: [pendingRun, completedRun],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchRuns()).resolves.toEqual(okResult);
  });

  test("resolves to an empty list unchanged — no runs yet is not malformed", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LRunRecord[]> = {
      ok: true,
      data: [],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchRuns()).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "network",
      message: "connection refused",
    };
    const errorResult: M3LConsoleFetchResult<readonly M3LRunRecord[]> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchRuns()).resolves.toEqual(errorResult);
  });

  test("downgrades a non-array ok body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: {} });

    await expect(fetchRuns()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades an array whose second element is malformed to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [pendingRun, { ...completedRun, status: "bogus" }],
    });

    await expect(fetchRuns()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a record shaped with scriptName instead of script to a malformed-body error", async () => {
    // The launch response (POST /api/v1/runs) uses `scriptName`; the stored
    // record (this route) uses `script`. A guard built around the wrong
    // field would reject every real row — this fixture proves the guard
    // checks `script`, by feeding it the other route's shape instead.
    const { script: _script, ...rest } = pendingRun;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [{ ...rest, scriptName: "json-etl" }],
    });

    await expect(fetchRuns()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});

describe("fetchRun", () => {
  test("calls fetchConsoleJson with the id in the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: pendingRun });

    await fetchRun(pendingRun.id);

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/runs/${pendingRun.id}`,
    );
  });

  test("resolves to the ok result with a well-formed record, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LRunRecord> = {
      ok: true,
      data: completedRun,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchRun(completedRun.id)).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
    };
    const errorResult: M3LConsoleFetchResult<M3LRunRecord> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchRun("missing-id")).resolves.toEqual(errorResult);
  });

  test("passes an arbitrary parameters value through verbatim without validating its shape", async () => {
    const runWithNestedParameters: M3LRunRecord = {
      ...completedRun,
      parameters: { nested: { list: [1, 2, 3], flag: true }, note: null },
    };
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: runWithNestedParameters,
    });

    await expect(fetchRun(completedRun.id)).resolves.toEqual({
      ok: true,
      data: runWithNestedParameters,
    });
  });

  test.each<M3LRunStatus>([
    "queued",
    "running",
    "success",
    "failure",
    "dry-run",
    "interrupted",
    "partial",
  ])("accepts %s as a valid run status", async (status) => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...completedRun, status },
    });

    await expect(fetchRun(completedRun.id)).resolves.toEqual({
      ok: true,
      data: { ...completedRun, status },
    });
  });

  test("downgrades a record with an unrecognised status value to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...completedRun, status: "cancelled" },
    });

    await expect(fetchRun(completedRun.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a non-object ok body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: null });

    await expect(fetchRun(pendingRun.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a record missing a required field to a malformed-body error", async () => {
    const { correlationId: _correlationId, ...withoutCorrelationId } =
      pendingRun;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: withoutCorrelationId,
    });

    await expect(fetchRun(pendingRun.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a record with a nullable field present as a string instead of null to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...pendingRun, startedAtMs: "not-a-number" },
    });

    await expect(fetchRun(pendingRun.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  // `id` is external input: it flows from location.hash through the router,
  // which only rejects empty and "/"-containing values — so a value like
  // ".." or "?x=1" can reach fetchRun verbatim. Mirrors the encoding
  // coverage fetchScript already has in tests/api/scripts.test.ts.
  //
  // NOTE for the reviewer/implementer: this asserts the *outcome* the
  // finding actually wants (a ".." id cannot resolve the request path up a
  // level), not "the .. gets percent-encoded" literally. JS's
  // encodeURIComponent leaves "." unescaped ("." is unreserved), so
  // encodeURIComponent("..") === "..": mirroring fetchScript's plain
  // encodeURIComponent(id) fix, as this task otherwise directs, would build
  // exactly the same path string as today's raw interpolation and this test
  // would still fail. Confirmed with WHATWG URL parsing directly (both
  // "/api/v1/runs/.." and "/api/v1/runs/%2e%2e" normalise to "/api/v1/" —
  // even a literal escaped dot-segment gets dot-normalised after percent
  // decoding). Closing this specific finding needs the implementer to
  // special-case reject an id that is exactly "." or ".." (or otherwise
  // guarantee the built path can't collapse), not just call
  // encodeURIComponent like fetchScript does.
  test("keeps a '..' id from resolving the request path up a level", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: pendingRun });

    await fetchRun("..");

    const [calledPath] = mockedFetchConsoleJson.mock.calls[0] ?? [];
    expect(typeof calledPath).toBe("string");
    const resolved = new URL(calledPath as string, "http://localhost");
    expect(resolved.pathname.startsWith("/api/v1/runs/")).toBe(true);
  });

  test("URL-encodes an id containing '?' so it cannot inject a query string", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: pendingRun });

    await fetchRun("?x=1");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/runs/${encodeURIComponent("?x=1")}`,
    );
  });

  test("URL-encodes an id containing '#'", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: pendingRun });

    await fetchRun("abc#def");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/runs/${encodeURIComponent("abc#def")}`,
    );
  });

  test("does not over-encode a normal UUID-shaped id", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: pendingRun });

    await fetchRun(pendingRun.id);

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/runs/${pendingRun.id}`,
    );
  });
});
