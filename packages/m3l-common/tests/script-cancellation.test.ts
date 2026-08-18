/**
 * Integration tests for cooperative cancellation (ADR-0049).
 *
 * Contract source: docs/adr/0049-cooperative-cancellation-contract.md,
 *   docs/reference/core/script.md#cooperative-cancellation-scriptsignal
 *
 * These tests exercise the end-to-end cancellation path:
 *   - `M3LScript` owns an `AbortController`; `script.signal` exposes it.
 *   - On the first shutdown signal the controller is aborted BEFORE runCleanup.
 *   - A `M3LPoller` constructed with `signal: script.signal` rejects mid-wait
 *     with `M3LOperationAbortedError` when the signal fires.
 *   - `runScript()` maps that rejection to `outcome:"interrupted"` and
 *     `process.exitCode = M3L_EXIT_CODES.INTERRUPTED` (5), rather than routing
 *     it through `mapErrorToExitCode` which would yield CONFIG_USAGE (2).
 *
 * All tests are deterministic: no real network or filesystem; fake timers
 * where needed; the shutdown signal is driven through the same captured-handler
 * seam the existing `script.test.ts` signal-handling tests use.
 */

import * as fsPromises from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Prevent real filesystem writes from stage-9 archival (M3LFileCopier uses
// node:fs/promises for mkdir/copyFile) — same guard as script.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
  return { ...actual };
});

import { M3LOperationAbortedError } from "../src/core/errors/index.js";
import {
  M3LDeploymentMode,
  M3LExecutionEnvironment,
  M3LExecutionEnvironmentType,
  M3LCredentialSource,
} from "../src/core/environment/index.js";
import type { M3LExecutionEnvironmentInfo } from "../src/core/environment/index.js";
import { M3LBackoff, M3LPoller } from "../src/core/polling/index.js";
import {
  M3L_EXIT_CODES,
  M3LRunReporter,
} from "../src/core/diagnostics/index.js";
import type { M3LRunReportInput } from "../src/core/diagnostics/index.js";
import { M3LScript, runScript } from "../src/core/script/index.js";
import type { M3LScriptMetadata } from "../src/core/script/index.js";

// ---------------------------------------------------------------------------
// Shared fixtures (mirror script.test.ts patterns)
// ---------------------------------------------------------------------------

const metadata: M3LScriptMetadata = {
  name: "test-cancellation-script",
  version: "1.0.0",
};

function makeNonAwsEnvironmentInfo(
  overrides: Partial<M3LExecutionEnvironmentInfo> = {},
): M3LExecutionEnvironmentInfo {
  const base = {
    environmentType: M3LExecutionEnvironmentType.CI,
    isInteractive: false,
    isAWSManaged: false,
    canPromptUser: false,
    canOpenBrowser: false,
    requiresAwsProfile: false,
    credentialSource: M3LCredentialSource.ENVIRONMENT,
    detectionDetails: {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      isCiEnvironment: true,
      hasLambdaTaskRoot: false,
      hasEcsMetadataUri: false,
      hasCodeBuildBuildId: false,
      workspaceMarkerPath: undefined,
    },
    deploymentMode: M3LDeploymentMode.STANDALONE,
    monorepoRoot: undefined,
  } satisfies M3LExecutionEnvironmentInfo;
  return { ...base, ...overrides } as M3LExecutionEnvironmentInfo;
}

function stubNonAwsEnvironment(): void {
  const info = makeNonAwsEnvironmentInfo();
  vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(info);
  vi.spyOn(M3LExecutionEnvironment, "detectFresh").mockReturnValue(info);
}

// Block real process signal listeners from being registered — every test
// captures the handlers it needs via a local vi.spyOn(process, "on").
beforeEach(() => {
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(process, "once").mockImplementation(() => process);
  vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fsPromises, "copyFile").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Prevent a leaked non-zero exitCode from corrupting the suite.
  process.exitCode = undefined;
});

