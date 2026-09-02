/**
 * Tests for the audit port's COMPOSITION into the console runtime (X7b,
 * ADR-0070): where the port comes from, that it cannot be turned off, and
 * that every write route the console serves is covered by a spec.
 *
 * A sibling of `main.test.ts` rather than an addition to it — that file sits
 * at 55,857 of its 60,000-byte ADR-0072 ceiling.
 *
 * The last test here is the one that matters most. The gate's per-route spec
 * table is a second place a route must be registered, so it can drift from
 * the real dispatch table. That test drives the exhaustiveness guard against
 * the ACTUAL routes `createConsoleRuntime` builds, which is what makes the
 * drift impossible rather than merely discouraged.
 *
 * @packageDocumentation
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { resolveHumanActionAuditRoot } from "../src/boot/human-action-audit.js";
import { jsonResponse } from "../src/http/respond.js";
import type { M3LRoute } from "../src/http/router.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { createConsoleRuntime } from "../src/main.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";
import type {
  M3LConsoleAuditRepository,
  M3LHumanActionIndexInput,
} from "../src/store/audit-repository.js";
import { openConsoleStore } from "../src/store/store.js";

/** A recording `M3LLoggerHandler` fake — the sanctioned test-double pattern. */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-console-audit-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** The minimum env a runtime needs, plus an audit root inside the tmpdir. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(workDir, "audit"),
    ...overrides,
  };
}

/** A recording port, for the injection cases. */
function createFakePort(): M3LHumanActionAuditPort & {
  readonly records: M3LHumanActionRecord[];
} {
  const records: M3LHumanActionRecord[] = [];
  return {
    records,
    record(record: M3LHumanActionRecord): Promise<void> {
      records.push(record);
      return Promise.resolve();
    },
  };
}

describe("the audit port is composed unconditionally", () => {
  test("a runtime boots with an audit trail resolved from M3L_CONSOLE_AUDIT_ROOT", () => {
    // "Audit unconfigured" is not a reachable state: `resolveAuditStreamRoot`
    // always yields a path, so there is no posture line and no disabled mode
    // to assert — a clean boot IS the assertion.
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [new RecordingHandler()],
    });

    expect(runtime.requestListener).toBeTypeOf("function");
  });

  test("options.auditPort short-circuits the env-derived port", () => {
    const port = createFakePort();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_AUDIT_ROOT: undefined }),
      handlers: [new RecordingHandler()],
      auditPort: port,
    });

    expect(runtime.requestListener).toBeTypeOf("function");
    // Nothing has been requested yet, so nothing is recorded — the point is
    // that boot did not need to resolve a real root.
    expect(port.records).toHaveLength(0);
  });

  test.each([
    ["a file: URI", "file:///tmp/audit"],
    ["a blank path", "   "],
  ] as [string, string][])(
    "an unusable audit root (%s) fails boot with a console error",
    (_label, configured) => {
      // `createConsoleRuntime`'s own `@throws` promises an
      // `M3LConsoleError`, so nothing from this path may surface as a bare
      // `Core.M3LError`.
      let thrown: unknown;
      try {
        createConsoleRuntime({
          env: buildEnv({ M3L_CONSOLE_AUDIT_ROOT: configured }),
          handlers: [new RecordingHandler()],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_CONFIG_INVALID",
      );
    },
  );

  test("the audit root is not created until something is recorded", async () => {
    createConsoleRuntime({
      env: buildEnv(),
      handlers: [new RecordingHandler()],
    });

    // Boot resolves the path; the append-only stream creates its directory
    // lazily on first append. Asserting this keeps a future change from
    // making boot itself a filesystem write.
    const entries = await readdir(workDir);
    expect(entries).not.toContain("audit");
  });
});

