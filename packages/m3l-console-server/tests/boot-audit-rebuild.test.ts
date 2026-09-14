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
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Core } from "@monte3l/m3l-common";

import { createHumanActionAuditStream } from "../src/audit/stream.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import {
  rebuildHumanActionIndex,
  rebuildHumanActionIndexOnBoot,
} from "../src/boot/audit-rebuild.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
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
  // Armed by `emitListening()`, emitted from `listen()`. The boot rebuild
  // under test is itself the `await` between `startConsole()` and the bind, so
  // a bare emit at call time would go nowhere — and
  // `lifecycle/http-server.ts` attaches its handlers BEFORE calling
  // `listen()`, so driving the emit from there always finds them. Mirrors
  // `tests/main-store.test.ts` (duplicated per `.claude/rules/tests.md`).
  let listened = false;
  let armedBind = false;
  const flushBind = (): void => {
    if (!listened || !armedBind) return;
    armedBind = false;
    setImmediate(() => {
      emitter.emit("listening");
    });
  };
  const extensions = {
    listen(): Server {
      listened = true;
      flushBind();
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
  return {
    instance,
    emitListening: () => {
      armedBind = true;
      flushBind();
    },
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

// =============================================================================
// X8b4c regression — an ARCHIVED sealed segment must not defeat the rebuild.
//
// `Core.M3LAppendOnlyStream.read()` now escalates a segment the directory's
// `manifest.jsonl` sealed and which is no longer on disk: without the
// `onArchivedSegment` read option it throws
// `M3LAppendOnlyStreamManifestError`. `readTrailIndexRows` supplies only
// `onTruncatedTail`, so archiving a whole date — the procedure ADR-0070
// sanctions — currently makes the boot rebuild index NOTHING, and
// PERMANENTLY: `insertAll` never runs, the index stays empty, so every later
// boot re-enters the same path.
//
// The console must TOLERATE archival instead: report each archived segment at
// `error` (an audit segment is gone — a compliance finding, not a debug
// detail) and index the segments that remain. A manifest that cannot be READ
// stays fatal, as the library intends.
// =============================================================================

/**
 * Midday UTC on two consecutive days: far enough from either UTC-day boundary
 * that which date prefix the writer stamps is unambiguous, the same fake-clock
 * shape `m3l-common`'s `storage-append-only-read-archival.test.ts` uses.
 */
const DAY_ONE_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY_TWO_MS = DAY_ONE_MS + 24 * 60 * 60 * 1000;
const DAY_ONE = "2026-01-01";

/** Correlation ids per day, so a surviving index row is attributable to a date. */
const DAY_ONE_CORRELATION_IDS = ["corr-d1-a", "corr-d1-b"] as const;
const DAY_TWO_CORRELATION_IDS = ["corr-d2-a", "corr-d2-b"] as const;

/**
 * The two clauses today's rebuild-failed message promises, both FALSE once a
 * segment has actually left the trail: the trail has lost data, and an index
 * that stayed empty means the next boot re-enters this path rather than
 * clearing it. An operator reading them takes a permanent audit-integrity
 * finding for transient index degradation.
 */
const STALE_DEGRADATION_PHRASES = [
  "the JSONL trail is unaffected",
  "until the next boot",
] as const;

/** Core's own code for a sidecar that exists and cannot be read. */
const MANIFEST_ERROR_CODE = "ERR_APPEND_ONLY_STREAM_MANIFEST";

/**
 * A human-action entry as an anonymous object literal, deliberately NOT
 * annotated {@link M3LHumanActionRecord}.
 *
 * `Core.M3LAppendOnlyStream.append` constrains its own type parameter to an
 * object whose properties are all `M3LAppendOnlyValue`s, and an `interface`
 * carries no implicit index signature — the inferred literal type is what
 * satisfies that constraint without a cast. The shape is {@link buildRecord}'s.
 * The console port is not usable for these fixtures: it exposes neither
 * `maxSegmentBytes` (needed to force the rotations that SEAL a segment) nor
 * `flush()`.
 */
function buildTrailEntry(correlationId: string) {
  return {
    atMs: 1_700_000_000_000,
    operator: "ada",
    operatorEmailDeclared: true,
    correlationId,
    action: "run.launch",
    target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
    parameterNames: ["queueUrl"],
    parameterRefs: [],
    posture: "confirmed",
    outcome: "allowed",
    detail: { attempt: 1 },
  };
}

/** The segment a `manifest.jsonl` line seals, or `undefined` for any other record. */
function sealedSegmentName(line: string): string | undefined {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Readonly<Record<string, unknown>>;
  if (record["kind"] !== "seal") return undefined;
  const segment = record["segment"];
  return typeof segment === "string" ? segment : undefined;
}

/** Every segment name {@link auditDir}'s sidecar currently states a seal for. */
async function sealedSegmentNames(): Promise<readonly string[]> {
  const content = await readFile(
    path.join(auditDir, Core.M3L_APPEND_ONLY_MANIFEST_NAME),
    "utf8",
  );
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => sealedSegmentName(line))
    .filter((name): name is string => name !== undefined);
}

/**
 * Writes a trail spanning a UTC date rollover, with REAL seals.
 *
 * `maxSegmentBytes: 1` makes every append after the first rotate before
 * writing, so N appends produce N segments and those rotations do the
 * sealing. Day one's LAST segment is sealed by the cold-start sweep the
 * day-two writer instance runs, which is why a second stream is constructed
 * rather than the first reused.
 *
 * `flush()` after each day settles that writer's seal tail: the sealer runs on
 * the writer's serialized tail AFTER `append()` resolves, so without it a
 * later `rm` races a seal that would recreate `manifest.jsonl`.
 */
async function seedRolledOverTrail(): Promise<void> {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(DAY_ONE_MS);
    const dayOne = new Core.M3LAppendOnlyStream({
      directory: auditDir,
      maxSegmentBytes: 1,
    });
    for (const correlationId of DAY_ONE_CORRELATION_IDS) {
      await dayOne.append(buildTrailEntry(correlationId));
    }
    await dayOne.flush();

    vi.setSystemTime(DAY_TWO_MS);
    const dayTwo = new Core.M3LAppendOnlyStream({
      directory: auditDir,
      maxSegmentBytes: 1,
    });
    for (const correlationId of DAY_TWO_CORRELATION_IDS) {
      await dayTwo.append(buildTrailEntry(correlationId));
    }
    await dayTwo.flush();
  } finally {
    // Unconditional: a failed append mid-fixture must not leak fake time into
    // the next test.
    vi.useRealTimers();
  }
}

/**
 * Archives day one exactly as ADR-0070's procedure does: every segment file
 * for that date is deleted and `manifest.jsonl` is left behind.
 *
 * Asserts the PRECONDITION that the sidecar claims each deleted segment. From
 * inside the directory a deleted sidecar and a trail that never sealed
 * anything read identically, so without this check a fixture whose seals
 * never landed would make every archival test below pass vacuously.
 */
async function archiveDayOne(): Promise<readonly string[]> {
  const listing = await new Core.M3LAppendOnlyStream({
    directory: auditDir,
  }).listSegments();
  const archived = listing.segments
    .filter((segment) => segment.datePrefix === DAY_ONE)
    .map((segment) => segment.name);
  // Exact count first: `arrayContaining([])` is satisfied by ANY sidecar, so
  // an empty `archived` would hand every caller below a no-op "archival" whose
  // own assertions still pass. One append per segment (`maxSegmentBytes: 1`)
  // makes day one's segment count its correlation-id count.
  expect(archived).toHaveLength(DAY_ONE_CORRELATION_IDS.length);
  expect(await sealedSegmentNames()).toEqual(
    expect.arrayContaining([...archived]),
  );
  for (const name of archived) {
    await rm(path.join(auditDir, name));
  }
  return archived;
}

/** Every `error`-category event a recording handler captured. */
function errorEvents(handler: RecordingHandler): readonly Core.M3LLogEvent[] {
  return handler.events.filter(
    (event) => event.category === Core.M3LLogEventCategory.ERROR,
  );
}

describe("rebuildHumanActionIndexOnBoot — an archived date is tolerated, not fatal", () => {
  test("a whole archived date still rebuilds the segments that remain", async () => {
    await seedRolledOverTrail();
    await archiveDayOne();
    const store = openStore();

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([]),
    });

    expect(inserted).toBe(DAY_TWO_CORRELATION_IDS.length);
    // The survivors are day TWO's rows specifically: the archived date's
    // entries have left the trail, so they cannot be in the index either —
    // a count alone would not say WHICH rows were indexed.
    expect(
      store.audit
        .list({ limit: 10 })
        .map((row) => row.correlationId)
        .sort(),
    ).toStrictEqual([...DAY_TWO_CORRELATION_IDS].sort());
  });

  test("each archived segment is reported at error level, naming that segment", async () => {
    await seedRolledOverTrail();
    const archived = await archiveDayOne();
    const handler = new RecordingHandler();
    const store = openStore();

    await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    // One `error` event per archived segment, each naming a DIFFERENT one.
    // Counting name MENTIONS would not discriminate: today's single
    // "rebuild failed" event already serializes every segment name out of the
    // manifest error's `context`, so it would satisfy a mention count.
    // Matching one event to one name is what fails against it.
    const named = errorEvents(handler).map((event) =>
      archived.find((segment) => JSON.stringify(event).includes(segment)),
    );
    expect([...named].sort()).toStrictEqual([...archived].sort());
  });

  test("the archival report never claims the trail is unaffected nor that a reboot clears it", async () => {
    await seedRolledOverTrail();
    const archived = await archiveDayOne();
    const handler = new RecordingHandler();
    const store = openStore();

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    // One row per `error` event, PAIRED: what that event correctly says, and
    // which stale clauses it carries. A bare negative string check is weak
    // twice over — it passes when nothing is logged at all, and it passes when
    // the wording merely changes to something else equally wrong. Shaping the
    // expectation against `archived` closes the first hole (silence is not an
    // empty list, it is a missing row) and the positive member closes the
    // second (whatever replaces the clauses must still name the segment).
    expect(
      errorEvents(handler).map((event) => ({
        namesAnArchivedSegment: archived.some((segment) =>
          JSON.stringify(event).includes(segment),
        ),
        stalePhrases: STALE_DEGRADATION_PHRASES.filter((phrase) =>
          JSON.stringify(event).includes(phrase),
        ),
      })),
    ).toStrictEqual(
      archived.map(() => ({ namesAnArchivedSegment: true, stalePhrases: [] })),
    );
    // And the run CONTINUED: the report describes what left the trail, it is
    // not a refusal to index what remains. Without this, a message-only
    // assertion would be satisfied by an implementation that logged the right
    // words and still indexed nothing.
    expect(inserted).toBe(DAY_TWO_CORRELATION_IDS.length);
  });
});

