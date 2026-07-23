/**
 * Tests for core/diagnostics — breadcrumbs.ts, collect.ts, run-report.ts
 * (RED phase — ADR-0035 phase 1, part 2 of 2; none of this module exists yet).
 *
 * Contract source: docs/reference/core/diagnostics.md, ADR-0035, plus the
 * hub-locked behavioral contract for this change set. A sibling spoke tests
 * the rest of the module (exit-code registry, formatErrorChain, runScript) in
 * `tests/diagnostics.test.ts` — not touched here.
 *
 * Exports under test (this file):
 *  - breadcrumbs.ts: M3LBreadcrumb, M3LBreadcrumbSource, M3LBreadcrumbTrailOptions,
 *    M3LBreadcrumbAttachOptions, M3LBreadcrumbTrail.
 *  - collect.ts: M3LConfigSchemaPort, M3LConfigSourcePort, M3LPathsPort,
 *    M3LConfigFingerprintEntry, M3LDiagnosticsEnvironment, M3LDiagnosticsSnapshot,
 *    M3LCollectDiagnosticsOptions, collectDiagnostics.
 *  - run-report.ts: M3LRunOutcome, M3LRunReport, M3LRunReportInput,
 *    M3LRunReporterOptions, M3LRunReporter.
 *
 * The central security contract for `M3LBreadcrumbTrail`: every event payload
 * is projected through a per-event summarizer keeping scalars only, then
 * passed through `redactSensitiveLogValue` — verified against the real
 * `M3LHttpClient`/`M3LListImporter`/polling event-map shapes (see the source
 * files cited inline below) rather than assumed.
 *
 * `mapErrorToExitCode` is imported for `run-report.ts`'s exit-code default
 * assertion even though it is implemented in a sibling file under the same
 * `core/diagnostics` barrel — both files are equally nonexistent right now,
 * so importing it here does not weaken the RED signal.
 */

import { readdirSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// `M3LHttpClient` wraps undici's `fetch`; mocked so the network-event-family
// breadcrumb tests never touch a real socket (mirrors tests/network.test.ts).
vi.mock("undici", () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn(),
}));

import { fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";

// `node:fs/promises` is otherwise used via bare named imports throughout this
// file (real temp-dir I/O); mocked here ONLY so a single test can vi.spyOn
// `realpath` (built-ins are not directly spy-able without this mock-then-spy
// pattern — see .claude/rules/tests.md). The factory spreads the real module
// so every other import above keeps its real, unmocked behavior.
import * as nodeFsPromises from "node:fs/promises";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof nodeFsPromises>("node:fs/promises");
  return { ...actual };
});

import {
  M3LConfig,
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigSchema,
} from "../src/core/config/index.js";
import {
  M3LCredentialSource,
  M3LDeploymentMode,
  M3LExecutionEnvironment,
  M3LExecutionEnvironmentType,
} from "../src/core/environment/index.js";
import type { M3LExecutionEnvironmentInfo } from "../src/core/environment/index.js";
import { M3LError } from "../src/core/errors/index.js";
import { M3LEventEmitter } from "../src/core/events/index.js";
import { M3LFileCopier } from "../src/core/files/index.js";
import { M3LHttpClient } from "../src/core/network/index.js";
import {
  M3LBackoff,
  M3LPoller,
  M3LRetryRunner,
} from "../src/core/polling/index.js";
import { M3LPathResolutionError } from "../src/core/utils/index.js";

// -----------------------------------------------------------------------
// SUT — does not exist yet. This import MUST fail in RED with "Cannot find
// module" (or equivalent). No try/catch around it — the whole file failing
// to resolve is the expected, correct RED signal.
// -----------------------------------------------------------------------
import {
  collectDiagnostics,
  M3LBreadcrumbTrail,
  M3LRunReporter,
  mapErrorToExitCode,
} from "../src/core/diagnostics/index.js";
import type {
  M3LBreadcrumb,
  M3LBreadcrumbAttachOptions,
  M3LBreadcrumbTrailOptions,
  M3LCollectDiagnosticsOptions,
  M3LConfigFingerprintEntry,
  M3LConfigSchemaPort,
  M3LConfigSourcePort,
  M3LDiagnosticsEnvironment,
  M3LDiagnosticsSnapshot,
  M3LPathsPort,
  M3LRunOutcome,
  M3LRunReport,
  M3LRunReportFailure,
  M3LRunReportInput,
} from "../src/core/diagnostics/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(undiciFetch).mockReset();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every value in a summarized breadcrumb payload must be a scalar (or array of scalars). */
function assertScalarOnly(value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) assertScalarOnly(item);
    return;
  }
  expect(["string", "number", "boolean"]).toContain(typeof value);
}

function assertAllScalarLeaves(record: Record<string, unknown>): void {
  for (const value of Object.values(record)) {
    assertScalarOnly(value);
  }
}

/** A minimal fake `M3LPathsPort` returning fixed, distinguishable directory strings. */
function fakePathsPort(): M3LPathsPort {
  return {
    getDataDir: () => "/fake/data",
    getConfigDir: () => "/fake/data/config",
    getInputDir: () => "/fake/data/input",
    getOutputDir: () => "/fake/data/output",
    getCacheDir: () => "/fake/data/cache",
  };
}

/** Builds a fake undici `Response` for the network breadcrumb tests. */
function makeJsonResponse(status: number, body: unknown): UndiciResponse {
  const fake = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: (): Promise<unknown> => Promise.resolve(body),
    text: (): Promise<string> => Promise.resolve(JSON.stringify(body)),
  };
  return fake as unknown as UndiciResponse;
}

// =============================================================================
// M3LBreadcrumbTrail — type contracts
// =============================================================================
describe("M3LBreadcrumb / M3LBreadcrumbTrailOptions / M3LBreadcrumbAttachOptions — type contracts", () => {
  test("M3LBreadcrumb has the documented readonly shape", () => {
    expectTypeOf<M3LBreadcrumb>().toMatchTypeOf<{
      readonly timestamp: string;
      readonly source: string;
      readonly event: string;
      readonly payload: Record<string, unknown>;
    }>();
  });

  test("M3LBreadcrumbTrailOptions.limit is optional", () => {
    const options: M3LBreadcrumbTrailOptions = {};
    expect(options).toEqual({});
    const withLimit: M3LBreadcrumbTrailOptions = { limit: 50 };
    expect(withLimit.limit).toBe(50);
  });

  test("M3LBreadcrumbAttachOptions accepts optional source and events", () => {
    const options: M3LBreadcrumbAttachOptions = {
      source: "x",
      events: ["a", "b"],
    };
    expect(options.events).toEqual(["a", "b"]);
  });
});

// =============================================================================
// M3LBreadcrumbTrail — construction, limit guard, ring eviction, clear
// =============================================================================
describe("M3LBreadcrumbTrail — construction & limit guard", () => {
  test("constructs with no options; default limit is 100", () => {
    const trail = new M3LBreadcrumbTrail();
    for (let i = 0; i < 105; i++)
      trail.record("s", "retry:success", { attempt: i });
    expect(trail.entries()).toHaveLength(100);
  });

  test("entries() is empty immediately after construction", () => {
    const trail = new M3LBreadcrumbTrail({ limit: 10 });
    expect(trail.entries()).toEqual([]);
  });

  test("limit: 1 is a valid, non-throwing boundary", () => {
    expect(() => new M3LBreadcrumbTrail({ limit: 1 })).not.toThrow();
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("limit=%p throws M3LError (code ERR_INVALID_ARGUMENT)", (limit) => {
    let thrown: unknown;
    try {
      new M3LBreadcrumbTrail({ limit });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });
});

describe("M3LBreadcrumbTrail — record/entries/clear", () => {
  test("ring eviction: recording limit+1 entries keeps exactly `limit`, oldest evicted first (FIFO)", () => {
    const trail = new M3LBreadcrumbTrail({ limit: 3 });
    for (let i = 1; i <= 4; i++)
      trail.record("s", "retry:success", { attempt: i });

    const entries = trail.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.payload).toEqual({ attempt: 2 });
    expect(entries[2]?.payload).toEqual({ attempt: 4 });
  });

  test("recording 3x the limit still leaves exactly `limit` entries, the most recent ones", () => {
    const trail = new M3LBreadcrumbTrail({ limit: 3 });
    for (let i = 1; i <= 9; i++)
      trail.record("s", "retry:success", { attempt: i });

    const entries = trail.entries();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry: M3LBreadcrumb) => entry.payload)).toEqual([
      { attempt: 7 },
      { attempt: 8 },
      { attempt: 9 },
    ]);
  });

  test("entries() returns a new array each call; mutating the result does not affect the trail", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("s", "retry:success", { attempt: 1 });

    const first = trail.entries();
    const second = trail.entries();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    const mutable = first as M3LBreadcrumb[];
    mutable.push({
      timestamp: new Date().toISOString(),
      source: "injected",
      event: "fake",
      payload: {},
    });
    expect(trail.entries()).toHaveLength(1);
  });

  test("timestamp is a valid ISO-8601 string", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("s", "retry:success", { attempt: 1 });
    const [entry] = trail.entries();
    expect(entry).toBeDefined();
    const timestamp = entry?.timestamp ?? "";
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  test("clear() empties the trail without detaching an attached source", () => {
    const emitter = new M3LEventEmitter<{ "custom:tick": { n: number } }>();
    const trail = new M3LBreadcrumbTrail();
    trail.attach(emitter, { events: ["custom:tick"] });

    emitter.emit("custom:tick", { n: 1 });
    expect(trail.entries()).toHaveLength(1);

    trail.clear();
    expect(trail.entries()).toEqual([]);

    emitter.emit("custom:tick", { n: 2 });
    expect(trail.entries()).toHaveLength(1);
  });
});

// =============================================================================
// M3LBreadcrumbTrail — event summarizers (the central security contract)
// =============================================================================
describe("M3LBreadcrumbTrail — event summarizers, simple scalar families", () => {
  const SIMPLE_EVENT_CASES: ReadonlyArray<{
    readonly event: string;
    readonly input: Record<string, unknown>;
    readonly expected: Record<string, unknown>;
  }> = [
    {
      event: "retry:attempt",
      input: { attempt: 1, maxAttempts: 5, secret: "drop-me" },
      expected: { attempt: 1, maxAttempts: 5 },
    },
    {
      event: "retry:scheduled",
      input: {
        attempt: 2,
        delayMs: 200,
        classification: "retriable",
        secret: "drop-me",
      },
      expected: { attempt: 2, delayMs: 200, classification: "retriable" },
    },
    {
      event: "retry:success",
      input: { attempt: 3, secret: "drop-me" },
      expected: { attempt: 3 },
    },
    {
      event: "retry:fatal",
      input: { attempt: 2, classification: "fatal", secret: "drop-me" },
      expected: { attempt: 2, classification: "fatal" },
    },
    {
      event: "retry:exhausted",
      input: { attempts: 10, secret: "drop-me" },
      expected: { attempts: 10 },
    },
    {
      event: "poll:attempt",
      input: { attempt: 1, maxAttempts: 30, secret: "drop-me" },
      expected: { attempt: 1, maxAttempts: 30 },
    },
    {
      event: "poll:wait",
      input: { attempt: 1, delayMs: 500, secret: "drop-me" },
      expected: { attempt: 1, delayMs: 500 },
    },
    {
      event: "poll:success",
      input: { attempt: 4, secret: "drop-me" },
      expected: { attempt: 4 },
    },
    {
      event: "poll:exhausted",
      input: { attempts: 30, secret: "drop-me" },
      expected: { attempts: 30 },
    },
    {
      event: "import:completed",
      input: { processed: 12, durationMs: 340, secret: "drop-me" },
      expected: { processed: 12, durationMs: 340 },
    },
    {
      event: "import:progress",
      input: { processed: 5, total: 20, secret: "drop-me" },
      expected: { processed: 5, total: 20 },
    },
    {
      event: "import:progress",
      input: { processed: 5, secret: "drop-me" },
      expected: { processed: 5 },
    },
  ];

  test.each(SIMPLE_EVENT_CASES)(
    "$event summarizes to the registry-defined scalar shape, dropping unregistered fields",
    ({ event, input, expected }) => {
      const trail = new M3LBreadcrumbTrail();
      trail.record("src", event, input);
      const [entry] = trail.entries();
      expect(entry?.payload).toEqual(expected);
      assertAllScalarLeaves(entry?.payload ?? {});
      expect(JSON.parse(JSON.stringify(entry?.payload))).toEqual(
        entry?.payload,
      );
    },
  );

  test("import:progress with a non-numeric total omits total entirely", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("src", "import:progress", { processed: 3, total: "unknown" });
    const [entry] = trail.entries();
    expect(entry?.payload).toEqual({ processed: 3 });
  });
});