describe("resolveHumanActionAuditRoot — the one answer both halves share", () => {
  // Exported precisely so `buildHumanActionAuditPort` (which WRITES the trail)
  // and `boot/audit-rebuild.ts` (which READS it back) cannot disagree about
  // where it is. Two independent `resolveAuditStreamRoot` calls would agree
  // today and drift later into "nothing to rebuild" — the quietest possible
  // wrong answer — so this is tested directly rather than only through boot.
  test("returns the configured root when M3L_CONSOLE_AUDIT_ROOT is set", () => {
    const configured = path.join(workDir, "audit");

    expect(resolveHumanActionAuditRoot(buildEnv())).toBe(configured);
  });

  test("falls back to a path under the data dir when the variable is absent", () => {
    const resolved = resolveHumanActionAuditRoot({});

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toContain("audit");
  });

  test("an unusable root raises ERR_CONSOLE_CONFIG_INVALID, never a bare Core.M3LError", () => {
    // `createConsoleRuntime`'s own `@throws` promises an `M3LConsoleError`, so
    // the wrapping in this function is the contract, not a convenience.
    let thrown: unknown;
    try {
      resolveHumanActionAuditRoot({ M3L_CONSOLE_AUDIT_ROOT: "file:///tmp/a" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_CONFIG_INVALID");
  });
});

describe("every write route the console serves is audited", () => {
  // THE DRIFT GUARD. `applyHumanActionAudit` throws for any non-GET route
  // with no spec, and `createConsoleRuntime` runs it over the real dispatch
  // table — so a new write route added to `routes/runs.ts` or
  // `routes/sessions.ts` without a spec fails HERE, at boot, rather than
  // shipping unaudited. Booting with every subsystem wired is what makes the
  // table complete; a bare boot registers only the health routes.
  test("a fully-wired runtime composes without a missing-spec failure", () => {
    const runtime = createConsoleRuntime({
      env: buildEnv({
        M3L_CONSOLE_RUNS_SCRIPTS_DIR: path.join(workDir, "scripts"),
      }),
      handlers: [new RecordingHandler()],
      auditPort: createFakePort(),
    });

    expect(runtime.requestListener).toBeTypeOf("function");
  });

  test("the runtime's own router still reflects the caller's table verbatim", () => {
    // `M3LConsoleRuntime.router` is documented to reflect `options.routes`
    // verbatim, NOT the dispatch table — the audit decoration must not have
    // leaked into it.
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [new RecordingHandler()],
      auditPort: createFakePort(),
    });

    expect(runtime.router.routes).toHaveLength(0);
  });
});

// =============================================================================
// The composition-root wiring for the X7c audit INDEX.
//
// `createConsoleRuntime` wraps the JSONL stream port in
// `boot/audit-index.ts`'s dual-write port when — and only when —
// `options.audit` supplied an index. Nothing above reaches that branch: every
// test so far either injects `options.auditPort` (which short-circuits it) or
// makes no request at all, so the index half of ADR-0070's dual store was
// covered only at the unit level in `tests/boot-audit-index.test.ts`.
//
// These two tests drive one REAL audited request through the composed
// `runtime.requestListener` and assert what reached the repository. Replacing
// `options.audit` with `undefined` at either hand-off — `main.ts`'s
// `indexHumanActionAuditPort(...)` call, or `startConsole`'s
// `audit: store.audit` — makes the first one fail.
//
// `POST /api/v1/runs` is the cheapest audited route: its spec's phase is
// `"before"`, so the entry is recorded ahead of the handler and an unresolvable
// script name still produces one. The doubles below mirror
// `tests/main.test.ts`'s own (duplicated per `.claude/rules/tests.md`, not
// shared across test files).
// =============================================================================

/** A minimal resolved runs config — the `runsConfig` seam that skips `loadRunsConfig`, so `POST /api/v1/runs` is registered without a real scripts directory. */
const MINIMAL_RUNS_CONFIG: M3LConsoleRunsConfig = {
  scriptsDir: "/opt/scripts",
  maxPerScript: 1,
  queueCapacity: 16,
  streamRetention: 256,
  killTimeoutMs: 5000,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
};

/** A loud-throwing `M3LRunRegistry` fake: the run route 404s on script resolution long before it reaches persistence. */
function createStubRegistry(): M3LRunRegistry {
  const unexpectedCall = (): never => {
    throw new Error("unexpected call on the stub run registry");
  };
  return {
    insertQueued: unexpectedCall,
    claimForStart: unexpectedCall,
    finish: unexpectedCall,
    get: unexpectedCall,
    list: unexpectedCall,
    countRunningForScript: (): number => 0,
    abandonQueued: unexpectedCall,
    reconcileOrphaned: (): number => 0,
  };
}

/** A recording {@link M3LConsoleAuditRepository}: `insert` collects rows, everything else fails loudly. */
function createRecordingAuditRepository(): {
  readonly repository: M3LConsoleAuditRepository;
  readonly inserted: M3LHumanActionIndexInput[];
} {
  const inserted: M3LHumanActionIndexInput[] = [];
  const unexpectedCall = (): never => {
    throw new Error("unexpected audit-repository call on the dual-write path");
  };
  return {
    inserted,
    repository: {
      insert(input: M3LHumanActionIndexInput): void {
        inserted.push(input);
      },
      insertAll: unexpectedCall,
      deleteAll: unexpectedCall,
      list: unexpectedCall,
      count: unexpectedCall,
    },
  };
}

/** The body every run-launch request double in this file posts. */
const RUN_LAUNCH_BODY = JSON.stringify({ scriptName: "no-such-script" });

/** A body-bearing `POST` `IncomingMessage` double aimed at `url` — an `EventEmitter` plus the `data`/`end` events `http/body.ts` listens on. */
function createPostRequest(url: string, body: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & {
    destroy: () => void;
  };
  Object.assign(req, {
    method: "POST",
    url,
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    },
    destroy: () => undefined,
  });
  queueMicrotask(() => {
    req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

/** A `ServerResponse` double recording `writeHead`/`end`, resolving `finished` the moment `end()` is called. */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
  readonly status: () => number | undefined;
  readonly finished: Promise<void>;
} {
  let status: number | undefined;
  const res = new EventEmitter() as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: (code: number): ServerResponse => {
      status = code;
      res.headersSent = true;
      return res;
    },
    end: (): ServerResponse => {
      res.writableEnded = true;
      resolveFinished();
      return res;
    },
  });
  return { res, status: () => status, finished };
}