describe("rebuildHumanActionIndexOnBoot — an unreadable manifest stays fatal", () => {
  // REGRESSION LOCK, not a RED case: this already passes today, because the
  // read throws the manifest error and the boot path catches it. It is here so
  // that supplying `onArchivedSegment` cannot be implemented as tolerating the
  // SIDECAR as well — a single bad byte must never disable archival detection
  // for the whole trail, least of all at the moment someone wrote that byte on
  // purpose. Re-confirm after the fix that it still discriminates.
  test("a malformed manifest line indexes nothing and reports the manifest code", async () => {
    await seedRolledOverTrail();
    // Every segment is present and intact; only the sidecar is damaged. The
    // bad line is newline-TERMINATED, so it can never be excused as the torn
    // tail the manifest reader tolerates: a complete record that is not a
    // record.
    await appendFile(
      path.join(auditDir, Core.M3L_APPEND_ONLY_MANIFEST_NAME),
      "{ not valid json\n",
      "utf8",
    );
    const handler = new RecordingHandler();
    const store = openStore();

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    expect(inserted).toBe(0);
    // Exactly one `error` event, and the manifest error's own code reaches the
    // operator through the serialized cause chain.
    expect(
      errorEvents(handler).map((event) =>
        JSON.stringify(event).includes(MANIFEST_ERROR_CODE),
      ),
    ).toStrictEqual([true]);
  });
});

