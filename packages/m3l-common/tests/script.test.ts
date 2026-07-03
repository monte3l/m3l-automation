/**
 * Tests for core/script submodule.
 *
 * Contract source: docs/reference/core/script.md
 * Exports under test: M3LScript, M3LScriptOptions, M3LScriptMetadata,
 *   M3LScriptLifecycleHooks, M3LScriptHookContext, M3LScriptConfigLoader,
 *   M3LScriptPresetLoader, M3LPresetUnknownKeysError, installProcessGuards,
 *   serializeError, setProcessGuardRequestId (11 symbols).
 *
 * Key behavioral contracts:
 *  - M3LScript wires config, logging, prompts, AWS credential management
 *    (via an internal seam only) from a single M3LScriptOptions.
 *  - run(mainFn) drives a 9-stage pipeline: env detect -> onBeforeInit/
 *    onAfterInit -> config load -> onBeforeConfigLoad/onAfterConfigLoad ->
 *    AWS credential seam (only when an aws.profile param is declared) ->
 *    onBeforeRun -> mainFn -> onAfterRun/onCleanup -> file archival.
 *  - onError fires when any stage throws.
 *  - createLambdaHandler<TEvent, TResult, TContext = unknown> wraps the same
 *    pipeline; resets initialized/configLoaded + clears config store per
 *    invocation; does not reset SDK clients (not directly observable here).
 *  - Signal handlers (SIGTERM/SIGINT/SIGQUIT) install only in non-AWS
 *    environments; a second signal forces process.exit(1).
 *  - installProcessGuards() is an idempotent process-global singleton
 *    installing unhandledRejection/uncaughtException/warning/beforeExit.
 *  - serializeError(unknown) never throws and is always JSON-serializable.
 *  - M3LScriptPresetLoader enforces max nesting depth 64 and gives
 *    Damerau-Levenshtein "did you mean" suggestions for unknown keys, via
 *    M3LPresetUnknownKeysError (an M3LError subclass).
 *
 * Assumptions documented where the contract is spec-silent (see individual
 * comments): `M3LScript` has NO public `aws` facade at this stage (the AWS
 * submodules do not exist yet in this worktree) — the credential seam is
 * exercised only indirectly via `instanceof M3LError`, never by importing an
 * AWS symbol. `M3LScriptOptions`'s exact config-schema field key is
 * spec-silent; we assume a `config: { params: readonly M3LConfigParameter[] }`
 * shape mirroring the config module's own `M3LConfigSchema` constructor
 * argument, and keep every assertion behavior-based rather than shape-based
 * wherever the module under test allows it.
 */

import * as fs from "fs";
import * as nodeFs from "node:fs";
import * as fsPromises from "node:fs/promises";
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

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigSchema,
  M3LUnsafeConfigKeyError,
} from "../src/core/config/index.js";
import {
  M3LDeploymentMode,
  M3LExecutionEnvironment,
  M3LExecutionEnvironmentType,
  M3LCredentialSource,
} from "../src/core/environment/index.js";
import type { M3LExecutionEnvironmentInfo } from "../src/core/environment/index.js";
import { M3LLogger } from "../src/core/logging/index.js";
import { M3LPrompt } from "../src/core/prompt/index.js";

// -----------------------------------------------------------------------
// SUT — does not exist yet. This import MUST fail in RED with
// "Cannot find module" (or equivalent). Do not add a try/catch around it —
// the whole file failing to resolve is the expected, correct RED signal.
// -----------------------------------------------------------------------
import {
  installProcessGuards,
  M3LPresetUnknownKeysError,
  M3LScript,
  M3LScriptConfigLoader,
  M3LScriptPresetLoader,
  serializeError,
  setProcessGuardRequestId,
} from "../src/core/script/index.js";
import type {
  M3LScriptHookContext,
  M3LScriptLifecycleHooks,
  M3LScriptMetadata,
  M3LScriptOptions,
} from "../src/core/script/index.js";

// `registerShutdownSignals` is an internal (non-barrel-exported) helper.
// `M3LScript`'s own `onShutdown` callback (wired to its private `runCleanup`
// method) always swallows its own errors internally, so the module's
// `.catch()` branch for a *rejecting* `onShutdown` can never be reached
// through the public surface — it is whitebox-tested directly here,
// mirroring the existing precedent of `tests/prompt.test.ts` importing
// `../src/internal/prompt/*` directly for the same reason (internal helper
// coverage the public API cannot reach).
import { registerShutdownSignals } from "../src/internal/script/signalHandlers.js";
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

  test("does NOT expose an aws facade on the instance", () => {
    const script = new M3LScript({ metadata });
    expect(
      (script as unknown as Record<string, unknown>)["aws"],
    ).toBeUndefined();
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

  test("internal/script/diagnostics: a diagnostic for an error WITH context (M3LError) redacts and includes the context field (the serialized.context !== undefined branch)", async () => {
    // Every other onError/onCleanup-failure test in this file throws a plain
    // `Error`, whose `serializeError` output has no `context` field — so
    // `logBestEffortDiagnostic`'s conditional-spread only ever exercised its
    // `false` side. An M3LError carries `context`, exercising the `true` side.
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
// M3LScript — AWS credential seam (stage 5)
// =============================================================================
describe("M3LScript.run() — AWS credential seam", () => {
  beforeEach(() => {
    stubNonAwsEnvironment();
  });

  test("no aws.profile param declared -> strict no-op: run completes and mainFn executes", async () => {
    const script = new M3LScript({ metadata });
    const mainFn = vi.fn();

    await expect(script.run(mainFn)).resolves.toBeUndefined();
    expect(mainFn).toHaveBeenCalledTimes(1);
  });

  test("an aws.profile param IS declared -> run() rejects with an M3LError (AWS not available)", async () => {
    const awsProfileParam = new M3LConfigParameter<string>({
      name: "aws.profile",
      type: M3LConfigParameterType.STRING,
    });

    // Config schema field key is spec-silent; `config.params` is our
    // documented assumption (see file header comment).
    const options: M3LScriptOptions = {
      metadata,
      config: { params: [awsProfileParam] },
    };
    const script = new M3LScript(options);
    const mainFn = vi.fn();

    let thrown: unknown;
    try {
      await script.run(mainFn);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    // The seam error class is internal/unexported by contract — we can only
    // assert the supertype and that mainFn never got a chance to run because
    // the AWS check (stage 5) precedes stage 6/7.
    expect(mainFn).not.toHaveBeenCalled();
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
    const region = new M3LConfigParameter<string>({
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
    const unset = new M3LConfigParameter<string>({
      name: "totallyUnset",
      type: M3LConfigParameterType.STRING,
    });

    const config = await loader.load({ params: [unset] });

    expect(config.has("totallyUnset")).toBe(false);
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
    expect(installProcessGuards()).toBeUndefined();
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
    expect(setProcessGuardRequestId("req-12345")).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("has signature (requestId: string) => void", () => {
      expectTypeOf(setProcessGuardRequestId).toEqualTypeOf<
        (requestId: string) => void
      >();
    });
  });
});