describe("M3LBreadcrumbTrail — import:started / import:item / import:error", () => {
  test("import:started summarizes to {source}, text-redacted", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("importer", "import:started", {
      source: "https://example.com/data?token=sk-secret",
    });
    const [entry] = trail.entries();
    expect(entry?.payload).toHaveProperty("source");
    expect(JSON.stringify(entry?.payload)).not.toContain("sk-secret");
  });

  test("import:item drops the item entirely, keeping only {index}", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("importer", "import:item", {
      item: { ssn: "123-45-6789" },
      index: 7,
    });
    const [entry] = trail.entries();
    expect(entry?.payload).toEqual({ index: 7 });
    expect(JSON.stringify(entry?.payload)).not.toContain("123-45-6789");
  });

  test("import:error with a raw Error carries errorName but NO error/stack/errorMessage", () => {
    const trail = new M3LBreadcrumbTrail();
    const error = new Error("row 4 failed for ssn 123-45-6789");
    trail.record("importer", "import:error", { error, index: 4 });
    const [entry] = trail.entries();
    const payload = entry?.payload ?? {};

    expect(payload.index).toBe(4);
    expect(payload.errorName).toBe("Error");
    expect(payload).not.toHaveProperty("error");
    expect(payload).not.toHaveProperty("stack");
    expect(payload).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(payload)).not.toContain("123-45-6789");
  });

  test("import:error with an M3LError carries errorCode too", () => {
    const trail = new M3LBreadcrumbTrail();
    const error = new M3LError("bad row", { code: "ERR_IMPORT_PARSE" });
    trail.record("importer", "import:error", { error, index: 9 });
    const [entry] = trail.entries();
    const payload = entry?.payload ?? {};

    expect(payload.errorCode).toBe("ERR_IMPORT_PARSE");
    expect(payload).not.toHaveProperty("errorMessage");
  });

  test("import:error without an index still summarizes (index is optional)", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("importer", "import:error", { error: new Error("no index") });
    const [entry] = trail.entries();
    expect(entry?.payload).not.toHaveProperty("index");
    expect(entry?.payload?.errorName).toBe("Error");
  });
});

describe("M3LBreadcrumbTrail — network event family via a real M3LHttpClient", () => {
  test("request event: header values never captured, only sorted headerNames", async () => {
    vi.mocked(undiciFetch).mockResolvedValue(
      makeJsonResponse(200, { ok: true }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      defaultHeaders: {
        Authorization: "Bearer sk-secret",
        Accept: "application/json",
      },
    });
    const trail = new M3LBreadcrumbTrail();
    trail.attach(client);

    await client.get("/x");

    const requestEntry = trail
      .entries()
      .find((entry: M3LBreadcrumb) => entry.event === "request");
    expect(requestEntry).toBeDefined();
    expect(JSON.stringify(requestEntry?.payload)).not.toContain("sk-secret");
    expect(requestEntry?.payload).toMatchObject({
      method: "GET",
      headerNames: ["Accept", "Authorization"],
    });
  });

  test("response event: {method,url,status,ok,durationMs}", async () => {
    vi.mocked(undiciFetch).mockResolvedValue(
      makeJsonResponse(200, { ok: true }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
    const trail = new M3LBreadcrumbTrail();
    trail.attach(client);

    await client.get("/y");

    const responseEntry = trail
      .entries()
      .find((entry: M3LBreadcrumb) => entry.event === "response");
    expect(responseEntry?.payload).toMatchObject({
      method: "GET",
      status: 200,
      ok: true,
    });
    const durationMs = responseEntry?.payload?.durationMs;
    expect(typeof durationMs).toBe("number");
  });

  test("error event: carries errorName/errorCode + a redacted errorMessage, no raw error object or stack", async () => {
    vi.mocked(undiciFetch).mockRejectedValue(new Error("network is down"));
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com/?token=sk-secret",
    });
    const trail = new M3LBreadcrumbTrail();
    trail.attach(client);

    await expect(client.get("/z")).rejects.toThrow();

    const errorEntry = trail
      .entries()
      .find((entry: M3LBreadcrumb) => entry.event === "error");
    expect(errorEntry).toBeDefined();
    const payload = errorEntry?.payload ?? {};

    expect(payload.errorName).toBe("M3LHttpClientError");
    expect(payload.errorCode).toBe("ERR_HTTP_REQUEST");
    expect(payload).not.toHaveProperty("error");
    expect(payload).not.toHaveProperty("stack");
    expect(typeof payload.errorMessage).toBe("string");
    expect(JSON.stringify(payload)).not.toContain("sk-secret");
  });
});

// =============================================================================
// M3LBreadcrumbTrail — URL sanitization (security Must-fix): request/response/
// error summarizers reduce `url` to origin+pathname only — userinfo and the
// ENTIRE query string are dropped (never merely redacted), and an unparseable
// or non-string url yields NO `url` field at all, never a raw-string fallback.
// =============================================================================
describe("M3LBreadcrumbTrail — URL sanitization (security Must-fix)", () => {
  test.each([
    [
      "request",
      "https://svcuser:s3cr3tPass@api.example.com/v1/items",
      "https://api.example.com/v1/items",
      "s3cr3tPass",
    ],
    [
      "response",
      "https://h.example.com/p?x-api-key=SEK123",
      "https://h.example.com/p",
      "SEK123",
    ],
    [
      "error",
      "https://h.example.com/p?access_token=abc123",
      "https://h.example.com/p",
      "abc123",
    ],
    [
      "request",
      "https://s3.example.com/k?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAEXAMPLE",
      "https://s3.example.com/k",
      "deadbeef",
    ],
  ] as const)(
    "%s event: url is reduced to origin+pathname, dropping the leaking part",
    (event, rawUrl, expectedUrl, leakedValue) => {
      const trail = new M3LBreadcrumbTrail();
      trail.record("src", event, {
        method: "GET",
        url: rawUrl,
        error: new Error("boom"),
      });
      const [entry] = trail.entries();
      expect(entry?.payload.url).toBe(expectedUrl);
      expect(JSON.stringify(entry?.payload)).not.toContain(leakedValue);
    },
  );

  test("a presigned-S3 url never leaks BOTH X-Amz-Signature and X-Amz-Credential", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("src", "request", {
      method: "GET",
      url: "https://s3.example.com/k?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAEXAMPLE",
    });
    const [entry] = trail.entries();
    expect(entry?.payload.url).toBe("https://s3.example.com/k");
    const serialized = JSON.stringify(entry?.payload);
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("AKIAEXAMPLE");
  });

  test("an unparseable url yields no `url` field at all — never falls back to the raw string", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("src", "request", { method: "GET", url: "not a valid url" });
    const [entry] = trail.entries();
    expect(entry?.payload).not.toHaveProperty("url");
    expect(JSON.stringify(entry?.payload)).not.toContain("not a valid url");
  });

  test("a non-string url (number) also yields no `url` field", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("src", "response", {
      method: "GET",
      url: 12_345,
      status: 200,
    });
    const [entry] = trail.entries();
    expect(entry?.payload).not.toHaveProperty("url");
  });

  // Security fix (d): `url` was already being reduced via `safeUrl`, but the
  // adjacent `errorMessage` field on the "error" event embeds
  // `M3LHttpClientError.message` (or any Error's `message`) verbatim, which
  // routinely re-embeds that same raw request URL — smuggling the credential
  // right back in next to the field that was supposed to have scrubbed it.
  test("error event: errorMessage is scrubbed of the same raw URL riding in url, not just the url field itself", () => {
    const RAW =
      "https://svc-user:hunter2SUPERPASS@api.example.com/v1/data?X-Amz-Signature=DEADBEEFSIGSECRET&sig=OTHERSECRET";
    const trail = new M3LBreadcrumbTrail();
    trail.record("src", "error", {
      method: "GET",
      url: RAW,
      error: new Error(`request to ${RAW} failed`),
    });

    const [entry] = trail.entries();
    expect(entry?.payload.url).toBe("https://api.example.com/v1/data");
    expect(typeof entry?.payload.errorMessage).toBe("string");

    const serialized = JSON.stringify(entry?.payload);
    expect(serialized).not.toContain("hunter2SUPERPASS");
    expect(serialized).not.toContain("DEADBEEFSIGSECRET");
    expect(serialized).not.toContain("OTHERSECRET");
  });

  // Security fix (e): `safeUrl` previously reported `origin` as the literal
  // string `"null"` for an opaque-origin scheme like `data:`, retaining the
  // rest of the payload verbatim; a `blob:` URL's `origin` duplicates the
  // inner URL it wraps. Both must now be rejected outright (no `url` field),
  // never partially retained.
  test.each([
    ["data:text/plain;base64,U0VDUkVUX0RBVEE", "U0VDUkVUX0RBVEE"],
    ["blob:https://api.example.com/uuid-SECRET", "uuid-SECRET"],
  ] as const)(
    "a non-http(s) scheme url (%s) yields no url field and never leaks its payload",
    (rawUrl, leakedValue) => {
      const trail = new M3LBreadcrumbTrail();
      trail.record("src", "request", { method: "GET", url: rawUrl });
      const [entry] = trail.entries();
      expect(entry?.payload).not.toHaveProperty("url");
      const serialized = JSON.stringify(entry?.payload);
      expect(serialized).not.toContain(leakedValue);
      expect(serialized).not.toContain("null");
    },
  );
});

