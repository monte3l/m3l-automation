import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type {
  M3LConsoleFetchError,
  M3LConsoleFetchResult,
} from "../../src/api/client.js";
import { fetchConsoleJson } from "../../src/api/client.js";
import type {
  M3LRunHandle,
  M3LRunLaunchRequest,
  M3LRunRecord,
  M3LRunStatus,
} from "../../src/api/runs.js";
import { fetchRun, fetchRuns, launchRun } from "../../src/api/runs.js";

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

const dryRunRequest: M3LRunLaunchRequest = {
  scriptName: "json-etl",
  parameters: { input: "a.json" },
  dryRun: true,
  confirmed: false,
};

// A launch *handle* uses `scriptName` (this is the field the launch route
// itself returns) — deliberately distinct from the stored M3LRunRecord's
// `script` field exercised above, per the contract's own warning.
const queuedHandle: M3LRunHandle = {
  id: "0193f0c2-3333-7abc-9def-000000000003",
  scriptName: "json-etl",
  status: "queued",
  dryRun: true,
  executionMode: "spawn",
};

describe("launchRun", () => {
  test("calls fetchConsoleJson with the launch path, POST, and the request body", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: queuedHandle });

    await launchRun(dryRunRequest);

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith("/api/v1/runs", {
      method: "POST",
      body: dryRunRequest,
    });
  });

  test("resolves to the ok result with a well-formed handle, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LRunHandle> = {
      ok: true,
      data: queuedHandle,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(launchRun(dryRunRequest)).resolves.toEqual(okResult);
  });

  test("downgrades a malformed 201 body (scriptName replaced by script) to a malformed-body error", async () => {
    // The handle uses `scriptName`; feeding it the run-record shape
    // (`script`) instead proves the guard is checking the handle's own
    // field, not accidentally reusing isM3LRunRecord.
    const { scriptName: _scriptName, ...rest } = queuedHandle;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...rest, script: "json-etl" },
    });

    await expect(launchRun(dryRunRequest)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a 201 body with an invalid status to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...queuedHandle, status: "success" },
    });

    await expect(launchRun(dryRunRequest)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a non-object 201 body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: null });

    await expect(launchRun(dryRunRequest)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("surfaces a 409 ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED envelope with its code and status intact", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "confirmation is required for a non-dry-run launch",
      status: 409,
      code: "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
      correlationId: "corr-confirm",
    };
    mockedFetchConsoleJson.mockResolvedValue({ ok: false, error });

    // The client-side union now forbids constructing an unconfirmed
    // real-run request (see the type-level review block below) — this test's
    // subject is the 409 envelope surfacing intact, not the client's ability
    // to send an illegal shape, so provoke it with a *legal* confirmed
    // request. The server can still return 409 for its own reasons
    // (e.g. a stale confirmation token) regardless of what the client sent.
    const result = await launchRun({
      ...dryRunRequest,
      dryRun: false,
      confirmed: true,
    });

    expect(result).toEqual({ ok: false, error });
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.status).toBe(409);
    expect(result.error.code).toBe("ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED");
  });

  test("surfaces a 429 ERR_CONSOLE_RUN_CAPACITY_EXCEEDED envelope with its code and status intact", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "the run queue is full",
      status: 429,
      code: "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
      correlationId: "corr-capacity",
    };
    mockedFetchConsoleJson.mockResolvedValue({ ok: false, error });

    const result = await launchRun(dryRunRequest);

    expect(result).toEqual({ ok: false, error });
    if (result.ok) {
      throw new Error("expected a failure result");
    }
    expect(result.error.status).toBe(429);
    expect(result.error.code).toBe("ERR_CONSOLE_RUN_CAPACITY_EXCEEDED");
  });
});

// X10d security/type-design review: `dryRun` and `confirmed` are two
// independent booleans today, so `{ dryRun: false, confirmed: false }`
// type-checks despite the server always rejecting it with a 409. The fix is
// a discriminated union: `{ dryRun: true } | { dryRun: false; confirmed:
// true }`.
//
// `expectTypeOf` is a compile-time-only assertion — it is a runtime no-op,
// so `vitest run` reports this describe block green regardless. The actual
// signal is `pnpm typecheck`: today it FAILS on the `.not.toMatchTypeOf`
// assertion below (the illegal shape still structurally matches
// `M3LRunLaunchRequest`) and on the two legal-shape assertions (both are
// missing a `confirmed` field the current, non-union type still requires
// unconditionally). Once the union lands, `pnpm typecheck` must pass all
// three.
describe("M3LRunLaunchRequest — dryRun/confirmed shape (type-level)", () => {
  test("[KNOWN BUG] the illegal dryRun:false/confirmed:false combination is not assignable to M3LRunLaunchRequest", () => {
    expectTypeOf<{
      readonly scriptName: string;
      readonly parameters: Readonly<Record<string, string>>;
      readonly dryRun: false;
      readonly confirmed: false;
    }>().not.toMatchTypeOf<M3LRunLaunchRequest>();
  });

  test("a dryRun: true request is assignable without a confirmed field", () => {
    expectTypeOf<{
      readonly scriptName: string;
      readonly parameters: Readonly<Record<string, string>>;
      readonly dryRun: true;
    }>().toMatchTypeOf<M3LRunLaunchRequest>();
  });

  test("a dryRun: false request carrying confirmed: true is assignable", () => {
    expectTypeOf<{
      readonly scriptName: string;
      readonly parameters: Readonly<Record<string, string>>;
      readonly dryRun: false;
      readonly confirmed: true;
    }>().toMatchTypeOf<M3LRunLaunchRequest>();
  });
});

// X10d type-design review: M3L_RUN_HANDLE_STATUSES (["queued", "running"])
// has no typed link to the seven-value M3L_RUN_STATUSES it is meant to
// subset. This assertion is a regression lock, not a currently-failing
// proof — no drift has happened yet, so it passes `pnpm typecheck` today.
// Its value is future: renaming "queued" in the seven-value list without
// touching this file would otherwise keep compiling clean while
// `isM3LRunHandleStatus` silently rejects every real 201 as
// `malformed-body`; with this pin in place, that rename trips `pnpm
// typecheck` here instead.
describe("M3LRunHandle status vocabulary — drift guard (type-level)", () => {
  test("every M3LRunHandle status is a member of M3LRunStatus", () => {
    expectTypeOf<M3LRunHandle["status"]>().toMatchTypeOf<M3LRunStatus>();
  });
});
