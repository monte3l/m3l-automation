/**
 * End-to-end coverage for X8 slice 3d's `store.health` telemetry, driven
 * through the REAL composition root (`startConsole` ->
 * `buildRuntimeAndBindListener` -> `sampleStoreSizeOnBoot`) against a REAL
 * SQLite store, and read back out of `console_telemetry_rollup`. Slices
 * 2b/3a/3b/3c each ship one of these (`tests/telemetry-http-e2e.test.ts`,
 * `tests/telemetry-runs-e2e.test.ts`, `tests/telemetry-sse-e2e.test.ts`,
 * `tests/telemetry-policy-e2e.test.ts`); this is 3d's.
 *
 * WHY THIS FILE USES A REAL DATABASE FILE, unlike every other telemetry e2e
 * in this package. The four sibling files all open
 * `openConsoleStore({ location: ":memory:" })`, and this package has a
 * standing history of tests accidentally touching the real store (see
 * `tests/main-store.test.ts`'s own header) — so the divergence needs
 * justifying rather than assuming. `":memory:"` is unusable HERE because
 * the behaviour under test is defined to record NOTHING for an in-memory
 * store: it has no on-disk footprint, and `store.health` is value-bearing,
 * so a `0` sample would be a fabricated measurement (see
 * `tests/telemetry-store-size.test.ts`, contract 2, which pins exactly
 * that). An `:memory:`-based e2e here would therefore assert the ABSENCE of
 * the row it exists to prove. The store is opened under an `mkdtemp`
 * directory that is removed in `afterEach`, never at the real
 * `data/console/console.sqlite` — `StartConsoleOptions.openStore` is the
 * seam that keeps `startConsole` from resolving the real data dir.
 *
 * WHAT ONLY THIS FILE CAN PROVE. The unit tests inject a hand-written
 * recorder straight into the sampler, so by construction none of them can
 * catch either of the two gaps below:
 *
 * - The WIRING. `sampleStoreSizeOnBoot` is called from `main.ts`'s
 *   `buildRuntimeAndBindListener`, beside `reconcileOnBoot`, and nothing in
 *   the unit tests would notice if that call were dropped, moved after the
 *   bind, or handed the wrong store.
 * - The DATABASE's verdict. `createStoreTelemetryRecorder` maps the sample
 *   onto an `M3LTelemetryMeasurement` and swallows a repository rejection as
 *   a logged `warning` rather than throwing (`src/telemetry-recorder.ts`), so
 *   a row `console_telemetry_rollup` REFUSES is invisible at the port
 *   boundary. The v9/v11 DDL has real teeth for this metric: `sum_value` is
 *   mandatory (`metric NOT IN (...) OR sum_value IS NOT NULL`), `outcome`
 *   must be `''` (`outcome = '' OR metric <> 'store.health'`), `script` must
 *   be `''` (`(script <> '') = (metric = 'run.finished')`), and
 *   `requireValidMeasure` rejects any `valueBytes` that is not a
 *   non-negative safe integer. Only a real store reports whether the row
 *   survived all of that.
 *
 * WHY `sum_value` IS ASSERTED PRESENT. `store.health` is VALUE-BEARING,
 * unlike `sse.stream` and `policy.decision`, whose e2e files assert the exact
 * opposite (`sumValue` undefined — `SQL_UPSERT_COUNTER` binds the measures as
 * SQL `NULL` literals). A regression that routed this metric through the
 * counter path would land a row, satisfy a bare "a row exists" assertion, and
 * silently discard the only number this metric carries.
 *
 * COUNT ASSERTIONS ARE METRIC-SCOPED. Slice 3c rescoped every cross-metric
 * `store.telemetry.count()` to its own metric precisely because a new
 * producer shifts a global total — and this slice IS such a new producer. Do
 * NOT change {@link countMetricRows} back to `count()`; the full rationale
 * lives at `tests/telemetry-runs-e2e.test.ts`'s own `countMetricRows`.
 *
 * No real socket is bound and no OS signal handler is registered: a fake
 * `Server` double stands in for the listener (mirroring
 * `tests/main-store.test.ts`'s own `FakeServer`, duplicated here rather than
 * imported per `.claude/rules/tests.md`), and `signals: []` opts out of the
 * default `SIGTERM`/`SIGINT`/`SIGQUIT` trap set.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { startConsole } from "../src/main.js";
import type { M3LRunningConsole } from "../src/main.js";
import { openConsoleStore } from "../src/store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
} from "../src/store/store.js";
import type {
  M3LTelemetryBucket,
  M3LTelemetryGranularity,
  M3LTelemetryMetric,
} from "../src/store/telemetry-repository.js";

/** The three granularity tiers every telemetry sample fans out to. */
const GRANULARITY_TIERS: readonly M3LTelemetryGranularity[] = [
  "minute",
  "hour",
  "day",
];