describe("M3LBreadcrumbTrail — generic fallback for unknown/foreign events", () => {
  test("an unknown event name falls back to a scalar-only projection of own enumerable props", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("foreign", "totally:unknown", {
      keep: 1,
      also: "yes",
      dropMe: { nested: true },
      fn: () => {},
    });
    const [entry] = trail.entries();
    expect(entry?.payload).toEqual({ keep: 1, also: "yes" });
  });

  test.each([null, 5, "a string", [1, 2, 3]])(
    "a non-record payload (%j) summarizes to {}",
    (payload) => {
      const trail = new M3LBreadcrumbTrail();
      expect(() =>
        trail.record("foreign", "totally:unknown", payload),
      ).not.toThrow();
      const [entry] = trail.entries();
      expect(entry?.payload).toEqual({});
    },
  );

  test("a wrong-shaped payload for a known event name never throws and still records a partial breadcrumb", () => {
    const trail = new M3LBreadcrumbTrail();
    expect(() =>
      trail.record("foreign", "retry:attempt", { attempt: "not-a-number" }),
    ).not.toThrow();
    const [entry] = trail.entries();
    expect(entry?.event).toBe("retry:attempt");
  });

  test("a hostile payload (throwing getter) never reaches the emitter's own stderr reporter", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new M3LEventEmitter<{ "retry:attempt": unknown }>();
    const trail = new M3LBreadcrumbTrail();
    trail.attach(emitter, { source: "hostile", events: ["retry:attempt"] });

    const hostilePayload: Record<string, unknown> = {};
    Object.defineProperty(hostilePayload, "attempt", {
      get(): number {
        throw new Error("boom");
      },
      enumerable: true,
    });

    expect(() => emitter.emit("retry:attempt", hostilePayload)).not.toThrow();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// M3LBreadcrumbTrail.attach() / detach
// =============================================================================
describe("M3LBreadcrumbTrail.attach() / detach", () => {
  test("attach(emitter) then emit -> exactly one breadcrumb, source = constructor name, event = emitted name", async () => {
    const runner = new M3LRetryRunner({
      classifier: () => "fatal",
      maxAttempts: 1,
    });
    const trail = new M3LBreadcrumbTrail();
    trail.attach(runner);

    await expect(
      runner.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    const attemptEntries = trail
      .entries()
      .filter((entry: M3LBreadcrumb) => entry.event === "retry:attempt");
    expect(attemptEntries).toHaveLength(1);
    expect(attemptEntries[0]?.source).toBe("M3LRetryRunner");
  });

  test("detach() removes exactly that attach's handlers; a second call is a no-op", async () => {
    const runner = new M3LRetryRunner({
      classifier: () => "fatal",
      maxAttempts: 1,
    });
    const trail = new M3LBreadcrumbTrail();
    const detach = trail.attach(runner);

    detach();
    expect(() => {
      detach();
    }).not.toThrow();

    await expect(
      runner.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    expect(trail.entries()).toEqual([]);
  });

  test("attaching to an emitter that never emits a given event records nothing (dormant registrations harmless)", () => {
    const runner = new M3LRetryRunner({
      classifier: () => "fatal",
      maxAttempts: 1,
    });
    const trail = new M3LBreadcrumbTrail();
    trail.attach(runner);
    expect(trail.entries()).toEqual([]);
  });

  test("double-attach on the same emitter records each event TWICE (documented, not deduped)", () => {
    const emitter = new M3LEventEmitter<{ "custom:tick": { n: number } }>();
    const trail = new M3LBreadcrumbTrail();
    trail.attach(emitter, { source: "ticker", events: ["custom:tick"] });
    trail.attach(emitter, { source: "ticker", events: ["custom:tick"] });

    emitter.emit("custom:tick", { n: 1 });

    expect(trail.entries()).toHaveLength(2);
  });

  test("options.source overrides the emitter's constructor name", () => {
    const emitter = new M3LEventEmitter<{ "custom:tick": { n: number } }>();
    const trail = new M3LBreadcrumbTrail();
    trail.attach(emitter, { source: "my-ticker", events: ["custom:tick"] });
    emitter.emit("custom:tick", { n: 1 });
    expect(trail.entries()[0]?.source).toBe("my-ticker");
  });

  test("attaches to a real M3LPoller and records poll:attempt/poll:wait/poll:success", async () => {
    let attempts = 0;
    const poller = new M3LPoller({
      backoff: M3LBackoff.constant(1),
      maxAttempts: 5,
    });
    const trail = new M3LBreadcrumbTrail();
    trail.attach(poller);

    await poller.poll(() => {
      attempts++;
      return attempts < 2
        ? { type: "continue" }
        : { type: "success", value: "done" };
    });

    const events = trail.entries().map((entry: M3LBreadcrumb) => entry.event);
    expect(events).toContain("poll:attempt");
    expect(events).toContain("poll:wait");
    expect(events).toContain("poll:success");
    expect(
      trail
        .entries()
        .every((entry: M3LBreadcrumb) => entry.source === "M3LPoller"),
    ).toBe(true);
  });
});

// =============================================================================
// collectDiagnostics
// =============================================================================
describe("collectDiagnostics — basic snapshot fields", () => {
  test("nodeVersion/platform/arch/capturedAt reflect the real process", () => {
    const snapshot = collectDiagnostics();
    expect(snapshot.nodeVersion).toBe(process.version);
    expect(snapshot.platform).toBe(process.platform);
    expect(snapshot.arch).toBe(process.arch);
    expect(new Date(snapshot.capturedAt).toISOString()).toBe(
      snapshot.capturedAt,
    );
  });

  test("detectionDetails is absent from the snapshot (it is a raw, unredacted env-signal blob)", () => {
    const snapshot = collectDiagnostics();
    expect("detectionDetails" in snapshot).toBe(false);
  });

  test("correlationId is echoed verbatim when supplied, omitted otherwise", () => {
    const withId = collectDiagnostics({ correlationId: "corr-42" });
    expect(withId.correlationId).toBe("corr-42");

    const withoutId = collectDiagnostics();
    expect(withoutId.correlationId).toBeUndefined();
  });

  test("never throws with no options, with {}, or with ports whose methods throw", () => {
    expect(() => collectDiagnostics()).not.toThrow();
    expect(() => collectDiagnostics({})).not.toThrow();

    const throwingSchema: M3LConfigSchemaPort = {
      declaredNames: () => {
        throw new Error("schema is broken");
      },
    };
    const throwingPaths: M3LPathsPort = {
      getDataDir: () => {
        throw new Error("broken");
      },
      getConfigDir: () => {
        throw new Error("broken");
      },
      getInputDir: () => {
        throw new Error("broken");
      },
      getOutputDir: () => {
        throw new Error("broken");
      },
      getCacheDir: () => {
        throw new Error("broken");
      },
    };

    expect(() =>
      collectDiagnostics({ schema: throwingSchema, paths: throwingPaths }),
    ).not.toThrow();

    const snapshot = collectDiagnostics({
      schema: throwingSchema,
      paths: throwingPaths,
    });
    expect(snapshot.config).toBeUndefined();
    expect(snapshot.paths).toBeUndefined();
  });
});

describe("collectDiagnostics — injected M3LPathsPort", () => {
  test("the five directories come from the injected port verbatim", () => {
    const options: M3LCollectDiagnosticsOptions = { paths: fakePathsPort() };
    const snapshot = collectDiagnostics(options);
    const values = Object.values(snapshot.paths ?? {});
    expect(values).toContain("/fake/data");
    expect(values).toContain("/fake/data/config");
    expect(values).toContain("/fake/data/input");
    expect(values).toContain("/fake/data/output");
    expect(values).toContain("/fake/data/cache");
  });
});

describe("collectDiagnostics — config fingerprint (names + sources only, never values)", () => {
  test("CRITICAL: a real M3LConfigSchema and M3LConfig satisfy the ports with zero adaptation", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "apiKey",
        type: M3LConfigParameterType.STRING,
      }),
    ]);
    const config = new M3LConfig();
    config.set("apiKey", "sk-live-SECRET", "environment-variable");

    const snapshot = collectDiagnostics({ schema, config });

    expect(snapshot.config).toEqual([
      { name: "apiKey", source: "environment-variable" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("sk-live-SECRET");
  });

  test("no schema port -> config is omitted entirely (a config port alone cannot enumerate names)", () => {
    const config = new M3LConfig();
    config.set("apiKey", "sk-live-SECRET", "cli");
    const snapshot = collectDiagnostics({ config });
    expect(snapshot.config).toBeUndefined();
  });

  test("schema without config -> every entry has source: undefined", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        aliases: ["aws-region"],
      }),
    ]);
    const snapshot = collectDiagnostics({ schema });
    expect(snapshot.config).toEqual([
      { name: "region", source: undefined },
      { name: "aws-region", source: undefined },
    ]);
  });

  test("entry order follows declaredNames() order; aliases appear as their own entries", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        aliases: ["aws-region"],
      }),
      new M3LConfigParameter({
        name: "profile",
        type: M3LConfigParameterType.STRING,
      }),
    ]);
    const config = new M3LConfig();
    config.set("aws-region", "eu-west-1", "cli");

    const snapshot = collectDiagnostics({ schema, config });
    expect(
      snapshot.config?.map((entry: M3LConfigFingerprintEntry) => entry.name),
    ).toEqual(["region", "aws-region", "profile"]);
    expect(
      snapshot.config?.find(
        (entry: M3LConfigFingerprintEntry) => entry.name === "aws-region",
      )?.source,
    ).toBe("cli");
  });

  test("type-level: M3LConfigFingerprintEntry has {name, source} and a `value` field closed off to `never` (Must-fix, RED until implemented)", () => {
    // Pending ADR-0035 phase-1 Must-fix: without `readonly value?: never`,
    // excess-property checking protects only fresh object literals — a
    // *widened* object carrying `value` compiles today and can leak a
    // secret into the persisted run report. This assertion is intentionally
    // RED until a code-implementer adds the field.
    expectTypeOf<M3LConfigFingerprintEntry>().toEqualTypeOf<{
      readonly name: string;
      readonly source: string | undefined;
      readonly value?: never;
    }>();
  });

  test("CRITICAL (Must-fix, RED until implemented): a widened object carrying `value` must not be assignable to M3LConfigFingerprintEntry", () => {
    const wide = { name: "k", source: "cli", value: "s3cret" };
    // @ts-expect-error -- `value` must be excluded even via a non-fresh (widened) assignment once `value?: never` lands; RED until the Must-fix ships
    const entry: M3LConfigFingerprintEntry = wide;
    void entry;
  });

  test("type-level: a real M3LConfig satisfies M3LConfigSourcePort structurally", () => {
    expectTypeOf<M3LConfig>().toMatchTypeOf<M3LConfigSourcePort>();
  });
});

// =============================================================================
// sanitizeSourceLabel — round-4 security fix regression (lock-in): the
// unrecognized-source label check is now an ALLOWLIST, not a shape regex. A
// shape-based denylist ("lowercase words joined by hyphens") is exactly as
// strong as an adversary's willingness to pick a lowercase-hyphenated
// secret — a prior shape regex let any such string through verbatim.
// =============================================================================
describe("collectDiagnostics — sanitizeSourceLabel allowlist (security Must-fix)", () => {
  test.each([
    "correct-horse-battery-staple",
    "hunterhunterhunter",
    "deadbeefcafe",
    "aws-secret-do-not-share",
  ])(
    "an unrecognized sourceOf() return value (%s) is replaced by the fixed 'other' marker, never stored verbatim",
    (rawSource) => {
      const schema: M3LConfigSchemaPort = { declaredNames: () => ["apiKey"] };
      const config: M3LConfigSourcePort = { sourceOf: () => rawSource };

      const snapshot = collectDiagnostics({ schema, config });

      expect(snapshot.config).toEqual([{ name: "apiKey", source: "other" }]);
      expect(JSON.stringify(snapshot)).not.toContain(rawSource);
    },
  );

  test.each(["cli", "environment-variable"])(
    "a known source label (%s) is stored verbatim",
    (known) => {
      const schema: M3LConfigSchemaPort = { declaredNames: () => ["apiKey"] };
      const config: M3LConfigSourcePort = { sourceOf: () => known };

      const snapshot = collectDiagnostics({ schema, config });

      expect(snapshot.config).toEqual([{ name: "apiKey", source: known }]);
    },
  );

  test("undefined sourceOf() return stays undefined, never becomes 'other'", () => {
    const schema: M3LConfigSchemaPort = { declaredNames: () => ["apiKey"] };
    const config: M3LConfigSourcePort = { sourceOf: () => undefined };

    const snapshot = collectDiagnostics({ schema, config });

    expect(snapshot.config).toEqual([{ name: "apiKey", source: undefined }]);
  });
});

describe("collectDiagnostics — tryCollectConfig catch: a broken schema vs. no schema wired", () => {
  test("declaredNames() throwing an Error: config is omitted AND a labeled stderr diagnostic fires", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const brokenSchema: M3LConfigSchemaPort = {
      declaredNames: () => {
        throw new Error("schema is broken");
      },
    };

    let snapshot: M3LDiagnosticsSnapshot | undefined;
    expect(() => {
      snapshot = collectDiagnostics({ schema: brokenSchema });
    }).not.toThrow();

    expect(snapshot?.config).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const [written] = stderrSpy.mock.calls[0] ?? [];
    expect(String(written)).toMatch(/^m3l-script: /);
    expect(String(written)).toContain("collectDiagnostics.config");
  });

  test("no schema port at all: config is also omitted, but NOTHING is written to stderr — distinguishable from a broken schema", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const snapshot = collectDiagnostics();

    expect(snapshot.config).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("a non-Error thrown cause is stringified via String(cause) into the diagnostic message", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const schema: M3LConfigSchemaPort = {
      declaredNames: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error cause to exercise describeConfigSchemaFailure's String(cause) fallback
        throw "boom-non-error";
      },
    };

    const snapshot = collectDiagnostics({ schema });

    expect(snapshot.config).toBeUndefined();
    const [written] = stderrSpy.mock.calls[0] ?? [];
    expect(String(written)).toContain("boom-non-error");
  });

  test("a hostile cause whose String() conversion itself throws falls back to the unrepresentable-error message", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const hostileCause = {
      toString(): string {
        throw new Error("cannot stringify");
      },
    };
    const schema: M3LConfigSchemaPort = {
      declaredNames: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error, hostile-toString cause to exercise the innermost catch
        throw hostileCause;
      },
    };

    const snapshot = collectDiagnostics({ schema });

    expect(snapshot.config).toBeUndefined();
    const [written] = stderrSpy.mock.calls[0] ?? [];
    expect(String(written)).toContain("[unrepresentable config schema error]");
  });
});

describe("collectDiagnostics — readSourceOf: a throwing config.sourceOf() degrades to source: undefined", () => {
  test("one throwing sourceOf() call still produces the entry, with source: undefined — tryCollectConfig itself never throws", () => {
    const schema: M3LConfigSchemaPort = {
      declaredNames: () => ["apiKey"],
    };
    const throwingConfig: M3LConfigSourcePort = {
      sourceOf: () => {
        throw new Error("sourceOf blew up");
      },
    };

    const snapshot = collectDiagnostics({ schema, config: throwingConfig });

    expect(snapshot.config).toEqual([{ name: "apiKey", source: undefined }]);
  });
});

describe("collectDiagnostics — environment section: STANDALONE branch and detection-failure omission", () => {
  function fakeExecutionEnvironmentInfo(
    deploymentMode: typeof M3LDeploymentMode.STANDALONE,
  ): M3LExecutionEnvironmentInfo {
    return {
      environmentType: M3LExecutionEnvironmentType.LOCAL_INTERACTIVE,
      isInteractive: true,
      isAWSManaged: false,
      canPromptUser: true,
      canOpenBrowser: true,
      requiresAwsProfile: false,
      credentialSource: M3LCredentialSource.SSO_PROFILE,
      detectionDetails: {
        stdoutIsTTY: true,
        stderrIsTTY: true,
        isCiEnvironment: false,
        hasLambdaTaskRoot: false,
        hasEcsMetadataUri: false,
        hasCodeBuildBuildId: false,
        workspaceMarkerPath: undefined,
      },
      deploymentMode,
      monorepoRoot: undefined,
    };
  }

  test("STANDALONE deploymentMode narrows monorepoRoot to undefined and is captured verbatim on the snapshot", () => {
    vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(
      fakeExecutionEnvironmentInfo(M3LDeploymentMode.STANDALONE),
    );

    const snapshot = collectDiagnostics();

    expect(snapshot.environment?.deploymentMode).toBe(
      M3LDeploymentMode.STANDALONE,
    );
    expect(snapshot.environment?.monorepoRoot).toBeUndefined();
  });

  test("environment section is OMITTED (not partially filled) when detection throws", () => {
    vi.spyOn(M3LExecutionEnvironment, "detect").mockImplementation(() => {
      throw new Error("detection blew up");
    });

    let snapshot: M3LDiagnosticsSnapshot | undefined;
    expect(() => {
      snapshot = collectDiagnostics();
    }).not.toThrow();

    expect(snapshot?.environment).toBeUndefined();
    expect(snapshot !== undefined && "environment" in snapshot).toBe(false);
  });
});

