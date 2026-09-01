/**
 * Tests for src/boot/audit-rebuild.ts — `rebuildHumanActionIndex` and
 * `rebuildHumanActionIndexOnBoot` (m3l-console-server X7c), the half of
 * ADR-0070's dual store that discharges its open consequence: "dual-store
 * audit (JSONL truth + SQLite index) needs its rebuild path tested".
 *
 * Deliberately built on the REAL pieces on both sides — a real
 * `Core.M3LAppendOnlyStream` writing real JSONL segments under a tmpdir, and
 * a real `openConsoleStore(":memory:")` with its real migrations applied.
 * Faking either would make the test agree with itself: the whole claim under
 * test is that a line the audit stream actually wrote can be read back and
 * projected into a row the `console_human_actions` `CHECK` constraints
 * actually accept. A fake trail and a fake repository can never disagree
 * about that.
 *
 * The last describe block is the end-to-end proof that #834's central claim
 * is resolved: boot a console, perform an audited write, and find the entry
 * in BOTH stores — then empty the index, boot again, and watch the trail put
 * it back.
 */
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createHumanActionAuditStream } from "../src/audit/stream.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import {
  rebuildHumanActionIndex,
  rebuildHumanActionIndexOnBoot,
} from "../src/boot/audit-rebuild.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { startConsole } from "../src/main.js";
import { openConsoleStore } from "../src/store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
} from "../src/store/store.js";

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
let auditDir: string;
let stores: (M3LConsoleStoreHandle & M3LConsoleStore)[];

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-audit-rebuild-"));
  auditDir = path.join(workDir, "audit");
  stores = [];
});

afterEach(async () => {
  for (const store of stores) {
    // Guarded rather than try/caught: `startConsole` closes the store on its
    // way down, so a second close is expected — but a close that fails for
    // any OTHER reason must still surface instead of vanishing into an empty
    // catch.
    if (store.isOpen) store.close();
  }
  await rm(workDir, { recursive: true, force: true });
});

/** Opens a real in-memory store with every migration applied, closed by `afterEach`. */
function openStore(): M3LConsoleStoreHandle & M3LConsoleStore {
  const store = openConsoleStore({ location: ":memory:" });
  stores.push(store);
  return store;
}

/** Builds a `M3LHumanActionRecord` fixture, defaulting to an allowed script launch. */
function buildRecord(
  overrides: Partial<M3LHumanActionRecord> = {},
): M3LHumanActionRecord {
  return {
    atMs: 1_700_000_000_000,
    operator: "ada",
    operatorEmailDeclared: true,
    correlationId: "corr-1",
    action: "run.launch",
    target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
    parameterNames: ["queueUrl"],
    parameterRefs: [],
    posture: "confirmed",
    outcome: "allowed",
    detail: { attempt: 1 },
    ...overrides,
  };
}

/** Writes `records` into a REAL audit trail under {@link auditDir}, through the shipped port. */
async function seedTrail(
  records: readonly M3LHumanActionRecord[],
): Promise<void> {
  const port = createHumanActionAuditStream({ directory: auditDir });
  for (const record of records) {
    await port.record(record);
  }
}