/**
 * Counts the persisted `console_telemetry_rollup` rows for ONE metric,
 * summed across all three granularity tiers. Metric-SCOPED on purpose — see
 * this file's header.
 *
 * @param telemetry - The real store's telemetry repository.
 * @param metric - The single metric to count rows for.
 * @returns The number of rollup rows carrying `metric`, across all tiers.
 */
function countMetricRows(
  telemetry: M3LConsoleStore["telemetry"],
  metric: M3LTelemetryMetric,
): number {
  return GRANULARITY_TIERS.reduce(
    (total, granularity) =>
      total + telemetry.list({ granularity, metric, limit: 100 }).length,
    0,
  );
}

/** Reads every persisted `store.health` row at `granularity`. */
function storeHealthRowsAt(
  telemetry: M3LConsoleStore["telemetry"],
  granularity: M3LTelemetryGranularity,
): readonly M3LTelemetryBucket[] {
  return telemetry.list({ granularity, metric: "store.health", limit: 100 });
}

/**
 * A minimal valid env: only the required operator name plus an audit root
 * that deliberately does not exist (mirrors all four sibling e2e files'
 * `buildEnv`). The database path resolved from this env is never used — the
 * `openStore` seam below supplies the real store instead.
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(
      tmpdir(),
      "m3l-console-telemetry-store-health-e2e-audit-absent",
    ),
  };
}

/**
 * A capturing `Core.M3LLoggerHandler`, the sanctioned test-double pattern for
 * this package — passed through `startConsole`'s `handlers` option, which
 * builds a real `Core.M3LLogger` (private fields, so it cannot be duck-typed)
 * over it internally.
 */
function buildCapturingHandler(): {
  readonly handler: Core.M3LLoggerHandler;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { handler, events };
}

/** A verified loopback address the bind check accepts. */
function tcpAddress(address = "127.0.0.1", port = 48_659): AddressInfo {
  return { address, family: "IPv4", port };
}

/**
 * A controllable fake `Server`. Trimmed from `tests/main-store.test.ts`'s own
 * `FakeServer` to the two operations this file needs — arming a successful
 * bind, and answering `close()` — and duplicated rather than imported, per
 * `.claude/rules/tests.md`.
 *
 * The bind outcome is ARMED rather than emitted directly: X7c's audit-index
 * boot rebuild puts an `await` before the bind, so a bare `emit` from the
 * test's own turn would go nowhere. `lifecycle/http-server.ts` attaches both
 * handlers before calling `listen()`, so an emit driven from inside
 * `listen()` always finds them.
 */
interface FakeServer {
  readonly instance: Server;
  /** Arms a successful bind; `listen()` is what actually emits it. */
  emitListening: () => void;
}

function createFakeServer(addressValue: AddressInfo): FakeServer {
  const emitter = new EventEmitter();
  let listened = false;
  let armed = false;

  const flushBind = (): void => {
    if (!listened || !armed) return;
    armed = false;
    setImmediate(() => {
      emitter.emit("listening");
    });
  };

  const extensions = {
    listen(...args: unknown[]): Server {
      void args;
      listened = true;
      flushBind();
      return extensions as unknown as Server;
    },
    close(callback?: (error?: Error) => void): Server {
      callback?.();
      return extensions as unknown as Server;
    },
    closeIdleConnections(): void {
      // Nothing to sweep — this fake never holds a connection.
    },
    closeAllConnections(): void {
      // Nothing to sweep — this fake never holds a connection.
    },
    address(): AddressInfo {
      return addressValue;
    },
  };

  return {
    instance: Object.assign(emitter, extensions) as unknown as Server,
    emitListening() {
      armed = true;
      flushBind();
    },
  };
}

/**
 * Asserts everything the v9/v11 DDL and the "value-bearing" contract require
 * of a `store.health` row beyond its measure.
 *
 * Every `''` below is a DDL requirement, not a cosmetic one: a non-empty
 * `script` violates `(script <> '') = (metric = 'run.finished')` and a
 * non-empty `outcome` violates `outcome = '' OR metric <> 'store.health'` —
 * either would make the INSERT fail, which
 * `createStoreTelemetryRecorder` swallows as a logged warning, so the row
 * would simply be absent. Asserting the sentinels documents WHY absence
 * would have been the symptom.
 */
function expectStoreHealthRowShape(row: M3LTelemetryBucket): void {
  expect(row.metric).toBe("store.health");
  expect(row.script).toBe("");
  expect(row.route).toBe("");
  expect(row.operation).toBe("");
  expect(row.outcome).toBe("");
  expect(row.posture).toBe("");
}