describe("M3LDiagnosticsEnvironment / M3LDiagnosticsSnapshot — type contracts", () => {
  test("the discriminated union narrows monorepoRoot by deploymentMode", () => {
    expectTypeOf<
      Extract<M3LDiagnosticsEnvironment, { deploymentMode: "MONOREPO" }>
    >().toMatchTypeOf<{ readonly monorepoRoot: string }>();
    expectTypeOf<
      Extract<M3LDiagnosticsEnvironment, { deploymentMode: "STANDALONE" }>
    >().toMatchTypeOf<{ readonly monorepoRoot: undefined }>();
  });

  test("M3LDiagnosticsSnapshot carries the documented optional sections", () => {
    expectTypeOf<M3LDiagnosticsSnapshot>().toMatchTypeOf<{
      readonly capturedAt: string;
      readonly packageVersion: string;
      readonly nodeVersion: string;
      readonly platform: string;
      readonly arch: string;
      readonly environment?: M3LDiagnosticsEnvironment;
      readonly correlationId?: string;
      readonly config?: readonly M3LConfigFingerprintEntry[];
    }>();
  });
});

describe("core/diagnostics ZONE B — no import of core/script", () => {
  function findDiagnosticsDir(): string {
    const testDir = dirname(fileURLToPath(import.meta.url));
    return join(testDir, "..", "src", "core", "diagnostics");
  }

  function listTsFiles(dir: string): string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  test("no file under src/core/diagnostics/** imports core/script (internal/script is permitted)", () => {
    const files = listTsFiles(findDiagnosticsDir());
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      // ADR-0009 Zone B forbids core/* -> core/script only. From a file in
      // src/core/diagnostics/, that import would appear as the relative
      // form "../script/..." (sibling core submodule), not as
      // "../../internal/script/...".
      expect(content).not.toMatch(/from\s+["']\.\.\/script\//);
      expect(content).not.toMatch(/from\s+["'].*\bcore\/script\//);
    }

    // Positive assertion: src/core/diagnostics/run-report.ts legitimately
    // imports the best-effort stderr fallback from internal/script — this
    // import is NOT zone-restricted and must remain permitted.
    const runReportContent = readFileSync(
      join(findDiagnosticsDir(), "run-report.ts"),
      "utf8",
    );
    expect(runReportContent).toMatch(
      /from\s+["']\.\.\/\.\.\/internal\/script\/diagnostics\.js["']/,
    );
  });
});

// =============================================================================
// M3LRunReporter
// =============================================================================
describe("M3LRunReporter.resolveReportPath()", () => {
  const startedAt = new Date("2026-07-23T10:20:30.123Z");

  test("joins outputDir/sanitized-ISO/fileName, replacing every ':' with '-'", () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => "/out" },
    });
    const reportPath = reporter.resolveReportPath(startedAt);
    expect(reportPath).toBe(
      join("/out", "2026-07-23T10-20-30.123Z", "run-report.json"),
    );
    expect(reportPath).not.toContain(":");
  });

  test("a custom fileName is honored", () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => "/out" },
      fileName: "custom-report.json",
    });
    expect(reporter.resolveReportPath(startedAt)).toBe(
      join("/out", "2026-07-23T10-20-30.123Z", "custom-report.json"),
    );
  });

  test("with no injected paths port, the output directory is resolved lazily (never captured at construction time)", () => {
    const reporter = new M3LRunReporter();
    vi.stubEnv("M3L_OUTPUT_DIR", "/env-configured-output");
    const reportPath = reporter.resolveReportPath(startedAt);
    expect(reportPath.startsWith("/env-configured-output")).toBe(true);
  });
});

describe("M3LRunReporter.build()", () => {
  const baseInput = {
    script: { name: "test-script", version: "1.0.0" },
    correlationId: "corr-1",
    startedAt: new Date("2026-07-23T10:20:30.123Z"),
  };

  test("success outcome omits `failure` even when input.error is supplied", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      error: new Error("should be ignored"),
    });
    expect(report.failure).toBeUndefined();
    expect(report.exitCode).toBe(0);
  });

  test.each(["dry-run", "interrupted"] as const)(
    "%s outcome also omits `failure` even when input.error is supplied",
    (outcome) => {
      const reporter = new M3LRunReporter();
      const report = reporter.build({
        ...baseInput,
        outcome,
        error: new Error("should be ignored"),
      });
      expect(report.failure).toBeUndefined();
    },
  );

  test("failure outcome with no error still emits failure with chain: [] and stage 'unknown'", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "failure",
    });
    expect(report.failure).toEqual({ stage: "unknown", chain: [] });
  });

  test("failure outcome with a stage and an error chain populates both, as a FLAT array", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "failure",
      stage: "mainFn",
      error: new Error("boom", { cause: new Error("root cause") }),
    });

    expect(report.failure?.stage).toBe("mainFn");
    expect(Array.isArray(report.failure?.chain)).toBe(true);
    expect(report.failure?.chain.length).toBeGreaterThan(0);
    for (const link of report.failure?.chain ?? []) {
      expect(Array.isArray(link)).toBe(false);
    }
  });

  test("exitCode: an explicit input.exitCode always wins over the outcome default", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      exitCode: 42,
    });
    expect(report.exitCode).toBe(42);
  });

  test("exitCode: failure defaults to mapErrorToExitCode(input.error)", () => {
    const reporter = new M3LRunReporter();
    const error = new Error("boom");
    const report = reporter.build({
      ...baseInput,
      outcome: "failure",
      error,
    });
    expect(report.exitCode).toBe(mapErrorToExitCode(error));
  });

  test.each(["success", "dry-run"] as const)(
    "exitCode: %s outcome defaults to 0",
    (outcome) => {
      const reporter = new M3LRunReporter();
      const report = reporter.build({
        ...baseInput,
        outcome,
      });
      expect(report.exitCode).toBe(0);
    },
  );

  test("finishedAt defaults to now; both timestamps serialize as ISO strings even from Date inputs", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
    });
    expect(new Date(report.startedAt).toISOString()).toBe(report.startedAt);
    expect(new Date(report.finishedAt).toISOString()).toBe(report.finishedAt);
  });

  test("environment defaults to collectDiagnostics(); timeline defaults to []", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
    });
    expect(report.timeline).toEqual([]);
    expect(report.environment.nodeVersion).toBe(process.version);
  });

  // Re-pointed off `archive` onto `timeline`: `archive` is now projected to
  // the documented M3LFileCopyReport shape (see the "archive projection"
  // describe below), so an arbitrary `{ apiKey, ok }` shape no longer reaches
  // sanitizeValue at all — it is dropped by the projection before redaction
  // ever runs. `timeline` still accepts arbitrary data and exercises the
  // exact same sanitizeValue pipeline.
  test("timeline breadcrumb payload passes through redactSensitiveLogValue before landing in the report", () => {
    const reporter = new M3LRunReporter();
    const breadcrumb: M3LBreadcrumb = {
      timestamp: new Date().toISOString(),
      source: "test",
      event: "custom:event",
      payload: { apiKey: "sk-secret", ok: true },
    };
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      timeline: [breadcrumb],
    });
    expect(JSON.stringify(report.timeline)).not.toContain("sk-secret");
    expect(report.timeline[0]?.payload).toMatchObject({ ok: true });
  });

  test("never throws for hostile input: null error, circular archive, hostile-getter error", () => {
    const reporter = new M3LRunReporter();

    expect(() =>
      reporter.build({
        ...baseInput,
        outcome: "failure",
        error: null,
      }),
    ).not.toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      reporter.build({
        ...baseInput,
        outcome: "success",
        archive: circular,
      }),
    ).not.toThrow();

    const hostileError: Record<string, unknown> = {};
    Object.defineProperty(hostileError, "message", {
      get(): string {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });
    expect(() =>
      reporter.build({
        ...baseInput,
        outcome: "failure",
        error: hostileError,
      }),
    ).not.toThrow();
  });

  test("full JSON round trip — a fully-populated success report", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      finishedAt: new Date("2026-07-23T10:21:00.000Z"),
      outcome: "success",
      // A real M3LFileCopyReport-shaped summary — an arbitrary `{ copied: 2 }`
      // no longer projects to anything (dropped), which would leave `archive`
      // absent from the round trip and no longer exercise this field at all.
      archive: {
        summary: {
          totalRegistered: 3,
          copied: 2,
          skipped: 1,
          skippedByReason: { "already-exists": 1 },
          totalBytesCopied: 2048,
        },
      },
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.archive).toMatchObject({ summary: { copied: 2 } });
  });

  test("full JSON round trip — a fully-populated failure report", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      finishedAt: new Date("2026-07-23T10:21:00.000Z"),
      outcome: "failure",
      stage: "mainFn",
      error: new Error("boom"),
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  test("never throws for a bogus (non-literal) outcome: falls back to exitCode 1 (UNCLASSIFIED)", () => {
    const reporter = new M3LRunReporter();
    const bogusOutcome = "not-a-real-outcome" as M3LRunOutcome;
    let report: M3LRunReport | undefined;
    expect(() => {
      report = reporter.build({ ...baseInput, outcome: bogusOutcome });
    }).not.toThrow();
    expect(report?.exitCode).toBe(1);
  });
});

describe("M3LRunReporter.write()", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-out-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  test("creates the directory recursively, writes pretty (2-space) JSON + trailing newline, and round-trips", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const report = reporter.build({
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
    });

    const writtenPath = await reporter.write(report);
    expect(writtenPath.startsWith(outDir)).toBe(true);

    const raw = await readFile(writtenPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(JSON.parse(raw)).toEqual(report);
  });

  test("the destination directory is named by startedAt, not finishedAt", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const report = reporter.build({
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      finishedAt: new Date("2026-07-23T11:00:00.000Z"),
      outcome: "success",
    });

    const writtenPath = await reporter.write(report);
    expect(writtenPath).toContain("2026-07-23T10-20-30.123Z");
    expect(writtenPath).not.toContain("11-00-00");
  });

  test("write() itself rejects with M3LPathResolutionError when the destination cannot be created (parent path is a regular file)", async () => {
    const parentIsFile = join(outDir, "blocker-file");
    await writeFile(parentIsFile, "i am a file, not a dir");
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => join(parentIsFile, "out") },
    });
    const report = reporter.build({
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
    });

    await expect(reporter.write(report)).rejects.toThrow();
  });
});