describe("rebuildHumanActionIndex — trail to index", () => {
  test("every seeded trail entry becomes an index row", async () => {
    await seedTrail([
      buildRecord({ correlationId: "corr-1" }),
      buildRecord({
        correlationId: "corr-2",
        action: "session.create",
        target: { kind: "session", id: "session-1" },
      }),
    ]);
    const store = openStore();

    const inserted = await rebuildHumanActionIndex({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([]),
    });

    expect(inserted).toBe(2);
    expect(store.audit.count()).toBe(2);
    const rows = store.audit.list({ limit: 10 });
    expect(rows.map((row) => row.correlationId).sort()).toStrictEqual([
      "corr-1",
      "corr-2",
    ]);
  });

  test("the script arm keeps its scriptName and the others do not invent one", async () => {
    await seedTrail([
      buildRecord({ target: { kind: "script", id: "s-1", scriptName: "etl" } }),
      buildRecord({
        target: { kind: "run", id: "run-1" },
        correlationId: "corr-2",
      }),
    ]);
    const store = openStore();

    await rebuildHumanActionIndex({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([]),
    });

    const rows = store.audit.list({ limit: 10 });
    const script = rows.find((row) => row.targetKind === "script");
    const run = rows.find((row) => row.targetKind === "run");
    expect(script?.scriptName).toBe("etl");
    expect(run?.scriptName).toBeUndefined();
  });

  test("an absent trail directory rebuilds to zero rows rather than failing", async () => {
    const store = openStore();

    const inserted = await rebuildHumanActionIndex({
      directory: path.join(workDir, "never-created"),
      store,
      logger: new Core.M3LLogger([]),
    });

    expect(inserted).toBe(0);
    expect(store.audit.count()).toBe(0);
  });

  // THE IDEMPOTENCE CLAIM. `insertAll` appends, so without the `deleteAll`
  // half a second rebuild would double every row. Drop the truncate from
  // `truncateAndInsert` and this is the test that fails.
  test("running it twice is idempotent — truncate-and-reinsert, not append", async () => {
    await seedTrail([buildRecord(), buildRecord({ correlationId: "corr-2" })]);
    const store = openStore();
    const options = {
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([]),
    };

    await rebuildHumanActionIndex(options);
    await rebuildHumanActionIndex(options);

    expect(store.audit.count()).toBe(2);
  });

  test("a populated index is replaced, not added to", async () => {
    await seedTrail([buildRecord()]);
    const store = openStore();
    store.audit.insert({
      atMs: 1,
      operator: "stale",
      operatorEmailDeclared: false,
      correlationId: "stale-corr",
      action: "run.launch",
      targetKind: "run",
      targetId: "run-stale",
      posture: "auto",
      outcome: "allowed",
    });

    await rebuildHumanActionIndex({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([]),
    });

    expect(store.audit.count()).toBe(1);
    expect(store.audit.list({ limit: 10 })[0]?.operator).toBe("ada");
  });
});

