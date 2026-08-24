/**
 * `core/script/run-script` and `core/script/M3LScript` — production secrets
 * redaction wiring (F20 / tracker row F20, GitHub issue #517).
 *
 * `runScript()` derives a `secrets` port from `script.configSchema` (via
 * `deriveSecretsSpecifier`) and threads it into the `M3LRunReporter` it
 * constructs internally, and into both of `persistBestEffort`'s best-effort
 * diagnostic call sites (`run-report-build-failed` / `run-report-persist-
 * rejected`). `M3LScript` derives the same `secrets` value once at
 * construction and threads it into its own two best-effort hook diagnostics
 * (`runOnErrorBestEffort` / `runCleanup`).
 *
 * This file is the END-TO-END proof that the injection actually happens in
 * the real production entry points — as opposed to `run-report-secrets.test.ts`,
 * which proves `M3LRunReporterOptions.secrets` works in isolation on a
 * directly-constructed `M3LRunReporter`. Every "with schema" case here is
 * paired with a "without schema" arm proving the exact same value leaks
 * verbatim — a redacted-only assertion would be a proxy per this repo's
 * `tests.md`.
 *
 * Also covers the two remaining production leak sites closed alongside this
 * one (GitHub issue #517 / tracker row F20): `core/script/process-guards.ts`'s
 * three fault-guard handlers (`unhandledRejection`/`uncaughtException`/
 * `warning`), which now consult a monotonic, append-only, process-global
 * secret-name union (`secretNameUnion`, widened only via
 * `addProcessGuardSecretNames`) — populated by BOTH `runScript()` (once per
 * run, from its own derived `secrets` specifier) AND `M3LScript`'s
 * constructor (unconditionally, from its own derived `this.secrets`, right
 * after it is assigned) — into their diagnostics, so a script driven via
 * `createLambdaHandler()` or a bare `script.run()` (neither of which ever
 * calls `runScript()`) still widens the union; and
 * `internal/script/signalHandlers.ts`'s `registerShutdownSignals`, whose
 * `onShutdown`-failure diagnostic now accepts an optional `secrets` second
 * parameter, threaded in by `M3LScript`'s constructor.
 *
 * The `persistBestEffort` section below deliberately does NOT mock
 * `M3LRunReporter.prototype.persist` in its `run-report-build-failed` cases —
 * that would skip `build()`, the very step that performs the redaction, and
 * would only prove what was passed in, never what redaction produced. The one
 * exception is the `run-report-persist-rejected` case, which needs
 * `persist()` itself to reject; that diagnostic's redaction happens in
 * `logBestEffortDiagnostic` (over the serialized rejection reason), not in
 * `build()`, so mocking `persist()` there does not skip the step under test.
 */

import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Configurable-namespace wrapper (mirrors tests/script.test.ts): keeps every
// real fs/promises behavior by default (mkdtemp/rm used for real, disposable
// tmp directories below) while letting one describe block below `vi.spyOn`
// `mkdir`/`copyFile` to no-ops for tests that don't care about archival I/O.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
  return { ...actual };
});

import {
  M3LConfigParameter,
  M3LConfigParameterType,
} from "../src/core/config/index.js";
import {
  M3LRunReporter,
  type M3LRunReport,
} from "../src/core/diagnostics/index.js";
import { M3LError } from "../src/core/errors/index.js";
import type { M3LSecretNamesPort } from "../src/core/logging/redact.js";
import {
  M3LScript,
  runScript,
  type M3LScriptMetadata,
} from "../src/core/script/index.js";
// `registerShutdownSignals` is an internal (non-barrel-exported) helper,
// imported directly for the same reason `tests/script.test.ts` does: its
// `onShutdown`-failure diagnostic (the `.catch()` branch) can only be
// exercised by invoking a captured signal handler directly, never through
// `M3LScript`'s public surface (which always swallows its own `onCleanup`
// errors before they reach `onShutdown`).
import { registerShutdownSignals } from "../src/internal/script/signalHandlers.js";
// Namespace import alongside the named one above, used ONLY by the
// "real constructor wiring" test in section 2 below to `vi.spyOn` the
// module's own `registerShutdownSignals` export — capturing what
// `M3LScript.ts`'s constructor actually passes as its second argument at
// its real call site, rather than proving only that the function's own
// `secrets` parameter is honoured when called directly (as the rest of
// this describe block already does).
import * as signalHandlersModule from "../src/internal/script/signalHandlers.js";