// =============================================================================
// M3LRunReporter — path containment (security Must-fix): a hostile
// `startedAt`-derived segment or a hostile `fileName` must be rejected by
// `isSafeRelativeSegment` + the resolved-path containment assertion, and
// nothing is ever written outside the output directory.
// =============================================================================
describe("M3LRunReporter — path containment (security Must-fix)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-containment-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function buildReportWithStartedAt(startedAt: string): M3LRunReport {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt,
      finishedAt: "2026-07-23T10:21:00.000Z",
      exitCode: 0,
      environment: collectDiagnostics(),
      timeline: [],
      outcome: "success",
    };
  }

  test.each(["../../../../tmp/evil", "2026-07-23T10:00:00.000Z/../../../etc"])(
    "write() rejects a hostile startedAt-derived segment (%s) with M3LPathResolutionError",
    async (startedAt) => {
      const reporter = new M3LRunReporter({
        paths: { getOutputDir: () => outDir },
      });
      const report = buildReportWithStartedAt(startedAt);

      let thrown: unknown;
      try {
        await reporter.write(report);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LPathResolutionError);
    },
  );

  test("write() rejects a hostile fileName with M3LPathResolutionError", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
      fileName: "../../../../etc/x.json",
    });
    const report = buildReportWithStartedAt("2026-07-23T10:20:30.123Z");

    let thrown: unknown;
    try {
      await reporter.write(report);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LPathResolutionError);
  });

  test("a valid startedAt and fileName still write successfully", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const report = buildReportWithStartedAt("2026-07-23T10:20:30.123Z");

    const writtenPath = await reporter.write(report);
    expect(writtenPath.startsWith(outDir)).toBe(true);
  });

  test("CRITICAL: persist() never rejects on a hostile fileName — resolves undefined and routes to the stderr diagnostic", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const hostileReporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
      fileName: "../../../../etc/x.json",
    });

    await expect(
      hostileReporter.persist({
        script: { name: "test-script", version: "1.0.0" },
        correlationId: "corr-1",
        startedAt: new Date("2026-07-23T10:20:30.123Z"),
        outcome: "success",
      }),
    ).resolves.toBeUndefined();

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("m3l-script: ");
  });

  test("CRITICAL: persist() never rejects on a hostile startedAt-derived segment — resolves undefined, never throws synchronously", async () => {
    // M3LRunReportInput.startedAt is typed as `Date`; a structurally-Date-like
    // object whose `toISOString()` returns an attacker-controlled string is
    // the only way to drive the hostile-segment path through the public
    // persist() API (real Date#toISOString cannot itself emit "../"). This
    // exercises the exact validation persist() must swallow, not just the
    // fileName variant above.
    const hostileStartedAt = { toISOString: () => "../../../../tmp/evil" };
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });

    await expect(
      reporter.persist({
        script: { name: "test-script", version: "1.0.0" },
        correlationId: "corr-1",
        startedAt: hostileStartedAt as Date,
        outcome: "success",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("M3LRunReporter.persist() — the failure path always attempts a write, never rejects, never shadows", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-persist-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function baseReportInput(
    overrides: Partial<M3LRunReportInput> = {},
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  test("resolves to undefined (never rejects) when the write fails (parent path is a regular file -> ENOTDIR)", async () => {
    const parentIsFile = join(outDir, "not-a-directory");
    await writeFile(parentIsFile, "i am a file, not a dir");
    const impossibleOutDir = join(parentIsFile, "output");
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => impossibleOutDir },
    });

    await expect(reporter.persist(baseReportInput())).resolves.toBeUndefined();
  });

  test("resolves to undefined when the paths port itself throws", async () => {
    const reporter = new M3LRunReporter({
      paths: {
        getOutputDir: () => {
          throw new Error("no output dir");
        },
      },
    });
    await expect(reporter.persist(baseReportInput())).resolves.toBeUndefined();
  });

  // NOTE: this used to assert persist() resolves undefined for a BigInt-bearing
  // archive — that expectation encoded the PRE-FIX bug ordering (redaction ran
  // BEFORE the cycle/depth-breaking pre-pass, so a raw BigInt survived
  // sanitizeValue untouched and only blew up later inside write()'s
  // JSON.stringify, which persist() then swallowed). sanitizeValue now runs
  // JSON.parse(safeJsonStringify(value)) FIRST, which normalizes a BigInt to
  // its string form before redaction ever sees it — so persistence now
  // SUCCEEDS. Do not restore the old "resolves undefined" expectation.
  //
  // Re-pointed off `archive` onto `environment`: `archive` is now projected
  // to the documented M3LFileCopyReport shape, so a `{ big: 1n }` payload no
  // longer reaches sanitizeValue at all (dropped by the projection).
  // `environment` still accepts arbitrary data (via the same `as
  // M3LDiagnosticsSnapshot` escape hatch the round-4 presigned-URL test
  // already uses) and exercises the exact same sanitizeValue pipeline.
  // `timeline`'s `payload` cannot be used here instead — it is typed to
  // scalar-only values (`M3LBreadcrumbScalar`), which a raw BigInt fails.
  test("a BigInt riding the environment is normalized to its string form, so persist() resolves the written path", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const environment = {
      ...collectDiagnostics(),
      big: 1n,
    } as unknown as M3LDiagnosticsSnapshot;

    const writtenPath = await reporter.persist(
      baseReportInput({ environment }),
    );

    expect(writtenPath).toBeDefined();
    const raw = await readFile(writtenPath as string, "utf8");
    const parsed = JSON.parse(raw) as { environment?: { big?: unknown } };
    expect(parsed.environment?.big).toBe("1");
  });

  test("on write failure, emits a best-effort stderr diagnostic starting 'm3l-script: '", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const parentIsFile = join(outDir, "blocker-file");
    await writeFile(parentIsFile, "x");
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => join(parentIsFile, "out") },
    });

    await reporter.persist(baseReportInput());

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("m3l-script: ");
  });

  test("a failing stderr write during the failure-diagnostic path is itself swallowed", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("stderr is broken");
    });
    const parentIsFile = join(outDir, "blocker-file-2");
    await writeFile(parentIsFile, "x");
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => join(parentIsFile, "out") },
    });

    await expect(reporter.persist(baseReportInput())).resolves.toBeUndefined();
  });

  test("never shadows the original error: the re-thrown value is the exact original, even when persistence fails", async () => {
    const parentIsFile = join(outDir, "blocker-file-3");
    await writeFile(parentIsFile, "x");
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => join(parentIsFile, "out") },
    });
    const original = new Error("the real failure");

    let thrown: unknown;
    try {
      try {
        throw original;
      } catch (caught) {
        await reporter.persist(
          baseReportInput({ outcome: "failure", error: caught }),
        );
        throw caught;
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
  });
});

// =============================================================================
// M3LRunReporter — sanitizeValue security regressions (security Must-fix):
// the cycle/depth-breaking pre-pass now runs BEFORE redaction (never the
// reverse), so neither a cyclic value nor an own-property `toJSON` can ride
// past `redactSensitiveLogValue` on its way into the persisted report. Every
// case here asserts the SECRET STRING is absent from the actual written file,
// not merely that persist() didn't throw.
// =============================================================================
describe("M3LRunReporter — sanitizeValue security regressions (security Must-fix)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-sanitize-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  test.each(["archive", "environment", "timeline"] as const)(
    "a cyclic %s value does not bypass redaction — the secret never lands in the written report",
    async (field) => {
      const cyclic: Record<string, unknown> = { apiKey: "sk-live-CIRCSECRET" };
      cyclic.self = cyclic;
      const input = reportInputWith({ [field]: cyclic });

      const raw = await persistAndReadBack(input);
      expect(raw).not.toContain("sk-live-CIRCSECRET");
    },
  );

  test("a very deep (~20k) acyclic archive graph does not bypass redaction either", async () => {
    let deep: Record<string, unknown> = { apiKey: "sk-live-DEEPSECRET" };
    for (let level = 0; level < 20_000; level += 1) {
      deep = { nested: deep };
    }

    const raw = await persistAndReadBack(reportInputWith({ archive: deep }));
    expect(raw).not.toContain("sk-live-DEEPSECRET");
  });

  test("an own-property toJSON returning secrets does not bypass redaction", async () => {
    const archive = {
      creds: {
        toJSON: () => ({ apiKey: "sk-live-BYPASSED", password: "hunter2" }),
      },
    };

    const raw = await persistAndReadBack(reportInputWith({ archive }));
    expect(raw).not.toContain("sk-live-BYPASSED");
    expect(raw).not.toContain("hunter2");
  });

  test("a raw credential-bearing URL embedded in a failure's error message/context never lands in the written report", async () => {
    const RAW =
      "https://svc-user:hunter2SUPERPASS@api.example.com/v1/data?X-Amz-Signature=DEADBEEFSIGSECRET&sig=OTHERSECRET";
    const error = new M3LError(`request to ${RAW} failed`, {
      code: "ERR_CONFIG_MISSING",
      context: { url: RAW },
    });

    const raw = await persistAndReadBack(
      reportInputWith({ outcome: "failure", stage: "mainFn", error }),
    );
    expect(raw).not.toContain("hunter2SUPERPASS");
    expect(raw).not.toContain("DEADBEEFSIGSECRET");
    expect(raw).not.toContain("OTHERSECRET");
    expect(raw).toContain("https://api.example.com/v1/data");
  });
});

// =============================================================================
// M3LRunReporter — symlink containment (security Should-fix): `write()`
// realpath-resolves before writing, so a pre-existing symlink planted at the
// timestamp-directory component of the destination path cannot redirect the
// write outside the output directory.
// =============================================================================
describe("M3LRunReporter — symlink containment (security Should-fix)", () => {
  let outDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-symlink-out-"));
    outsideDir = await mkdtemp(
      join(tmpdir(), "m3l-run-report-symlink-outside-"),
    );
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  test("write() rejects when the timestamp directory is a symlink pointing outside the output dir, and nothing lands outside", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const report = reporter.build({
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
    });
    const timestampSegment = report.startedAt.replaceAll(":", "-");
    const linkPath = join(outDir, timestampSegment);

    try {
      await symlink(outsideDir, linkPath, "dir");
    } catch {
      // Symlink creation itself is unsupported/unprivileged on this platform
      // (e.g. Windows without developer mode) — skip gracefully rather than
      // failing on an environment limitation unrelated to the guard under test.
      return;
    }

    let thrown: unknown;
    try {
      await reporter.write(report);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LPathResolutionError);

    const outsideEntries = await readdir(outsideDir);
    expect(outsideEntries).toHaveLength(0);
  });
});

// =============================================================================
// STAGE-9 regression — M3LFileCopier still archives flat, unaffected by the
// run-report's own timestamped directory (M3LRunReporter creates its OWN
// timestamped subdir; archival must not change).
// =============================================================================
describe("STAGE-9 regression: M3LFileCopier still writes flat to <outputDir>/inputs and <outputDir>/configs", () => {
  let sourceDir: string;
  let outDir: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), "m3l-stage9-src-"));
    outDir = await mkdtemp(join(tmpdir(), "m3l-stage9-out-"));
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  test("input/config files land directly under outDir/inputs and outDir/configs", async () => {
    const inputFile = join(sourceDir, "source.csv");
    const configFile = join(sourceDir, "config.yaml");
    await writeFile(inputFile, "id,value\n1,1\n");
    await writeFile(configFile, "key: value\n");

    const copier = new M3LFileCopier({ paths: { getOutputDir: () => outDir } });
    copier.registerFile(inputFile, { subdir: "inputs" });
    copier.registerFile(configFile, { subdir: "configs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]?.destination).toBe(
      join(outDir, "inputs", "source.csv"),
    );
    expect(report.results[1]?.destination).toBe(
      join(outDir, "configs", "config.yaml"),
    );
  });
});