describe("rebuildHumanActionIndex — a corrupt trail is never indexed as a prefix", () => {
  test("a malformed line surfaces loudly and writes NOTHING", async () => {
    await seedTrail([buildRecord(), buildRecord({ correlationId: "corr-2" })]);
    // A whole extra line that is not JSON at all, terminated so it is NOT a
    // torn tail — this is corruption, and the read must refuse it.
    const [segment] = await import("node:fs/promises").then(async (fs) =>
      (await fs.readdir(auditDir)).map((name) => path.join(auditDir, name)),
    );
    await appendFile(segment as string, "not-json\n", "utf8");
    const store = openStore();

    // The NAMED failure, not merely "something threw": the documented
    // contract is Core's own read error, and a bare `.toThrow()` would also
    // pass for, say, a TypeError from a botched projection.
    await expect(
      rebuildHumanActionIndex({
        directory: auditDir,
        store,
        logger: new Core.M3LLogger([]),
      }),
    ).rejects.toThrow(Core.M3LAppendOnlyStreamReadError);

    // The point: a partial index that LOOKS complete is the one outcome an
    // audit index may never produce. The whole trail is read before the
    // transaction opens, so a read failure leaves zero rows.
    expect(store.audit.count()).toBe(0);
  });

  test("a torn LAST line is tolerated, logged, and excluded", async () => {
    await seedTrail([buildRecord(), buildRecord({ correlationId: "corr-2" })]);
    const [segment] = await import("node:fs/promises").then(async (fs) =>
      (await fs.readdir(auditDir)).map((name) => path.join(auditDir, name)),
    );
    // No trailing newline: a process that died mid-append.
    await appendFile(segment as string, '{"atMs":1,"operator":"a"', "utf8");
    const handler = new RecordingHandler();
    const store = openStore();

    const inserted = await rebuildHumanActionIndex({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    expect(inserted).toBe(2);
    const warnings = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain("torn record");
  });
});

describe("rebuildHumanActionIndexOnBoot — the trigger, and its silence", () => {
  test("rebuilds when the index is empty and the trail is not", async () => {
    await seedTrail([buildRecord()]);
    const handler = new RecordingHandler();
    const store = openStore();

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    expect(inserted).toBe(1);
    expect(store.audit.count()).toBe(1);
    expect(JSON.stringify(handler.events)).toContain("rebuilt");
  });

  test("an empty trail is a no-op, and says nothing", async () => {
    const handler = new RecordingHandler();
    const store = openStore();

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    expect(inserted).toBe(0);
    expect(handler.events).toStrictEqual([]);
  });

  // The bound on the trigger. An unconditional rebuild would be O(trail) on
  // every boot, forever.
  test("a NON-empty index is left alone — the trail is never re-read", async () => {
    await seedTrail([buildRecord(), buildRecord({ correlationId: "corr-2" })]);
    const store = openStore();
    store.audit.insert({
      atMs: 1,
      operator: "already-indexed",
      operatorEmailDeclared: false,
      correlationId: "corr-existing",
      action: "run.launch",
      targetKind: "run",
      targetId: "run-1",
      posture: "auto",
      outcome: "allowed",
    });

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([]),
    });

    expect(inserted).toBe(0);
    expect(store.audit.count()).toBe(1);
    expect(store.audit.list({ limit: 10 })[0]?.operator).toBe(
      "already-indexed",
    );
  });

  test("a corrupt trail degrades LOUDLY instead of failing the boot", async () => {
    await seedTrail([buildRecord()]);
    const [segment] = await import("node:fs/promises").then(async (fs) =>
      (await fs.readdir(auditDir)).map((name) => path.join(auditDir, name)),
    );
    await appendFile(segment as string, "not-json\n", "utf8");
    const handler = new RecordingHandler();
    const store = openStore();

    // Resolves — the index is derived, so a console that cannot rebuild it
    // must still boot and serve.
    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    expect(inserted).toBe(0);
    const errors = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).toContain("rebuild failed");
  });
});

// =============================================================================
// The end-to-end proof that issue #834's central claim is resolved.
//
// Claim: "the SQLite audit index has no writer", so an audited write lands in
// the JSONL trail only. This boots a real console against a real file-backed
// store and a real trail directory, performs one audited write through the
// composed request listener, and asserts the entry is in BOTH stores — then
// empties the index, boots again, and asserts the trail put it back.
//
// A fake server double (not a real socket) keeps this in the unit lane, which
// is the repo's single coverage authority.
// =============================================================================

/** A minimal resolved runs config, so `POST /api/v1/runs` is registered without a real scripts directory. */
const MINIMAL_RUNS_CONFIG: M3LConsoleRunsConfig = {
  scriptsDir: "/opt/scripts",
  maxPerScript: 1,
  queueCapacity: 16,
  streamRetention: 256,
  killTimeoutMs: 5000,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
};