// =============================================================================
// PR #1254 review nit (slice X8b4c) — the manifest classification must survive
// being WRAPPED.
//
// `describeRebuildFailure` inspects only the top-level caught object. That is
// correct today: `Core.M3LAppendOnlyStream.read()` throws
// `M3LAppendOnlyStreamManifestError` directly and nothing between it and the
// boot catch re-raises it, so the top-level test always sees it. What makes
// the nit worth pinning is what the FALLBACK says. `REBUILD_FAILED_MESSAGE`
// promises the operator that "the JSONL trail is unaffected" and that the
// condition clears "until the next boot", and both are false of a manifest
// failure — replacing those two sentences is the entire reason
// `MANIFEST_UNREADABLE_MESSAGE` was added in this slice. So a future wrapper
// anywhere on the read path would not merely downgrade the wording: it would
// silently reinstate the two claims this slice existed to delete, on the one
// log line an operator gets, and no gate would catch it.
//
// The contract pinned below: an `M3LAppendOnlyStreamManifestError` ANYWHERE in
// the caught value's `cause` chain selects the manifest message, a directly
// thrown one still does, and a chain holding none still selects the generic
// message.
// =============================================================================

/**
 * A phrase only the manifest-unreadable message carries — the repair the
 * operator actually has to perform. Matched as a phrase rather than by
 * copying the whole sentence so that rewording the message does not fail a
 * test about CLASSIFICATION, and read off `event.message` rather than the
 * serialized event so the assertion cannot be satisfied by the cause chain
 * `errorFrom` also writes into `data`.
 */