// =============================================================================
// M3LRunReporter — round-3 security fix regressions (lock-in). Every case
// asserts the SECRET STRING is absent from the actual WRITTEN report file
// read back from disk — never merely that persist()/build() didn't throw.
// =============================================================================
describe("M3LRunReporter — round-3 security fix regressions (lock-in, must not regress)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-round3-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  /**
   * Wraps `field` in a valid `M3LDiagnosticsSnapshot` for use as
   * `input.environment` — the escape hatch this describe block's tests use
   * to carry arbitrary (non-scalar) data through sanitizeValue, mirroring
   * the round-4 presigned-URL-in-environment test's own cast pattern.
   */
  function environmentWith(
    field: Record<string, unknown>,
  ): M3LDiagnosticsSnapshot {
    return {
      ...collectDiagnostics(),
      ...field,
    };
  }

  // (a) REGRESSION LOCK: a Set used to be dropped entirely by
  // `redactSensitiveLogValue` (returning `{}` for a bare Set); an
  // intermediate fix then turned it into a raw array of its bare members —
  // which defeats key-based redaction outright, since a Set's elements carry
  // no key name for `isSensitiveKey` to inspect. Do NOT "simplify"
  // `describeSetCardinality` back into `[...set]` — that reintroduces this
  // exact leak.
  //
  // Re-pointed off `archive` onto `environment`: `archive` is now projected
  // to the documented M3LFileCopyReport shape (see the "archive projection"
  // describe below) and a `{ s: Set }` shape does not conform, so it would be
  // dropped before ever reaching sanitizeValue — `environment` exercises the
  // same sanitizeValue pipeline without that projection.
  test("a Set's raw contents never reach the written report; only a non-reversible cardinality marker does", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        environment: environmentWith({ s: new Set(["sk-SET"]) }),
      }),
    );
    expect(raw).not.toContain("sk-SET");
    expect(raw).toContain("[set: 1 item]");
  });

  test("a nested Set several levels deep is also reduced to a cardinality marker, never leaked", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        environment: environmentWith({ a: { b: new Set(["sk-NEST"]) } }),
      }),
    );
    expect(raw).not.toContain("sk-NEST");
    expect(raw).toContain("[set: 1 item]");
  });

  // (b) Sibling fix: a Map must still be redacted BY KEY — converted to a
  // plain Record first, so `apiKey` is a real object key
  // `redactSensitiveLogValue` can recognize, not an element of a
  // `[key, value]` pair array. Guards against re-breaking this alongside (a).
  //
  // Re-pointed off `archive` onto `environment` for the same projection
  // reason as (a).
  test("a Map's sensitive key is still redacted by name; the secret value never reaches the report", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        environment: environmentWith({ s: new Map([["apiKey", "sk-MAP"]]) }),
      }),
    );
    expect(raw).not.toContain("sk-MAP");
    const parsed = JSON.parse(raw) as {
      environment?: { s?: { apiKey?: string } };
    };
    expect(parsed.environment?.s?.apiKey).toBe("[REDACTED]");
  });

  // (c) Cyclic value: sanitizeValue's cycle-breaking pre-pass must run
  // BEFORE redaction, never the reverse — otherwise redaction throws on the
  // cycle and the fallback path emits no redaction at all.
  //
  // Re-pointed off `archive` onto `environment`: a cyclic `{ apiKey, self }`
  // shape does not conform to the projected M3LFileCopyReport shape either,
  // so it would be dropped before reaching sanitizeValue — trivially "safe"
  // for the wrong reason. `environment` still exercises the real
  // cycle-breaking pre-pass this test locks in.
  test("a cyclic environment value never leaks its secret into the written report", async () => {
    const cyclic: Record<string, unknown> = { apiKey: "sk-CYC" };
    cyclic.self = cyclic;
    const raw = await persistAndReadBack(
      reportInputWith({ environment: environmentWith(cyclic) }),
    );
    expect(raw).not.toContain("sk-CYC");
  });

  // (d) `safeJsonStringify` does NOT invoke `toJSON` — an earlier TSDoc
  // claimed it did, and that claim was wrong. `sanitizeValue`'s own
  // `normalizeForRedaction` pre-pass is what invokes an object's own
  // `toJSON()` (guarded against a throwing implementation), ahead of
  // enumerating its properties, so a class using `toJSON` as its redaction
  // boundary is respected rather than bypassed.
  //
  // Re-pointed off `archive` onto `environment` for the same projection
  // reason as (a)/(c).
  test("an own-property toJSON returning a secret does not bypass redaction", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        environment: environmentWith({
          c: { toJSON: () => ({ apiKey: "sk-TJ" }) },
        }),
      }),
    );
    expect(raw).not.toContain("sk-TJ");
  });

  // (e) `URL_PATTERN` previously matched only the lowercase `https?://`
  // prefix, letting an uppercase-scheme URL (and any userinfo/query
  // credential riding it) through unscrubbed. It now carries the `i` flag.
  test.each(["HTTPS://", "HtTpS://"])(
    "a %s-scheme credential-bearing URL is scrubbed from the failure message and context.url",
    async (scheme) => {
      const rawUrl = `${scheme}AKIA:wJalr-SEC@api.example.com/d?X-Amz-Signature=SIGSEC`;
      const error = new M3LError(`request to ${rawUrl} failed`, {
        code: "ERR_CONFIG_MISSING",
        context: { url: rawUrl },
      });
      const raw = await persistAndReadBack(
        reportInputWith({ outcome: "failure", stage: "mainFn", error }),
      );
      expect(raw).not.toContain("wJalr-SEC");
      expect(raw).not.toContain("SIGSEC");
    },
  );

  // (f) `error.name` can itself carry a credential-bearing URL (a hostile or
  // buggy caller assigning `error.name` directly) — it must be scrubbed the
  // same way `message`/`stack`/`context` already are.
  test("a credential-bearing error.name is scrubbed in failure.chain[].name", async () => {
    const error = new Error("boom");
    error.name = "https://u:pNAMESEC@h/p";
    const raw = await persistAndReadBack(
      reportInputWith({ outcome: "failure", stage: "mainFn", error }),
    );
    expect(raw).not.toContain("pNAMESEC");
  });

  // (g) The scrubber used to consume the `token=` anchor when the value was
  // immediately followed by a quote/angle-bracket, stranding the value
  // outside the match with no `key=` prefix left for the name-based
  // redactor to recognize it by.
  test.each([
    'GET https://h/p?token="QSEC" d',
    "GET https://h/p?token=<QSEC> d",
    "GET https://h/p?token=QSEC d",
  ])(
    "a stranded key= value (%s) is still redacted, not left dangling outside the match",
    async (rawMessage) => {
      const error = new M3LError(rawMessage, {
        code: "ERR_CONFIG_MISSING",
        context: { detail: rawMessage },
      });
      const raw = await persistAndReadBack(
        reportInputWith({ outcome: "failure", stage: "mainFn", error }),
      );
      expect(raw).not.toContain("QSEC");
    },
  );
});

// =============================================================================
// M3LRunReporter — dangling-symlink leaf containment (round-3 security fix):
// a pre-existing directory-entry at the exact report leaf path — including a
// DANGLING symlink pointing outside the output dir, which `realpath` cannot
// distinguish from "not yet created" — must never be followed. The
// exclusive-create ("wx") flag closes this gap directly.
// =============================================================================
describe("M3LRunReporter — dangling-symlink leaf containment (round-3 security fix)", () => {
  let outDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-dangling-out-"));
    outsideDir = await mkdtemp(
      join(tmpdir(), "m3l-run-report-dangling-outside-"),
    );
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  test("write() rejects when the report leaf is a pre-existing dangling symlink; nothing lands outside; persist() resolves undefined", async () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const report = reporter.build({
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
    });
    const timestampSegment = report.startedAt.replaceAll(":", "-");
    const timestampDir = join(outDir, timestampSegment);
    await mkdir(timestampDir, { recursive: true });
    const danglingTarget = join(outsideDir, "never-created.json");
    const leafPath = join(timestampDir, "run-report.json");

    try {
      await symlink(danglingTarget, leafPath, "file");
    } catch {
      // Symlink creation itself is unsupported/unprivileged on this platform
      // (e.g. Windows without developer mode) — skip gracefully rather than
      // failing on an environment limitation unrelated to the guard under test.
      return;
    }

    await expect(reporter.write(report)).rejects.toThrow();

    const outsideEntries = await readdir(outsideDir);
    expect(outsideEntries).toHaveLength(0);

    await expect(
      reporter.persist({
        script: { name: "test-script", version: "1.0.0" },
        correlationId: "corr-1",
        startedAt: new Date("2026-07-23T10:20:30.123Z"),
        outcome: "success",
      }),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// M3LRunReporter — closing remaining branch coverage (Part 2): every
// defensive path added across three rounds of security fixes, each traced
// back to a specific uncovered line/branch in coverage-final.json.
// =============================================================================
describe("M3LRunReporter — closing remaining branch coverage", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-coverage-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  // bestEffortRealpath's walk-up-to-filesystem-root fallback: when `realpath`
  // rejects all the way up to "/", `dirname("/") === "/"` and the walk
  // returns the original, unresolved candidate path rather than throwing.
  test("write() still succeeds when realpath rejects for every ancestor (walks up to the filesystem root, then falls back)", async () => {
    const realpathSpy = vi
      .spyOn(nodeFsPromises, "realpath")
      .mockRejectedValue(new Error("realpath unavailable"));

    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const report = reporter.build({
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
    });

    const writtenPath = await reporter.write(report);
    expect(writtenPath.startsWith(outDir)).toBe(true);

    realpathSpy.mockRestore();
  });

  /**
   * Wraps `field` in a valid `M3LDiagnosticsSnapshot` for use as
   * `input.environment` — see the identical helper's TSDoc in the round-3
   * describe block above for why `environment` (not `archive`) is the
   * vehicle for these sanitizeValue-internals tests.
   */
  function environmentWith(
    field: Record<string, unknown>,
  ): M3LDiagnosticsSnapshot {
    return {
      ...collectDiagnostics(),
      ...field,
    };
  }

  // normalizePlainObject: a dangerous key (`__proto__`) on a plain object
  // must be dropped, not bracket-assigned onto the sanitized clone (which
  // would mutate its prototype instead of adding a data property).
  //
  // Re-pointed off `archive` onto `environment`: `archive` is now projected
  // to the documented M3LFileCopyReport shape, so a bare `{ ok: true }`
  // payload does not conform and would be dropped before normalizePlainObject
  // ever runs on it.
  test("a dangerous __proto__ key on a plain object is dropped, sibling data still redacts normally", async () => {
    const field: Record<string, unknown> = { ok: true };
    Object.defineProperty(field, "__proto__", {
      value: "sk-PROTO",
      enumerable: true,
      configurable: true,
    });
    const raw = await persistAndReadBack(
      reportInputWith({ environment: environmentWith(field) }),
    );
    expect(raw).not.toContain("sk-PROTO");
    const parsed = JSON.parse(raw) as { environment?: { ok?: boolean } };
    expect(parsed.environment?.ok).toBe(true);
  });

  // normalizeMapEntries: a non-string key has no representable key name (so
  // the entry is dropped rather than leaking through a pair-array fallback),
  // and a dangerous string key (`__proto__`) is dropped for the same
  // prototype-pollution reason as the plain-object case above.
  //
  // Re-pointed off `archive` onto `environment` for the same projection
  // reason as the previous test.
  test("a Map with a non-string key and a dangerous string key drops both, keeping the normal entry", async () => {
    const field = {
      m: new Map<unknown, unknown>([
        ["apiKey", "sk-MAPKEY"],
        [42, "dropped-numeric-key"],
        ["__proto__", "dropped-dangerous-key"],
      ]),
    };
    const raw = await persistAndReadBack(
      reportInputWith({ environment: environmentWith(field) }),
    );
    expect(raw).not.toContain("sk-MAPKEY");
    expect(raw).not.toContain("dropped-numeric-key");
    expect(raw).not.toContain("dropped-dangerous-key");
    const parsed = JSON.parse(raw) as {
      environment?: { m?: Record<string, unknown> };
    };
    expect(parsed.environment?.m).toEqual({ apiKey: "[REDACTED]" });
  });

  // scalarToRedactable: symbol (with/without a description)/function/
  // undefined/null leaves, plus a non-empty array walked element-by-element
  // (the array .map() callback itself, not just the empty-array default).
  //
  // Re-pointed off `archive` onto `environment` for the same projection
  // reason as the previous two tests.
  test("symbol/function/undefined/null leaves normalize safely, and a non-empty array is walked element-by-element", async () => {
    const field = {
      sym: Symbol("hasDescription"),
      bareSym: Symbol(),
      fn: (): string => "unreachable",
      undef: undefined,
      nil: null,
      tags: ["keep-one", "keep-two"],
    };
    const raw = await persistAndReadBack(
      reportInputWith({ environment: environmentWith(field) }),
    );
    const parsed = JSON.parse(raw) as {
      environment?: {
        sym?: string;
        bareSym?: string;
        fn?: string;
        undef?: unknown;
        nil?: unknown;
        tags?: string[];
      };
    };
    expect(parsed.environment?.sym).toBe("hasDescription");
    expect(parsed.environment?.bareSym).toBe("");
    expect(parsed.environment?.fn).toBe("");
    expect(parsed.environment?.undef).toBeNull();
    expect(parsed.environment?.nil).toBeNull();
    expect(parsed.environment?.tags).toEqual(["keep-one", "keep-two"]);
  });

  // safeToISOString: a hostile Date-like whose toISOString() throws falls
  // back to the Unix epoch rather than propagating.
  test("safeToISOString falls back to the Unix epoch when Date#toISOString throws", () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const hostileDate = {
      toISOString: (): string => {
        throw new Error("hostile toISOString");
      },
    };
    let report: M3LRunReport | undefined;
    expect(() => {
      report = reporter.build({
        script: { name: "test-script", version: "1.0.0" },
        correlationId: "corr-1",
        startedAt: hostileDate as unknown as Date,
        outcome: "success",
      });
    }).not.toThrow();
    expect(report?.startedAt).toBe(new Date(0).toISOString());
  });

  // readInputError: a hostile getter directly on `input.error` itself (not
  // on the error's own message) must be swallowed by build()'s "never
  // throws" contract too.
  test("a hostile getter directly on input.error is swallowed; build() still returns a well-formed failure with an empty chain", () => {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const hostileInput: Record<string, unknown> = {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "failure",
      stage: "mainFn",
    };
    Object.defineProperty(hostileInput, "error", {
      get(): never {
        throw new Error("hostile input.error getter");
      },
      enumerable: true,
    });

    let report: M3LRunReport | undefined;
    expect(() => {
      report = reporter.build(hostileInput as unknown as M3LRunReportInput);
    }).not.toThrow();
    expect(report?.failure).toEqual({ stage: "mainFn", chain: [] });
  });

  // invokeToJSONSafely: a throwing own-property toJSON degrades that node
  // (only) to the unredactable placeholder, without blanking sibling data.
  //
  // Re-pointed off `archive` onto `environment`: `archive` is now projected
  // to the documented M3LFileCopyReport shape, so this shape does not conform
  // and would be dropped before invokeToJSONSafely ever runs on it.
  test("a throwing own-property toJSON degrades that node to the unredactable placeholder, without blanking siblings", async () => {
    const field = {
      ok: true,
      broken: {
        toJSON: (): never => {
          throw new Error("hostile toJSON");
        },
      },
    };
    const raw = await persistAndReadBack(
      reportInputWith({ environment: environmentWith(field) }),
    );
    const parsed = JSON.parse(raw) as {
      environment?: { ok?: boolean; broken?: string };
    };
    expect(parsed.environment?.ok).toBe(true);
    expect(parsed.environment?.broken).toBe("[unredactable value omitted]");
  });

  // sanitizeValue's own outermost catch: a Proxy whose `ownKeys` trap throws
  // makes `Object.keys()` itself throw inside normalizeForRedaction — caught
  // by sanitizeValue, degrading the WHOLE value to the placeholder (not just
  // one field), since the failure happened before any redaction could run.
  //
  // Re-pointed off `archive` onto `environment`: an `archive` shaped this way
  // would be dropped entirely by the projection (never even reaching
  // sanitizeValue), silently defeating this lock-in.
  test("a Proxy with a throwing ownKeys trap degrades the whole sanitizeValue call to the unredactable placeholder", async () => {
    const hostileValue: Record<string, unknown> = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile ownKeys");
        },
      },
    );
    const raw = await persistAndReadBack(
      reportInputWith({
        environment: environmentWith({ hostile: hostileValue }),
      }),
    );
    const parsed = JSON.parse(raw) as { environment?: unknown };
    expect(parsed.environment).toBe("[unredactable value omitted]");
  });

  // buildPersistFailureDiagnostic: a non-Error cause degrades to
  // `{ message: String(cause) }` rather than reading Error-only fields.
  test("a non-Error thrown by the paths port yields a persist-failure diagnostic built from String(cause)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const reporter = new M3LRunReporter({
      paths: {
        getOutputDir: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error cause to exercise buildPersistFailureDiagnostic's String(cause) fallback
          throw "not an Error instance";
        },
      },
    });

    await expect(
      reporter.persist(reportInputWith({})),
    ).resolves.toBeUndefined();

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("not an Error instance");
  });

  // buildPersistFailureDiagnostic: an Error cause whose `stack` is
  // `undefined` omits the `stack` field entirely (never spreads
  // `{ stack: undefined }` into the diagnostic).
  test("an Error cause with stack === undefined omits the stack field from the persist-failure diagnostic", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const causeWithoutStack = new Error("boom-without-a-stack");
    Object.defineProperty(causeWithoutStack, "stack", { value: undefined });
    const reporter = new M3LRunReporter({
      paths: {
        getOutputDir: () => {
          throw causeWithoutStack;
        },
      },
    });

    await expect(
      reporter.persist(reportInputWith({})),
    ).resolves.toBeUndefined();

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("boom-without-a-stack");
    expect(written).not.toContain('"stack"');
  });
});