const metadata: M3LScriptMetadata = {
  name: "test-script",
  version: "1.0.0",
};

/** A fresh config declaring a single secret parameter under a heuristic-unmatched name. */
function secretConfig(): { params: readonly M3LConfigParameter[] } {
  return secretConfigNamed("tenantRef");
}

/**
 * A fresh config declaring a single secret parameter under an
 * arbitrary, caller-chosen name — used by the process-guards describe
 * block below, whose tests each need a secret name never declared by any
 * other test in this file (the process-guards secret-name union is a
 * monotonic, module-global `Set` with no test-only reset hook).
 */
function secretConfigNamed(name: string): {
  params: readonly M3LConfigParameter[];
} {
  return {
    params: [
      new M3LConfigParameter({
        name,
        type: M3LConfigParameterType.STRING,
        secret: true,
      }),
    ],
  };
}

// Every describe block below constructs at least one `M3LScript` and either
// calls `script.run()` or `runScript()`, both of which install real
// `SIGTERM`/`SIGINT`/`SIGQUIT` listeners on `process` in a non-AWS
// environment (this test runner). Mocked file-wide, mirroring
// tests/script.test.ts's own global guard, so no test here leaks a real
// listener onto the shared test-runner process.
beforeEach(() => {
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(process, "once").mockImplementation(() => process);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

// =============================================================================
// 0. core/script/process-guards — fault-guard diagnostics honor runScript()'s
//    derived secrets port (differential)
// =============================================================================
// `installProcessGuards()` is an idempotent, process-global singleton (see
// its own TSDoc) with no test-only reset hook — only the very FIRST call to
// `runScript()` anywhere in this file's process actually invokes the real
// `process.on("unhandledRejection", ...)` registration; every later call is
// a no-op that leaves the already-registered handler in place
// (`tests/script.test.ts`'s own `installProcessGuards()` describe block
// documents the identical constraint). This block is deliberately placed
// FIRST in the file so its own `process.on` override is the one that
// captures the real handler function, and BOTH differential arms below
// invoke that SAME captured reference directly — the same whitebox
// capture-and-invoke pattern `script.test.ts` already established for
// `registerShutdownSignals`'s signal handlers, chosen over racing a real
// floating-promise rejection against Node's own unhandled-rejection
// detection timing, and over letting a real listener land on the actual
// test-runner process (this mock never calls through to the real
// `process.on`, so no listener is ever installed on the real process here).
describe("core/script/process-guards — fault-guard diagnostics honor runScript()'s derived secrets port (differential)", () => {
  let outDir: string;
  let unhandledRejectionHandler: ((reason: unknown) => void) | undefined;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-script-secrets-guard-"));
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        if (eventName === "unhandledRejection") {
          unhandledRejectionHandler = listener;
        }
        return process;
      },
    );
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function makeScript(config?: {
    params: readonly M3LConfigParameter[];
  }): M3LScript {
    vi.stubEnv("M3L_OUTPUT_DIR", outDir);
    return new M3LScript({
      metadata,
      ...(config === undefined ? {} : { config }),
    });
  }

  /**
   * Runs `script` via `runScript()`, invokes the captured
   * `unhandledRejection` handler with an `Error` whose message is
   * `message`, and returns everything written to stderr across the run.
   */
  async function triggerUnhandledRejection(
    script: M3LScript,
    message: string,
  ): Promise<string> {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runScript(script, () => {
      expect(unhandledRejectionHandler).toBeDefined();
      unhandledRejectionHandler?.(new Error(message));
    });

    return stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("\n");
  }

  test("without a declared-secret schema, the unhandledRejection diagnostic leaks the embedded value", async () => {
    // Uses a secret-name literal declared by NO other test anywhere in
    // this file. The process-guards secret-name union is a monotonic,
    // module-global `Set` with no test-only reset hook (see this describe
    // block's own comment above), so reusing a name any other "with
    // schema" test in this file registers (e.g. `tenantRef`, used
    // pervasively below) would make this leak assertion pass or fail
    // depending on whether that other test already ran — not on the
    // actual behavior under test.
    const script = makeScript();
    const written = await triggerUnhandledRejection(
      script,
      // No colon immediately precedes the secret name, per
      // `redactSensitiveLogText`'s documented bare-key=value pass-1
      // limitation (a preceding non-sensitive `key:` swallows the rest of
      // the line) — the same phrasing rule section 3 below follows.
      "floating rejection with process-guards-control-unregistered=guard-secret-value",
    );
    expect(written).toContain("unhandledRejection");
    expect(written).toContain(
      "process-guards-control-unregistered=guard-secret-value",
    );
  });

  test("with a declared-secret schema, the unhandledRejection diagnostic redacts the embedded value", async () => {
    const script = makeScript(secretConfigNamed("tenantRef"));
    const written = await triggerUnhandledRejection(
      script,
      "floating rejection with tenantRef=guard-secret-value",
    );
    expect(written).toContain("unhandledRejection");
    expect(written).not.toContain("guard-secret-value");
    expect(written).toContain("tenantRef=[REDACTED]");
  });

  test("a later schema-less run does not evict an earlier run's registered secret from the union (regression)", async () => {
    // Proves the original leak class stays fixed: a security review found
    // that both a clear-on-exit AND an unconditional set-on-entry
    // single-slot design let a later, unrelated `runScript()` call evict
    // an earlier call's registered secret names. Run 1 registers
    // "union-persists-secret" via a declared schema; Run 2 is a separate,
    // LATER, schema-less `runScript()` call, which must contribute
    // nothing and must NOT evict Run 1's registration.
    const run1 = makeScript(secretConfigNamed("union-persists-secret"));
    await runScript(run1, () => {});

    const run2 = makeScript();
    const written = await triggerUnhandledRejection(
      run2,
      "floating rejection with union-persists-secret=some-value",
    );

    expect(written).toContain("unhandledRejection");
    expect(written).not.toContain("some-value");
    expect(written).toContain("union-persists-secret=[REDACTED]");
  });

  test("a later run with a different schema does not evict an earlier run's registered secret from the union (regression)", async () => {
    // Run 1 registers "union-a-secret"; Run 2, a separate, later
    // `runScript()` call, registers a DIFFERENT name ("union-b-secret")
    // without declaring "union-a-secret" — the union must retain BOTH,
    // proving Run 2's own registration doesn't evict Run 1's.
    const run1 = makeScript(secretConfigNamed("union-a-secret"));
    await runScript(run1, () => {});

    const run2 = makeScript(secretConfigNamed("union-b-secret"));
    await runScript(run2, () => {});

    const run3 = makeScript();
    const written = await triggerUnhandledRejection(
      run3,
      "floating rejection with union-a-secret=value-a and union-b-secret=value-b",
    );

    expect(written).toContain("unhandledRejection");
    expect(written).not.toContain("value-a");
    expect(written).not.toContain("value-b");
    expect(written).toContain("union-a-secret=[REDACTED]");
    expect(written).toContain("union-b-secret=[REDACTED]");
  });

  test("M3LScript's constructor alone registers its own declared secrets into the union, reachable without ever calling runScript() (real constructor wiring)", () => {
    // `unhandledRejectionHandler` here is the SAME real handler captured
    // once, by the very first test in this describe block's own
    // `runScript()` call — `installProcessGuards()` is a process-global,
    // idempotent singleton with no per-test reset, so it is already
    // available to every later test in this block. This test deliberately
    // never calls `runScript()` for ITS OWN script instance: the point is
    // proving `M3LScript`'s constructor call to `addProcessGuardSecretNames`
    // (right after `this.secrets` is assigned) registers the name on its
    // own, independent of `runScript()` — the exact gap a script driven via
    // `createLambdaHandler()` or a bare `script.run()` used to fall through.
    expect(unhandledRejectionHandler).toBeDefined();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    makeScript(secretConfigNamed("m3lscript-ctor-secret"));

    unhandledRejectionHandler?.(
      new Error(
        "floating rejection with m3lscript-ctor-secret=ctor-secret-value",
      ),
    );

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("unhandledRejection");
    expect(written).not.toContain("ctor-secret-value");
    expect(written).toContain("m3lscript-ctor-secret=[REDACTED]");
  });
});