const MANIFEST_MESSAGE_PHRASE = "until the sidecar is repaired or restored";

/**
 * A phrase only the generic rebuild-failed message carries. It is also the
 * first of {@link STALE_DEGRADATION_PHRASES}, deliberately: what makes the
 * generic message wrong for a manifest failure is the same clause that
 * identifies it.
 */
const GENERIC_MESSAGE_PHRASE = "the JSONL trail is unaffected";

/**
 * How deep below the wrapper the manifest error sits. Both rows matter: an
 * implementation that inspected `cause.cause` alone would pass the deeper row
 * and fail the shallow one, and one that inspected `cause` alone the reverse.
 */
const WRAPPED_CHAIN_DEPTHS = [
  { label: "as the direct cause", depth: 1 },
  { label: "two links down the chain", depth: 2 },
] as const;

/**
 * Returns a REAL `M3LAppendOnlyStreamManifestError`, thrown by Core's own
 * reader against a genuinely damaged sidecar in this test's own trail.
 *
 * Hand-constructing one would prove less. The classification under test is an
 * `instanceof` check, so what it runs against must be the object the library
 * actually throws on this path — same class, same `code`, same `context`, and
 * the same nested `cause` from the failed parse, which is what a chain-walking
 * implementation has to step over without mistaking it for the manifest error
 * itself. Read here through a bare stream rather than through the boot path,
 * because the boot path is the thing under test: this call produces a FIXTURE.
 *
 * The damage is the same as the "stays fatal" block above: every segment
 * present and intact, one newline-terminated non-record appended to the
 * sidecar, so it can never be excused as the torn manifest tail the reader
 * tolerates.
 */
async function captureManifestError(): Promise<Core.M3LAppendOnlyStreamManifestError> {
  await seedRolledOverTrail();
  await appendFile(
    path.join(auditDir, Core.M3L_APPEND_ONLY_MANIFEST_NAME),
    "{ not valid json\n",
    "utf8",
  );
  const seen: unknown[] = [];
  let captured: unknown;
  try {
    for await (const entry of new Core.M3LAppendOnlyStream({
      directory: auditDir,
    }).read()) {
      seen.push(entry);
    }
  } catch (cause) {
    captured = cause;
  }
  // The fixture asserts its own premise: a reader that stopped escalating an
  // unreadable sidecar would hand every test below a `captured` of
  // `undefined`, and a chain containing nothing would then classify as generic
  // for the right reason and fail for the wrong one.
  expect(captured).toBeInstanceOf(Core.M3LAppendOnlyStreamManifestError);
  return captured as Core.M3LAppendOnlyStreamManifestError;
}