// =============================================================================
// M3LRunOutcome — type contract
// =============================================================================
describe("M3LRunOutcome — type contract", () => {
  test("is exactly the 4-literal union", () => {
    expectTypeOf<M3LRunOutcome>().toEqualTypeOf<
      "success" | "failure" | "dry-run" | "interrupted"
    >();
  });
});

// =============================================================================
// M3LRunReport — type contract
// =============================================================================
describe("M3LRunReport — type contract", () => {
  test("carries the documented base fields shared by every outcome, including archive and environment", () => {
    expectTypeOf<M3LRunReport>().toMatchTypeOf<{
      readonly script: { readonly name: string; readonly version: string };
      readonly correlationId: string;
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly exitCode: number;
      readonly environment: M3LDiagnosticsSnapshot;
      readonly timeline: readonly M3LBreadcrumb[];
      readonly archive?: unknown;
    }>();
  });

  test("the 'failure' branch requires a fully-shaped M3LRunReportFailure", () => {
    expectTypeOf<
      Extract<M3LRunReport, { outcome: "failure" }>
    >().toMatchTypeOf<{
      readonly outcome: "failure";
      readonly failure: M3LRunReportFailure;
    }>();
  });

  test("every non-failure outcome narrows `failure` to undefined", () => {
    // `Exclude`, not `Extract` on a narrower literal: branch B's `outcome` is
    // itself a 3-member union (`Exclude<M3LRunOutcome, "failure">`), so
    // `Extract<M3LRunReport, { outcome: "success" }>` would fail to match
    // either top-level constituent and silently collapse to `never`.
    expectTypeOf<
      Exclude<M3LRunReport, { outcome: "failure" }>
    >().toMatchTypeOf<{
      readonly outcome: Exclude<M3LRunOutcome, "failure">;
      readonly failure?: undefined;
    }>();
  });

  test("illegal state unrepresentable: outcome 'success' cannot carry a `failure` detail", () => {
    const environment = collectDiagnostics();
    // @ts-expect-error -- outcome "success" narrows `failure` to `undefined`; a real M3LRunReportFailure object is not assignable here
    const illegal: M3LRunReport = {
      script: { name: "s", version: "1.0.0" },
      correlationId: "c",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0,
      environment,
      timeline: [],
      outcome: "success",
      failure: { stage: "x", chain: [] },
    };
    void illegal;
  });

  test("illegal state unrepresentable: outcome 'failure' requires a `failure` detail", () => {
    const environment = collectDiagnostics();
    // @ts-expect-error -- outcome "failure" requires `failure`, which is omitted here
    const illegal: M3LRunReport = {
      script: { name: "s", version: "1.0.0" },
      correlationId: "c",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 1,
      environment,
      timeline: [],
      outcome: "failure",
    };
    void illegal;
  });

  test("narrowing on report.outcome === 'failure' narrows report.failure to M3LRunReportFailure (not optional)", () => {
    function describeOutcome(report: M3LRunReport): string {
      if (report.outcome === "failure") {
        expectTypeOf(report.failure).toEqualTypeOf<M3LRunReportFailure>();
        return report.failure.stage;
      }
      expectTypeOf(report.failure).toEqualTypeOf<undefined>();
      return "not a failure";
    }
    expect(typeof describeOutcome).toBe("function");
  });
});

// =============================================================================
// M3LRunReporter — round-4 security fix regressions (lock-in). Every case
// asserts the SECRET STRING is absent from the actual WRITTEN report file
// read back from disk — never merely that persist()/build() didn't throw.
// =============================================================================

// -----------------------------------------------------------------------
// (1) Unterminated-quote stranded value: round 3's fix only handled CLOSED
// delimiters (`token="secret" rest`) — an unclosed quote let the URL match
// consume and drop the `key=` anchor while the raw, unterminated value
// survived untouched *outside* the match, unrecognizable to the name-based
// redactor once the anchor was gone.
// -----------------------------------------------------------------------
describe("M3LRunReporter — round-4 (unterminated-quote stranded value, lock-in)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-round4-quote-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  test.each(['"', "'"])(
    "an unterminated %s-quote query value in an error's message AND context is never stranded outside the URL scrub match",
    async (quoteChar) => {
      const rawMessage = `GET https://h/p?token=${quoteChar}QSEC1 failed`;
      const error = new M3LError(rawMessage, {
        code: "ERR_CONFIG_MISSING",
        context: { detail: rawMessage },
      });

      const raw = await persistAndReadBack(
        reportInputWith({ outcome: "failure", stage: "mainFn", error }),
      );
      expect(raw).not.toContain("QSEC1");
    },
  );
});

// -----------------------------------------------------------------------
// (2) Presigned URL must not reach the report: `sanitizeValue` previously ran
// no URL scrub at all while `format-error.ts`'s `redactContext` already did —
// the asymmetry was the bug. `archive`, `timeline`, and `environment` all
// share `sanitizeValue`'s pipeline and must stay in lockstep.
// -----------------------------------------------------------------------
describe("M3LRunReporter — round-4 (presigned URL must not reach the report, lock-in)", () => {
  let outDir: string;

  const PRESIGNED_URL =
    "https://s3.amazonaws.com/bk/obj?X-Amz-Signature=PRESIG&X-Amz-Credential=AKIAEXAMPLE";

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-round4-presign-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  // UPDATED (post-projection): this test still passes, but now for a
  // DIFFERENT reason than when it was written. `archive` is projected to the
  // documented M3LFileCopyReport shape (`{ results, summary }`) before
  // sanitizeValue ever runs — `uploadUrl` is not part of that shape, so the
  // whole `archive` field is DROPPED here, not scrubbed. The secret is absent
  // from the report because the field never survives projection, not because
  // the URL scrub caught it. See the "archive projection" describe below for
  // the case that DOES still exercise the URL scrub post-projection: a
  // presigned URL riding a legitimate `results[].source` field.
  test("archive.uploadUrl: neither PRESIG nor AKIAEXAMPLE reach the written report (now because the field is dropped, not scrubbed)", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({ archive: { uploadUrl: PRESIGNED_URL } }),
    );
    expect(raw).not.toContain("PRESIG");
    expect(raw).not.toContain("AKIAEXAMPLE");
  });

  test("a timeline breadcrumb payload carrying the presigned URL: neither PRESIG nor AKIAEXAMPLE reach the written report", async () => {
    const breadcrumb: M3LBreadcrumb = {
      timestamp: new Date().toISOString(),
      source: "test",
      event: "custom:upload",
      payload: { uploadUrl: PRESIGNED_URL },
    };

    const raw = await persistAndReadBack(
      reportInputWith({ timeline: [breadcrumb] }),
    );
    expect(raw).not.toContain("PRESIG");
    expect(raw).not.toContain("AKIAEXAMPLE");
  });

  test("environment carrying the presigned URL: neither PRESIG nor AKIAEXAMPLE reach the written report", async () => {
    const environment = {
      ...collectDiagnostics(),
      uploadUrl: PRESIGNED_URL,
    } as M3LDiagnosticsSnapshot;

    const raw = await persistAndReadBack(reportInputWith({ environment }));
    expect(raw).not.toContain("PRESIG");
    expect(raw).not.toContain("AKIAEXAMPLE");
  });
});

// -----------------------------------------------------------------------
// (3) Shared (acyclic) subgraph must not OOM: `visited` is now a true
// SEEN-set (never deleted on unwind) rather than a PATH-set, so a perfectly
// acyclic but SHARED subgraph collapses to "[Circular]" the same as a
// genuine cycle instead of being exponentially re-expanded at every
// reference. Before the fix, fan-out 8 x depth 9 exhausted the heap after
// ~24s with an UNCATCHABLE `FATAL ERROR: Ineffective mark-compacts`, which
// killed the process on the very failure path the report exists to
// document.
//
// Re-pointed off `archive` onto `environment`: a fan-out/cyclic object shaped
// like `{ c0: …, c1: … }` (no `results`/`summary`) does not conform to the
// projected M3LFileCopyReport shape, so it would be DROPPED before ever
// reaching sanitizeValue's traversal — silently defeating both locks below
// (the OOM-prevention `visited` SEEN-set logic, and cycle detection, would
// never actually run). `environment` still accepts arbitrary data and
// exercises the real traversal these tests exist to guard.
// -----------------------------------------------------------------------
describe("M3LRunReporter — round-4 (shared acyclic subgraph must not OOM, lock-in)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-round4-shared-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  test("a shared (acyclic) subgraph with fan-out 8 x depth 9 does not exhaust the heap; persist() completes and resolves", async () => {
    let node: Record<string, unknown> = { leaf: "x" };
    for (let depth = 0; depth < 9; depth += 1) {
      const next: Record<string, unknown> = {};
      for (let fanout = 0; fanout < 8; fanout += 1) {
        next[`c${fanout}`] = node;
      }
      node = next;
    }

    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const environment = { ...collectDiagnostics(), node };
    const writtenPath = await reporter.persist(
      reportInputWith({ environment }),
    );
    expect(writtenPath).toBeDefined();
  }, 20_000); // Generous but finite: a regression should time out and fail rather than hang CI indefinitely.

  test("a genuine cycle is still detected (must not have regressed)", async () => {
    const cyclic: Record<string, unknown> = { apiKey: "sk-CYCLE4" };
    cyclic.self = cyclic;

    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const environment = { ...collectDiagnostics(), cyclic };
    const writtenPath = await reporter.persist(
      reportInputWith({ environment }),
    );
    expect(writtenPath).toBeDefined();
    const raw = await readFile(writtenPath as string, "utf8");
    expect(raw).not.toContain("sk-CYCLE4");
  });
});

// -----------------------------------------------------------------------
// (5) describeSetCardinality: a hostile `size` getter (non-integer, negative,
// or otherwise not a genuine cardinality) must never be interpolated
// verbatim into the marker — it degrades to `0` instead.
// -----------------------------------------------------------------------
describe("M3LRunReporter — round-4 (describeSetCardinality hostile size, lock-in)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-round4-setsize-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  // Re-pointed off `archive` onto `environment`: `archive` is now projected
  // to the documented M3LFileCopyReport shape, so a `{ s: Set }` shape does
  // not conform and would be dropped before describeSetCardinality ever runs
  // on it.
  test.each([
    ["1); DROP TABLE x; --", "DROP TABLE"],
    [-5, "-5"],
    [1.7, "1.7"],
    [Number.NaN, "NaN"],
  ] as const)(
    "a Set whose size getter returns the hostile/non-integer value %p degrades to a plain non-negative integer marker, never the injected value",
    async (hostileSize, forbiddenFragment) => {
      const hostileSet = new Set(["sk-SIZE"]);
      Object.defineProperty(hostileSet, "size", {
        get: () => hostileSize,
        configurable: true,
      });

      const reporter = new M3LRunReporter({
        paths: { getOutputDir: () => outDir },
      });
      const environment = {
        ...collectDiagnostics(),
        s: hostileSet,
      };
      const writtenPath = await reporter.persist(
        reportInputWith({ environment }),
      );
      expect(writtenPath).toBeDefined();
      const raw = await readFile(writtenPath as string, "utf8");

      expect(raw).not.toContain("sk-SIZE");
      expect(raw).toMatch(/\[set: \d+ items?\]/);
      expect(raw).not.toContain(String(forbiddenFragment));
    },
  );
});