// =============================================================================
// 1. runScript() end-to-end — build() redaction via a real M3L_OUTPUT_DIR
//    (differential)
// =============================================================================
describe("runScript() end-to-end — the persisted report's failure context (differential)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-script-secrets-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  /**
   * `M3LPaths` snapshots `M3L_OUTPUT_DIR` at construction time, so the env
   * var must be stubbed BEFORE `new M3LScript(...)` runs. Real `mkdir`/
   * `writeFile` calls made by `M3LRunReporter.persist()` and stage 9's file
   * archival both land inside this disposable tmp directory only.
   */
  function makeScript(withSecretSchema: boolean): M3LScript {
    vi.stubEnv("M3L_OUTPUT_DIR", outDir);
    return new M3LScript({
      metadata,
      ...(withSecretSchema ? { config: secretConfig() } : {}),
    });
  }

  test("without a declared-secret schema, the failure context leaks the declared value verbatim", async () => {
    // `build()` is spied but NOT given a `mockImplementation` — it still
    // runs for real (called internally by the real, unmocked `persist()`),
    // so `.mock.results[0].value` is the genuine, unmocked `M3LRunReport`
    // that redaction produced (or, here, failed to produce).
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript(false);

    await runScript(script, () => {
      throw new M3LError("boom", {
        code: "ERR_CONFIG_MISSING",
        context: { tenantRef: "prod-secret-value" },
      });
    });

    expect(buildSpy).toHaveBeenCalledTimes(1);
    const report = buildSpy.mock.results[0]?.value as M3LRunReport | undefined;
    expect(report?.failure?.chain[0]?.context?.["tenantRef"]).toBe(
      "prod-secret-value",
    );
    expect(JSON.stringify(report)).toContain("prod-secret-value");
  });

  test("with a declared-secret schema, the failure context is redacted", async () => {
    const buildSpy = vi.spyOn(M3LRunReporter.prototype, "build");
    const script = makeScript(true);

    await runScript(script, () => {
      throw new M3LError("boom", {
        code: "ERR_CONFIG_MISSING",
        context: { tenantRef: "prod-secret-value" },
      });
    });

    expect(buildSpy).toHaveBeenCalledTimes(1);
    const report = buildSpy.mock.results[0]?.value as M3LRunReport | undefined;
    expect(report?.failure?.chain[0]?.context?.["tenantRef"]).toBe(
      "[REDACTED]",
    );
    expect(JSON.stringify(report)).not.toContain("prod-secret-value");
  });
});

