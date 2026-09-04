/**
 * Tests for the `src/main.ts` composition seam that wires
 * {@link "../src/telemetry/port.js".M3LTelemetryRecorder} into
 * `M3LConsoleRuntime` (X8 telemetry recorder port, PR 2a, File 4 of the
 * contract).
 *
 * RED: `createConsoleRuntime` does not yet accept an `options.telemetry`
 * (a {@link "../src/store/telemetry-repository.js".M3LConsoleTelemetryRepository})
 * and `M3LConsoleRuntime` does not yet expose a `telemetry` property at all.
 * Every case below is expected to fail — either at typecheck (the object
 * literal passed as `options` carries an excess/unknown `telemetry` key, or
 * `runtime.telemetry` does not exist on the resolved type) or at runtime
 * (`runtime.telemetry` reads back `undefined`) — until the implementer adds
 * both. That is the correct RED reason; nothing here should fail because of
 * a typo or a bad import path.
 *
 * Split into its own file (deliberately NOT added to `tests/main.test.ts`,
 * which sits at 59,503 of a 60,000-byte ceiling) per the PR 2a contract.
 *
 * Isolation: every case here calls only `createConsoleRuntime` — a pure
 * composition step that binds no socket and opens no store — and NEVER
 * `startConsole`. The injected `telemetry` option is always a hand-written
 * fake object satisfying `M3LConsoleTelemetryRepository`; no real
 * `openConsoleStore`/`DatabaseSync` is ever constructed, so this file cannot
 * create or touch `data/console/console.sqlite` (the exact bug already fixed
 * once in `tests/main.test.ts`). The audit root is pointed at an absolute,
 * deliberately-nonexistent path (mirroring `tests/main.test.ts`'s own
 * `buildEnv`) rather than a real `mkdtempSync` directory, since
 * `no-restricted-syntax` bans real filesystem mutations in this package's
 * tests and `createConsoleRuntime` never touches that path eagerly anyway.
 *
 * Logger capture follows `tests/access-log.test.ts:51`'s sanctioned pattern:
 * `Core.M3LLogger` is a class with `#private` fields, so a plain object
 * literal can never satisfy it. Every case that needs to observe a log line
 * passes `handlers: [handler]` into `createConsoleRuntime` (the runtime's
 * OWN `M3LConsoleRuntimeOptions.handlers` seam — "Log sinks the runtime's
 * logger fans events out to") and asserts on the captured
 * `Core.M3LLogEvent`s, never by reaching for the logger directly.
 */
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime } from "../src/main.js";
import type { M3LConsoleRuntimeOptions } from "../src/main.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryMeasurement,
} from "../src/store/telemetry-repository.js";

/**
 * A minimal valid env: the required operator name, plus an audit root that
 * deliberately does NOT exist (mirroring `tests/main.test.ts`'s own
 * `buildEnv`) — `createConsoleRuntime` never reads that path eagerly, so
 * nothing under this env touches the real data dir.
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(
      tmpdir(),
      "m3l-console-telemetry-seam-audit-absent",
    ),
  };
}

/**
 * A capturing `Core.M3LLoggerHandler` — the sanctioned test-double pattern
 * for `M3LLogger` (see this file's own header comment and
 * `tests/access-log.test.ts:51`).
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

/**
 * A hand-written fake `M3LConsoleTelemetryRepository`. `record` throws — the
 * store-backed adapter must fan out through a single `recordAll` call (see
 * `src/telemetry-recorder.ts`), so a call reaching `record` at all would be
 * the wrong adapter, not this seam's concern, but it keeps the fake honest.
 * `recordAllImpl` lets a test control `recordAll`'s return/throw behavior —
 * used below to prove a repository failure never escapes `runtime.telemetry`.
 */
function createFakeTelemetryRepository(
  recordAllImpl: (
    measurements: readonly M3LTelemetryMeasurement[],
  ) => number = (measurements) => measurements.length,
): {
  readonly repository: M3LConsoleTelemetryRepository;
  readonly calls: (readonly M3LTelemetryMeasurement[])[];
} {
  const calls: (readonly M3LTelemetryMeasurement[])[] = [];
  const repository: M3LConsoleTelemetryRepository = {
    record: () => {
      throw new Error("unexpected call to record — expected recordAll only");
    },
    recordAll: (measurements) => {
      calls.push(measurements);
      return recordAllImpl(measurements);
    },
    list: () => [],
    count: () => 0,
    prune: () => 0,
  };
  return { repository, calls };
}

describe("createConsoleRuntime — telemetry seam: store-backed when supplied", () => {
  test("runtime.telemetry is present and a call reaches the injected repository's recordAll", () => {
    const { repository, calls } = createFakeTelemetryRepository();
    const options: M3LConsoleRuntimeOptions = {
      env: buildEnv(),
      telemetry: repository,
    };

    const runtime = createConsoleRuntime(options);

    expect(runtime.telemetry).toBeDefined();
    runtime.telemetry.httpRequest({
      route: "/api/v1/runs",
      outcome: "2xx",
      latencyMs: 12,
    });

    // Proves the store-backed adapter was chosen, not the no-op: the no-op
    // never touches any repository, so a reaching call here can only be
    // explained by `options.telemetry` having been wired through.
    expect(calls).toHaveLength(1);
  });
});

describe("createConsoleRuntime — telemetry seam: no-op when omitted", () => {
  test("runtime.telemetry is still present and calling a method neither throws nor reaches any repository", () => {
    const options: M3LConsoleRuntimeOptions = { env: buildEnv() };

    const runtime = createConsoleRuntime(options);

    expect(runtime.telemetry).toBeDefined();
    // No repository was supplied at all — a storeless console
    // (`M3LConsoleRuntimeOptions.store` is already optional) still has to
    // satisfy the port, per `telemetry/no-op.ts`'s own contract.
    expect(() => {
      runtime.telemetry.httpRequest({
        route: "/api/v1/runs",
        outcome: "2xx",
        latencyMs: 12,
      });
    }).not.toThrow();
    expect(() => {
      runtime.telemetry.storeHealth({ sizeBytes: 4_096 });
    }).not.toThrow();
  });
});

describe("createConsoleRuntime — telemetry seam: a repository failure never escapes the runtime", () => {
  test("a recordAll throw is caught and logged through the runtime's own logger, never rethrown to the caller", () => {
    const { repository } = createFakeTelemetryRepository(() => {
      throw new Error("recordAll boom");
    });
    const { handler, events } = buildCapturingHandler();
    const options: M3LConsoleRuntimeOptions = {
      env: buildEnv(),
      handlers: [handler],
      telemetry: repository,
    };

    const runtime = createConsoleRuntime(options);
    events.length = 0; // Drop the unrelated posture log line emitted by createConsoleRuntime itself.

    expect(() => {
      runtime.telemetry.httpRequest({
        route: "/api/v1/runs",
        outcome: "2xx",
        latencyMs: 12,
      });
    }).not.toThrow();

    const drops = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(drops).toHaveLength(1);
    const [drop] = drops;
    if (drop === undefined) {
      throw new Error("expected exactly one error event");
    }
    expect(JSON.stringify(drop)).toContain("http.request");
  });
});