describe("telemetry-store-health-e2e — real file-backed store, real composition root", () => {
  let workDir: string | undefined;
  let store: (M3LConsoleStoreHandle & M3LConsoleStore) | undefined;
  let running: M3LRunningConsole | undefined;

  afterEach(async () => {
    // No `running.shutdown()` is driven: `signals: []` registered no handler
    // and nothing here starts a drain, so there is no timer or listener left
    // behind — closing the store and removing the directory is the whole
    // teardown. `close()` is idempotent.
    store?.close();
    store = undefined;
    running = undefined;
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  /**
   * Boots the real console against a real file-backed store and a fake
   * listener, returning the captured log events alongside it.
   */
  async function boot(): Promise<{
    readonly events: Core.M3LLogEvent[];
  }> {
    workDir = await mkdtemp(path.join(tmpdir(), "m3l-store-health-e2e-"));
    const location = path.join(workDir, "console.sqlite");
    const opened = openConsoleStore({ location });
    store = opened;
    const { handler, events } = buildCapturingHandler();
    const fake = createFakeServer(tcpAddress());
    const promise = startConsole({
      env: buildEnv(),
      handlers: [handler],
      signals: [],
      createServer: () => fake.instance,
      openStore: () => opened,
    });
    fake.emitListening();
    running = await promise;
    return { events };
  }

  test("booting against a real database file persists exactly one store.health row per granularity, each carrying a non-NULL sum_value and an empty script", async () => {
    const { events } = await boot();

    if (store === undefined) {
      throw new Error("the store was not opened");
    }
    // Precondition: the console really did finish booting against the real
    // file-backed store — otherwise the row assertions below would be
    // unfalsifiable rather than true.
    expect(running?.store.location).toBe(store.location);
    expect(store.location).not.toBe(":memory:");

    // One boot sample, three granularity tiers, one dimension combination.
    expect(countMetricRows(store.telemetry, "store.health")).toBe(3);
    // Attribution: nothing else produced a row during this boot, so the 3
    // above are the boot sampler's and only the boot sampler's. No request
    // was dispatched and no run was launched.
    expect(countMetricRows(store.telemetry, "http.request")).toBe(0);
    expect(countMetricRows(store.telemetry, "run.finished")).toBe(0);

    for (const granularity of GRANULARITY_TIERS) {
      const rows = storeHealthRowsAt(store.telemetry, granularity);
      // Exactly one row at this tier, not merely "at least one": a second
      // would mean the boot measurement ran more than once.
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined) continue;
      expect(row.granularity).toBe(granularity);
      expect(row.sampleCount).toBe(1);
      expectStoreHealthRowShape(row);

      // THE point of this file: `sum_value` is present. A regression routing
      // this metric through `SQL_UPSERT_COUNTER` would leave it NULL (surfaced
      // as `undefined`) while still landing a row.
      expect(row.sumValue).toBeDefined();
      const sumValue = row.sumValue;
      if (sumValue === undefined) continue;
      // A real, open WAL-mode database always occupies bytes, so a `0` here
      // would mean the sampler fabricated a measurement instead of taking one.
      expect(sumValue).toBeGreaterThan(0);
      // The exact byte count is deliberately NOT pinned — it depends on
      // SQLite's page layout and on how much the boot's own writes have
      // pushed into the `-wal` sidecar, neither of which this slice owns.
      // What IS pinned is that the value survived `requireValidMeasure`.
      expect(Number.isSafeInteger(sumValue)).toBe(true);
      // One sample, so the aggregate columns must all agree with it.
      expect(row.minValue).toBe(sumValue);
      expect(row.maxValue).toBe(sumValue);
    }

    // A repository rejection is otherwise invisible — the store-backed
    // recorder swallows it as a logged warning rather than throwing — so its
    // absence is asserted explicitly, mirroring every sibling e2e file.
    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });

  test("the store.health row lands before the listener is reachable — it is already queryable the moment startConsole resolves", async () => {
    await boot();

    if (store === undefined) {
      throw new Error("the store was not opened");
    }
    // `startConsole` resolving means the bind was verified
    // (`lifecycle/http-server.ts`), so a row present at this instant proves
    // the sampler ran on the pre-bind side of `buildRuntimeAndBindListener` —
    // the same ordering guarantee `reconcileOnBoot` and the audit-index
    // rebuild have. A sampler moved after the bind would leave this at 0 on
    // the synchronous read below while still passing a test that awaited a
    // tick first.
    expect(running?.server.port).toBe(tcpAddress().port);
    expect(countMetricRows(store.telemetry, "store.health")).toBe(3);
  });
});