/**
 * Chains `inner` `depth` links below an `M3LConsoleError`.
 *
 * **Why this is a shape the boot catch can genuinely receive.** Neither the
 * wrapper nor the chaining is invented for the test. `audit/stream.ts` already
 * builds `new M3LConsoleError("ERR_CONSOLE_AUDIT_RECORD_INVALID" |
 * "ERR_CONSOLE_AUDIT_WRITE_FAILED", …, { cause })` around a Core append-only
 * failure — putting a console code over a chained Core storage error is this
 * package's established way of surfacing one — and
 * `ERR_CONSOLE_AUDIT_RECORD_INVALID` specifically reaches THIS catch block
 * today, thrown by `projectHumanActionRecord` inside `readTrailIndexRows`. The
 * one thing that does not exist today is a wrapper on the read path that
 * chains the MANIFEST error, which is precisely the future change the nit is
 * about. So the wrapper is real, the wrapped error is real, and only their
 * composition is synthesized.
 *
 * The intermediate links are plain `Error`s with `cause`, the shape anything
 * from a `node:fs` helper to a third-party await boundary produces — the
 * chain-walk must not depend on every link being an `M3LError`.
 */
function chainUnder(inner: unknown, depth: number): M3LConsoleError {
  let chained = inner;
  for (let link = 1; link < depth; link += 1) {
    chained = new Error(`intermediate wrapper ${String(link)}`, {
      cause: chained,
    });
  }
  return new M3LConsoleError(
    "ERR_CONSOLE_AUDIT_RECORD_INVALID",
    "a trail line could not be projected",
    { cause: chained },
  );
}

/** One `error` event, reduced to what it says about the message that was chosen. */
interface ClassifiedFailureEvent {
  readonly selectsManifestMessage: boolean;
  readonly selectsGenericMessage: boolean;
  readonly stalePhrases: readonly string[];
}

/**
 * Runs the boot rebuild with `failure` raised by the injected store, and
 * returns what each `error` event says about the message that was chosen.
 *
 * The failure is delivered through `options.store` — the first collaborator
 * the try block touches — so the caught value is exactly `failure` and nothing
 * else runs or logs: the classification is a property of the CATCH, not of the
 * read. A spy on the REAL store keeps the seam the one the boot path is
 * actually given, and it dies with this test's own store instance, so there is
 * no mock state to restore.
 *
 * Each row pairs what the message correctly SAYS with the stale clauses it
 * carries. A bare negative check would pass when nothing is logged at all;
 * shaping the expectation as a one-row list makes silence a missing row, and
 * the positive members make a message that merely reworded into something
 * else equally wrong fail too.
 */
async function classifyBootFailure(
  failure: unknown,
): Promise<readonly ClassifiedFailureEvent[]> {
  const store = openStore();
  vi.spyOn(store.audit, "count").mockImplementation(() => {
    throw failure;
  });
  const handler = new RecordingHandler();

  const inserted = await rebuildHumanActionIndexOnBoot({
    directory: auditDir,
    store,
    logger: new Core.M3LLogger([handler]),
  });

  // Still never throws, and still reports zero rows — the classification may
  // not be bought by turning the degradation into a refusal.
  expect(inserted).toBe(0);
  return errorEvents(handler).map((event) => ({
    selectsManifestMessage: event.message.includes(MANIFEST_MESSAGE_PHRASE),
    selectsGenericMessage: event.message.includes(GENERIC_MESSAGE_PHRASE),
    stalePhrases: STALE_DEGRADATION_PHRASES.filter((phrase) =>
      event.message.includes(phrase),
    ),
  }));
}

