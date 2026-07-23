/**
 * Tests for core/script submodule.
 *
 * Contract source: docs/reference/core/script.md
 * Exports under test: M3LScript, M3LScriptOptions, M3LScriptMetadata,
 *   M3LScriptLifecycleHooks, M3LScriptHookContext, M3LScriptConfigLoader,
 *   M3LScriptPresetLoader, M3LPresetUnknownKeysError, M3LPresetCycleError,
 *   installProcessGuards, serializeError, setProcessGuardRequestId,
 *   AWS_PROFILE_PARAM_NAME, AWS_REGION_PARAM_NAME (14 symbols).
 *
 * Key behavioral contracts:
 *  - M3LScript wires config, logging, prompts, and AWS client provisioning
 *    from a single M3LScriptOptions.
 *  - run(mainFn) drives a 9-stage pipeline: env detect -> onBeforeInit/
 *    onAfterInit -> config load -> onBeforeConfigLoad/onAfterConfigLoad ->
 *    AWS provisioning seam (only when an aws.profile param is declared) ->
 *    onBeforeRun -> mainFn -> onAfterRun/onCleanup -> file archival.
 *  - onError fires when any stage throws.
 *  - createLambdaHandler<TEvent, TResult, TContext = unknown> wraps the same
 *    pipeline; resets initialized/configLoaded + clears config store per
 *    invocation; does NOT reset the provisioned `aws` facade — it is
 *    constructed once per `M3LScript` instance and reused across warm
 *    invocations.
 *  - Signal handlers (SIGTERM/SIGINT/SIGQUIT) install only in non-AWS
 *    environments; a second signal forces process.exit(1).
 *  - installProcessGuards() is an idempotent process-global singleton
 *    installing unhandledRejection/uncaughtException/warning/beforeExit.
 *  - serializeError(unknown) never throws and is always JSON-serializable.
 *  - M3LScriptPresetLoader enforces max nesting depth 64 and gives
 *    Damerau-Levenshtein "did you mean" suggestions for unknown keys, via
 *    M3LPresetUnknownKeysError (an M3LError subclass).
 *  - WS-F: a preset may declare a top-level `extends: <path>` resolved
 *    relative to the extending FILE's directory (not CWD). Base + derived are
 *    SHALLOW-merged (derived top-level keys wholly replace the base's; a
 *    nested object/array is replaced as a unit, never deep-merged); `extends`
 *    chains (deepest base first, nearest override wins) and is stripped from
 *    the result. A cycle or a chain deeper than MAX_PRESET_EXTENDS_DEPTH (16)
 *    throws M3LPresetCycleError (code ERR_PRESET_CYCLE) whose
 *    context.chain/`chain` getter is the ordered resolved-path cycle.
 *    Unknown-key/depth validation runs on the fully merged record.
 *
 * Assumptions documented where the contract is spec-silent (see individual
 * comments): `M3LScript` exposes a public `get aws(): AWSProvider | undefined`
 * getter. It is `undefined` until stage 5 of `run()` provisions it — which
 * only happens when the config schema declares an `aws.profile` parameter —
 * and, once provisioned, is memoized for the instance's lifetime (not cleared
 * by `resetForInvocation`, so warm `createLambdaHandler` invocations reuse the
 * same `AWSProvider`). `M3LScriptOptions`'s exact config-schema field key is
 * spec-silent; we assume a `config: { params: readonly M3LConfigParameter[] }`
 * shape mirroring the config module's own `M3LConfigSchema` constructor
 * argument, and keep every assertion behavior-based rather than shape-based
 * wherever the module under test allows it.
 */

import * as fs from "fs";
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// Make 'fs' configurable so vi.spyOn can intercept individual functions.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual };
});
// `M3LScript`'s own archival step (stage 9) imports "node:fs" directly (not
// "fs") for readdirSync. Vitest's module registry treats the two specifiers
// as distinct mock targets even though Node resolves them to the same
// underlying module, so both need their own configurable-namespace mock and
// their own `vi.spyOn` target (spying on the "fs" binding does not intercept
// calls made through the separately-imported "node:fs" binding).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof nodeFs>("node:fs");
  return { ...actual };
});
// `M3LFileCopier` (invoked internally by stage 9) uses "node:fs/promises" for
// mkdir/copyFile/stat -- mocked so archival tests never touch real disk.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
  return { ...actual };
});
// WS-D: the generated-correlation-id path (docs/reference/core/script.md#correlation-ids)
// calls `crypto.randomUUID()` when `options.correlationId` is omitted. Mocked
// with the same configurable-namespace pattern as the fs mocks above so
// individual tests can `vi.spyOn(nodeCrypto, "randomUUID")` and control the
// generated id deterministically.
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof nodeCrypto>("node:crypto");
  return { ...actual };
});

import { S3Client } from "@aws-sdk/client-s3";

import {
  AWSClientProvider,
  AWSProvider,
  M3LAWSIdentityError,
} from "../src/aws/index.js";
import { M3LError } from "../src/core/errors/index.js";
import {
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigSchema,
  M3LInMemoryConfigProvider,
  M3LPresetConfigProvider,
  M3LUnsafeConfigKeyError,
} from "../src/core/config/index.js";
import {
  M3LDeploymentMode,
  M3LExecutionEnvironment,
  M3LExecutionEnvironmentType,
  M3LCredentialSource,
} from "../src/core/environment/index.js";
import type { M3LExecutionEnvironmentInfo } from "../src/core/environment/index.js";
import {
  M3LConsoleLoggerHandler,
  M3LLogger,
} from "../src/core/logging/index.js";
import { M3LPrompt } from "../src/core/prompt/index.js";
import { M3LPaths } from "../src/core/utils/index.js";

// -----------------------------------------------------------------------
// SUT — does not exist yet. This import MUST fail in RED with
// "Cannot find module" (or equivalent). Do not add a try/catch around it —
// the whole file failing to resolve is the expected, correct RED signal.
// -----------------------------------------------------------------------
import {
  AWS_PROFILE_PARAM_NAME,
  AWS_REGION_PARAM_NAME,
  installProcessGuards,
  M3LPresetCycleError,
  M3LPresetUnknownKeysError,
  M3LScript,
  M3LScriptConfigLoader,
  M3LScriptPresetLoader,
  runScript,
  serializeError,
  setProcessGuardRequestId,
} from "../src/core/script/index.js";
import type {
  M3LRunScriptOptions,
  M3LScriptHookContext,
  M3LScriptLifecycleHooks,
  M3LScriptMetadata,
  M3LScriptOptions,
  M3LScriptRunOptions,
} from "../src/core/script/index.js";
// ADR-0035 phase 4a: `runScript`'s own composition-root behavior (installing
// process guards, mapping a caught error to a process exit code, and
// best-effort persisting an `M3LRunReport`) is exercised against the same
// public `../src/core/diagnostics/index.js` surface `runScript` is documented
// to compose — not a private reimplementation of exit-code mapping.
import {
  M3L_EXIT_CODES,
  M3LBreadcrumbTrail,
  M3LRunReporter,
} from "../src/core/diagnostics/index.js";
import type { M3LRunReportInput } from "../src/core/diagnostics/index.js";

// `registerShutdownSignals` is an internal (non-barrel-exported) helper.
// `M3LScript`'s own `onShutdown` callback (wired to its private `runCleanup`
// method) always swallows its own errors internally, so the module's
// `.catch()` branch for a *rejecting* `onShutdown` can never be reached
// through the public surface — it is whitebox-tested directly here,
// mirroring the existing precedent of `tests/prompt.test.ts` importing
// `../src/internal/prompt/*` directly for the same reason (internal helper
// coverage the public API cannot reach).
import { logBestEffortDiagnostic } from "../src/internal/script/diagnostics.js";
import {
  getForcedSignalExitCode,
  pushForcedSignalExitCode,
  registerShutdownSignals,
  setForcedSignalExitCode,
} from "../src/internal/script/signalHandlers.js";
// ADR-0035 phase 4a: `runScript` installs the process guards via
// `installProcessGuards()` (re-exported through the barrel above, and
// imported here again as a namespace so a spy on THIS module's exported
// property intercepts the call `runScript` makes internally — the
// `installProcessGuards()` singleton flag is a genuine, un-resettable
// process-global (see the "runScript — composition-root wrapper" describe
// block below), so asserting call COUNT via `process.on` registrations would
// depend on this file's test execution order; spying on the function
// reference itself does not.
import * as ProcessGuardsModule from "../src/core/script/process-guards.js";
import { fakeRoot } from "./helpers/fake-path.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal valid metadata, reused across constructions. */
const metadata: M3LScriptMetadata = {
  name: "test-script",
  version: "1.0.0",
};

/**
 * Builds a fresh non-AWS, non-CI, non-interactive-ish local environment info
 * object so `M3LScript` construction/run does not depend on the real
 * process's TTY/CI signals. Kept minimal — only fields the contract actually
 * documents on `M3LExecutionEnvironmentInfo`.
 */