// =============================================================================
// 2. internal/script/signalHandlers — the onShutdown-failure diagnostic
//    carries the caller-supplied secrets port (differential)
// =============================================================================
// Sending a real OS signal to the test-runner process (`process.kill(pid,
// "SIGTERM")`) is intrusive and risks side effects on the runner itself.
// `tests/script.test.ts` already establishes the safe alternative for this
// exact function: capture the handler `registerShutdownSignals` passes to
// `process.on` via a mocked implementation, then invoke it directly and let
// its internal fire-and-forget `.then().catch()` chain settle on the
// microtask queue — mirrored here rather than invented fresh.
describe("internal/script/signalHandlers — the onShutdown-failure diagnostic carries the caller-supplied secrets port (differential)", () => {
  async function triggerOnShutdownFailure(
    secrets: M3LSecretNamesPort | undefined,
  ): Promise<string> {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        if (typeof eventName === "string") {
          handlers.set(eventName, listener);
        }
        return process;
      },
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const onShutdown = (): Promise<void> =>
      Promise.reject(
        new Error("shutdown hook failed with tenantRef=shutdown-secret-value"),
      );

    registerShutdownSignals(onShutdown, secrets);

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();

    // Fire-and-forget: `onShutdown()` here returns an already-rejected
    // promise, so the internal `Promise.resolve().then(() =>
    // onShutdown()).catch(...)` chain needs the thenable-resolution
    // procedure's extra microtask hop on top of the two `.then`/`.catch`
    // hops — a fixed small count of `await Promise.resolve()` ticks is
    // fragile against that, so flush the ENTIRE microtask queue via a
    // `setImmediate` macrotask boundary instead (Node always drains all
    // pending microtasks before running a `setImmediate` callback).
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    return stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("\n");
  }

  test("without a secrets port, the onShutdown-failure diagnostic leaks the embedded value", async () => {
    const written = await triggerOnShutdownFailure(undefined);
    expect(written).toContain("onShutdown");
    expect(written).toContain("tenantRef=shutdown-secret-value");
  });

  test("with a secrets port, the onShutdown-failure diagnostic redacts the embedded value", async () => {
    const written = await triggerOnShutdownFailure({
      isSecret: (name) => name === "tenantRef",
    });
    expect(written).toContain("onShutdown");
    expect(written).not.toContain("shutdown-secret-value");
    expect(written).toContain("tenantRef=[REDACTED]");
  });

  test("M3LScript's constructor passes its own derived `this.secrets` as registerShutdownSignals's real second argument (real constructor wiring)", () => {
    // The two tests above call `registerShutdownSignals` directly with a
    // hand-constructed `secrets` port, which only proves the FUNCTION
    // honours its own parameter — not that `M3LScript.ts`'s constructor
    // actually passes `this.secrets` at its real call site
    // (`registerShutdownSignals(() => { ...; return
    // this.runCleanup("signal-shutdown"); }, this.secrets)`). Spying on the
    // module's own export (rather than re-deriving the whole signal-fires
    // -> onShutdown-rejects -> stderr flow already covered above) captures
    // exactly what the constructor passed, with no other production
    // behavior mocked away.
    const registerShutdownSignalsSpy = vi.spyOn(
      signalHandlersModule,
      "registerShutdownSignals",
    );

    new M3LScript({
      metadata,
      config: secretConfigNamed("shutdown-ctor-wiring-secret"),
    });

    expect(registerShutdownSignalsSpy).toHaveBeenCalledTimes(1);
    const passedSecrets = registerShutdownSignalsSpy.mock.calls[0]?.[1];
    expect(passedSecrets).toBeDefined();
    expect(passedSecrets?.isSecret("shutdown-ctor-wiring-secret")).toBe(true);
    expect(passedSecrets?.isSecret("some-unrelated-name")).toBe(false);
  });
});