describe("rebuildHumanActionIndexOnBoot — a manifest failure is classified through the whole cause chain", () => {
  test.each(WRAPPED_CHAIN_DEPTHS)(
    "a wrapped manifest error ($label) still selects the manifest message",
    async ({ depth }) => {
      const manifestError = await captureManifestError();

      expect(
        await classifyBootFailure(chainUnder(manifestError, depth)),
      ).toEqual([
        {
          selectsManifestMessage: true,
          selectsGenericMessage: false,
          stalePhrases: [],
        },
      ]);
    },
  );

  // The regression guard on the case that already works: a fix that walks the
  // chain must not lose the top-level one. Driven through the REAL boot path
  // rather than the injected seam, because this shape needs no synthesis —
  // `read()` throws the manifest error itself. Passes today; it is here so it
  // cannot stop passing.
  test("a directly thrown manifest error still selects the manifest message", async () => {
    await seedRolledOverTrail();
    await appendFile(
      path.join(auditDir, Core.M3L_APPEND_ONLY_MANIFEST_NAME),
      "{ not valid json\n",
      "utf8",
    );
    const handler = new RecordingHandler();
    const store = openStore();

    const inserted = await rebuildHumanActionIndexOnBoot({
      directory: auditDir,
      store,
      logger: new Core.M3LLogger([handler]),
    });

    expect(inserted).toBe(0);
    expect(
      errorEvents(handler).map((event) => ({
        selectsManifestMessage: event.message.includes(MANIFEST_MESSAGE_PHRASE),
        stalePhrases: STALE_DEGRADATION_PHRASES.filter((phrase) =>
          event.message.includes(phrase),
        ),
      })),
    ).toEqual([{ selectsManifestMessage: true, stalePhrases: [] }]);
  });

  // The discriminating case. An implementation that answered "manifest"
  // whenever the caught value had a `cause` at all would satisfy both tests
  // above and fail this one: same wrapper, same depth, same injection — only
  // the innermost class differs. Passes today, so it is a lock, not a RED
  // case; re-confirm after the fix that it still discriminates.
  test("a chained failure with NO manifest error in it still selects the generic message", async () => {
    const chained = chainUnder(
      new Core.M3LAppendOnlyStreamReadError("a trail line was malformed", {
        // A nested cause of its own, so "has a deep chain" cannot be what the
        // fix keys on.
        cause: new Error("unexpected token"),
      }),
      WRAPPED_CHAIN_DEPTHS.length,
    );

    expect(await classifyBootFailure(chained)).toEqual([
      {
        selectsManifestMessage: false,
        selectsGenericMessage: true,
        stalePhrases: [...STALE_DEGRADATION_PHRASES],
      },
    ]);
  });
});

// =============================================================================
// Slice X8b — the two DEFENSIVE branches of `hasManifestErrorInChain`: the
// depth bound (`MAX_CAUSE_CHAIN_WALK`) running out, and a link that cannot be
// inspected without throwing. Both are argued for at length in that function's
// own doc comment, and nothing executed either — which also left its in-loop
// `catch` an uncovered BRANCH under this repo's per-file 80% branch gate.
//
// **Every shape below is SYNTHETIC, and this block does not pretend otherwise.**
// No seam in this package produces a cyclic `cause`, a chain past the bound, or
// a hostile link today: the deepest chain the tree builds is three links (a
// console wrapper over a Core storage error over a parse failure), and the
// blocks above already cover that end to end. What is NOT synthetic is the call
// site. This walk runs inside `rebuildHumanActionIndexOnBoot`'s `catch`, on the
// boot path of a process that must come up, over a value whose only guarantee
// is that something threw it — and that `catch` is not itself guarded, so a
// throw from the walk escapes the never-throws contract entirely.
//
// **Why expecting the GENERIC message is not vacuous here, test by test.** The
// generic message is also what a walk that inspected nothing at all would
// select, so each test carries its own discriminator:
//
//   - the bound pair is TWO-SIDED. One real manifest error at the deepest link
//     the bound still reaches selects the MANIFEST message; the same error one
//     link further selects the generic one. A walk that inspected nothing fails
//     the first row, and an unbounded walk fails the second.
//   - the uninspectable-link table carries a BENIGN CONTROL row — the identical
//     structure with an accessor that RETURNS instead of throwing selects the
//     manifest message — so the generic outcome is attributable to the throw
//     rather than to a walk that never arrived. Every row also counts its own
//     reads, so "the walk reached this link" is asserted rather than assumed.
//   - the cycle test's discriminator is not the message at all: it is that the
//     call RETURNS, under a timeout well below the suite default, having read
//     no more links than the documented bound allows.
// =============================================================================

/**
 * `MAX_CAUSE_CHAIN_WALK` as `boot/audit-rebuild.ts` documents it — the caught
 * value itself plus up to nine causes.
 *
 * Module-private there and deliberately not exported (its own doc comment
 * explains why it is mirrored rather than hoisted into a shared module), so
 * this is a PIN on the documented bound: raising or lowering it there is a
 * prompt to update this constant, exactly as the cross-reference to
 * `errors/errno.ts` is a prompt to go read that site. The value is stated once
 * here and every depth below is derived from it, so the update is one line.
 */
const DOCUMENTED_MAX_CAUSE_CHAIN_WALK = 10;