// =============================================================================
// M3LRunReporter — archive projection (M3LFileCopyReport allowlist): `archive`
// is projected field-by-field to the documented M3LFileCopyReport shape
// (`{ results, summary }`) before ever reaching sanitizeValue — anything not
// part of that shape is DROPPED, not passed through. This closes the largest
// unbounded-input surface on the persisted report (a confirmed leak: a
// presigned S3 URL riding an arbitrary `archive` shape reached disk).
// =============================================================================
describe("M3LRunReporter — archive projection (M3LFileCopyReport allowlist)", () => {
  let outDir: string;

  const PRESIGNED_URL =
    "https://s3.amazonaws.com/bk/obj?X-Amz-Signature=PROJPRESIG&X-Amz-Credential=AKIAPROJEX";

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-archive-proj-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  test("a real M3LFileCopyReport-shaped archive round-trips with its useful fields intact", async () => {
    const validReport = {
      results: [
        {
          skipped: false,
          source: "/src/a.csv",
          destination: "/out/inputs/a.csv",
          size: 1234,
          timestamp: "2026-07-23T10:00:00.000Z",
        },
        {
          skipped: true,
          source: "/src/b.csv",
          destination: "/out/inputs/b.csv",
          reason: "already-exists",
          timestamp: "2026-07-23T10:00:01.000Z",
        },
      ],
      summary: {
        totalRegistered: 2,
        copied: 1,
        skipped: 1,
        skippedByReason: { "already-exists": 1 },
        totalBytesCopied: 1234,
      },
    };

    const raw = await persistAndReadBack(
      reportInputWith({ archive: validReport }),
    );
    const parsed = JSON.parse(raw) as { archive?: unknown };
    expect(parsed.archive).toEqual(validReport);
  });

  test("an arbitrary object unrelated to M3LFileCopyReport is dropped entirely — neither secret reaches the written report", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: { secretBlob: "sk-ARB", nested: { tok: "sk-ARB2" } },
      }),
    );
    expect(raw).not.toContain("sk-ARB");
    expect(raw).not.toContain("sk-ARB2");
    const parsed = JSON.parse(raw) as { archive?: unknown };
    expect(parsed.archive).toBeUndefined();
  });

  test("a presigned URL under a non-conforming top-level key is dropped, not merely scrubbed", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({ archive: { uploadUrl: PRESIGNED_URL } }),
    );
    const parsed = JSON.parse(raw) as { archive?: unknown };
    expect(parsed.archive).toBeUndefined();
    expect(raw).not.toContain("PROJPRESIG");
    expect(raw).not.toContain("AKIAPROJEX");
  });

  test("a results entry with wrong-typed fields is dropped entirely, not passed through partially-typed", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          results: [
            {
              skipped: false,
              source: 123, // wrong type: should be a string
              destination: "/out/a.csv",
              size: "not-a-number", // wrong type: should be a number
              timestamp: "2026-07-23T10:00:00.000Z",
            },
            {
              skipped: false,
              source: "/src/good.csv",
              destination: "/out/good.csv",
              size: 10,
              timestamp: "2026-07-23T10:00:02.000Z",
            },
          ],
        },
      }),
    );
    const parsed = JSON.parse(raw) as {
      archive?: { results?: readonly unknown[] };
    };
    expect(parsed.archive?.results).toHaveLength(1);
    expect(parsed.archive?.results?.[0]).toMatchObject({
      source: "/src/good.csv",
    });
  });

  test("a missing summary and a non-array results are each independently omitted, never fabricated", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({ archive: { results: "not-an-array" } }),
    );
    const parsed = JSON.parse(raw) as { archive?: unknown };
    // `results` fails to project (not an array) and there is no `summary`
    // either, so the whole `archive` field is omitted — never a fabricated
    // `{ results: [] }` shell.
    expect(parsed.archive).toBeUndefined();
  });

  test("an unrecognized skip reason literal is dropped from a skipped result entry, never passed through", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          results: [
            {
              skipped: true,
              source: "/src/c.csv",
              destination: "/out/c.csv",
              reason: "not-a-real-reason",
              timestamp: "2026-07-23T10:00:03.000Z",
            },
          ],
        },
      }),
    );
    const parsed = JSON.parse(raw) as {
      archive?: { results?: readonly unknown[] };
    };
    // The entry fails to project (its `reason` is not one of the four
    // documented literals) and is dropped, leaving an empty `results` array.
    expect(parsed.archive?.results).toEqual([]);
  });

  test("a presigned URL riding a legitimate results[].source field still gets scrubbed after projection", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          results: [
            {
              skipped: false,
              source: PRESIGNED_URL,
              destination: "/out/a.csv",
              size: 10,
              timestamp: "2026-07-23T10:00:00.000Z",
            },
          ],
        },
      }),
    );
    expect(raw).not.toContain("PROJPRESIG");
    expect(raw).not.toContain("AKIAPROJEX");
    const parsed = JSON.parse(raw) as {
      archive?: { results?: ReadonlyArray<{ source?: string }> };
    };
    expect(parsed.archive?.results?.[0]?.source).toBe(
      "https://s3.amazonaws.com/bk/obj",
    );
  });

  test("a non-object results entry (string/number/null) is dropped, keeping only the valid entries", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          results: [
            "not-an-object",
            42,
            null,
            {
              skipped: false,
              source: "/src/good.csv",
              destination: "/out/good.csv",
              size: 5,
              timestamp: "2026-07-23T10:00:04.000Z",
            },
          ],
        },
      }),
    );
    const parsed = JSON.parse(raw) as {
      archive?: { results?: ReadonlyArray<{ source?: string }> };
    };
    expect(parsed.archive?.results).toHaveLength(1);
    expect(parsed.archive?.results?.[0]?.source).toBe("/src/good.csv");
  });

  test("a skipped: false entry with an invalid size (only that field wrong) is dropped entirely", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          results: [
            {
              skipped: false,
              source: "/src/badsize.csv",
              destination: "/out/badsize.csv",
              size: "not-a-number",
              timestamp: "2026-07-23T10:00:05.000Z",
            },
          ],
        },
      }),
    );
    const parsed = JSON.parse(raw) as {
      archive?: { results?: readonly unknown[] };
    };
    expect(parsed.archive?.results).toEqual([]);
  });

  test("a results entry with neither skipped: true nor skipped: false is dropped entirely", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          results: [
            {
              source: "/src/noflag.csv",
              destination: "/out/noflag.csv",
              timestamp: "2026-07-23T10:00:06.000Z",
            },
          ],
        },
      }),
    );
    const parsed = JSON.parse(raw) as {
      archive?: { results?: readonly unknown[] };
    };
    expect(parsed.archive?.results).toEqual([]);
  });

  test("a non-object summary.skippedByReason is omitted, sibling summary fields still project", async () => {
    const raw = await persistAndReadBack(
      reportInputWith({
        archive: {
          summary: {
            totalRegistered: 4,
            copied: 3,
            skipped: 1,
            skippedByReason: "not-an-object",
            totalBytesCopied: 500,
          },
        },
      }),
    );
    const parsed = JSON.parse(raw) as {
      archive?: {
        summary?: { copied?: number; skippedByReason?: unknown };
      };
    };
    expect(parsed.archive?.summary?.copied).toBe(3);
    expect(parsed.archive?.summary?.skippedByReason).toBeUndefined();
  });

  test.each([["a plain string"], [42], [true]] as const)(
    "a non-object archive (%p) is dropped, never throwing",
    async (nonObjectArchive) => {
      const raw = await persistAndReadBack(
        reportInputWith({ archive: nonObjectArchive }),
      );
      const parsed = JSON.parse(raw) as { archive?: unknown };
      expect(parsed.archive).toBeUndefined();
    },
  );

  test("a null archive is dropped, never throwing", async () => {
    const raw = await persistAndReadBack(reportInputWith({ archive: null }));
    const parsed = JSON.parse(raw) as { archive?: unknown };
    expect(parsed.archive).toBeUndefined();
  });
});

// =============================================================================
// M3LRunReporter — object-KEY URL scrubbing (new fix, no coverage yet): a URL
// riding as an object/Map KEY must be scrubbed the same way the identical URL
// riding as a VALUE already is. The key/value asymmetry was the bug —
// `scrubUrlsInSanitizedValue` (run-report.ts) and `scrubUrlsInValue`
// (format-error.ts, for M3LError.context) both scrub keys, but had no
// regression cover proving it. Every case below asserts the SECRET STRING is
// absent from the actual WRITTEN report read back from disk, and the control
// (same URL as a value) is asserted clean too — the asymmetry is only
// meaningful relative to that control.
// =============================================================================
describe("M3LRunReporter — object-KEY URL scrubbing (new fix, no coverage yet)", () => {
  let outDir: string;

  const KEY_URL =
    "https://bkt.s3.amazonaws.com/o?X-Amz-Signature=SIGKEY&X-Amz-Credential=AKIAEX";

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-keyscrub-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function reportInputWith(
    overrides: Partial<M3LRunReportInput>,
  ): M3LRunReportInput {
    return {
      script: { name: "test-script", version: "1.0.0" },
      correlationId: "corr-1",
      startedAt: new Date("2026-07-23T10:20:30.123Z"),
      outcome: "success",
      ...overrides,
    };
  }

  async function persistAndReadBack(input: M3LRunReportInput): Promise<string> {
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });
    const writtenPath = await reporter.persist(input);
    expect(writtenPath).toBeDefined();
    return readFile(writtenPath as string, "utf8");
  }

  test("a URL used as a plain-object key is scrubbed; the identical URL as a value is also clean (control)", async () => {
    const breadcrumb: M3LBreadcrumb = {
      timestamp: new Date().toISOString(),
      source: "test",
      event: "custom:event",
      payload: { [KEY_URL]: "ok", valueControl: KEY_URL },
    };

    const raw = await persistAndReadBack(
      reportInputWith({ timeline: [breadcrumb] }),
    );
    expect(raw).not.toContain("SIGKEY");
    expect(raw).not.toContain("AKIAEX");

    const parsed = JSON.parse(raw) as {
      timeline?: ReadonlyArray<{ payload?: Record<string, unknown> }>;
    };
    const payload = parsed.timeline?.[0]?.payload ?? {};
    expect(Object.keys(payload)).toContain("https://bkt.s3.amazonaws.com/o");
    expect(payload["https://bkt.s3.amazonaws.com/o"]).toBe("ok");
    expect(payload.valueControl).toBe("https://bkt.s3.amazonaws.com/o");
  });

  test("a URL used as a Map key, nested several levels deep, is scrubbed", async () => {
    const nested = {
      level1: {
        level2: {
          level3: new Map([[KEY_URL, "ok"]]),
        },
      },
    };
    const environment = { ...collectDiagnostics(), nested };

    const raw = await persistAndReadBack(reportInputWith({ environment }));
    expect(raw).not.toContain("SIGKEY");
    expect(raw).not.toContain("AKIAEX");

    const parsed = JSON.parse(raw) as {
      environment?: {
        nested?: {
          level1?: { level2?: { level3?: Record<string, unknown> } };
        };
      };
    };
    const level3 = parsed.environment?.nested?.level1?.level2?.level3 ?? {};
    expect(Object.keys(level3)).toContain("https://bkt.s3.amazonaws.com/o");
    expect(level3["https://bkt.s3.amazonaws.com/o"]).toBe("ok");
  });

  test("a URL used as a key in M3LError.context is scrubbed, alongside the identical URL riding as a value (control)", async () => {
    const error = new M3LError("upload failed", {
      code: "ERR_CONFIG_MISSING",
      context: { [KEY_URL]: "ok", valueControl: KEY_URL },
    });
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });

    const writtenPath = await reporter.persist(
      reportInputWith({ outcome: "failure", stage: "mainFn", error }),
    );
    expect(writtenPath).toBeDefined();
    const raw = await readFile(writtenPath as string, "utf8");

    expect(raw).not.toContain("SIGKEY");
    expect(raw).not.toContain("AKIAEX");
    expect(raw).toContain("https://bkt.s3.amazonaws.com/o");
  });
});