// =============================================================================
// 3. M3LScript's own best-effort hook diagnostics (differential)
// =============================================================================
describe("M3LScript — best-effort hook diagnostics carry the derived secrets port (differential)", () => {
  // Mirrors tests/script.test.ts's own global archival guard: every
  // `script.run()` call below reaches stage 9 (file archival) regardless of
  // outcome, and an unmocked `mkdir`/`copyFile` would either write into this
  // real repo's `data/output/` or fail unpredictably across platforms. These
  // tests only assert on stderr diagnostics, so archival I/O is a no-op.
  beforeEach(() => {
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "copyFile").mockResolvedValue(undefined);
  });

  describe("onError hook failure", () => {
    function makeScript(withSecretSchema: boolean): M3LScript {
      return new M3LScript({
        metadata,
        ...(withSecretSchema ? { config: secretConfig() } : {}),
        hooks: {
          onError: () => {
            throw new M3LError("onError blew up", {
              code: "ERR_TEST_HOOK",
              context: { tenantRef: "hook-secret-value" },
            });
          },
        },
      });
    }

    test("without a declared-secret schema, the stderr diagnostic leaks the declared value", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const script = makeScript(false);

      let thrown: unknown;
      try {
        await script.run(() => {
          throw new Error("original failure");
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);

      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("onError hook failure");
      expect(written).toContain("hook-secret-value");
    });

    test("with a declared-secret schema, the stderr diagnostic redacts the declared value", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const script = makeScript(true);

      let thrown: unknown;
      try {
        await script.run(() => {
          throw new Error("original failure");
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);

      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("onError hook failure");
      expect(written).not.toContain("hook-secret-value");
      expect(written).toContain("[REDACTED]");
    });
  });

  describe("onCleanup hook failure", () => {
    function makeScript(withSecretSchema: boolean): M3LScript {
      return new M3LScript({
        metadata,
        ...(withSecretSchema ? { config: secretConfig() } : {}),
        hooks: {
          onCleanup: () => {
            throw new M3LError("onCleanup blew up", {
              code: "ERR_TEST_HOOK",
              context: { tenantRef: "cleanup-secret-value" },
            });
          },
        },
      });
    }

    test("without a declared-secret schema, the stderr diagnostic leaks the declared value", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const script = makeScript(false);

      let thrown: unknown;
      try {
        await script.run(() => {
          throw new Error("original failure");
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);

      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("onCleanup failure");
      expect(written).toContain("cleanup-secret-value");
    });

    test("with a declared-secret schema, the stderr diagnostic redacts the declared value", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const script = makeScript(true);

      let thrown: unknown;
      try {
        await script.run(() => {
          throw new Error("original failure");
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);

      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("onCleanup failure");
      expect(written).not.toContain("cleanup-secret-value");
      expect(written).toContain("[REDACTED]");
    });
  });
});

// =============================================================================
// 4. runScript()'s persistBestEffort — run-report-build-failed diagnostic
//    (differential)
// =============================================================================
describe("runScript()'s persistBestEffort — run-report-build-failed diagnostic (differential)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(
      join(tmpdir(), "m3l-run-script-secrets-build-failed-"),
    );
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function makeScript(withSecretSchema: boolean): M3LScript {
    vi.stubEnv("M3L_OUTPUT_DIR", outDir);
    return new M3LScript({
      metadata,
      ...(withSecretSchema ? { config: secretConfig() } : {}),
    });
  }

  // A bare `key=value` pair with no preceding colon, per
  // `redactSensitiveLogText`'s documented pass-1 limitation (a preceding
  // non-sensitive `key:` swallows the rest of the line) — the exact
  // phrasing `run-report-secrets.test.ts` already worked around.
  const throwingTrail = {
    entries: () => {
      throw new Error("trail read failed with tenantRef=persist-secret-value");
    },
  };

  test("without a declared-secret schema, the build-failure diagnostic leaks the embedded value", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = makeScript(false);

    await runScript(script, () => {}, { trail: throwingTrail });

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("run-report-build-failed");
    expect(written).toContain("tenantRef=persist-secret-value");
  });

  test("with a declared-secret schema, the build-failure diagnostic redacts the embedded key=value pair", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = makeScript(true);

    await runScript(script, () => {}, { trail: throwingTrail });

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("run-report-build-failed");
    expect(written).not.toContain("persist-secret-value");
    expect(written).toContain("tenantRef=[REDACTED]");
  });
});