// =============================================================================
// End-to-end integration — shutdown signal → M3LPoller abort → interrupted
//
// This is the verify clause from ADR-0049: a runScript whose body awaits an
// abortable M3LPoller with `signal: script.signal` and a check that always
// returns `continue`; the shutdown signal is fired mid-wait; the run resolves
// with outcome:"interrupted" and process.exitCode 5 (INTERRUPTED).
// =============================================================================
describe("runScript() — cooperative cancellation end-to-end (ADR-0049)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a runScript body awaiting a M3LPoller with signal:script.signal maps the resulting M3LOperationAbortedError to outcome:interrupted and exit code 5", async () => {
    // Drive time explicitly so the poller's backoff delay does not keep the
    // test alive for real wall-clock time. The abort signal should wake the
    // delay immediately (via AbortSignal's abort event), so advancing past the
    // full delay is a belt-and-braces safeguard, not a prerequisite.
    vi.useFakeTimers();

    // Capture the real SIGTERM handler so we can fire it programmatically.
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        handlers.set(eventName, listener);
        return process;
      },
    );

    // Capture the persisted report input to assert its `outcome` field.
    let capturedInput: M3LRunReportInput | undefined;
    vi.spyOn(M3LRunReporter.prototype, "persist").mockImplementation(
      (input: M3LRunReportInput) => {
        capturedInput = input;
        return Promise.resolve("/fake/report.json");
      },
    );

    stubNonAwsEnvironment();
    const script = new M3LScript({ metadata });

    // Verify the signal accessor exists before starting the async dance —
    // an absent getter (pre-implementation) returns undefined, and the
    // assertion below terminates the test cleanly without hanging.
    // RED failure expected here: "Expected undefined to be an instance of AbortSignal"
    expect(script.signal).toBeInstanceOf(AbortSignal);

    // A poller that never terminates on its own: the check always returns
    // `continue`. Only the abort signal (delivered below via SIGTERM) should
    // stop it. The `signal` option is the new ADR-0049 addition to
    // M3LPollerOptions — not present in the current implementation.
    const poller = new M3LPoller({
      backoff: M3LBackoff.constant(30_000),
      maxAttempts: 1_000,
      signal: script.signal, // ADR-0049: new option, not yet implemented → RED
    });

    // Start the run WITHOUT awaiting — we need to interleave the SIGTERM.
    const runPromise = runScript(script, async () => {
      await poller.poll((): { type: "continue" } => ({ type: "continue" }));
    });

    // Drain the microtask queue so the pipeline reaches mainFn and the
    // poller starts its first backoff delay. Four hops cover the async stages.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Fire the first SIGTERM: this should abort `script.signal`, causing the
    // in-flight delay to reject with M3LOperationAbortedError rather than
    // sleeping out the full 30 s. The abort wakes the delay via the AbortSignal
    // `abort` event — intentionally NOT advancing the timer here, so the test
    // proves the delay was abandoned, not expired.
    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();

    // Drain microtasks so abort-event handlers and M3LPoller's rejection path
    // propagate before runScript's catch block runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Now await the run — it must resolve (never reject) regardless of the
    // cancellation, per the runScript() contract.
    await runPromise;

    // The report outcome must be "interrupted", not "failure".
    expect(capturedInput).toBeDefined();
    expect(capturedInput?.outcome).toBe("interrupted");

    // The process exit code must be INTERRUPTED (5), not CONFIG_USAGE (2).
    expect(process.exitCode).toBe(M3L_EXIT_CODES.INTERRUPTED);
  });

  // Complementary regression: a run that completes normally after a prior
  // M3LOperationAbortedError run on the same script instance must still
  // report "success" — the `interrupted` classification is per-throw, not
  // sticky on the instance.
  test("a subsequent successful runScript on the same script instance reports outcome:success (interrupted outcome is per-throw, not sticky)", async () => {
    vi.useFakeTimers();

    const persistSpy = vi
      .spyOn(M3LRunReporter.prototype, "persist")
      .mockResolvedValue("/fake/report.json");

    stubNonAwsEnvironment();
    const script = new M3LScript({ metadata });

    // Run 1: mainFn throws M3LOperationAbortedError directly (simpler than
    // driving a full poller abort — proves the outcome mapping is per-error,
    // not per-instance).
    await runScript(script, () => {
      throw new M3LOperationAbortedError("cancelled");
    });

    expect(process.exitCode).toBe(M3L_EXIT_CODES.INTERRUPTED);
    process.exitCode = undefined;
    persistSpy.mockClear();

    // Run 2: clean success — must not be contaminated by the prior abort.
    await runScript(script, () => {});

    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
    expect(input.outcome).toBe("success");
    expect(process.exitCode).toBeUndefined();
  });
});