/** A `Server` double reporting a verified loopback bind once `emitListening()` is called. */
function createFakeServer(): {
  readonly instance: Server;
  readonly emitListening: () => void;
  readonly resolveClose: () => void;
} {
  const emitter = new EventEmitter();
  let pendingClose: ((error?: Error) => void) | undefined;
  const extensions = {
    listen(): Server {
      return extensions as unknown as Server;
    },
    close(callback?: (error?: Error) => void): Server {
      pendingClose = callback;
      return extensions as unknown as Server;
    },
    closeIdleConnections(): void {
      /* no-op */
    },
    closeAllConnections(): void {
      /* no-op */
    },
    address(): AddressInfo {
      return { address: "127.0.0.1", family: "IPv4", port: 45_001 };
    },
  };
  const instance = Object.assign(emitter, extensions) as unknown as Server;
  // Deferred until `startConsoleServer` has attached its handler: the boot
  // rebuild under test is itself the `await` that sits between
  // `startConsole()` and the bind, so a bare synchronous emit would go
  // nowhere. Mirrors the `settleBind` helper in `tests/main-store.test.ts`
  // (duplicated per `.claude/rules/tests.md`, not shared across files).
  const settleBind = (): void => {
    let attempts = 0;
    const emit = (): void => {
      if (emitter.listenerCount("listening") === 0 && attempts < 200) {
        attempts += 1;
        setImmediate(emit);
        return;
      }
      emitter.emit("listening");
    };
    emit();
  };
  return {
    instance,
    emitListening: settleBind,
    resolveClose: () => {
      pendingClose?.();
    },
  };
}

/** A body-bearing `POST /api/v1/runs` request double. */
function createRunLaunchRequest(): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & {
    destroy: () => void;
  };
  const body = JSON.stringify({ scriptName: "no-such-script" });
  Object.assign(req, {
    method: "POST",
    url: "/api/v1/runs",
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

/** A `ServerResponse` double resolving `finished` the moment `end()` is called. */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
  readonly finished: Promise<void>;
} {
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
    writeHead: (): ServerResponse => {
      res.headersSent = true;
      return res;
    },
    end: (): ServerResponse => {
      res.writableEnded = true;
      resolveFinished();
      return res;
    },
  });
  return { res, finished };
}

describe("the dual store, end to end (issue #834)", () => {
  test("an audited write reaches the JSONL trail AND the SQLite index, and a boot rebuild restores a wiped index", async () => {
    const store = openStore();
    const env: NodeJS.ProcessEnv = {
      M3L_CONSOLE_OPERATOR_NAME: "ada",
      M3L_CONSOLE_AUDIT_ROOT: auditDir,
    };

    // --- boot 1: perform one audited write --------------------------------
    const first = createFakeServer();
    const bootOne = startConsole({
      env,
      handlers: [new RecordingHandler()],
      runsConfig: MINIMAL_RUNS_CONFIG,
      createServer: () => first.instance,
      openStore: () => store,
    });
    first.emitListening();
    const runningOne = await bootOne;

    const { res, finished } = createRecordingServerResponse();
    runningOne.runtime.requestListener(createRunLaunchRequest(), res);
    await finished;

    // The JSONL trail gained at least one line...
    const trail = new Core.M3LAppendOnlyStream({ directory: auditDir });
    const trailEntries: unknown[] = [];
    for await (const entry of trail.read()) trailEntries.push(entry);
    expect(trailEntries.length).toBeGreaterThan(0);

    // ...and so did the index. This is the state #834 says is impossible.
    const indexedCount = store.audit.count();
    expect(indexedCount).toBeGreaterThan(0);

    const shutdownOne = runningOne.shutdown();
    first.resolveClose();
    await shutdownOne;

    // --- wipe the index, then boot again ----------------------------------
    // `startConsole` closed `store` on the way down, so the second boot needs
    // a fresh handle — the trail directory is what carries state across.
    const reopened = openStore();
    expect(reopened.audit.count()).toBe(0);

    const second = createFakeServer();
    const bootTwo = startConsole({
      env,
      handlers: [new RecordingHandler()],
      runsConfig: MINIMAL_RUNS_CONFIG,
      createServer: () => second.instance,
      openStore: () => reopened,
    });
    second.emitListening();
    const runningTwo = await bootTwo;

    // The ADR-0070 consequence, demonstrated: the trail put the rows back.
    expect(reopened.audit.count()).toBe(indexedCount);

    const shutdownTwo = runningTwo.shutdown();
    second.resolveClose();
    await shutdownTwo;
  });
});