// =============================================================================
// 5. runScript()'s persistBestEffort — run-report-persist-rejected diagnostic
//    (differential)
// =============================================================================
// Distinct from section 4 above: this fires when `reporter.persist(input)`
// itself rejects, AFTER `buildInput()` already succeeded — not when
// `buildInput()` throws. `M3LRunReporter.prototype.persist` is mocked here
// (unlike section 1's build()-redaction tests) because the redaction under
// test happens in `logBestEffortDiagnostic` over the serialized rejection
// reason, not inside `build()`; mocking `persist()` to reject does not skip
// any step this test needs to exercise.
describe("runScript()'s persistBestEffort — run-report-persist-rejected diagnostic (differential)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(
      join(tmpdir(), "m3l-run-script-secrets-persist-rejected-"),
    );
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function makeScript(withSecretSchema: boolean): M3LScript {
    vi.stubEnv("M3L_OUTPUT_DIR", outDir);
    return new M3LScript({
      metadata,
      ...(withSecretSchema ? { config: secretConfig() } : {}),
    });
  }

  test("without a declared-secret schema, the persist-rejection diagnostic leaks the embedded value", async () => {
    vi.spyOn(M3LRunReporter.prototype, "persist").mockRejectedValue(
      new Error("persist failed with tenantRef=persist-rejected-secret"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = makeScript(false);

    await runScript(script, () => {});

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("run-report-persist-rejected");
    expect(written).toContain("tenantRef=persist-rejected-secret");
  });

  test("with a declared-secret schema, the persist-rejection diagnostic redacts the embedded key=value pair", async () => {
    vi.spyOn(M3LRunReporter.prototype, "persist").mockRejectedValue(
      new Error("persist failed with tenantRef=persist-rejected-secret"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = makeScript(true);

    await runScript(script, () => {});

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("run-report-persist-rejected");
    expect(written).not.toContain("persist-rejected-secret");
    expect(written).toContain("tenantRef=[REDACTED]");
  });
});
