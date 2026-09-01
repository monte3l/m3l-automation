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

import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { createConsoleRuntime } from "../src/main.js";

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