function makeEnvironmentInfo(
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

/** Forces `M3LExecutionEnvironment.detect`/`detectFresh` to a fixed CI (non-AWS) info. */
function stubNonAwsEnvironment(
  overrides: Partial<M3LExecutionEnvironmentInfo> = {},
): void {
  const info = makeEnvironmentInfo(overrides);
  vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(info);
  vi.spyOn(M3LExecutionEnvironment, "detectFresh").mockReturnValue(info);
}

/** Forces an AWS-managed (Lambda) environment info. */
function stubAwsLambdaEnvironment(): void {
  const info = makeEnvironmentInfo({
    environmentType: M3LExecutionEnvironmentType.AWS_LAMBDA,
    isAWSManaged: true,
    credentialSource: M3LCredentialSource.WEB_IDENTITY,
    detectionDetails: {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      isCiEnvironment: false,
      hasLambdaTaskRoot: true,
      hasEcsMetadataUri: false,
      hasCodeBuildBuildId: false,
      workspaceMarkerPath: undefined,
    },
  });
  vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(info);
  vi.spyOn(M3LExecutionEnvironment, "detectFresh").mockReturnValue(info);
}

// Guard against real process-global signal handler leakage: `M3LScript`
// registers real `SIGTERM`/`SIGINT`/`SIGQUIT` listeners on `process` in
// non-AWS environments as a side effect of construction. Every test in this
// file defaults to a no-op `process.on`/`process.once` spy so constructing an
// `M3LScript` never leaves a real listener attached to the shared test-runner
// process. Tests that need to inspect registration (the "signal handling"
// and "installProcessGuards" describe blocks) re-spy locally with their own
// recording `mockImplementation`, which cleanly overrides this default.
//
// Also guard against real filesystem writes from stage 9 (file archival):
// EVERY `script.run()`/Lambda-handler invocation in this file reaches
// `M3LScript.archiveFiles()`, which — with no `M3L_INPUT_DIR`/`M3L_CONFIG_DIR`
// override — resolves against this real monorepo's `data/input`/`data/config`
// (which contain real, tracked `.gitkeep` files), and unconditionally calls
// `M3LFileCopier.finalizeRegisteredFiles()`. An unmocked `mkdir`/`copyFile`
// therefore either writes real files into this repo's `data/output/` (found
// exactly this way while investigating a CI-only failure) or, worse, fails
// with EACCES on CI where the writable/fakeRoot-relative path differs from a
// developer machine. Mocking both here, once, for the whole file closes that
// class of Windows-vs-Linux-masked real-write bug everywhere, not just in
// the dedicated archival describe block (which additionally re-mocks these
// locally for its own tests as extra, harmless belt-and-braces).
beforeEach(() => {
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(process, "once").mockImplementation(() => process);
  vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fsPromises, "copyFile").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// =============================================================================
// M3LScriptMetadata — shape
// =============================================================================
describe("M3LScriptMetadata", () => {
  test("type-level: requires readonly name and version strings", () => {
    expectTypeOf<M3LScriptMetadata>().toEqualTypeOf<{
      readonly name: string;
      readonly version: string;
    }>();
  });
});

// =============================================================================
// M3LScript — construction
// =============================================================================
describe("M3LScript — construction", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("constructs from options carrying only required metadata", () => {
    expect(() => new M3LScript({ metadata })).not.toThrow();
  });

  test("exposes a logger instance facility", () => {
    const script = new M3LScript({ metadata });
    expect(script.logger).toBeDefined();
  });

  test("uses the injected logger instance instead of constructing a default", () => {
    const fakeLogger = new M3LLogger([]);
    const script = new M3LScript({ metadata, logger: fakeLogger });
    expect(script.logger).toBe(fakeLogger);
  });

  test("exposes a prompt instance facility", () => {
    const script = new M3LScript({ metadata });
    expect(script.prompt).toBeDefined();
  });

  test("uses the injected prompt instance instead of constructing a default (S6)", () => {
    const fakePrompt = new M3LPrompt();
    const script = new M3LScript({ metadata, prompt: fakePrompt });
    expect(script.prompt).toBe(fakePrompt);
  });

  test("exposes an `aws` getter that is undefined before provisioning (construction only, no aws.profile declared)", () => {
    const script = new M3LScript({ metadata });
    expect(script.aws).toBeUndefined();
  });

  // F4: `M3LScript.paths` is a public getter exposing the `M3LPaths`
  // instance held in the native private field `#paths`.
  test("exposes a `paths` getter returning the internal M3LPaths instance", () => {
    const script = new M3LScript({ metadata });
    expect(script.paths).toBeDefined();
    expect(script.paths).toBeInstanceOf(M3LPaths);
  });

  test("`paths` getter returns the same instance on every access (resolved once, reused)", () => {
    const script = new M3LScript({ metadata });
    expect(script.paths).toBe(script.paths);
  });

  test("`paths` getter is backed by a functioning M3LPaths instance", () => {
    const script = new M3LScript({ metadata });
    expect(script.paths.getInputDir()).toEqual(expect.any(String));
  });

  test("type-level: `paths` getter returns M3LPaths", () => {
    expectTypeOf<M3LScript["paths"]>().toEqualTypeOf<M3LPaths>();
  });

  test("getConfiguration() is asynchronous (returns a thenable)", () => {
    const script = new M3LScript({ metadata });
    const result: unknown = script.getConfiguration();
    expect(typeof (result as { then?: unknown }).then).toBe("function");
  });
});

// =============================================================================
// M3LScript.run — 9-stage execution order
// =============================================================================
describe("M3LScript.run() — stage order", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("runs stages in documented order: init hooks -> config hooks -> onBeforeRun -> mainFn -> onAfterRun -> onCleanup", async () => {
    const order: string[] = [];
    const hooks: M3LScriptLifecycleHooks = {
      onBeforeInit: () => {
        order.push("onBeforeInit");
      },
      onAfterInit: () => {
        order.push("onAfterInit");
      },
      onBeforeConfigLoad: () => {
        order.push("onBeforeConfigLoad");
      },
      onAfterConfigLoad: () => {
        order.push("onAfterConfigLoad");
      },
      onBeforeRun: () => {
        order.push("onBeforeRun");
      },
      onAfterRun: () => {
        order.push("onAfterRun");
      },
      onCleanup: () => {
        order.push("onCleanup");
      },
    };
    const script = new M3LScript({ metadata, hooks });
    const mainFn = vi.fn(() => {
      order.push("mainFn");
    });

    await script.run(mainFn);

    expect(order).toEqual([
      "onBeforeInit",
      "onAfterInit",
      "onBeforeConfigLoad",
      "onAfterConfigLoad",
      "onBeforeRun",
      "mainFn",
      "onAfterRun",
      "onCleanup",
    ]);
    expect(mainFn).toHaveBeenCalledTimes(1);
  });

  test("onBeforeInit runs before M3LExecutionEnvironment.detect() is consulted for this run", async () => {
    // We can't directly observe stage 1 (env detection) as a hook, but we can
    // assert detect/detectFresh was actually invoked during the run — proving
    // stage 1 happens rather than being skipped entirely.
    const detectSpy = vi.spyOn(M3LExecutionEnvironment, "detect");
    const script = new M3LScript({ metadata });
    await script.run(() => {});
    expect(detectSpy).toHaveBeenCalled();
  });

  test("onError fires when mainFn throws", async () => {
    const onError = vi.fn();
    const script = new M3LScript({ metadata, hooks: { onError } });

    await expect(
      script.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("onError fires when a config-stage hook throws", async () => {
    const onError = vi.fn();
    const script = new M3LScript({
      metadata,
      hooks: {
        onBeforeConfigLoad: () => {
          throw new Error("config stage failure");
        },
        onError,
      },
    });

    await expect(script.run(() => {})).rejects.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("onError receives (ctx, error) with error being the exact thrown value", async () => {
    const onError = vi.fn();
    const script = new M3LScript({ metadata, hooks: { onError } });
    const thrownError = new Error("boom");

    await expect(
      script.run(() => {
        throw thrownError;
      }),
    ).rejects.toThrow(thrownError);

    expect(onError).toHaveBeenCalledTimes(1);
    const [ctxArg, errorArg] = onError.mock.calls[0] as [
      M3LScriptHookContext,
      unknown,
    ];
    expect(ctxArg.config).toBeDefined();
    expect(errorArg).toBe(thrownError);
  });

  test("a throwing onError is contained: run() still runs onCleanup and still rejects with the ORIGINAL error", async () => {
    // The onError hook's own failure is recorded as a best-effort diagnostic
    // to stderr (see M3LScript.runOnErrorBestEffort) rather than propagated —
    // spying on stderr both keeps test output quiet and lets us assert the
    // diagnostic actually fired.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const onCleanup = vi.fn();
    const originalError = new Error("original failure");
    const onErrorFailure = new Error("onError itself blew up");
    const script = new M3LScript({
      metadata,
      hooks: {
        onError: () => {
          throw onErrorFailure;
        },
        onCleanup,
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    // The original error is re-thrown, never the onError hook's own failure.
    expect(thrown).toBe(originalError);
    expect(thrown).not.toBe(onErrorFailure);
    expect(onCleanup).toHaveBeenCalledTimes(1);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("onError hook failure");
    expect(written).toContain("onError itself blew up");
  });

  test("a rejecting (async) onError is likewise contained without masking the original error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const originalError = new Error("original failure");
    const onCleanup = vi.fn();
    const script = new M3LScript({
      metadata,
      hooks: {
        onError: () => Promise.reject(new Error("async onError failure")),
        onCleanup,
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(onCleanup).toHaveBeenCalledTimes(1);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("onError hook failure");
  });

  test("a throwing onCleanup does not mask the original error and does not itself crash run()", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const originalError = new Error("original failure");
    const script = new M3LScript({
      metadata,
      hooks: {
        onCleanup: () => {
          throw new Error("cleanup itself blew up");
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("onCleanup failure");
  });

  test("internal/script/diagnostics: an M3LError thrown from onCleanup surfaces a best-effort diagnostic carrying its redacted context (integration through M3LScript.run)", async () => {
    // End-to-end lifecycle coverage: M3LScript.run() -> a throwing onCleanup
    // -> the process/cleanup diagnostic -> logBestEffortDiagnostic, asserting
    // the emitted stderr diagnostic carries the M3LError's context field.
    // This complements the direct-call unit tests below that exercise
    // logBestEffortDiagnostic's message/stack redaction in isolation.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const originalError = new Error("original failure");
    const cleanupFailureWithContext = new M3LError("cleanup failed", {
      code: "ERR_TEST_CLEANUP",
      context: { attempt: 3 },
    });
    const script = new M3LScript({
      metadata,
      hooks: {
        onCleanup: () => {
          throw cleanupFailureWithContext;
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("onCleanup failure");
    expect(written).toContain("attempt");
  });

  test("internal/script/diagnostics: logBestEffortDiagnostic redacts a secret carried in serialized.message, not just serialized.context", () => {
    // MF-2: the current implementation only redacts `serialized.context`
    // before spreading the rest of `serialized` verbatim, so a secret riding
    // `message` (e.g. interpolated into an error string) reaches stderr raw.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const serialized: ReturnType<typeof serializeError> = {
      message: "connect failed token=SUPERSECRET_ABC123",
    };

    logBestEffortDiagnostic("test", serialized);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("[REDACTED]");
    expect(written).not.toContain("SUPERSECRET_ABC123");
  });

  test("internal/script/diagnostics: logBestEffortDiagnostic redacts a secret carried in serialized.stack", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const serialized: ReturnType<typeof serializeError> = {
      message: "connect failed",
      stack: "Error: connect failed\n    at password=hunter2xyz (file.ts:1:1)",
    };

    logBestEffortDiagnostic("test", serialized);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("[REDACTED]");
    expect(written).not.toContain("hunter2xyz");
  });

  test("internal/script/diagnostics: logBestEffortDiagnostic masks a Bearer-scheme credential carried in serialized.message", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const serialized: ReturnType<typeof serializeError> = {
      message: "upstream rejected Authorization: Bearer eyJhbGSECRET",
    };

    logBestEffortDiagnostic("test", serialized);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("[REDACTED]");
    expect(written).not.toContain("eyJhbGSECRET");
  });

  test("internal/script/diagnostics: logBestEffortDiagnostic still redacts a sensitive serialized.context key while leaving a non-sensitive context field intact", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const serialized: ReturnType<typeof serializeError> = {
      message: "cleanup failed",
      context: { attempt: 3, apiKey: "topsecretvalue" },
    };

    logBestEffortDiagnostic("test", serialized);

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("[REDACTED]");
    expect(written).not.toContain("topsecretvalue");
    expect(written).toContain("attempt");
  });

  test("internal/script/diagnostics: logBestEffortDiagnostic never throws even when process.stderr.write throws", () => {
    vi.spyOn(process.stderr, "write").mockImplementationOnce(() => {
      throw new Error("stderr is broken");
    });
    const serialized: ReturnType<typeof serializeError> = {
      message: "boom",
    };

    expect(() => {
      logBestEffortDiagnostic("test", serialized);
    }).not.toThrow();
  });

  test("internal/script/diagnostics: a failing stderr write itself is swallowed (the last-resort catch branch)", async () => {
    // The write-failure catch has nothing observable to assert beyond "does
    // not throw" -- that IS its entire contract (see diagnostics.ts's own
    // doc comment). Fails once so run() itself still completes normally.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementationOnce(() => {
        throw new Error("stderr is broken");
      });
    const originalError = new Error("original failure");
    const script = new M3LScript({
      metadata,
      hooks: {
        onCleanup: () => {
          throw new Error("cleanup itself blew up");
        },
      },
    });

    let thrown: unknown;
    await expect(
      (async () => {
        try {
          await script.run(() => {
            throw originalError;
          });
        } catch (error) {
          thrown = error;
        }
      })(),
    ).resolves.toBeUndefined();

    expect(thrown).toBe(originalError);
    expect(stderrSpy).toHaveBeenCalled();
  });

  test("a throwing onCleanup on the happy path (stage 8) is caught by run()'s own catch branch, which then best-effort-retries onCleanup and rejects with the cleanup failure", async () => {
    // Stage 8's `onCleanup` call (inside `runPipeline`) is a plain
    // `runHook(...)`, unguarded — so a throw there propagates into `run()`'s
    // own try/catch exactly like a `mainFn` failure would. That catch branch
    // then calls `onError` (with the cleanup failure as `cause`) and
    // `runCleanup("onError")`, which invokes `onCleanup` a SECOND time — this
    // second invocation is the one wrapped in the best-effort try/catch (see
    // `M3LScript.runCleanup`), so it is swallowed rather than crashing `run()`
    // a second time. Net effect: `onCleanup` runs twice, and `run()` rejects
    // with the cleanup failure itself (there being no earlier/original error
    // on the happy path).
    let cleanupCalls = 0;
    const cleanupFailure = new Error("cleanup blew up on the happy path");
    const script = new M3LScript({
      metadata,
      hooks: {
        onCleanup: () => {
          cleanupCalls++;
          throw cleanupFailure;
        },
      },
    });

    await expect(script.run(() => {})).rejects.toThrow(cleanupFailure);
    expect(cleanupCalls).toBe(2);
  });

  test("onCleanup still fires after an error (best-effort teardown)", async () => {
    const onCleanup = vi.fn();
    const script = new M3LScript({
      metadata,
      hooks: { onCleanup },
    });

    await expect(
      script.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  test("run() resolves to undefined (Promise<void>) on success", async () => {
    const script = new M3LScript({ metadata });
    await expect(script.run(() => {})).resolves.toBeUndefined();
  });

  test("run() supports an async mainFn and awaits it before onAfterRun", async () => {
    const order: string[] = [];
    const script = new M3LScript({
      metadata,
      hooks: {
        onAfterRun: () => {
          order.push("onAfterRun");
        },
      },
    });

    await script.run(async () => {
      await Promise.resolve();
      order.push("mainFn");
    });

    expect(order).toEqual(["mainFn", "onAfterRun"]);
  });

  describe("type-level contract", () => {
    test("run returns Promise<void>", () => {
      expectTypeOf<M3LScript["run"]>().returns.toEqualTypeOf<Promise<void>>();
    });

    test("run accepts a callback returning void | Promise<void>", () => {
      expectTypeOf<M3LScript["run"]>()
        .parameter(0)
        .toEqualTypeOf<() => void | Promise<void>>();
    });
  });
});

// =============================================================================
// M3LScript — AWS provisioning seam (stage 5)
// =============================================================================
describe("M3LScript.run() — AWS provisioning seam", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  /** An `aws.profile` param with a resolvable value, so stage 3 actually stores it (no provider/env/CLI mocking needed). */
  function makeAwsProfileParam(): M3LConfigParameter {
    return new M3LConfigParameter({
      name: AWS_PROFILE_PARAM_NAME,
      type: M3LConfigParameterType.STRING,
      defaultValue: "test-profile",
    });
  }

  test("no aws.profile param declared -> strict no-op: run completes, mainFn executes, and script.aws stays undefined", async () => {
    const script = new M3LScript({ metadata });
    const mainFn = vi.fn();

    await expect(script.run(mainFn)).resolves.toBeUndefined();
    expect(mainFn).toHaveBeenCalledTimes(1);
    expect(script.aws).toBeUndefined();
  });

  test("an aws.profile param IS declared -> run() resolves and provisions script.aws as an AWSProvider whose clients.s3 is an S3Client", async () => {
    // Config schema field key is spec-silent; `config.params` is our
    // documented assumption (see file header comment).
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [makeAwsProfileParam()] },
    };
    const script = new M3LScript(options);
    const mainFn = vi.fn();

    await expect(script.run(mainFn)).resolves.toBeUndefined();

    expect(mainFn).toHaveBeenCalledTimes(1);
    expect(script.aws).toBeInstanceOf(AWSProvider);
    expect(script.aws?.clients).toBeInstanceOf(AWSClientProvider);
    expect(script.aws?.clients.s3).toBeInstanceOf(S3Client);
  });

  test("an aws.profile param is declared but resolves to no value -> run() resolves and still provisions script.aws as an AWSProvider", async () => {
    // No `defaultValue`/`asyncFallback` on this param, and no env var/CLI arg
    // supplies "aws.profile" — so `config.get("aws.profile")` resolves to
    // `undefined`, driving the FALSE side of `hasProfile ? { profile } : {}`
    // (M3LScript.ts:360): the param is merely DECLARED, so provisioning still
    // proceeds, just without a `profile` in the AWSProvider options — the
    // provider falls back to the SDK's default credential chain.
    const unresolvedProfileParam = new M3LConfigParameter({
      name: AWS_PROFILE_PARAM_NAME,
      type: M3LConfigParameterType.STRING,
    });
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [unresolvedProfileParam] },
    };
    const script = new M3LScript(options);
    const mainFn = vi.fn();

    await expect(script.run(mainFn)).resolves.toBeUndefined();

    expect(mainFn).toHaveBeenCalledTimes(1);
    expect(script.aws).toBeInstanceOf(AWSProvider);
    expect(script.aws?.clients).toBeInstanceOf(AWSClientProvider);
    expect(script.aws?.clients.s3).toBeInstanceOf(S3Client);
  });

  test("the aws.region config value flows into provisioning: script.aws.clients.s3's resolved region matches it", async () => {
    const awsRegionParam = new M3LConfigParameter({
      name: AWS_REGION_PARAM_NAME,
      type: M3LConfigParameterType.STRING,
      defaultValue: "eu-south-1",
    });
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [makeAwsProfileParam(), awsRegionParam] },
    };
    const script = new M3LScript(options);

    await script.run(() => {});

    const region = await script.aws?.clients.s3.config.region();
    expect(region).toBe("eu-south-1");
  });

  test("a malformed configured aws.region value fails loud: run() rejects with the SAME M3LAWSIdentityError (code ERR_AWS_INVALID_REGION), not swallowed or wrapped", async () => {
    const malformedRegionParam = new M3LConfigParameter({
      name: AWS_REGION_PARAM_NAME,
      type: M3LConfigParameterType.STRING,
      defaultValue: "not a region",
    });
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [makeAwsProfileParam(), malformedRegionParam] },
    };
    const script = new M3LScript(options);
    const mainFn = vi.fn();

    let thrown: unknown;
    try {
      await script.run(mainFn);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSIdentityError);
    expect((thrown as M3LAWSIdentityError).code).toBe("ERR_AWS_INVALID_REGION");
    // Fails loud: mainFn never ran, and the pipeline never reached stage 5's
    // successful provisioning of `script.aws`.
    expect(mainFn).not.toHaveBeenCalled();
    expect(script.aws).toBeUndefined();
  });

  test("a malformed configured aws.profile value fails loud: run() rejects with the SAME M3LAWSIdentityError (code ERR_AWS_INVALID_PROFILE), not swallowed or wrapped", async () => {
    const malformedProfileParam = new M3LConfigParameter({
      name: AWS_PROFILE_PARAM_NAME,
      type: M3LConfigParameterType.STRING,
      defaultValue: "has whitespace",
    });
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [malformedProfileParam] },
    };
    const script = new M3LScript(options);
    const mainFn = vi.fn();

    let thrown: unknown;
    try {
      await script.run(mainFn);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSIdentityError);
    expect((thrown as M3LAWSIdentityError).code).toBe(
      "ERR_AWS_INVALID_PROFILE",
    );
    expect(mainFn).not.toHaveBeenCalled();
    expect(script.aws).toBeUndefined();
  });

  test("a valid configured aws.region and aws.profile still provision fine — the fail-loud path is specific to malformed input", async () => {
    const validRegionParam = new M3LConfigParameter({
      name: AWS_REGION_PARAM_NAME,
      type: M3LConfigParameterType.STRING,
      defaultValue: "us-east-1",
    });
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [makeAwsProfileParam(), validRegionParam] },
    };
    const script = new M3LScript(options);
    const mainFn = vi.fn();

    await expect(script.run(mainFn)).resolves.toBeUndefined();

    expect(mainFn).toHaveBeenCalledTimes(1);
    expect(script.aws).toBeInstanceOf(AWSProvider);
    const region = await script.aws?.clients.s3.config.region();
    expect(region).toBe("us-east-1");
  });

  test("the provisioned AWSProvider is memoized: two warm createLambdaHandler invocations expose the SAME script.aws instance", async () => {
    stubAwsLambdaEnvironment();
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [makeAwsProfileParam()] },
    };
    const script = new M3LScript(options);
    const handler = script.createLambdaHandler(() => Promise.resolve());

    await handler({}, {});
    const firstAws = script.aws;
    expect(firstAws).toBeInstanceOf(AWSProvider);

    await handler({}, {});
    const secondAws = script.aws;

    // resetForInvocation clears initialized/configLoaded/config but must NOT
    // clear the provisioned AWSProvider — a warm Lambda invocation reuses it.
    expect(secondAws).toBe(firstAws);
  });
});

// =============================================================================
// AWS_PROFILE_PARAM_NAME / AWS_REGION_PARAM_NAME — canonical config parameter
// names the AWS-provisioning seam looks up (SF-8)
// =============================================================================
describe("AWS_PROFILE_PARAM_NAME / AWS_REGION_PARAM_NAME", () => {
  test("AWS_PROFILE_PARAM_NAME is the literal string 'aws.profile'", () => {
    expect(AWS_PROFILE_PARAM_NAME).toBe("aws.profile");
  });

  test("AWS_REGION_PARAM_NAME is the literal string 'aws.region'", () => {
    expect(AWS_REGION_PARAM_NAME).toBe("aws.region");
  });

  describe("type-level contract", () => {
    test("AWS_PROFILE_PARAM_NAME is typed as the narrow literal, not widened to string", () => {
      expectTypeOf(AWS_PROFILE_PARAM_NAME).toEqualTypeOf<"aws.profile">();
    });

    test("AWS_REGION_PARAM_NAME is typed as the narrow literal, not widened to string", () => {
      expectTypeOf(AWS_REGION_PARAM_NAME).toEqualTypeOf<"aws.region">();
    });
  });
});