/** Races `promise` against a short timeout, so a listener that never ends fails fast and legibly. */
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, 2000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("options.audit reaches the composed audit port", () => {
  test("an audited request projects a row into the supplied index", async () => {
    const { repository, inserted } = createRecordingAuditRepository();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [new RecordingHandler()],
      runsConfig: MINIMAL_RUNS_CONFIG,
      runs: createStubRegistry(),
      audit: repository,
    });

    const { res, finished } = createRecordingServerResponse();
    runtime.requestListener(
      createPostRequest("/api/v1/runs", RUN_LAUNCH_BODY),
      res,
    );
    await withTimeout(finished, "requestListener never called res.end()");

    // The `"before"` entry, plus the compensating one the 404 produces —
    // what matters is that ANY row reached the index at all.
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted[0]?.action).toBe("run.launch");
    expect(inserted[0]?.operator).toBe("ada");
    expect(inserted[0]?.targetKind).toBe("script");
    expect(inserted[0]?.scriptName).toBe("no-such-script");
  });

  test("options.auditPort takes precedence: the index is left untouched", async () => {
    // The documented precedence (`main.ts`'s `options.auditPort ??`): a
    // caller handing in its own port owns what that port writes, index half
    // included. A `count`/`insert` here would throw loudly.
    const { repository, inserted } = createRecordingAuditRepository();
    const port = createFakePort();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [new RecordingHandler()],
      runsConfig: MINIMAL_RUNS_CONFIG,
      runs: createStubRegistry(),
      audit: repository,
      auditPort: port,
    });

    const { res, finished } = createRecordingServerResponse();
    runtime.requestListener(
      createPostRequest("/api/v1/runs", RUN_LAUNCH_BODY),
      res,
    );
    await withTimeout(finished, "requestListener never called res.end()");

    expect(port.records.length).toBeGreaterThan(0);
    expect(inserted).toStrictEqual([]);
  });
});