/**
 * A ceiling on how many times a cyclic link's `cause` may be READ across one
 * boot failure — the bound above, plus a small allowance.
 *
 * The allowance exists because the classification walk is not the only reader:
 * `errorFrom` serializes the same chain into the event's `data` immediately
 * afterwards, and against the built library that costs exactly one further read
 * of this link. Two is allowed so this stays an assertion about the WALK's
 * bound and not a pin on a serializer this test does not own. What it still
 * fails: a walk whose bound is orders of magnitude larger — one that
 * terminates, so no timeout catches it, while doing exactly the unbounded work
 * the cap exists to refuse.
 */
const MAX_CYCLIC_CAUSE_READS = DOCUMENTED_MAX_CAUSE_CHAIN_WALK + 2;

/**
 * Well below the 5s suite default, so a regression to an unbounded walk fails
 * as this one test timing out rather than wedging the whole run. Generous
 * enough that it is never a wall-clock race: the work under test is ten
 * property reads.
 */
const CYCLIC_WALK_TIMEOUT_MS = 2_000;

/**
 * Where the manifest error sits relative to the bound, and what that selects.
 *
 * The deepest DETECTED depth is the bound minus one, because depth 0 is the
 * caught value itself. The second row is the bound-exhaustion path, and it is
 * the one case where the generic message is knowingly WRONG about audit
 * integrity — a manifest error is in the chain, and the operator is told the
 * JSONL trail is unaffected and that a reboot clears it. That is the trade-off
 * `hasManifestErrorInChain` argues for explicitly ("the less wrong direction
 * rather than a harmless one"), and pinning it is what keeps it a decision
 * rather than an accident.
 */
const BOUND_RELATIVE_DEPTHS = [
  {
    label: "at the deepest link the bound still inspects",
    depth: DOCUMENTED_MAX_CAUSE_CHAIN_WALK - 1,
    selectsManifestMessage: true,
  },
  {
    label: "one link past the bound",
    depth: DOCUMENTED_MAX_CAUSE_CHAIN_WALK,
    selectsManifestMessage: false,
  },
] as const;

/** Counts how often a fixture link was actually read, so "never reached" is visible. */
interface LinkReadProbe {
  reads: number;
}

/**
 * The three reads `hasManifestErrorInChain` performs per link that a hostile
 * value can turn into a throw — the `instanceof` test (a `Proxy`
 * `getPrototypeOf` trap) and the `.cause` read (an own throwing accessor) —
 * plus the benign control that makes their outcome attributable.
 *
 * Each builder puts a REAL manifest error `behind` the link, so the chain does
 * contain one: the throwing rows therefore assert that an uninspectable link
 * ends the walk and forfeits a classification it could otherwise have made,
 * which is the honest reading of that branch. `Object.hasOwn`'s own trap
 * (`getOwnPropertyDescriptor`) is left uncovered on purpose — it is the same
 * `try`, the same `return false`, and one more `Proxy` would add machinery
 * without adding a branch.
 *
 * The own accessor comes first because it needs no `Proxy` at all: an object
 * that exposes `cause` as a getter is what a third-party boundary or a lazily
 * materialized error wrapper actually produces.
 */
const UNINSPECTABLE_LINKS = [
  {
    label: "an own `cause` accessor that throws",
    selectsManifestMessage: false,
    build: (behind: unknown, probe: LinkReadProbe): unknown => {
      const link = new Error("a third-party await boundary", { cause: behind });
      // Redefines the own data property the options bag just installed
      // (writable AND configurable per spec), so `Object.hasOwn` still answers
      // `true` and the walk commits to a read it cannot complete.
      Object.defineProperty(link, "cause", {
        configurable: true,
        get: (): unknown => {
          probe.reads += 1;
          throw new TypeError("this link's cause cannot be read");
        },
      });
      return link;
    },
  },
  {
    label: "an own `cause` accessor that returns (the control)",
    selectsManifestMessage: true,
    build: (behind: unknown, probe: LinkReadProbe): unknown => {
      const link = new Error("a third-party await boundary");
      Object.defineProperty(link, "cause", {
        configurable: true,
        get: (): unknown => {
          probe.reads += 1;
          return behind;
        },
      });
      return link;
    },
  },
  {
    label: "a Proxy whose getPrototypeOf trap throws",
    selectsManifestMessage: false,
    build: (behind: unknown, probe: LinkReadProbe): unknown =>
      new Proxy(new Error("a third-party await boundary", { cause: behind }), {
        getPrototypeOf: (): never => {
          probe.reads += 1;
          throw new TypeError("this link's prototype cannot be read");
        },
      }),
  },
] as const;