// =============================================================================
// M3LScript.run() — stage 9 file archival (M1)
// =============================================================================
describe("M3LScript.run() — stage 9 file archival (getLastArchiveReport)", () => {
  /** A minimal fake fs.Dirent — just enough for M3LScript's own `entry.isFile()`/`entry.name` usage. */
  function fakeFileDirent(name: string): fs.Dirent {
    return { name, isFile: () => true } as fs.Dirent;
  }

  beforeEach(() => {
    stubNonAwsEnvironment();
    // Every test in this block resolves the output directory to a
    // `fakeRoot()`-based path. Unconditionally mocking the fs WRITE
    // primitives here (rather than per-test) means no archival test — now or
    // added later — can ever perform a real filesystem write: on Linux,
    // `fakeRoot("fake", ...)` resolves under "/", so an unmocked `mkdir`
    // fails with EACCES at the real filesystem root; on Windows the same
    // path is drive-rooted and silently succeeds, creating a stray real
    // directory and masking the failure that only surfaces in CI. Each
    // test's own `readdirSync`/`stat` mocks (or lack thereof) still encode
    // that test's specific input scenario.
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "copyFile").mockResolvedValue(undefined);
  });

  test("getLastArchiveReport() is undefined before run() has completed at least once", () => {
    const script = new M3LScript({ metadata });
    expect(script.getLastArchiveReport()).toBeUndefined();
  });

  test("archives real (mocked) input and config files and populates getLastArchiveReport()", async () => {
    const root = fakeRoot("fake", "archive-test");
    const inputDir = `${root}/data/input`;
    const configDir = `${root}/data/config`;
    const outputDir = `${root}/data/output`;

    vi.stubEnv("M3L_INPUT_DIR", inputDir);
    vi.stubEnv("M3L_CONFIG_DIR", configDir);
    vi.stubEnv("M3L_OUTPUT_DIR", outputDir);

    // `readdirSync` is overloaded on its `options` shape (string- vs.
    // buffer-encoded Dirent); M3LScript always calls it with
    // `{ withFileTypes: true }` and no `encoding`, which resolves to the
    // string-Dirent overload. A plain `mockImplementation` callback cannot be
    // directly cast to the full overloaded function type (none of its
    // individual call signatures is a supertype of the others), so the
    // implementation is narrowed through `unknown` first — the standard
    // escape hatch for satisfying an intentionally narrower mock against an
    // overloaded Node API.
    vi.spyOn(nodeFs, "readdirSync").mockImplementation(((
      dir: fs.PathLike,
    ): fs.Dirent[] => {
      if (String(dir) === inputDir) return [fakeFileDirent("source.csv")];
      if (String(dir) === configDir) return [fakeFileDirent("config.yaml")];
      return [];
    }) as unknown as typeof nodeFs.readdirSync);
    // `stat` is used both to size the SOURCE file and to probe whether the
    // DESTINATION already exists (`pathExists`); a blanket "always resolves"
    // mock makes every destination look pre-existing, forcing an
    // "already-exists" skip. Distinguish by path: only the two known source
    // files resolve (with a size); anything else (i.e. every destination
    // under outputDir) rejects ENOENT, matching a clean output directory.
    vi.spyOn(fsPromises, "stat").mockImplementation((target: fs.PathLike) => {
      const targetPath = String(target);
      if (
        targetPath === `${inputDir}/source.csv` ||
        targetPath === `${configDir}/config.yaml`
      ) {
        return Promise.resolve({ size: 128 } as fs.Stats);
      }
      return Promise.reject(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    });
    // `mkdir`/`copyFile` are mocked once for the whole describe block (see
    // the outer `beforeEach`); no per-test override needed here.

    const script = new M3LScript({ metadata });
    await script.run(() => {});

    const report = script.getLastArchiveReport();
    expect(report).toBeDefined();
    // Stage 9 did real (mocked) work: both discovered files were registered
    // and copied — this is the behavior-level replacement for the old
    // "doesn't throw" test-theater assertion.
    expect(report?.summary.totalRegistered).toBe(2);
    expect(report?.summary.copied).toBe(2);
    expect(report?.results).toHaveLength(2);
    expect(report?.results.every((result) => !result.skipped)).toBe(true);
  });

  test.each([
    ["EACCES", "EACCES: permission denied"],
    ["EPERM", "EPERM: operation not permitted"],
  ])(
    "a %s reading the input directory surfaces the fault instead of silently producing a zero-file archive report",
    async (code, message) => {
      const root = fakeRoot("fake", `archive-${code.toLowerCase()}`);
      const inputDir = `${root}/data/input`;
      const configDir = `${root}/data/config`;
      const outputDir = `${root}/data/output`;

      vi.stubEnv("M3L_INPUT_DIR", inputDir);
      vi.stubEnv("M3L_CONFIG_DIR", configDir);
      vi.stubEnv("M3L_OUTPUT_DIR", outputDir);

      // Unlike the ENOENT-tolerant case below, a directory that EXISTS but
      // cannot be read (a real permissions fault, e.g. in a locked-down
      // container/CI user) must not be swallowed as "nothing to archive" —
      // that would hide a genuine fault behind a successful, truncated
      // report. Unlike the sibling `readdirSync` mocks in this file, this
      // implementation never returns (always throws), so a zero-arg arrow is
      // itself a valid substitute for every overload of the real
      // `readdirSync` — no `as unknown` narrowing needed here.
      vi.spyOn(nodeFs, "readdirSync").mockImplementation(() => {
        throw Object.assign(new Error(message), { code });
      });

      const script = new M3LScript({ metadata });

      let thrown: unknown;
      try {
        await script.run(() => {});
      } catch (error) {
        thrown = error;
      }

      // Behavioral assertion: the permission fault must actually be
      // reachable from what `run()` throws, not merely "run() didn't
      // resolve". Accept either a raw re-thrown errno or an M3LError that
      // chained it via `cause` — either way the "code" must surface.
      expect(thrown).toBeDefined();
      const thrownWithCause = thrown as {
        code?: unknown;
        cause?: { code?: unknown };
      };
      const surfacedCode = thrownWithCause.code ?? thrownWithCause.cause?.code;
      expect(surfacedCode).toBe(code);

      // The zero-file report the current (buggy) implementation would have
      // produced must NOT exist — run() must not have completed successfully.
      expect(script.getLastArchiveReport()).toBeUndefined();
    },
  );

  test("an empty input/config directory still produces a (zero-file) archive report, not undefined", async () => {
    const root = fakeRoot("fake", "archive-empty");
    vi.stubEnv("M3L_INPUT_DIR", `${root}/data/input`);
    vi.stubEnv("M3L_CONFIG_DIR", `${root}/data/config`);
    vi.stubEnv("M3L_OUTPUT_DIR", `${root}/data/output`);

    // No mock override for readdirSync: the real implementation runs against
    // a directory that does not exist, which M3LScript's own
    // `listRegularFiles` tolerates (catches and returns []) rather than
    // throwing — so no fs mocking is even needed for this path.
    const script = new M3LScript({ metadata });
    await script.run(() => {});

    const report = script.getLastArchiveReport();
    expect(report).toBeDefined();
    expect(report?.summary.totalRegistered).toBe(0);
  });

  test("REGRESSION: repeated warm createLambdaHandler invocations produce a STABLE archive count, not an accumulating one", async () => {
    // Locks a Lambda warm-start bug fix: `archiveFiles()` used to reuse a
    // single instance-lifetime `M3LFileCopier`, whose internal registration
    // queue is never cleared between calls — so a second warm invocation of
    // the SAME `M3LScript` instance would re-register the first invocation's
    // files on top of the second's, doubling (then tripling, ...) the
    // reported count on every subsequent invocation. `archiveFiles()` now
    // constructs a fresh `M3LFileCopier` on every call, so each invocation's
    // report reflects only that invocation's own files.
    //
    // If this regression reappeared (e.g. `fileCopier` reverted to an
    // instance field), the second assertion below would see
    // `totalRegistered === 4` instead of the stable `2`.
    stubAwsLambdaEnvironment();

    const root = fakeRoot("fake", "archive-warm-start");
    const inputDir = `${root}/data/input`;
    const configDir = `${root}/data/config`;
    const outputDir = `${root}/data/output`;

    vi.stubEnv("M3L_INPUT_DIR", inputDir);
    vi.stubEnv("M3L_CONFIG_DIR", configDir);
    vi.stubEnv("M3L_OUTPUT_DIR", outputDir);

    vi.spyOn(nodeFs, "readdirSync").mockImplementation(((
      dir: fs.PathLike,
    ): fs.Dirent[] => {
      if (String(dir) === inputDir) return [fakeFileDirent("source.csv")];
      if (String(dir) === configDir) return [fakeFileDirent("config.yaml")];
      return [];
    }) as unknown as typeof nodeFs.readdirSync);
    vi.spyOn(fsPromises, "stat").mockImplementation((target: fs.PathLike) => {
      const targetPath = String(target);
      if (
        targetPath === `${inputDir}/source.csv` ||
        targetPath === `${configDir}/config.yaml`
      ) {
        return Promise.resolve({ size: 128 } as fs.Stats);
      }
      return Promise.reject(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    });
    // `mkdir`/`copyFile` are mocked once for the whole describe block (see
    // the outer `beforeEach`); no per-test override needed here.

    // ONE M3LScript, ONE createLambdaHandler — the warm-start scenario the
    // bug depended on (a single instance reused across invocations).
    const script = new M3LScript({ metadata });
    const handler = script.createLambdaHandler(() => Promise.resolve());

    await handler({}, {});
    const firstReport = script.getLastArchiveReport();
    expect(firstReport?.summary.totalRegistered).toBe(2);

    await handler({}, {});
    const secondReport = script.getLastArchiveReport();
    // The bug's signature: totalRegistered would be 4 (2 + 2, accumulated)
    // on a warm second invocation. It must stay at 2 — the SAME two files
    // discovered fresh, not appended to a leftover queue.
    expect(secondReport?.summary.totalRegistered).toBe(2);
  });
});

// =============================================================================
// M3LScript.createLambdaHandler
// =============================================================================
describe("M3LScript.createLambdaHandler()", () => {
  beforeEach(() => {
    stubAwsLambdaEnvironment();
  });

  test("returns a callable handler function", () => {
    const script = new M3LScript({ metadata });
    const handler = script.createLambdaHandler(() => Promise.resolve());
    expect(typeof handler).toBe("function");
  });

  test("invoking the handler drives the mainFn and resolves", async () => {
    const script = new M3LScript({ metadata });
    const mainFn = vi.fn(() => Promise.resolve({ ok: true }));
    const handler = script.createLambdaHandler(mainFn);

    await handler({}, {});

    expect(mainFn).toHaveBeenCalledTimes(1);
  });

  test("each invocation re-runs config load (config-stage hooks fire again on a second call)", async () => {
    let configLoadCount = 0;
    const script = new M3LScript({
      metadata,
      hooks: {
        onAfterConfigLoad: () => {
          configLoadCount++;
        },
      },
    });
    const handler = script.createLambdaHandler(() => Promise.resolve());

    await handler({}, {});
    await handler({}, {});

    expect(configLoadCount).toBe(2);
  });

  describe("type-level contract", () => {
    test("compiles with a 2-arg generic call (TContext defaults)", () => {
      interface MyEvent {
        readonly id: string;
      }
      interface MyResult {
        readonly ok: boolean;
      }
      const script = new M3LScript({ metadata });
      const handler = script.createLambdaHandler<MyEvent, MyResult>(
        (): Promise<MyResult> => Promise.resolve({ ok: true }),
      );
      expectTypeOf(handler).parameter(0).toMatchTypeOf<MyEvent>();
    });
  });
});

// =============================================================================
// Signal handling — SIGTERM/SIGINT/SIGQUIT
// =============================================================================
describe("M3LScript — signal handling", () => {
  test("registers SIGTERM/SIGINT/SIGQUIT handlers in a non-AWS environment", () => {
    stubNonAwsEnvironment();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    const script = new M3LScript({ metadata });
    void script;

    const registeredSignals = onSpy.mock.calls
      .map(([eventName]) => eventName)
      .filter(
        (eventName) =>
          eventName === "SIGTERM" ||
          eventName === "SIGINT" ||
          eventName === "SIGQUIT",
      );

    expect(registeredSignals).toEqual(
      expect.arrayContaining(["SIGTERM", "SIGINT", "SIGQUIT"]),
    );
  });

  test("does NOT register signal handlers in an AWS-managed environment", () => {
    stubAwsLambdaEnvironment();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    const script = new M3LScript({ metadata });
    void script;

    const registeredSignals = onSpy.mock.calls
      .map(([eventName]) => eventName)
      .filter(
        (eventName) =>
          eventName === "SIGTERM" ||
          eventName === "SIGINT" ||
          eventName === "SIGQUIT",
      );

    expect(registeredSignals).toEqual([]);
  });

  test("the first signal runs the graceful shutdown (onCleanup) path without exiting", async () => {
    stubNonAwsEnvironment();
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        handlers.set(eventName, listener);
        return process;
      },
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const onCleanup = vi.fn();
    const script = new M3LScript({ metadata, hooks: { onCleanup } });
    void script;

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();

    // The shutdown callback is fire-and-forget (`Promise.resolve().then(...)`
    // internally), so let its microtask queue drain before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("a second signal forces process.exit(1) without waiting for shutdown to complete", () => {
    stubNonAwsEnvironment();
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        handlers.set(eventName, listener);
        return process;
      },
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const script = new M3LScript({ metadata });
    void script;

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();
    sigtermHandler?.();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("a second SIGINT (not just a repeated SIGTERM) also forces process.exit(1) via the same shared 'signaled' flag", () => {
    stubNonAwsEnvironment();
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        handlers.set(eventName, listener);
        return process;
      },
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const script = new M3LScript({ metadata });
    void script;

    const sigtermHandler = handlers.get("SIGTERM");
    const sigintHandler = handlers.get("SIGINT");
    expect(sigtermHandler).toBeDefined();
    expect(sigintHandler).toBeDefined();

    sigtermHandler?.();
    expect(exitSpy).not.toHaveBeenCalled();
    sigintHandler?.();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("internal/script/registerShutdownSignals: a rejecting onShutdown is swallowed by the handler's own .catch() (whitebox)", async () => {
    // `M3LScript` always wraps its own `onShutdown` in a try/catch (its
    // private `runCleanup` method), so this module's internal `.catch()` for
    // a *rejecting* `onShutdown` promise is unreachable through the public
    // `M3LScript` surface — exercised directly against the internal helper.
    const handlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        if (typeof eventName === "string") {
          handlers.set(eventName, listener);
        }
        return process;
      },
    );

    const onShutdown = vi.fn(() => Promise.reject(new Error("cleanup failed")));

    expect(() => registerShutdownSignals(onShutdown)).not.toThrow();

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();

    expect(() => sigtermHandler?.()).not.toThrow();

    // Let the fire-and-forget promise chain (including its .catch()) settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onShutdown).toHaveBeenCalledTimes(1);
    // Nothing further to assert observably — the .catch() branch's entire
    // contract is "a rejection here must not throw/crash the process", which
    // the `not.toThrow()` above already proves.
  });
});

// =============================================================================
// M3LScriptLifecycleHooks — type-level contract
// =============================================================================
describe("M3LScriptLifecycleHooks — type-level contract", () => {
  test("every hook except onError has the signature (ctx: M3LScriptHookContext) => void | Promise<void>; onError also receives the triggering error", () => {
    type HookFn = (ctx: M3LScriptHookContext) => void | Promise<void>;
    // `onError` intentionally has a DISTINCT signature from the other seven
    // hooks: it also receives the `error` that triggered the failure, so
    // error-handling logic can observe what went wrong (not just the
    // pipeline's config snapshot).
    type ErrorHookFn = (
      ctx: M3LScriptHookContext,
      error: unknown,
    ) => void | Promise<void>;
    expectTypeOf<M3LScriptLifecycleHooks>().toEqualTypeOf<{
      onBeforeInit?: HookFn;
      onAfterInit?: HookFn;
      onBeforeConfigLoad?: HookFn;
      onAfterConfigLoad?: HookFn;
      onBeforeRun?: HookFn;
      onAfterRun?: HookFn;
      onError?: ErrorHookFn;
      onCleanup?: HookFn;
    }>();
  });

  test("all 8 hooks are optional (an empty object satisfies the type)", () => {
    const hooks: M3LScriptLifecycleHooks = {};
    expect(hooks).toEqual({});
  });
});

// =============================================================================
// M3LScriptHookContext — carries the live config store
// =============================================================================
describe("M3LScriptHookContext", () => {
  test("onAfterConfigLoad receives a context exposing a config field", async () => {
    stubNonAwsEnvironment();
    let capturedContext: M3LScriptHookContext | undefined;
    const script = new M3LScript({
      metadata,
      hooks: {
        onAfterConfigLoad: (ctx) => {
          capturedContext = ctx;
        },
      },
    });

    await script.run(() => {});

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.config).toBeDefined();
  });

  // WS-D (docs/reference/core/script.md#correlation-ids): `correlationId` is
  // "always resolved by the first hook" — a REQUIRED `string`, never
  // `string | undefined`, unlike `M3LScriptOptions.correlationId` (optional
  // on input; see the `M3LScriptOptions — type-level contract` block below).
  test("type-level: correlationId is a required string, not string | undefined", () => {
    expectTypeOf<M3LScriptHookContext>().toHaveProperty("correlationId");
    expectTypeOf<
      M3LScriptHookContext["correlationId"]
    >().toEqualTypeOf<string>();
  });
});