// =============================================================================
// The `options.routes` audit boundary (claim 2 of issue #834, X7c).
//
// The behaviour is UNCHANGED and correct; this locks it, because two OPPOSITE
// regressions are possible and neither would fail any existing test:
//
//   * routing `options.routes` through `applyHumanActionAudit` would make the
//     exhaustiveness guard throw at boot for every caller-supplied write
//     route, breaking a documented seam; and
//   * auditing them under some invented spec would record entries against a
//     path template this console does not own.
//
// The route below is a WRITE (`POST`), which is what makes the test load
// bearing — a `GET` passes the guard trivially, so it would prove nothing.
// =============================================================================

/** A synthetic caller-supplied write route — the same fixture `tests/main.test.ts` registers. */
const echoRoute: M3LRoute = {
  method: "POST",
  path: "/api/v1/echo",
  auth: "exempt",
  handler: () => jsonResponse(200, { ok: true }),
};

describe("a write route registered through options.routes is served, but NOT audited", () => {
  test("boot does not throw the exhaustiveness guard for a caller-supplied POST", () => {
    // `applyHumanActionAudit` throws ERR_CONSOLE_INTERNAL for a non-GET route
    // with no spec. It never sees this one — that is the boundary.
    expect(() =>
      createConsoleRuntime({
        env: buildEnv(),
        handlers: [new RecordingHandler()],
        routes: [echoRoute],
        auditPort: createFakePort(),
      }),
    ).not.toThrow();
  });

  test("it serves normally, and records no audit entry", async () => {
    const port = createFakePort();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [new RecordingHandler()],
      routes: [echoRoute],
      auditPort: port,
    });

    const { res, status, finished } = createRecordingServerResponse();
    runtime.requestListener(createPostRequest("/api/v1/echo", "{}"), res);
    await withTimeout(finished, "requestListener never called res.end()");

    // BOTH halves, in this order. Asserting only the empty trail would pass
    // vacuously if the route were never reached at all — a 404 also records
    // nothing. The 200 is what proves the route really served.
    expect(status()).toBe(200);
    expect(port.records).toStrictEqual([]);
  });
});

// =============================================================================
// The X7d read routes, end to end against a REAL trail and a REAL store.
//
// Everything above either injects `options.auditPort` (a fake trail) or
// `options.audit` (a fake repository). Both halves faked, they can never
// disagree — so a projection that silently dropped a field, or a spec whose
// target did not survive the JSONL round-trip, would pass every one of them.
//
// The two tests below drive one real `GET /api/v1/runs/:id/report` through
// the composed `requestListener` with:
//
//   * the real append-only JSONL trail, resolved from
//     `M3L_CONSOLE_AUDIT_ROOT` and read back off disk with Core's own reader;
//   * the real SQLite `console_human_actions` index, read back with the real
//     repository.
//
// A `view.*` kind is the right one to prove this with: its spec's phase is
// `"after"`, so nothing is recorded unless the route genuinely served — which
// means these also prove the report route, the output-root wiring and the
// reader all work, not just the audit projection.
// =============================================================================

/** Reads every record back off the real JSONL trail at `directory`. */
async function readTrail(
  directory: string,
): Promise<readonly M3LHumanActionRecord[]> {
  const stream = new Core.M3LAppendOnlyStream({ directory });
  const records: M3LHumanActionRecord[] = [];
  for await (const entry of stream.read()) {
    records.push(structuredClone(entry) as unknown as M3LHumanActionRecord);
  }
  return records;
}

/** A `GET` `IncomingMessage` double aimed at `url`. */
function createGetRequest(url: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & {
    destroy: () => void;
  };
  Object.assign(req, {
    method: "GET",
    url,
    headers: { host: "127.0.0.1" },
    destroy: () => undefined,
  });
  return req;
}