/**
 * The one-row expectation {@link classifyBootFailure} must produce for each
 * outcome, written out on both sides rather than negated: a row asserting only
 * what the message is NOT would be satisfied by a message that is differently
 * wrong.
 */
function expectOneEventSelecting(
  selectsManifestMessage: boolean,
): readonly ClassifiedFailureEvent[] {
  return [
    selectsManifestMessage
      ? {
          selectsManifestMessage: true,
          selectsGenericMessage: false,
          stalePhrases: [],
        }
      : {
          selectsManifestMessage: false,
          selectsGenericMessage: true,
          stalePhrases: [...STALE_DEGRADATION_PHRASES],
        },
  ];
}

describe("rebuildHumanActionIndexOnBoot — the cause-chain walk is bounded and cannot be made to throw", () => {
  // `e.cause = e` is constructible, and a walk without a bound over it does not
  // return — it spins inside a catch block on the boot path, so the process
  // never finishes coming up and never logs why. The assertion that matters is
  // therefore the one the test framework makes: this call RETURNED. The message
  // is checked too, but the timeout is the discriminator.
  test(
    "a cyclic cause chain returns a generic degradation instead of spinning",
    { timeout: CYCLIC_WALK_TIMEOUT_MS },
    async () => {
      const cyclic = new Error("a failure whose cause is itself");
      cyclic.cause = cyclic;

      expect(await classifyBootFailure(cyclic)).toEqual(
        expectOneEventSelecting(false),
      );

      // And it terminated because the BOUND ran out, not because the work was
      // merely finite: the same cycle built from a counting accessor shows how
      // many links were read. A cycle read once is as compatible with "the walk
      // did nothing" as with a cap, and a cycle read ten thousand times would
      // satisfy the timeout above while defeating the reason the cap is a depth
      // cap rather than a visited-set.
      const probe: LinkReadProbe = { reads: 0 };
      const counted = new Error(
        "a failure whose cause accessor returns itself",
      );
      Object.defineProperty(counted, "cause", {
        configurable: true,
        get: (): unknown => {
          probe.reads += 1;
          return counted;
        },
      });

      expect(await classifyBootFailure(counted)).toEqual(
        expectOneEventSelecting(false),
      );
      expect(probe.reads).toBeGreaterThanOrEqual(1);
      expect(probe.reads).toBeLessThanOrEqual(MAX_CYCLIC_CAUSE_READS);
    },
  );

  test.each(BOUND_RELATIVE_DEPTHS)(
    "a manifest error $label selects the manifest message: $selectsManifestMessage",
    async ({ depth, selectsManifestMessage }) => {
      const manifestError = await captureManifestError();

      expect(
        await classifyBootFailure(chainUnder(manifestError, depth)),
      ).toEqual(expectOneEventSelecting(selectsManifestMessage));
    },
  );

  test.each(UNINSPECTABLE_LINKS)(
    "$label ends the walk without escaping the never-throws contract",
    async ({ build, selectsManifestMessage }) => {
      const manifestError = await captureManifestError();
      const probe: LinkReadProbe = { reads: 0 };

      // A throw out of the walk would surface HERE, as this call rejecting
      // rather than as a wrongly chosen message — `classifyBootFailure` awaits
      // the real boot entry point and asserts it inserted zero rows. That is
      // the whole reason the `try` sits inside the loop, so a test that only
      // compared message text would miss it.
      const classified = await classifyBootFailure(
        chainUnder(build(manifestError, probe), 1),
      );

      expect(classified).toEqual(
        expectOneEventSelecting(selectsManifestMessage),
      );
      // The walk actually arrived at the hostile link. Without this, a walk
      // that stopped one link earlier for an unrelated reason would produce
      // the same generic message and look like a covered defence.
      expect(probe.reads).toBeGreaterThanOrEqual(1);
    },
  );
});