// =============================================================================
// M3LScriptOptions — type-level contract (WS-D correlation IDs)
// =============================================================================
describe("M3LScriptOptions — type-level contract", () => {
  test("correlationId is optional (string | undefined)", () => {
    expectTypeOf<M3LScriptOptions["correlationId"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  test("an options object omitting correlationId is still valid", () => {
    const options: M3LScriptOptions = { metadata };
    expect(options.correlationId).toBeUndefined();
  });

  // F8 (preset seam): `options.preset` is an optional file path to a
  // YAML/JSON preset, loaded (validated against `options.config.params`) and
  // inserted at precedence level 6 — below CLI/env, above static defaults.
  test("F8: preset is optional (string | undefined)", () => {
    expectTypeOf<M3LScriptOptions["preset"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  test("F8: an options object declaring a preset path is valid", () => {
    const options: M3LScriptOptions = {
      metadata,
      preset: "./data/config/presets/prod.yaml",
    };
    expect(options.preset).toBe("./data/config/presets/prod.yaml");
  });
});

// =============================================================================
// M3LScript — Correlation IDs (WS-D)
//
// Contract: docs/reference/core/script.md#correlation-ids. `run()` resolves
// one correlation id per run — the supplied `options.correlationId` verbatim,
// or a generated `crypto.randomUUID()` when omitted — BEFORE the first hook
// fires, so every M3LScriptHookContext.correlationId is a stable, non-empty
// string for the whole run. `createLambdaHandler()` resolves the id fresh
// PER INVOCATION, preferring `context.awsRequestId` over a generated UUID;
// an explicit `options.correlationId` still wins over both.
// =============================================================================
describe("M3LScript — Correlation IDs", () => {
  const GENERATED_UUID: `${string}-${string}-${string}-${string}-${string}` =
    "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    stubNonAwsEnvironment();
    vi.spyOn(nodeCrypto, "randomUUID").mockReturnValue(GENERATED_UUID);
  });

  test("B6: a supplied correlationId is used verbatim on every hook's ctx.correlationId", async () => {
    const seen: string[] = [];
    const script = new M3LScript({
      metadata,
      correlationId: "X",
      hooks: {
        onBeforeInit: (ctx) => {
          seen.push(ctx.correlationId);
        },
        onAfterConfigLoad: (ctx) => {
          seen.push(ctx.correlationId);
        },
        onCleanup: (ctx) => {
          seen.push(ctx.correlationId);
        },
      },
    });

    await script.run(() => {});

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === "X")).toBe(true);
  });

  test("B7: an omitted correlationId is generated via crypto.randomUUID() and resolved before the EARLIEST hook fires", async () => {
    let earliestId: string | undefined;
    const script = new M3LScript({
      metadata,
      hooks: {
        onBeforeInit: (ctx) => {
          // onBeforeInit is documented as the very first lifecycle hook, so
          // this is the earliest possible observation point for the
          // resolved id.
          earliestId ??= ctx.correlationId;
        },
      },
    });

    await script.run(() => {});

    expect(earliestId).toBeDefined();
    expect(earliestId).toBe(GENERATED_UUID);
    expect((earliestId as string).length).toBeGreaterThan(0);
  });

  test("FIX-1: an empty-string options.correlationId is treated as absent, not used verbatim — falls through to a generated id", async () => {
    // Regression for a `??`-passthrough bug: `resolveCorrelationId` currently
    // does `configuredCorrelationId ?? preferredId ?? randomUUID()`, and `??`
    // only short-circuits on `null`/`undefined` — an empty string survives
    // it and is used as-is, so `ctx.correlationId` would resolve to `""`,
    // violating the documented "always a non-empty string" guarantee. The
    // fix mirrors `extractAwsRequestId`'s own `length > 0` guard and falls
    // through to a generated UUID when the configured id is blank.
    let earliestId: string | undefined;
    const script = new M3LScript({
      metadata,
      correlationId: "",
      hooks: {
        onBeforeInit: (ctx) => {
          earliestId ??= ctx.correlationId;
        },
      },
    });

    await script.run(() => {});

    expect(earliestId).toBeDefined();
    expect(earliestId).not.toBe("");
    expect((earliestId as string).length).toBeGreaterThan(0);
    expect(earliestId).toBe(GENERATED_UUID);
  });

  test("B8: the resolved correlationId is stable across every hook in one run", async () => {
    const seen: string[] = [];
    const script = new M3LScript({
      metadata,
      correlationId: "X",
      hooks: {
        onBeforeInit: (ctx) => {
          seen.push(ctx.correlationId);
        },
        onAfterConfigLoad: (ctx) => {
          seen.push(ctx.correlationId);
        },
        onCleanup: (ctx) => {
          seen.push(ctx.correlationId);
        },
      },
    });

    await script.run(() => {});

    expect(seen).toHaveLength(3);
    // Asserting the CONCRETE value (not just "all equal") prevents this test
    // from false-passing when correlationId resolves to `undefined` on
    // every hook (three equal `undefined`s would otherwise still satisfy a
    // bare "same value" check).
    expect(seen).toEqual(["X", "X", "X"]);
  });

  test("B9: createLambdaHandler() resolves a distinct generated id per invocation when correlationId is omitted", async () => {
    stubAwsLambdaEnvironment();
    const firstUuid: `${string}-${string}-${string}-${string}-${string}` =
      "22222222-2222-4222-8222-222222222221";
    const secondUuid: `${string}-${string}-${string}-${string}-${string}` =
      "22222222-2222-4222-8222-222222222222";
    const randomUUIDSpy = vi.spyOn(nodeCrypto, "randomUUID");
    randomUUIDSpy
      .mockReturnValueOnce(firstUuid)
      .mockReturnValueOnce(secondUuid);
    const seen: string[] = [];
    const script = new M3LScript({
      metadata,
      hooks: {
        onBeforeInit: (ctx) => {
          seen.push(ctx.correlationId);
        },
      },
    });
    const handler = script.createLambdaHandler(() => Promise.resolve());

    await handler({}, {});
    await handler({}, {});

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("B10: createLambdaHandler() prefers context.awsRequestId over a generated id", async () => {
    stubAwsLambdaEnvironment();
    let captured: string | undefined;
    const script = new M3LScript({
      metadata,
      hooks: {
        onBeforeInit: (ctx) => {
          captured ??= ctx.correlationId;
        },
      },
    });
    const handler = script.createLambdaHandler<
      Record<string, never>,
      void,
      { awsRequestId: string }
    >(() => Promise.resolve());

    await handler({}, { awsRequestId: "req-123" });

    expect(captured).toBe("req-123");
  });

  test("B11: an explicit options.correlationId still wins over context.awsRequestId under Lambda", async () => {
    stubAwsLambdaEnvironment();
    let captured: string | undefined;
    const script = new M3LScript({
      metadata,
      correlationId: "X",
      hooks: {
        onBeforeInit: (ctx) => {
          captured ??= ctx.correlationId;
        },
      },
    });
    const handler = script.createLambdaHandler<
      Record<string, never>,
      void,
      { awsRequestId: string }
    >(() => Promise.resolve());

    await handler({}, { awsRequestId: "req-123" });

    expect(captured).toBe("X");
  });

  test("B12: a supplied correlationId stays fixed across two Lambda invocations", async () => {
    stubAwsLambdaEnvironment();
    const seen: string[] = [];
    const script = new M3LScript({
      metadata,
      correlationId: "X",
      hooks: {
        onBeforeInit: (ctx) => {
          seen.push(ctx.correlationId);
        },
      },
    });
    const handler = script.createLambdaHandler(() => Promise.resolve());

    await handler({}, {});
    await handler({}, {});

    expect(seen).toEqual(["X", "X"]);
  });

  test("C14: the onError hook's ctx.correlationId equals the run's resolved id on a forced stage failure", async () => {
    let errorCtxId: string | undefined;
    const script = new M3LScript({
      metadata,
      correlationId: "X",
      hooks: {
        onError: (ctx) => {
          errorCtxId = ctx.correlationId;
        },
      },
    });

    await expect(
      script.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    expect(errorCtxId).toBe("X");
  });

  test("FIX-2: an early-stage failure under Lambda still surfaces the platform awsRequestId on onError, not a freshly generated id", async () => {
    // Regression for the id-resolved-too-late bug: `resolveCorrelationId` is
    // currently invoked partway through `runPipeline` — AFTER stage 1
    // (`M3LExecutionEnvironment.detect()`) — so `hookContext()`'s fallback
    // (`this.currentCorrelationId ?? this.resolveCorrelationId()`) resolves
    // with NO `preferredId` when an earlier stage throws before that point is
    // reached, generating a random UUID instead of preferring the Lambda
    // `context.awsRequestId`. The fix resolves the id at the very top of the
    // pipeline, before stage 1, so it is already set (and consistent) by the
    // time `onError` fires no matter which stage fails.
    //
    // `stubAwsLambdaEnvironment()` first lets construction (which also calls
    // `M3LExecutionEnvironment.detect()`) succeed normally; the spy is then
    // overridden with `mockImplementationOnce` so only the pipeline's OWN
    // stage-1 call — the earliest mockable-to-throw seam in this file's
    // existing patterns — throws.
    stubAwsLambdaEnvironment();
    let errorCtxId: string | undefined;
    const script = new M3LScript({
      metadata,
      hooks: {
        onError: (ctx) => {
          errorCtxId = ctx.correlationId;
        },
      },
    });
    vi.spyOn(M3LExecutionEnvironment, "detect").mockImplementationOnce(() => {
      throw new Error("stage 1 (environment detection) failed");
    });

    const handler = script.createLambdaHandler<
      Record<string, never>,
      void,
      { awsRequestId: string }
    >(() => Promise.resolve());

    await expect(handler({}, { awsRequestId: "req-early" })).rejects.toThrow();

    expect(errorCtxId).toBe("req-early");
  });

  test("C15: the best-effort stderr diagnostic on a failing run carries the correlation id string, post-redaction", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = new M3LScript({
      metadata,
      correlationId: "trace-id-9000",
      hooks: {
        onCleanup: () => {
          // Forces the best-effort stderr diagnostic path already exercised
          // elsewhere in this file (see "a throwing onCleanup does not mask
          // the original error").
          throw new Error("cleanup itself blew up");
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw new Error("original failure");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    // Deliberately NOT pinning a specific JSON key: the field name (e.g.
    // `requestId` reuse vs. a new `correlationId`) is an implementer choice.
    expect(written).toContain("trace-id-9000");
  });

  test("C16: the re-thrown stage error's context does not gain a correlationId key (no mutation of the readonly context)", async () => {
    const originalContext = { attempt: 3 };
    const originalError = new M3LError("stage failed", {
      code: "ERR_TEST_STAGE",
      context: originalContext,
    });
    const script = new M3LScript({ metadata, correlationId: "X" });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    const context = (thrown as M3LError).context as
      Record<string, unknown> | undefined;
    expect(context).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(context, "correlationId")).toBe(
      false,
    );
  });

  test("D18: a failing run's diagnostic line carries the correlation id while a secret in the same failure is redacted", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = new M3LScript({
      metadata,
      correlationId: "trace-id-secret-test",
      hooks: {
        onCleanup: () => {
          throw new M3LError("cleanup failed", {
            code: "ERR_TEST_CLEANUP",
            context: { apiKey: "topsecretvalue" },
          });
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {
        throw new Error("original failure");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("trace-id-secret-test");
    expect(written).toContain("[REDACTED]");
    expect(written).not.toContain("topsecretvalue");
  });
});

// =============================================================================
// M3LScriptConfigLoader
// =============================================================================
describe("M3LScriptConfigLoader", () => {
  // Constructor/method names are spec-silent; behavior is exercised
  // end-to-end through M3LScript.run() above. Here we only assert the
  // symbol is a constructible class, per the documented public surface.
  test("is constructible", () => {
    expect(() => new M3LScriptConfigLoader()).not.toThrow();
  });

  test("load() stores a resolved parameter value in the returned config store", async () => {
    // Exercises the `value !== undefined` branch of load()'s per-parameter
    // loop: a param with a defaultValue always resolves (no provider/env/CLI
    // mocking needed), so `config.set(...)` actually runs — as opposed to
    // every other test in this file, which only ever declares zero params
    // (or a single `aws.profile` param never given a value), so that branch
    // was never taken.
    const loader = new M3LScriptConfigLoader();
    const region = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
      defaultValue: "eu-south-1",
    });

    const config = await loader.load({ params: [region] });

    expect(config.get("region")).toBe("eu-south-1");
    expect(config.has("region")).toBe(true);
  });

  test("load() omits a parameter from the config store when it resolves to undefined", async () => {
    // The `value !== undefined` branch's false side: a param with no
    // provider value, no defaultValue, and no asyncFallback resolves to
    // undefined and is skipped (not stored).
    const loader = new M3LScriptConfigLoader();
    const unset = new M3LConfigParameter({
      name: "totallyUnset",
      type: M3LConfigParameterType.STRING,
    });

    const config = await loader.load({ params: [unset] });

    expect(config.has("totallyUnset")).toBe(false);
  });
});

// =============================================================================
// M3LScriptConfigLoader — presetProviders precedence (F8: preset seam)
//
// Contract: `load()` gains a distinct, LOWEST-priority provider slot appended
// AFTER CLI + env: providers = [...extraProviders, CLI, env, ...presetProviders].
// `extraProviders` stays front-spread (highest priority).
// =============================================================================
describe("M3LScriptConfigLoader — presetProviders precedence (F8)", () => {
  const originalArgv = process.argv;

  /** Replaces `process.argv.slice(2)` (what `M3LCommandLineConfigProvider` reads by default) with `args`. */
  function stubArgv(...args: string[]): void {
    process.argv = [
      originalArgv[0] ?? "node",
      originalArgv[1] ?? "script",
      ...args,
    ];
  }

  afterEach(() => {
    process.argv = originalArgv;
  });

  test("a presetProviders value fills a param with no CLI/env value, overriding its static defaultValue", async () => {
    stubArgv();
    const loader = new M3LScriptConfigLoader();
    const region = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
      defaultValue: "default-region",
    });

    const config = await loader.load({
      params: [region],
      presetProviders: [
        new M3LPresetConfigProvider({ region: "preset-region" }),
      ],
    });

    expect(config.get("region")).toBe("preset-region");
  });

  test("a CLI value overrides a presetProviders value for the same parameter", async () => {
    stubArgv("--region=cli-region");
    const loader = new M3LScriptConfigLoader();
    const region = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
    });

    const config = await loader.load({
      params: [region],
      presetProviders: [
        new M3LPresetConfigProvider({ region: "preset-region" }),
      ],
    });

    expect(config.get("region")).toBe("cli-region");
  });

  test("an environment value overrides a presetProviders value for the same parameter", async () => {
    stubArgv();
    vi.stubEnv("REGION", "env-region");
    const loader = new M3LScriptConfigLoader();
    const region = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
    });

    const config = await loader.load({
      params: [region],
      presetProviders: [
        new M3LPresetConfigProvider({ region: "preset-region" }),
      ],
    });

    expect(config.get("region")).toBe("env-region");
  });

  test("an extraProviders value (front-spread, highest priority) overrides a presetProviders value", async () => {
    stubArgv();
    const loader = new M3LScriptConfigLoader();
    const region = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
    });

    const config = await loader.load({
      params: [region],
      extraProviders: [
        new M3LInMemoryConfigProvider({ region: "extra-region" }),
      ],
      presetProviders: [
        new M3LPresetConfigProvider({ region: "preset-region" }),
      ],
    });

    expect(config.get("region")).toBe("extra-region");
  });
});

// =============================================================================
// M3LScriptPresetLoader
// =============================================================================
describe("M3LScriptPresetLoader", () => {
  test("loads a preset at the maximum allowed nesting depth (64) without throwing", () => {
    // Build a 64-level-deep nested object: { level: { level: { ... } } }.
    let deepest: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 63; i++) {
      deepest = { level: deepest };
    }
    const preset = { level: deepest };

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(preset));

    const loader = new M3LScriptPresetLoader();
    expect(() => loader.load("/fixtures/preset-depth-64.json")).not.toThrow();
  });

  test("rejects a preset exceeding the maximum nesting depth (65)", () => {
    let deepest: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 64; i++) {
      deepest = { level: deepest };
    }
    const preset = { level: deepest };

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(preset));

    const loader = new M3LScriptPresetLoader();
    expect(() => loader.load("/fixtures/preset-depth-65.json")).toThrow();
  });

  test("throws M3LPresetUnknownKeysError for a key not recognized by the schema", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ unknownKey: "value" }),
    );

    const loader = new M3LScriptPresetLoader();
    expect(() => loader.load("/fixtures/preset-unknown-key.json")).toThrow(
      M3LPresetUnknownKeysError,
    );
  });

  test("M3LPresetUnknownKeysError is also an instance of M3LError", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ unknownKey: "value" }),
    );

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-unknown-key.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    expect(thrown).toBeInstanceOf(M3LError);
  });

  test("M3LPresetUnknownKeysError exposes typed unknownKeys/suggestions getters (not just context)", () => {
    // S5: the preferred access path is the typed, readonly properties, not
    // reaching into the inherited `context` bag.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ unknownKey: "value" }),
    );

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-unknown-key.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    const error = thrown as M3LPresetUnknownKeysError;
    expect(error.unknownKeys).toEqual(["unknownKey"]);
    expect(error.suggestions).toEqual([
      { key: "unknownKey", suggestion: undefined },
    ]);
  });

  test("preset read failure (e.g. ENOENT) surfaces as an M3LError, not a raw Node error", () => {
    // M2 fix: the read AND parse are covered by the same catch, chaining the
    // underlying OS error as `cause` rather than letting a raw ENOENT escape.
    const enoentError = Object.assign(new Error("no such file or directory"), {
      code: "ENOENT",
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw enoentError;
    });

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load("/fixtures/does-not-exist.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_PRESET_LOAD");
    expect((thrown as M3LError).cause).toBe(enoentError);
  });

  /**
   * A schema declaring two real parameter names ("region", "maxRows") so
   * `findClosestMatch` has real candidates to rank against — a loader built
   * with no schema (declaredNames() === []) short-circuits before
   * `damerauLevenshteinDistance` is ever called, which is why the previous
   * "did you mean" test here was hollow (it never actually verified a
   * suggestion was produced).
   */
  function makeRegionSchema(): M3LConfigSchema {
    return new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      }),
      new M3LConfigParameter({
        name: "maxRows",
        type: M3LConfigParameterType.INT,
      }),
    ]);
  }

  test.each([
    ["regionx", "insertion"],
    ["regon", "deletion"],
    ["regien", "substitution"],
    ["regoin", "adjacent transposition"],
  ])("suggests the declared name 'region' for a %s (%s) typo", (typoKey) => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ [typoKey]: "eu-west-1" }),
    );

    const loader = new M3LScriptPresetLoader({ schema: makeRegionSchema() });
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-typo.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    // S5: assert via the typed `suggestions` getter (the preferred access
    // path), not by scanning the human-readable message — a real
    // suggestion was actually computed, not just embedded in text that
    // could pass even if findClosestMatch had never run.
    const error = thrown as M3LPresetUnknownKeysError;
    expect(error.unknownKeys).toEqual([typoKey]);
    expect(error.suggestions).toEqual([{ key: typoKey, suggestion: "region" }]);
  });

  test("ranks the closest of multiple declared candidates (region beats maxRows for a region-typo key)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ regoin: "eu-west-1" }),
    );

    const loader = new M3LScriptPresetLoader({ schema: makeRegionSchema() });
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-typo.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    const error = thrown as M3LPresetUnknownKeysError;
    expect(error.suggestions).toEqual([
      { key: "regoin", suggestion: "region" },
    ]);
  });

  test("still picks a (distant) closest candidate — findClosestMatch has no distance threshold", () => {
    // findClosestMatch ranks by minimum distance only; it always returns
    // *some* candidate as long as the schema declares at least one name, no
    // matter how far. "no similar declared parameter found" is reserved for
    // the empty-schema case, exercised in the next test.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ zzzzzzzzzz: "value" }),
    );

    const loader = new M3LScriptPresetLoader({ schema: makeRegionSchema() });
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-far-key.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    const error = thrown as M3LPresetUnknownKeysError;
    expect(error.suggestions).toEqual([
      { key: "zzzzzzzzzz", suggestion: "region" },
    ]);
  });

  test("suggestion is undefined ('no similar declared parameter found') when the schema declares no names at all", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ unknownKey: "value" }),
    );

    const loader = new M3LScriptPresetLoader({
      schema: new M3LConfigSchema([]),
    });
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-empty-schema.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    const error = thrown as M3LPresetUnknownKeysError;
    expect(error.suggestions).toEqual([
      { key: "unknownKey", suggestion: undefined },
    ]);
  });

  test.each([["__proto__"], ["constructor"], ["prototype"]])(
    "throws M3LUnsafeConfigKeyError for a dangerous top-level preset key: %s (S4)",
    (dangerousKey) => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify(
          JSON.parse(`{"${dangerousKey}": {"polluted": true}}`) as Record<
            string,
            unknown
          >,
        ),
      );

      const loader = new M3LScriptPresetLoader();

      expect(() => loader.load("/fixtures/preset-dangerous-key.json")).toThrow(
        M3LUnsafeConfigKeyError,
      );
      // Belt-and-braces: confirm no prototype pollution actually occurred.
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    },
  );

  test("M3LUnsafeConfigKeyError (from the dangerous-key screen) is also an instance of M3LError", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify(
        JSON.parse('{"__proto__": {"polluted": true}}') as Record<
          string,
          unknown
        >,
      ),
    );

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load("/fixtures/preset-dangerous-key.json");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LUnsafeConfigKeyError);
    expect(thrown).toBeInstanceOf(M3LError);
  });
});