/** A registry whose `get` reports one terminal run and nothing else. */
function createOneRunRegistry(runId: string): M3LRunRegistry {
  const unexpectedCall = (): never => {
    throw new Error("unexpected call on the one-run registry");
  };
  return {
    insertQueued: unexpectedCall,
    claimForStart: unexpectedCall,
    finish: unexpectedCall,
    get: (id: string) =>
      id === runId
        ? ({
            id: runId,
            script: "sqs-etl",
            status: "success",
            dryRun: false,
            executionMode: "spawn",
            parameters: {},
            operator: "ada",
            correlationId: "corr-1",
            queuedAtMs: 1_000,
            startedAtMs: 1_100,
            endedAtMs: 1_200,
            outcome: "success",
            exitCode: 0,
            failureMessage: null,
          } as unknown as ReturnType<M3LRunRegistry["get"]>)
        : undefined,
    list: unexpectedCall,
    countRunningForScript: (): number => 0,
    abandonQueued: unexpectedCall,
    reconcileOrphaned: (): number => 0,
  };
}

describe("view.run.report is audited end to end, against a real trail", () => {
  const RUN_ID = "run-e2e";

  /**
   * Boots a runtime whose report route can actually serve, writes the report
   * a real child would have written, and issues the request.
   */
  async function serveReport(audit?: M3LConsoleAuditRepository): Promise<{
    readonly status: number | undefined;
    readonly auditRoot: string;
  }> {
    const outputRoot = path.join(workDir, "runs");
    const reportDir = path.join(outputRoot, RUN_ID, "2026-09-02T10-14-02.000Z");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "run-report.json"),
      JSON.stringify({ outcome: "success", steps: 2 }),
      "utf8",
    );

    const env = buildEnv({ M3L_CONSOLE_RUNS_OUTPUT_ROOT: outputRoot });
    const runtime = createConsoleRuntime({
      env,
      handlers: [new RecordingHandler()],
      runsConfig: MINIMAL_RUNS_CONFIG,
      runs: createOneRunRegistry(RUN_ID),
      ...(audit !== undefined && { audit }),
    });

    const { res, status, finished } = createRecordingServerResponse();
    runtime.requestListener(
      createGetRequest(`/api/v1/runs/${RUN_ID}/report`),
      res,
    );
    await withTimeout(finished, "requestListener never called res.end()");

    return {
      status: status(),
      auditRoot: resolveHumanActionAuditRoot(env),
    };
  }

  test("the served request leaves one view.run.report entry in the real JSONL trail", async () => {
    const { status, auditRoot } = await serveReport();

    // The route really served — which is what makes the `"after"` entry
    // meaningful rather than a record of a refusal.
    expect(status).toBe(200);

    const records = await readTrail(auditRoot);
    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe("view.run.report");
    expect(records[0]?.outcome).toBe("served");
    expect(records[0]?.operator).toBe("ada");
    // The trail carries the record's own `target` object; the SQLite index
    // flattens it to `targetKind`/`targetId`. Asserting the two SHAPES
    // separately, here and in the index test below, is what makes this pair
    // able to disagree — a single shared helper reading one of them would
    // not be a cross-check at all.
    expect(records[0]?.target).toEqual({ kind: "run", id: RUN_ID });
  });

  // INVARIANT: display-vs-persist, asserted against the BYTES on disk rather
  // than an in-memory record. The report body served here carries a
  // distinctive value; none of it may appear anywhere in the trail.
  test("the trail on disk holds no part of the report it recorded a view of", async () => {
    const { auditRoot } = await serveReport();

    const records = await readTrail(auditRoot);
    expect(JSON.stringify(records)).not.toContain("steps");
  });

  test("the same request lands one matching row in the real SQLite index", async () => {
    const store = openConsoleStore({ location: ":memory:" });
    try {
      await serveReport(store.audit);

      const rows = store.audit.list({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("view.run.report");
      expect(rows[0]?.targetId).toBe(RUN_ID);
    } finally {
      store.close();
    }
  });
});