// =============================================================================
// M3LScriptPresetLoader — extends inheritance (WS-F)
//
// Contract: docs/reference/core/script.md § "Preset inheritance (`extends`)".
// The loader does REAL fs.readFileSync and resolves `extends` relative to
// `path.dirname` of the extending file, so these tests use REAL fixture files
// under a real, writable temp directory tree (mocking fs would defeat
// path-relative resolution). Every fixture-writing test gets a fresh temp dir
// in `beforeEach` and it is removed in `afterEach` — no fixture ever touches
// this repo's own tree.
// =============================================================================
describe("M3LScriptPresetLoader — extends inheritance", () => {
  let dir: string;

  // Shared schema declaring every top-level key any merge fixture in this
  // block uses (region, retries, tags, timeout, nested). The loader is
  // strict by default (an omitted/empty schema flags every merged key as
  // unknown per the documented contract), so any test whose fixtures merge
  // into one of these keys must construct the loader with this schema.
  // Deliberately does NOT declare "bogus" — the unknown-keys test below
  // still needs that key to be rejected.
  const extendsMergeSchema = new M3LConfigSchema([
    new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
    }),
    new M3LConfigParameter({
      name: "retries",
      type: M3LConfigParameterType.INT,
    }),
    new M3LConfigParameter({
      name: "tags",
      type: M3LConfigParameterType.STRING_ARRAY,
    }),
    new M3LConfigParameter({
      name: "timeout",
      type: M3LConfigParameterType.INT,
    }),
    new M3LConfigParameter({
      name: "nested",
      type: M3LConfigParameterType.STRING,
    }),
  ]);

  beforeEach(async () => {
    // The file-wide `beforeEach` (above, guarding stage-9 archival tests)
    // stubs `fsPromises.mkdir` to a no-op `mockResolvedValue(undefined)` for
    // every test in this file — and, because "fs"/"node:fs"/"node:fs/promises"
    // are mocked once at module scope, that same stub is shared by the named
    // `mkdir` import used below. This block writes REAL fixture files (a
    // subdirectory fixture needs a REAL `mkdir`), so restore the genuine
    // implementation here, scoped to this describe block only.
    const actualFsPromises =
      await vi.importActual<typeof fsPromises>("node:fs/promises");
    vi.spyOn(fsPromises, "mkdir").mockImplementation(actualFsPromises.mkdir);
    dir = await mkdtemp(nodePath.join(tmpdir(), "m3l-preset-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes `content` (already-serialized YAML/JSON text) to `relativePath` under the temp dir, creating parent directories as needed. */
  async function writeFixture(
    relativePath: string,
    content: string,
  ): Promise<string> {
    const fullPath = nodePath.join(dir, relativePath);
    await mkdir(nodePath.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  }

  test("2-level extends: derived overrides scalars, inherits region, REPLACES (not merges) the tags array, and strips `extends`", async () => {
    await writeFixture(
      "base.yaml",
      ["region: eu-south-1", "retries: 3", "tags:", "  - baseline", ""].join(
        "\n",
      ),
    );
    const prodPath = await writeFixture(
      "prod.yaml",
      ["extends: ./base.yaml", "retries: 5", "tags:", "  - prod", ""].join(
        "\n",
      ),
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    const result = loader.load(prodPath);

    expect(result).toEqual({
      region: "eu-south-1",
      retries: 5,
      tags: ["prod"],
    });
    expect("extends" in result).toBe(false);
  });

  test("3-level chain shallow-merges: nested.b is dropped (never deep-merged) and the nearest override wins fold order", async () => {
    await writeFixture(
      "grandparent.yaml",
      [
        "region: eu-south-1",
        "retries: 1",
        "timeout: 30",
        "nested:",
        "  a: 1",
        "  b: 2",
        "",
      ].join("\n"),
    );
    await writeFixture(
      "parent.yaml",
      [
        "extends: ./grandparent.yaml",
        "retries: 2",
        "nested:",
        "  a: 9",
        "",
      ].join("\n"),
    );
    const childPath = await writeFixture(
      "child.yaml",
      ["extends: ./parent.yaml", "timeout: 99", ""].join("\n"),
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    const result = loader.load(childPath);

    expect(result).toEqual({
      region: "eu-south-1",
      retries: 2,
      timeout: 99,
      nested: { a: 9 },
    });
  });

  test("`extends` is stripped from the returned record after any inheriting load", async () => {
    await writeFixture("base.yaml", "region: eu-south-1\n");
    const derivedPath = await writeFixture(
      "derived.yaml",
      "extends: ./base.yaml\nretries: 1\n",
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    const result = loader.load(derivedPath);

    expect("extends" in result).toBe(false);
  });

  test("a direct cycle (A extends ./A) throws M3LPresetCycleError whose chain starts and ends at A's resolved path", async () => {
    const aPath = await writeFixture("a.yaml", "extends: ./a.yaml\n");

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load(aPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetCycleError);
    const error = thrown as M3LPresetCycleError;
    expect(error.code).toBe("ERR_PRESET_CYCLE");
    expect(error.chain).toBe(error.context.chain);
    expect(Array.isArray(error.chain)).toBe(true);
    expect(error.chain.length).toBeGreaterThan(0);
    const resolvedA = nodePath.resolve(aPath);
    expect(error.chain[0]).toBe(resolvedA);
    expect(error.chain[error.chain.length - 1]).toBe(resolvedA);
  });

  test("a transitive cycle (A extends B extends A) throws M3LPresetCycleError with an ordered chain including both resolved paths", async () => {
    const aPath = await writeFixture("a.yaml", "extends: ./b.yaml\n");
    const bPath = await writeFixture("b.yaml", "extends: ./a.yaml\n");

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load(aPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetCycleError);
    const error = thrown as M3LPresetCycleError;
    expect(error.code).toBe("ERR_PRESET_CYCLE");
    const resolvedA = nodePath.resolve(aPath);
    const resolvedB = nodePath.resolve(bPath);
    expect(error.chain.length).toBeGreaterThanOrEqual(3);
    expect(error.chain).toContain(resolvedA);
    expect(error.chain).toContain(resolvedB);
  });

  test("an extends chain longer than MAX_PRESET_EXTENDS_DEPTH (16) throws M3LPresetCycleError (ERR_PRESET_CYCLE) even with no repeated file", async () => {
    // Build a 17-file non-repeating chain: file00 extends file01 extends ...
    // extends file17 (the terminal file, no further `extends`). Loading
    // file00 requires resolving 17 `extends` hops, one more than the
    // documented cap of 16 — a runaway/pathological chain is treated as a
    // cycle for safety per the contract.
    const depth = 17;
    for (let i = depth; i >= 0; i--) {
      const name = `file${String(i).padStart(2, "0")}.yaml`;
      const isTerminal = i === depth;
      const content = isTerminal
        ? "region: eu-south-1\n"
        : `extends: ./file${String(i + 1).padStart(2, "0")}.yaml\n`;
      await writeFixture(name, content);
    }

    const loader = new M3LScriptPresetLoader();
    const topPath = nodePath.join(dir, "file00.yaml");

    let thrown: unknown;
    try {
      loader.load(topPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetCycleError);
    expect((thrown as M3LPresetCycleError).code).toBe("ERR_PRESET_CYCLE");
  });

  test("`extends` resolves relative to the extending FILE's directory, not the process CWD", async () => {
    await writeFixture("base.yaml", "region: eu-south-1\nretries: 3\n");
    const subPath = await writeFixture(
      "sub/derived.yaml",
      "extends: ../base.yaml\nretries: 7\n",
    );

    // Sanity check the negative: a base.yaml resolved relative to the
    // process CWD would not exist under CWD's "base.yaml" (this test's temp
    // dir is never the CWD), so a correct dir-relative resolution is the
    // only way this load can succeed at all.
    expect(nodePath.resolve(process.cwd(), "base.yaml")).not.toBe(
      nodePath.resolve(dir, "base.yaml"),
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    const result = loader.load(subPath);

    expect(result).toEqual({ region: "eu-south-1", retries: 7 });
  });

  test("unknown-key validation runs on the MERGED result: a base key absent from the schema still throws, and a declared base key the derived omits is inherited without error", async () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      }),
      new M3LConfigParameter({
        name: "retries",
        type: M3LConfigParameterType.INT,
      }),
    ]);

    // Positive: base declares only `region` (declared), derived overrides
    // `retries` (also declared) — merged result has no unknown keys.
    await writeFixture("ok-base.yaml", "region: eu-south-1\n");
    const okDerivedPath = await writeFixture(
      "ok-derived.yaml",
      "extends: ./ok-base.yaml\nretries: 5\n",
    );
    const okLoader = new M3LScriptPresetLoader({ schema });
    expect(okLoader.load(okDerivedPath)).toEqual({
      region: "eu-south-1",
      retries: 5,
    });

    // Negative: base carries an undeclared key ("bogus") the derived never
    // mentions — validation still catches it because it runs on the merged
    // record, not just the derived file's own keys.
    await writeFixture("bad-base.yaml", "region: eu-south-1\nbogus: true\n");
    const badDerivedPath = await writeFixture(
      "bad-derived.yaml",
      "extends: ./bad-base.yaml\nretries: 5\n",
    );
    const badLoader = new M3LScriptPresetLoader({ schema });
    expect(() => badLoader.load(badDerivedPath)).toThrow(
      M3LPresetUnknownKeysError,
    );
  });

  test("a YAML base extended by a JSON derived preset merges successfully across formats", async () => {
    await writeFixture("base.yaml", "region: eu-south-1\nretries: 3\n");
    const childPath = await writeFixture(
      "child.json",
      JSON.stringify({ extends: "./base.yaml", retries: 9 }),
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    const result = loader.load(childPath);

    expect(result).toEqual({ region: "eu-south-1", retries: 9 });
  });

  test("a missing extends target propagates the loader's load error (ERR_PRESET_LOAD) with the underlying fs error chained as cause", async () => {
    const derivedPath = await writeFixture(
      "derived.yaml",
      "extends: ./does-not-exist.yaml\nretries: 1\n",
    );

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load(derivedPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_PRESET_LOAD");
    expect((thrown as M3LError).cause).toBeDefined();
  });

  test("a malformed-YAML extends base surfaces ERR_PRESET_LOAD with a chained cause", async () => {
    await writeFixture("malformed.yaml", "region: [unterminated\n");
    const derivedPath = await writeFixture(
      "derived.yaml",
      "extends: ./malformed.yaml\nretries: 1\n",
    );

    const loader = new M3LScriptPresetLoader();
    let thrown: unknown;
    try {
      loader.load(derivedPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_PRESET_LOAD");
    expect((thrown as M3LError).cause).toBeDefined();
  });

  test("a non-string extends value throws ERR_PRESET_LOAD, not silently coerced", async () => {
    const derivedPath = await writeFixture(
      "bad-extends.yaml",
      "extends: 42\nretries: 1\n",
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    let thrown: unknown;
    try {
      loader.load(derivedPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_PRESET_LOAD");
  });

  test("a base file whose top-level is a list (not a mapping) throws ERR_PRESET_LOAD", async () => {
    await writeFixture("list-base.yaml", "- a\n- b\n");
    const derivedPath = await writeFixture(
      "uses-list-base.yaml",
      "extends: ./list-base.yaml\nretries: 1\n",
    );

    const loader = new M3LScriptPresetLoader({ schema: extendsMergeSchema });
    let thrown: unknown;
    try {
      loader.load(derivedPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_PRESET_LOAD");
  });

  test("REGRESSION: a plain preset with no `extends` still loads and validates exactly as before", async () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      }),
    ]);
    const plainPath = await writeFixture("plain.yaml", "region: eu-south-1\n");

    const loader = new M3LScriptPresetLoader({ schema });
    const result = loader.load(plainPath);

    expect(result).toEqual({ region: "eu-south-1" });
  });

  describe("type-level contract", () => {
    test("M3LPresetCycleError.chain is a readonly string[]", () => {
      expectTypeOf<M3LPresetCycleError["chain"]>().toEqualTypeOf<
        readonly string[]
      >();
    });
  });
});

// =============================================================================
// M3LScript — preset seam (F8)
//
// Contract: docs/reference/core/script.md + core/config.md. `options.preset`
// is an optional file path to a YAML/JSON preset. When set, `M3LScript`
// loads it (validated against `options.config.params`) and wires it in at
// precedence level 6 (below CLI/env, above static `defaultValue`). Absent =>
// no behavior change, no preset file read. F8 introduces NO new error
// types -- the preset loader's own throws (`M3LPresetUnknownKeysError`, and
// an `M3LError` coded "ERR_PRESET_LOAD" for a missing/malformed file)
// propagate unchanged through `loadConfig()` -> `run()` (`onError` fires,
// then the original error is rethrown).
// =============================================================================
describe("M3LScript — preset seam (F8)", () => {
  const originalArgv = process.argv;

  /** Replaces `process.argv.slice(2)` (what `M3LCommandLineConfigProvider` reads by default) with `args`. */
  function stubArgv(...args: string[]): void {
    process.argv = [
      originalArgv[0] ?? "node",
      originalArgv[1] ?? "script",
      ...args,
    ];
  }

  /** The single-parameter schema every test in this block declares. */
  function makeRegionParam(defaultValue?: string): M3LConfigParameter {
    return defaultValue === undefined
      ? new M3LConfigParameter({
          name: "region",
          type: M3LConfigParameterType.STRING,
        })
      : new M3LConfigParameter({
          name: "region",
          type: M3LConfigParameterType.STRING,
          defaultValue,
        });
  }

  beforeEach(() => {
    stubNonAwsEnvironment();
    stubArgv();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  test("a preset value flows through run() into resolved configuration, overriding the param's static defaultValue", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ region: "preset-region" }),
    );
    let resolvedRegion: unknown;
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam("default-region")] },
      preset: "/fixtures/preset.json",
      hooks: {
        onAfterConfigLoad: (ctx) => {
          resolvedRegion = ctx.config.get("region");
        },
      },
    });

    await script.run(() => {});

    expect(resolvedRegion).toBe("preset-region");
  });

  test("a CLI value overrides the preset value for the same parameter", async () => {
    stubArgv("--region=cli-region");
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ region: "preset-region" }),
    );
    let resolvedRegion: unknown;
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam()] },
      preset: "/fixtures/preset.json",
      hooks: {
        onAfterConfigLoad: (ctx) => {
          resolvedRegion = ctx.config.get("region");
        },
      },
    });

    await script.run(() => {});

    expect(resolvedRegion).toBe("cli-region");
  });

  test("an environment value overrides the preset value for the same parameter", async () => {
    vi.stubEnv("REGION", "env-region");
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ region: "preset-region" }),
    );
    let resolvedRegion: unknown;
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam()] },
      preset: "/fixtures/preset.json",
      hooks: {
        onAfterConfigLoad: (ctx) => {
          resolvedRegion = ctx.config.get("region");
        },
      },
    });

    await script.run(() => {});

    expect(resolvedRegion).toBe("env-region");
  });

  test("omitting options.preset resolves configuration exactly as before, with no preset file read", async () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    let resolvedRegion: unknown;
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam("default-region")] },
      hooks: {
        onAfterConfigLoad: (ctx) => {
          resolvedRegion = ctx.config.get("region");
        },
      },
    });

    await script.run(() => {});

    expect(resolvedRegion).toBe("default-region");
    expect(readSpy).not.toHaveBeenCalled();
  });

  test("a preset key not declared in options.config.params rejects run() with M3LPresetUnknownKeysError", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ unknownKey: "value" }),
    );
    let onErrorError: unknown;
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam()] },
      preset: "/fixtures/preset-unknown-key.json",
      hooks: {
        onError: (_ctx, error) => {
          onErrorError = error;
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    expect(onErrorError).toBe(thrown);
  });

  test("a preset key that IS a declared param resolves fine (no throw)", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ region: "preset-region" }),
    );
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam()] },
      preset: "/fixtures/preset-known-key.json",
    });

    await expect(script.run(() => {})).resolves.toBeUndefined();
  });

  test("a missing/unreadable preset file rejects run() with an M3LError coded ERR_PRESET_LOAD (M3LPresetLoadError stays unexported)", async () => {
    const enoentError = Object.assign(new Error("no such file or directory"), {
      code: "ENOENT",
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw enoentError;
    });
    let onErrorError: unknown;
    const script = new M3LScript({
      metadata,
      config: { params: [makeRegionParam()] },
      preset: "/fixtures/does-not-exist.json",
      hooks: {
        onError: (_ctx, error) => {
          onErrorError = error;
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_PRESET_LOAD");
    expect((thrown as M3LError).cause).toBe(enoentError);
    expect(onErrorError).toBe(thrown);
  });

  test("preset supplied without options.config rejects run() with M3LPresetUnknownKeysError, since every top-level preset key is then unknown", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ foo: "bar" }),
    );
    let onErrorError: unknown;
    const script = new M3LScript({
      metadata,
      preset: "/fixtures/preset-no-config.json",
      hooks: {
        onError: (_ctx, error) => {
          onErrorError = error;
        },
      },
    });

    let thrown: unknown;
    try {
      await script.run(() => {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LPresetUnknownKeysError);
    expect(onErrorError).toBe(thrown);
  });
});

// =============================================================================
// installProcessGuards — idempotent process-global singleton
// =============================================================================
describe("installProcessGuards()", () => {
  // `installProcessGuards` is a genuine process-global singleton (a module
  // top-level `guardsInstalled` flag, with no test-only reset hook exposed —
  // by design, matching the documented "idempotent … safe to call from every
  // constructor" contract). Consequently only the *first* call to
  // `installProcessGuards()` across this whole test file actually invokes
  // `process.on(...)`; every later call anywhere else is already a no-op.
  // This first test is therefore the only place the four real handler
  // callbacks can be captured and invoked — later tests in this block can
  // only observe the (correct) absence of further registration.
  test("installs unhandledRejection, uncaughtException, warning, and beforeExit handlers, and each callback runs without throwing", () => {
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(
        (
          eventName: string | symbol,
          listener: (...args: unknown[]) => void,
        ) => {
          handlers.set(eventName, listener);
          return process;
        },
      );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    installProcessGuards();

    const registeredEvents = onSpy.mock.calls.map(([eventName]) => eventName);
    expect(registeredEvents).toEqual(
      expect.arrayContaining([
        "unhandledRejection",
        "uncaughtException",
        "warning",
        "beforeExit",
      ]),
    );

    // Invoke every captured callback so their bodies (which call
    // serializeError + write a diagnostic to stderr) are actually exercised,
    // not just registered.
    const unhandledRejection = handlers.get("unhandledRejection");
    const uncaughtException = handlers.get("uncaughtException");
    const warning = handlers.get("warning");
    const beforeExit = handlers.get("beforeExit");

    expect(unhandledRejection).toBeDefined();
    expect(uncaughtException).toBeDefined();
    expect(warning).toBeDefined();
    expect(beforeExit).toBeDefined();

    expect(() =>
      unhandledRejection?.(new Error("unhandled rejection")),
    ).not.toThrow();
    expect(() =>
      uncaughtException?.(new Error("uncaught exception")),
    ).not.toThrow();
    expect(() => warning?.(new Error("a warning"))).not.toThrow();
    // beforeExit's handler takes no meaningful argument (see contract: it
    // exists to confirm the guard layer observes normal shutdown too).
    expect(() => beforeExit?.(0)).not.toThrow();

    // Each fault-reporting callback (not beforeExit, which reports nothing)
    // wrote a best-effort diagnostic to stderr.
    expect(stderrSpy).toHaveBeenCalled();
  });

  test("setProcessGuardRequestId attaches the request id to guard-caught diagnostics", () => {
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        // installProcessGuards is already installed by the previous test (in
        // this same process); on a repeat call `process.on` is never invoked
        // again, so this spy only matters if this test file's execution
        // order ever changes. Captured defensively so the assertion below is
        // meaningful either way.
        handlers.set(eventName, listener);
        return process;
      },
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    installProcessGuards();
    setProcessGuardRequestId("req-guard-test");

    const uncaughtException = handlers.get("uncaughtException");
    if (uncaughtException !== undefined) {
      uncaughtException(new Error("boom"));
      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("req-guard-test");
    } else {
      // installProcessGuards was already installed by an earlier test in
      // this file (the singleton only registers once per process) — exercise
      // serializeError directly instead, which is what every guard callback
      // delegates to for request-id attribution.
      expect(serializeError(new Error("boom"))).toMatchObject({
        requestId: "req-guard-test",
      });
    }
  });

  test("calling installProcessGuards() twice does not double-register handlers", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    installProcessGuards();
    const firstCallCount = onSpy.mock.calls.length;
    installProcessGuards();
    const secondCallCount = onSpy.mock.calls.length;

    expect(secondCallCount).toBe(firstCallCount);
  });

  test("returns void", () => {
    vi.spyOn(process, "on").mockImplementation(() => process);
    installProcessGuards();
    expectTypeOf(installProcessGuards).returns.toBeVoid();
  });

  describe("type-level contract", () => {
    test("has signature () => void", () => {
      expectTypeOf(installProcessGuards).toEqualTypeOf<() => void>();
    });
  });
});

// =============================================================================
// serializeError — robustness across arbitrary unknown inputs
// =============================================================================
describe("serializeError()", () => {
  test("serializes an Error, producing an object with at least a message field", () => {
    const result = serializeError(new Error("plain failure"));
    expect(result).toMatchObject({ message: "plain failure" });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("serializes an M3LError, including its code", () => {
    const error = new M3LError("config problem", { code: "ERR_TEST" });
    const result = serializeError(error);
    expect(result).toMatchObject({
      message: "config problem",
      code: "ERR_TEST",
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("serializes a bare string without throwing", () => {
    let result: unknown;
    expect(() => {
      result = serializeError("just a string");
    }).not.toThrow();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("serializes undefined without throwing", () => {
    let result: unknown;
    expect(() => {
      result = serializeError(undefined);
    }).not.toThrow();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("serializes a circular object without throwing", () => {
    const circular: Record<string, unknown> = { name: "circular" };
    circular["self"] = circular;

    let result: unknown;
    expect(() => {
      result = serializeError(circular);
    }).not.toThrow();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  describe("type-level contract", () => {
    test("parameter is typed unknown, not Error", () => {
      expectTypeOf(serializeError).parameter(0).toBeUnknown();
    });
  });
});

// =============================================================================
// setProcessGuardRequestId
// =============================================================================
describe("setProcessGuardRequestId()", () => {
  test("accepts a string and returns void without throwing", () => {
    expect(() => setProcessGuardRequestId("req-12345")).not.toThrow();
    expectTypeOf(setProcessGuardRequestId).returns.toBeVoid();
  });

  describe("type-level contract", () => {
    test("has signature (requestId: string) => void", () => {
      expectTypeOf(setProcessGuardRequestId).toEqualTypeOf<
        (requestId: string) => void
      >();
    });
  });
});

// =============================================================================
// runScript() — the composition-root wrapper (ADR-0035 phase 4a)
//
// Contract under test: `runScript(script, mainFn, options?)`
//  1. installs the process guards;
//  2. drives `script.run(mainFn, { dryRun })`;
//  3. on success, best-effort persists a "success" `M3LRunReport` and leaves
//     `process.exitCode` untouched;
//  4. on failure, routes the error to `script.logger.errorFrom` (never
//     throws), best-effort persists a "failure" report carrying
//     `script.getLastFailureStage() ?? "unknown"` and the error, sets
//     `process.exitCode` via `mapErrorToExitCode`, and resolves — it never
//     re-throws and never calls `process.exit` itself.
//
// `M3LRunReporter.prototype.persist` is spied throughout rather than left to
// hit the real filesystem: `persist()` is documented as never-rejecting, so
// spying it directly (rather than mocking its `mkdir`/`writeFile`/`realpath`
// I/O primitives) is both simpler and lets individual tests force the "report
// writer itself failed" scenario (case 6 below) that the real implementation
// is specifically designed never to produce.
// =============================================================================
describe("runScript() — composition-root wrapper", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  afterEach(() => {
    // A leaked non-zero `process.exitCode` corrupts the whole suite's own
    // exit status even when every test passes — see the file-level isolation
    // note this task's brief calls out explicitly.
    process.exitCode = undefined;
  });

  describe("process guard installation", () => {
    test("installs the process guards", async () => {
      const installSpy = vi.spyOn(ProcessGuardsModule, "installProcessGuards");
      // Isolation: without this stub, a successful run's default
      // `report: true` persistence reaches the REAL `M3LRunReporter.persist`,
      // which resolves `script.paths` against the real repo and attempts to
      // write `data/output/<timestamp>/run-report.json` on disk — harmless
      // only by accident (ENOENT when `data/output/` happens to be absent,
      // best-effort-swallowed). Every sibling test in this describe block
      // stubs `persist`; this one must too.
      vi.spyOn(M3LRunReporter.prototype, "persist").mockResolvedValue(
        "/fake/report.json",
      );
      const script = new M3LScript({ metadata });

      await runScript(script, () => {});

      expect(installSpy).toHaveBeenCalled();
    });

    test("M3LScript construction alone does NOT install the process guards", () => {
      const installSpy = vi.spyOn(ProcessGuardsModule, "installProcessGuards");
      const script = new M3LScript({ metadata });
      void script;

      expect(installSpy).not.toHaveBeenCalled();
    });
  });

  describe("exit codes by error origin", () => {
    test.each([
      [
        "a caller-origin M3LError (ERR_CONFIG_MISSING, catalog-classified)",
        () => new M3LError("bad config", { code: "ERR_CONFIG_MISSING" }),
        M3L_EXIT_CODES.CONFIG_USAGE,
      ],
      [
        "an external-origin M3LError (ERR_AWS_CLIENT, catalog-classified)",
        () => new M3LError("aws unreachable", { code: "ERR_AWS_CLIENT" }),
        M3L_EXIT_CODES.EXTERNAL,
      ],
      [
        "a library-origin M3LError (explicit origin override — no built-in code classifies as library)",
        () =>
          new M3LError("internal invariant violated", {
            code: "ERR_INVALID_ARGUMENT",
            origin: "library",
          }),
        M3L_EXIT_CODES.LIBRARY,
      ],
      [
        "a plain (non-M3LError) Error",
        () => new Error("boom"),
        M3L_EXIT_CODES.UNCLASSIFIED,
      ],
    ])(
      "%s sets process.exitCode to %i",
      async (_label, makeError, expected) => {
        vi.spyOn(M3LRunReporter.prototype, "persist").mockResolvedValue(
          "/fake/report.json",
        );
        const exitSpy = vi
          .spyOn(process, "exit")
          .mockImplementation(() => undefined as never);
        const script = new M3LScript({ metadata });

        await runScript(script, () => {
          throw makeError();
        });

        expect(process.exitCode).toBe(expected);
        // `runScript` must only ever SET `process.exitCode`, never call
        // `process.exit()` directly.
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );

    test("a thrown bare string (non-Error, non-M3LError) also maps to UNCLASSIFIED (1)", async () => {
      vi.spyOn(M3LRunReporter.prototype, "persist").mockResolvedValue(
        "/fake/report.json",
      );
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const script = new M3LScript({ metadata });

      await runScript(script, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify mapErrorToExitCode's UNCLASSIFIED fallback reaches runScript's own catch/exitCode assignment
        throw "boom";
      });

      expect(process.exitCode).toBe(M3L_EXIT_CODES.UNCLASSIFIED);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  test("a thrown error does not escape runScript's returned promise, but still reaches logger.errorFrom and the persisted report", async () => {
    const persistSpy = vi
      .spyOn(M3LRunReporter.prototype, "persist")
      .mockResolvedValue("/fake/report.json");
    const script = new M3LScript({ metadata });
    const errorFromSpy = vi.spyOn(script.logger, "errorFrom");
    const failure = new Error("mainFn exploded");

    await expect(
      runScript(script, () => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(errorFromSpy).toHaveBeenCalledWith(failure);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
    expect(input.outcome).toBe("failure");
    expect(input.error).toBe(failure);
  });

  test('a successful run persists a report with outcome "success" and leaves process.exitCode untouched', async () => {
    const persistSpy = vi
      .spyOn(M3LRunReporter.prototype, "persist")
      .mockResolvedValue("/fake/report.json");
    const script = new M3LScript({ metadata });
    const exitCodeBefore = process.exitCode;

    await runScript(script, () => {});

    expect(process.exitCode).toBe(exitCodeBefore);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
    expect(input.outcome).toBe("success");
  });

  test('a config-load-stage failure and a mainFn (main-stage) failure persist reports with DIFFERENT stage labels, neither of which is mislabeled "main" for the config failure', async () => {
    // Config-load-stage failure: a preset key not declared in
    // `options.config.params` throws `M3LPresetUnknownKeysError` out of stage
    // 3 (config load), before `mainFn` is ever reached — mirroring the
    // existing "M3LScript — preset seam (F8)" describe block's own fixture
    // for the identical failure mode.
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ unknownKey: "value" }),
    );
    const configPersistSpy = vi
      .spyOn(M3LRunReporter.prototype, "persist")
      .mockResolvedValue("/fake/config-report.json");
    const configFailScript = new M3LScript({
      metadata,
      config: {
        params: [
          new M3LConfigParameter({
            name: "region",
            type: M3LConfigParameterType.STRING,
            defaultValue: "default-region",
          }),
        ],
      },
      preset: "/fixtures/preset-unknown-key.json",
    });

    await runScript(configFailScript, () => {});

    expect(configPersistSpy).toHaveBeenCalledTimes(1);
    const [configInput] = configPersistSpy.mock.calls[0] as [M3LRunReportInput];
    expect(configInput.outcome).toBe("failure");
    const configStage = configInput.stage;
    expect(configStage).toBeDefined();
    expect(configStage).not.toBe("main");
    configPersistSpy.mockRestore();

    // Main-stage failure: mainFn itself throws.
    const mainPersistSpy = vi
      .spyOn(M3LRunReporter.prototype, "persist")
      .mockResolvedValue("/fake/main-report.json");
    const mainFailScript = new M3LScript({ metadata });

    await runScript(mainFailScript, () => {
      throw new Error("main blew up");
    });

    expect(mainPersistSpy).toHaveBeenCalledTimes(1);
    const [mainInput] = mainPersistSpy.mock.calls[0] as [M3LRunReportInput];
    expect(mainInput.stage).toBe("main");
    expect(mainInput.stage).not.toBe(configStage);
  });

  test("a rejecting M3LRunReporter.persist does not lose the exit code, and runScript still resolves", async () => {
    vi.spyOn(M3LRunReporter.prototype, "persist").mockRejectedValue(
      new Error("disk full"),
    );
    const script = new M3LScript({ metadata });

    await expect(
      runScript(script, () => {
        throw new M3LError("bad config", { code: "ERR_CONFIG_MISSING" });
      }),
    ).resolves.toBeUndefined();

    expect(process.exitCode).toBe(M3L_EXIT_CODES.CONFIG_USAGE);
  });

  test("options.report === false skips report persistence entirely but still sets process.exitCode", async () => {
    const persistSpy = vi.spyOn(M3LRunReporter.prototype, "persist");
    const script = new M3LScript({ metadata });

    await runScript(
      script,
      () => {
        throw new M3LError("aws unreachable", { code: "ERR_AWS_CLIENT" });
      },
      { report: false },
    );

    expect(persistSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(M3L_EXIT_CODES.EXTERNAL);
  });

  describe("options.report on a SUCCESSFUL run", () => {
    test("report: false skips persistence entirely and leaves process.exitCode untouched", async () => {
      const persistSpy = vi.spyOn(M3LRunReporter.prototype, "persist");
      const script = new M3LScript({ metadata });
      const exitCodeBefore = process.exitCode;

      await runScript(script, () => {}, { report: false });

      expect(persistSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCodeBefore);
    });
  });

  describe("timeline persistence via options.trail", () => {
    test("a successful run persists the timeline from a supplied trail", async () => {
      const persistSpy = vi
        .spyOn(M3LRunReporter.prototype, "persist")
        .mockResolvedValue("/fake/report.json");
      const script = new M3LScript({ metadata });
      const trail = new M3LBreadcrumbTrail();
      trail.record("test", "custom:tick", { n: 1 });

      await runScript(script, () => {}, { trail });

      expect(persistSpy).toHaveBeenCalledTimes(1);
      const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
      expect(input.timeline).toEqual(trail.entries());
    });

    test("a failing run persists the timeline from a supplied trail", async () => {
      const persistSpy = vi
        .spyOn(M3LRunReporter.prototype, "persist")
        .mockResolvedValue("/fake/report.json");
      const script = new M3LScript({ metadata });
      const trail = new M3LBreadcrumbTrail();
      trail.record("test", "custom:tick", { n: 1 });

      await runScript(
        script,
        () => {
          throw new Error("main blew up");
        },
        { trail },
      );

      expect(persistSpy).toHaveBeenCalledTimes(1);
      const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
      expect(input.timeline).toEqual(trail.entries());
    });
  });

  describe("a throwing options.trail.entries() must not lose the exit code (ADR-0035 phase 4a regression)", () => {
    // Regression coverage for a bug reproduced against built `dist/`: a
    // genuine failure that should exit `2` instead exited `0` because
    // `buildFailureInput`/`buildSuccessInput` were evaluated as function
    // ARGUMENTS, outside `persistBestEffort`'s own try/catch — so a throwing
    // `options.trail.entries()` escaped the guarded region entirely, skipped
    // `process.exitCode = mapErrorToExitCode(error)`, and surfaced only as an
    // unhandled rejection absorbed (log-only) by `runScript`'s own
    // `uncaughtException`/`unhandledRejection` guard. The fix moved
    // `buildInput` construction inside `persistBestEffort`'s try/catch (as a
    // thunk) and moved the `process.exitCode` assignment to immediately after
    // `logger.errorFrom`, before any report work.
    //
    // `trail` is `Pick<M3LBreadcrumbTrail, "entries">`, so a plain object
    // literal satisfies it without subclassing `M3LBreadcrumbTrail`.
    const hostileTrail: Pick<M3LBreadcrumbTrail, "entries"> = {
      entries: () => {
        throw new Error("boom: entries() blew up");
      },
    };

    test("failure arm: a throwing trail.entries() alongside a caller-origin mainFn failure still resolves and sets process.exitCode, with a best-effort diagnostic for the failed report build", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const persistSpy = vi.spyOn(M3LRunReporter.prototype, "persist");
      const script = new M3LScript({ metadata });

      await expect(
        runScript(
          script,
          () => {
            throw new M3LError("bad config", { code: "ERR_CONFIG_MISSING" });
          },
          { trail: hostileTrail },
        ),
      ).resolves.toBeUndefined();

      expect(process.exitCode).toBe(M3L_EXIT_CODES.CONFIG_USAGE);
      // `reporter.persist` is never reached — the build failed before it.
      expect(persistSpy).not.toHaveBeenCalled();
      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("run-report-build-failed");
    });

    test("success arm: a throwing trail.entries() on an otherwise-successful run resolves and leaves process.exitCode untouched, with a best-effort diagnostic for the failed report build", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const persistSpy = vi.spyOn(M3LRunReporter.prototype, "persist");
      const script = new M3LScript({ metadata });
      const exitCodeBefore = process.exitCode;

      await expect(
        runScript(script, () => {}, { trail: hostileTrail }),
      ).resolves.toBeUndefined();

      // Previously, the success-arm throw fell into the outer `catch`, which
      // re-invoked the failure builder with the SAME poisoned trail and threw
      // again with nothing left to catch — this asserts `process.exitCode` is
      // untouched, not merely truthy/falsy.
      expect(process.exitCode).toBe(exitCodeBefore);
      expect(persistSpy).not.toHaveBeenCalled();
      const written = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("\n");
      expect(written).toContain("run-report-build-failed");
    });

    test("ordering guarantee: process.exitCode is already set BEFORE reporter.persist is even invoked, so it survives persist also rejecting", async () => {
      let exitCodeWhenPersistCalled: typeof process.exitCode;
      vi.spyOn(M3LRunReporter.prototype, "persist").mockImplementation(() => {
        // Captured at call time, not after — proves `process.exitCode` was
        // assigned before this call was ever reached, not merely by the
        // time `runScript` returns.
        exitCodeWhenPersistCalled = process.exitCode;
        return Promise.reject(new Error("disk full"));
      });
      const script = new M3LScript({ metadata });

      await expect(
        runScript(script, () => {
          throw new M3LError("bad config", { code: "ERR_CONFIG_MISSING" });
        }),
      ).resolves.toBeUndefined();

      expect(exitCodeWhenPersistCalled).toBe(M3L_EXIT_CODES.CONFIG_USAGE);
      expect(process.exitCode).toBe(M3L_EXIT_CODES.CONFIG_USAGE);
    });
  });

  describe("archive metadata persistence on a successful run", () => {
    test("a run whose stage 9 archival populated getLastArchiveReport() persists that archive", async () => {
      const persistSpy = vi
        .spyOn(M3LRunReporter.prototype, "persist")
        .mockResolvedValue("/fake/report.json");
      const script = new M3LScript({ metadata });

      await runScript(script, () => {});

      const archiveReport = script.getLastArchiveReport();
      expect(archiveReport).toBeDefined();
      expect(persistSpy).toHaveBeenCalledTimes(1);
      const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
      expect(input.archive).toBe(archiveReport);
    });
  });

  describe("dry-run must not embed a stale archive (ADR-0035 phase 4a regression)", () => {
    test("a dry run on an instance that already ran for real omits `archive` entirely rather than embedding the PRIOR real run's archive manifest", async () => {
      const persistSpy = vi
        .spyOn(M3LRunReporter.prototype, "persist")
        .mockResolvedValue("/fake/report.json");
      const script = new M3LScript({ metadata });

      // A real run first, so `script.getLastArchiveReport()` is populated —
      // `getLastArchiveReport()` is never reset per run, so a naive
      // `dryRun ? undefined : script.getLastArchiveReport()` would still see
      // this prior report on the dry run below.
      await runScript(script, () => {});
      expect(script.getLastArchiveReport()).toBeDefined();
      persistSpy.mockClear();

      await runScript(script, () => {}, { dryRun: true });

      expect(persistSpy).toHaveBeenCalledTimes(1);
      const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
      expect(input.outcome).toBe("dry-run");
      // Under `exactOptionalPropertyTypes`, the key must be ABSENT, not
      // present-and-`undefined` — `toBeUndefined()` alone would pass for
      // `{ archive: undefined }` too, which is not what the fix guarantees.
      expect(input).not.toHaveProperty("archive");
    });
  });

  describe("forced signal exit code is scoped to the run and restored afterward (ADR-0035 phase 4a regression)", () => {
    // Previously, `setForcedSignalExitCode(M3L_EXIT_CODES.INTERRUPTED)` was
    // never restored, so every subsequent bare `script.run()` in the same
    // process also force-exited on a second signal with the INTERRUPTED code
    // instead of whatever value was in effect before `runScript` ran.
    afterEach(() => {
      setForcedSignalExitCode(1);
    });

    test.each([
      [
        "a successful run",
        () => {
          /* no-op mainFn */
        },
      ],
      [
        "a failing run",
        () => {
          throw new M3LError("bad config", { code: "ERR_CONFIG_MISSING" });
        },
      ],
    ])(
      "%s forces INTERRUPTED for the DURATION of the run, then restores the prior value afterward",
      async (_label, mainFn) => {
        vi.spyOn(M3LRunReporter.prototype, "persist").mockResolvedValue(
          "/fake/report.json",
        );
        setForcedSignalExitCode(1);
        const script = new M3LScript({ metadata });
        let duringRun: number | undefined;

        await runScript(script, () => {
          duringRun = getForcedSignalExitCode();
          mainFn();
        });

        expect(duringRun).toBe(M3L_EXIT_CODES.INTERRUPTED);
        expect(getForcedSignalExitCode()).toBe(1);
      },
    );

    test("restores whatever prior value was in effect, not the hardcoded default 1 (so a nested/second runScript's own override is never corrupted)", async () => {
      vi.spyOn(M3LRunReporter.prototype, "persist").mockResolvedValue(
        "/fake/report.json",
      );
      setForcedSignalExitCode(42);
      const script = new M3LScript({ metadata });

      await runScript(script, () => {});

      expect(getForcedSignalExitCode()).toBe(42);
    });

    test("after runScript resolves, a second shutdown signal forces the RESTORED prior code, not INTERRUPTED", async () => {
      vi.spyOn(M3LRunReporter.prototype, "persist").mockResolvedValue(
        "/fake/report.json",
      );
      setForcedSignalExitCode(1);
      const script = new M3LScript({ metadata });

      await runScript(script, () => {});

      const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
      vi.spyOn(process, "on").mockImplementation(
        (
          eventName: string | symbol,
          listener: (...args: unknown[]) => void,
        ) => {
          handlers.set(eventName, listener);
          return process;
        },
      );
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);

      registerShutdownSignals(vi.fn());
      const sigtermHandler = handlers.get("SIGTERM");
      expect(sigtermHandler).toBeDefined();
      sigtermHandler?.();
      sigtermHandler?.();

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("type-level contract", () => {
    test("M3LRunScriptOptions: every field is optional", () => {
      expectTypeOf<M3LRunScriptOptions>().toEqualTypeOf<{
        readonly dryRun?: boolean;
        readonly report?: boolean;
        readonly trail?: Pick<M3LBreadcrumbTrail, "entries">;
      }>();
    });

    test("runScript returns Promise<void>", () => {
      expectTypeOf(runScript).returns.toEqualTypeOf<Promise<void>>();
    });

    // `trail` is narrowed to `Pick<M3LBreadcrumbTrail, "entries">` (only
    // `.entries()` is ever called), mirroring
    // `M3LRunReporterOptions.paths`'s `Pick<M3LPathsPort, "getOutputDir">` —
    // but a real `M3LBreadcrumbTrail` instance must remain assignable, since
    // that backward-compatibility guarantee is the whole point of picking a
    // subset rather than inventing a bespoke narrower interface.
    test("M3LRunScriptOptions.trail accepts a real M3LBreadcrumbTrail instance (backward compatible with the narrowed Pick)", () => {
      const trail = new M3LBreadcrumbTrail();
      const options: M3LRunScriptOptions = { trail };
      expectTypeOf(options.trail).toEqualTypeOf<
        Pick<M3LBreadcrumbTrail, "entries"> | undefined
      >();
    });
  });
});

// =============================================================================
// setForcedSignalExitCode() — the second-signal forced exit code (ADR-0035 phase 4a)
//
// `internal/script/signalHandlers.ts`'s `registerShutdownSignals` currently
// hardcodes `process.exit(1)` on a second signal (see the existing
// "M3LScript — signal handling" describe block above). `setForcedSignalExitCode`
// makes that code configurable so `runScript` can force it to
// `M3L_EXIT_CODES.INTERRUPTED` (5) for the duration of a run. Exercised
// directly against the internal module, mirroring this file's existing
// whitebox precedent for `registerShutdownSignals` itself.
//
// `setForcedSignalExitCode` mutates genuine module-level state (like the
// `installProcessGuards` singleton flag, but — unlike that flag — designed to
// be repeatedly settable), so every test here restores the documented default
// (`1`) afterward to avoid leaking into any other test in this file.
// =============================================================================
describe("setForcedSignalExitCode() — second-signal exit code", () => {
  afterEach(() => {
    setForcedSignalExitCode(1);
  });

  test("without an override, a second signal forces process.exit(1)", () => {
    setForcedSignalExitCode(1);
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        handlers.set(eventName, listener);
        return process;
      },
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    registerShutdownSignals(vi.fn());

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();
    sigtermHandler?.();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("after setForcedSignalExitCode(5) (as runScript applies for the duration of a run), a second signal forces process.exit(5)", () => {
    setForcedSignalExitCode(5);
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        handlers.set(eventName, listener);
        return process;
      },
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    registerShutdownSignals(vi.fn());

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();
    sigtermHandler?.();

    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  test("getForcedSignalExitCode() reflects the value most recently set by setForcedSignalExitCode()", () => {
    setForcedSignalExitCode(1);
    expect(getForcedSignalExitCode()).toBe(1);

    setForcedSignalExitCode(5);
    expect(getForcedSignalExitCode()).toBe(5);
  });

  describe("type-level contract", () => {
    test("setForcedSignalExitCode has signature (code: number) => void", () => {
      expectTypeOf(setForcedSignalExitCode).toEqualTypeOf<
        (code: number) => void
      >();
    });

    test("getForcedSignalExitCode has signature () => number", () => {
      expectTypeOf(getForcedSignalExitCode).toEqualTypeOf<() => number>();
    });
  });
});

// =============================================================================
// pushForcedSignalExitCode() — scoped, nesting/overlap-safe override
//
// Unlike `setForcedSignalExitCode` (an unscoped, permanent setter),
// `pushForcedSignalExitCode` tracks a depth counter so the baseline is
// captured only on the outermost entry and restored only on the outermost
// release — the mechanism that makes overlapping/nested `runScript` calls
// compose correctly (see the module's TSDoc for the naive-pattern leak this
// fixes). Like `setForcedSignalExitCode`, this mutates genuine module-level
// state, so every test restores depth 0 / code 1 afterward.
// =============================================================================
describe("pushForcedSignalExitCode() — scoped forced exit code", () => {
  // Every push made through this local wrapper is tracked here so `afterEach`
  // can release it regardless of whether the test itself already released it
  // (the real release is idempotent, so a redundant call here is a no-op) —
  // this guarantees depth returns fully to 0 even if a test's own assertion
  // throws between an acquire and its release, so a leaked scope can never
  // survive into a later test.
  const pendingReleases: (() => void)[] = [];

  function push(code: number): () => void {
    const release = pushForcedSignalExitCode(code);
    pendingReleases.push(release);
    return release;
  }

  afterEach(() => {
    for (const release of pendingReleases.splice(0)) {
      release();
    }
    setForcedSignalExitCode(1);
  });

  test("a single scope sets the code, and releasing restores the captured prior value", () => {
    setForcedSignalExitCode(7);

    const release = push(5);
    expect(getForcedSignalExitCode()).toBe(5);

    release();
    expect(getForcedSignalExitCode()).toBe(7);
  });

  test("nested scopes: releasing the inner scope does not restore while the outer is still in flight", () => {
    const releaseOuter = push(5);
    expect(getForcedSignalExitCode()).toBe(5);

    const releaseInner = push(9);
    expect(getForcedSignalExitCode()).toBe(9);

    releaseInner();
    expect(getForcedSignalExitCode()).toBe(9);

    releaseOuter();
    expect(getForcedSignalExitCode()).toBe(1);
  });

  test("out-of-order release (A then B) restores the baseline only once B releases, never getting stuck on the override", () => {
    const releaseA = push(5);
    const releaseB = push(9);
    expect(getForcedSignalExitCode()).toBe(9);

    // A releases first even though it was acquired first — the pattern
    // produced by overlapping async `runScript` calls.
    releaseA();
    expect(getForcedSignalExitCode()).toBe(9);

    releaseB();
    expect(getForcedSignalExitCode()).toBe(1);
  });

  test("releasing the same release function twice does not corrupt a still-open outer scope", () => {
    const releaseOuter = push(5);
    const releaseInner = push(9);

    releaseInner();
    releaseInner();
    expect(getForcedSignalExitCode()).toBe(9);

    releaseOuter();
    expect(getForcedSignalExitCode()).toBe(1);
  });

  describe("type-level contract", () => {
    test("pushForcedSignalExitCode has signature (code: number) => () => void", () => {
      expectTypeOf(pushForcedSignalExitCode).toEqualTypeOf<
        (code: number) => () => void
      >();
    });
  });
});

// =============================================================================
// M3LScript.run() — dry-run semantics (ADR-0035 phase 4a)
//
// Contract: `run(mainFn, { dryRun: true })` drives stages 1-5 (env detect,
// init hooks, config load, config hooks, AWS provisioning) exactly as a
// normal run, then runs `onCleanup` and stops — `onBeforeRun`/`onAfterRun`
// never fire, `mainFn` is never called, and stage 9 (file archival) never
// runs. `onCleanup` still fires so every terminal path tears down whatever
// stages 1-5 allocated; a dry run that skipped cleanup would be the one path
// that leaks it.
// =============================================================================
describe("M3LScript.run() — dry-run semantics (ADR-0035 phase 4a)", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("dry-run skips mainFn, onBeforeRun, and onAfterRun, but still runs init/config hooks and onCleanup exactly once", async () => {
    const order: string[] = [];
    const mainFn = vi.fn();
    const hooks: M3LScriptLifecycleHooks = {
      onBeforeInit: () => {
        order.push("onBeforeInit");
      },
      onAfterInit: () => {
        order.push("onAfterInit");
      },
      onBeforeConfigLoad: () => {
        order.push("onBeforeConfigLoad");
      },
      onAfterConfigLoad: () => {
        order.push("onAfterConfigLoad");
      },
      onBeforeRun: () => {
        order.push("onBeforeRun");
      },
      onAfterRun: () => {
        order.push("onAfterRun");
      },
      onCleanup: () => {
        order.push("onCleanup");
      },
    };
    const script = new M3LScript({ metadata, hooks });

    await script.run(mainFn, { dryRun: true });

    expect(mainFn).not.toHaveBeenCalled();
    expect(order).toEqual([
      "onBeforeInit",
      "onAfterInit",
      "onBeforeConfigLoad",
      "onAfterConfigLoad",
      "onCleanup",
    ]);
  });

  test("dry-run does not run stage 9 file archival: getLastArchiveReport() stays undefined", async () => {
    const script = new M3LScript({ metadata });

    await script.run(() => {}, { dryRun: true });

    expect(script.getLastArchiveReport()).toBeUndefined();
  });

  test("dry-run still loads configuration (stage 3 ran): getConfiguration() resolves normally afterward", async () => {
    const greetingParam = new M3LConfigParameter({
      name: "greeting",
      type: M3LConfigParameterType.STRING,
      defaultValue: "hello",
    });
    const script = new M3LScript({
      metadata,
      config: { params: [greetingParam] },
    });

    await script.run(() => {}, { dryRun: true });

    const config = await script.getConfiguration();
    expect(config.get("greeting")).toBe("hello");
  });

  test("runScript() dry-run: mainFn never runs, persists a report with outcome 'dry-run', and leaves process.exitCode untouched", async () => {
    const persistSpy = vi
      .spyOn(M3LRunReporter.prototype, "persist")
      .mockResolvedValue("/fake/dry-run-report.json");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const mainFn = vi.fn();
    const script = new M3LScript({ metadata });
    const exitCodeBefore = process.exitCode;

    await runScript(script, mainFn, { dryRun: true });

    expect(mainFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [input] = persistSpy.mock.calls[0] as [M3LRunReportInput];
    expect(input.outcome).toBe("dry-run");
  });

  afterEach(() => {
    // Mirrors the composition-root wrapper describe block's own guard: a
    // leaked non-zero `process.exitCode` corrupts the whole suite's exit
    // status even when every test in this block passes.
    process.exitCode = undefined;
  });
});

// =============================================================================
// M3LScriptHookContext.dryRun — visibility (ADR-0035 phase 4a)
//
// Contract: `dryRun` is ALWAYS present on the hook context (never optional),
// `true` in every hook that fires during a dry run, and `false` in every
// hook (including `onError`) during a normal run — whether the second
// argument to `run` is omitted entirely, an empty object, or an explicit
// `{ dryRun: false }`.
// =============================================================================
describe("M3LScriptHookContext.dryRun — visibility across dry and normal runs (ADR-0035 phase 4a)", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("ctx.dryRun is true in every hook that fires during a dry run", async () => {
    const seen: boolean[] = [];
    const script = new M3LScript({
      metadata,
      hooks: {
        onBeforeInit: (ctx) => {
          seen.push(ctx.dryRun);
        },
        onAfterInit: (ctx) => {
          seen.push(ctx.dryRun);
        },
        onBeforeConfigLoad: (ctx) => {
          seen.push(ctx.dryRun);
        },
        onAfterConfigLoad: (ctx) => {
          seen.push(ctx.dryRun);
        },
        onCleanup: (ctx) => {
          seen.push(ctx.dryRun);
        },
      },
    });

    await script.run(() => {}, { dryRun: true });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === true)).toBe(true);
  });

  test.each<[string, M3LScriptRunOptions | undefined]>([
    ["omitted entirely", undefined],
    ["an empty options object", {}],
    ["an explicit { dryRun: false }", { dryRun: false }],
  ])(
    "ctx.dryRun is false on every hook during a normal run when the second argument is %s",
    async (_label, runOptions) => {
      const seen: boolean[] = [];
      const script = new M3LScript({
        metadata,
        hooks: {
          onBeforeInit: (ctx) => {
            seen.push(ctx.dryRun);
          },
          onBeforeRun: (ctx) => {
            seen.push(ctx.dryRun);
          },
          onAfterRun: (ctx) => {
            seen.push(ctx.dryRun);
          },
          onCleanup: (ctx) => {
            seen.push(ctx.dryRun);
          },
        },
      });

      if (runOptions === undefined) {
        await script.run(() => {});
      } else {
        await script.run(() => {}, runOptions);
      }

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((value) => value === false)).toBe(true);
    },
  );

  test("ctx.dryRun is false in the onError hook on a normal failing run", async () => {
    let observed: boolean | undefined;
    const script = new M3LScript({
      metadata,
      hooks: {
        onError: (ctx) => {
          observed = ctx.dryRun;
        },
      },
    });

    await expect(
      script.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    expect(observed).toBe(false);
  });
});

// =============================================================================
// M3LScript.run() — backward compatibility with no options argument
// (ADR-0035 phase 4a)
//
// The additive guarantee: `run(mainFn)` called with no second argument at
// all behaves EXACTLY as it did before dry-run existed — every stage runs,
// `mainFn` is called, archival happens, and a stage failure still RE-THROWS
// (bare `run()` never swallows an error; only `runScript` does that).
// =============================================================================
describe("M3LScript.run() — backward compatibility with no options argument (ADR-0035 phase 4a)", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("run(mainFn) with no second argument still runs every stage, including mainFn and archival", async () => {
    const order: string[] = [];
    const mainFn = vi.fn(() => {
      order.push("mainFn");
    });
    const script = new M3LScript({
      metadata,
      hooks: {
        onBeforeRun: () => {
          order.push("onBeforeRun");
        },
        onAfterRun: () => {
          order.push("onAfterRun");
        },
      },
    });

    await script.run(mainFn);

    expect(mainFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["onBeforeRun", "mainFn", "onAfterRun"]);
    expect(script.getLastArchiveReport()).toBeDefined();
  });

  test("run(mainFn) with no second argument still re-throws a stage failure (bare run() never swallows)", async () => {
    const script = new M3LScript({ metadata });
    const failure = new Error("boom");

    await expect(
      script.run(() => {
        throw failure;
      }),
    ).rejects.toThrow(failure);
  });
});

// =============================================================================
// M3LScript — metadata / correlationId / getLastFailureStage accessors
// (ADR-0035 phase 4a)
// =============================================================================
describe("M3LScript — accessors (ADR-0035 phase 4a)", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  describe("metadata", () => {
    test("returns the exact metadata object passed to the constructor", () => {
      const script = new M3LScript({ metadata });

      expect(script.metadata.name).toBe(metadata.name);
      expect(script.metadata.version).toBe(metadata.version);
    });
  });

  describe("correlationId", () => {
    test("is undefined before any run", () => {
      const script = new M3LScript({ metadata });

      expect(script.correlationId).toBeUndefined();
    });

    test("equals the id observed via ctx.correlationId after a run", async () => {
      let observed: string | undefined;
      const script = new M3LScript({
        metadata,
        hooks: {
          onAfterConfigLoad: (ctx) => {
            observed = ctx.correlationId;
          },
        },
      });

      await script.run(() => {});

      expect(observed).toBeDefined();
      expect(script.correlationId).toBe(observed);
    });

    test("equals options.correlationId verbatim when it was supplied explicitly", async () => {
      const script = new M3LScript({ metadata, correlationId: "explicit-id" });

      await script.run(() => {});

      expect(script.correlationId).toBe("explicit-id");
    });
  });

  describe("getLastFailureStage()", () => {
    test("is undefined on a fresh script", () => {
      const script = new M3LScript({ metadata });

      expect(script.getLastFailureStage()).toBeUndefined();
    });

    test("is undefined after a successful run", async () => {
      const script = new M3LScript({ metadata });

      await script.run(() => {});

      expect(script.getLastFailureStage()).toBeUndefined();
    });

    test("is 'main' when mainFn throws", async () => {
      const script = new M3LScript({ metadata });

      await expect(
        script.run(() => {
          throw new Error("main blew up");
        }),
      ).rejects.toThrow();

      expect(script.getLastFailureStage()).toBe("main");
    });

    test("is 'environment' when stage 1 (environment detection) throws", async () => {
      // Construct FIRST under the outer beforeEach's non-throwing stub — the
      // constructor itself also consults `M3LExecutionEnvironment.detect()`
      // (independently of the pipeline's own stage 1 call), so overriding the
      // mock to always throw before construction would fail construction
      // itself rather than isolating the failure to stage 1 of `run()`.
      const script = new M3LScript({ metadata });
      vi.spyOn(M3LExecutionEnvironment, "detect").mockImplementation(() => {
        throw new Error("detect blew up");
      });

      await expect(script.run(() => {})).rejects.toThrow();

      expect(script.getLastFailureStage()).toBe("environment");
    });

    test("is 'config-load' when stage 3 (config load) itself throws (not a hook)", async () => {
      // Mirrors the existing "M3LScript — preset seam (F8)" / runScript
      // fixture for an unknown preset key throwing `M3LPresetUnknownKeysError`
      // directly out of config load, before any config-load hook runs.
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify({ unknownKey: "value" }),
      );
      const script = new M3LScript({
        metadata,
        config: {
          params: [
            new M3LConfigParameter({
              name: "region",
              type: M3LConfigParameterType.STRING,
              defaultValue: "default-region",
            }),
          ],
        },
        preset: "/fixtures/preset-unknown-key.json",
      });

      await expect(script.run(() => {})).rejects.toThrow();

      expect(script.getLastFailureStage()).toBe("config-load");
    });

    test("is 'aws-provisioning' when stage 5 (AWS provisioning) throws", async () => {
      // Mirrors the "AWS provisioning seam" describe block's malformed-region
      // fixture: a syntactically invalid configured region fails loud out of
      // stage 5, before mainFn is ever reached.
      const malformedRegionParam = new M3LConfigParameter({
        name: AWS_REGION_PARAM_NAME,
        type: M3LConfigParameterType.STRING,
        defaultValue: "not a region",
      });
      const profileParam = new M3LConfigParameter({
        name: AWS_PROFILE_PARAM_NAME,
        type: M3LConfigParameterType.STRING,
        defaultValue: "test-profile",
      });
      const script = new M3LScript({
        metadata,
        config: { params: [profileParam, malformedRegionParam] },
      });

      await expect(script.run(() => {})).rejects.toThrow();

      expect(script.getLastFailureStage()).toBe("aws-provisioning");
    });

    test("is 'archive' when stage 9 (file archival) throws", async () => {
      // Mirrors the archival describe block's own EACCES fixture: a
      // permissions fault reading the input directory must surface as a
      // genuine failure, not a silently-truncated report.
      const root = fakeRoot("fake", "failure-stage-archive");
      vi.stubEnv("M3L_INPUT_DIR", `${root}/data/input`);
      vi.stubEnv("M3L_CONFIG_DIR", `${root}/data/config`);
      vi.stubEnv("M3L_OUTPUT_DIR", `${root}/data/output`);
      vi.spyOn(nodeFs, "readdirSync").mockImplementation(() => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      });
      const script = new M3LScript({ metadata });

      await expect(script.run(() => {})).rejects.toThrow();

      expect(script.getLastFailureStage()).toBe("archive");
    });

    test.each<[string, string, Partial<M3LScriptLifecycleHooks>]>([
      [
        "onBeforeInit",
        "init-hooks",
        {
          onBeforeInit: () => {
            throw new Error("onBeforeInit blew up");
          },
        },
      ],
      [
        "onAfterInit",
        "init-hooks",
        {
          onAfterInit: () => {
            throw new Error("onAfterInit blew up");
          },
        },
      ],
      [
        "onBeforeConfigLoad",
        "config-hooks",
        {
          onBeforeConfigLoad: () => {
            throw new Error("onBeforeConfigLoad blew up");
          },
        },
      ],
      [
        "onAfterConfigLoad",
        "config-hooks",
        {
          onAfterConfigLoad: () => {
            throw new Error("onAfterConfigLoad blew up");
          },
        },
      ],
      [
        "onBeforeRun",
        "before-run",
        {
          onBeforeRun: () => {
            throw new Error("onBeforeRun blew up");
          },
        },
      ],
      [
        "onAfterRun",
        "after-run",
        {
          onAfterRun: () => {
            throw new Error("onAfterRun blew up");
          },
        },
      ],
    ])(
      "a throwing %s hook maps getLastFailureStage() to '%s'",
      async (_hookName, expectedStage, hooks) => {
        const script = new M3LScript({ metadata, hooks });

        await expect(script.run(() => {})).rejects.toThrow();

        expect(script.getLastFailureStage()).toBe(expectedStage);
      },
    );
  });

  describe("type-level contract", () => {
    test("M3LScriptRunOptions: dryRun is optional", () => {
      expectTypeOf<M3LScriptRunOptions>().toEqualTypeOf<{
        readonly dryRun?: boolean;
      }>();
    });

    test("M3LScriptHookContext.dryRun is exactly boolean, never boolean | undefined", () => {
      expectTypeOf<M3LScriptHookContext>().toHaveProperty("dryRun");
      expectTypeOf<M3LScriptHookContext["dryRun"]>().toEqualTypeOf<boolean>();
    });

    test("run's second parameter is optional M3LScriptRunOptions", () => {
      expectTypeOf<M3LScript["run"]>()
        .parameter(1)
        .toEqualTypeOf<M3LScriptRunOptions | undefined>();
    });

    test("metadata getter returns M3LScriptMetadata", () => {
      expectTypeOf<M3LScript["metadata"]>().toEqualTypeOf<M3LScriptMetadata>();
    });

    test("correlationId getter returns string | undefined", () => {
      expectTypeOf<M3LScript["correlationId"]>().toEqualTypeOf<
        string | undefined
      >();
    });

    test("getLastFailureStage() returns string | undefined", () => {
      expectTypeOf<M3LScript["getLastFailureStage"]>().returns.toEqualTypeOf<
        string | undefined
      >();
    });
  });
});

// =============================================================================
// ADR-0035 phase 4b (A4b): the constructor resolves a log-level floor from
// CLI/env and passes it as the DEFAULT logger's `minLevel` — never mutating
// or overriding a caller-supplied `options.logger`.
//
// These tests focus on the ENV tier of the precedence chain; the full
// CLI > env > default matrix is owned by `resolveLogLevelFloor`'s own unit
// tests in logging.test.ts. This suite only proves the wiring reaches the
// default logger.
//
// `process.env.M3L_LOG_LEVEL`/`M3L_DEBUG` are stubbed via `vi.stubEnv` (the
// established pattern in this file — see `vi.unstubAllEnvs()` in the
// file-level `afterEach` above), never assigned directly, so nothing leaks
// into the rest of the suite.
// =============================================================================
describe("M3LScript constructor — default logger honors the resolved log-level floor (ADR-0035 phase 4b)", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("M3L_LOG_LEVEL=error: the default logger drops an info event and admits an error event", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "error");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const script = new M3LScript({ metadata });
    script.logger.info("dropped by the error floor");
    expect(stdoutSpy).not.toHaveBeenCalled();

    script.logger.error("admitted by the error floor");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test("M3L_LOG_LEVEL=error: the default logger also admits a fatal event", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "error");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const script = new M3LScript({ metadata });
    script.logger.fatal("admitted by the error floor");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test("M3L_DEBUG=1: the default logger admits a debug event", () => {
    vi.stubEnv("M3L_DEBUG", "1");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const script = new M3LScript({ metadata });
    const stop = script.logger.time("probe");
    stop();

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("a caller-supplied options.logger is unaffected by a set M3L_LOG_LEVEL: it still admits info", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "error");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const suppliedLogger = new M3LLogger([new M3LConsoleLoggerHandler()]);
    new M3LScript({ metadata, logger: suppliedLogger });

    suppliedLogger.info(
      "must still pass — the constructor must not mutate a caller-supplied logger",
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("bare construction, no M3L_LOG_LEVEL/M3L_DEBUG set: the default logger keeps the additive no-floor behavior (info still passes)", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "");
    vi.stubEnv("M3L_DEBUG", "");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const script = new M3LScript({ metadata });
    script.logger.info("admitted with no floor configured");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("an invalid M3L_LOG_LEVEL throws M3LError with code ERR_INVALID_ARGUMENT at construction", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "verbose");

    let thrown: unknown;
    try {
      new M3LScript({ metadata });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  // Contrast with the test above: an invalid M3L_LOG_LEVEL only matters when
  // the constructor is building the DEFAULT logger. A caller-supplied
  // `options.logger` opts out of floor resolution entirely, so the same
  // invalid env value must not crash construction, and the custom logger
  // must remain unaffected (still admits info).
  test("a caller-supplied options.logger opts out of floor resolution: an invalid M3L_LOG_LEVEL does NOT throw, and the custom logger still admits info", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "verbose");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const customLogger = new M3LLogger([new M3LConsoleLoggerHandler()]);

    expect(
      () => new M3LScript({ metadata, logger: customLogger }),
    ).not.toThrow();

    customLogger.info("still admitted — the custom logger is exempt");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});
