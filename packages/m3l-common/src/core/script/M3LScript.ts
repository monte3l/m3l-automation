/**
 * `core/script/M3LScript` — the single entry point for every automation
 * script and Lambda handler.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";

import { M3LConfig, M3LConfigSchema } from "../config/index.js";
import { M3LExecutionEnvironment } from "../environment/index.js";
import type { M3LFileCopyReport } from "../files/index.js";
import { M3LFileCopier, getDefaultSubdirForPathType } from "../files/index.js";
import { M3LConsoleLoggerHandler, M3LLogger } from "../logging/index.js";
import { M3LPrompt } from "../prompt/index.js";
import { M3LPaths } from "../utils/index.js";

import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";
import { M3LAWSUnavailableError } from "../../internal/script/M3LAWSUnavailableError.js";
import { registerShutdownSignals } from "../../internal/script/signalHandlers.js";

import { M3LScriptConfigLoader } from "./M3LScriptConfigLoader.js";
import { serializeError } from "./process-guards.js";
import type {
  M3LScriptHookContext,
  M3LScriptLifecycleHooks,
  M3LScriptOptions,
} from "./M3LScriptOptions.js";

/** The config parameter name that gates the AWS credential seam (stage 5). */
const AWS_PROFILE_PARAM_NAME = "aws.profile";

/**
 * Invokes `hook` (if defined) with `ctx`, awaiting the result. A `hook` left
 * `undefined` is a no-op — the caller does not need to check for presence.
 */
async function runHook(
  hook: ((ctx: M3LScriptHookContext) => void | Promise<void>) | undefined,
  ctx: M3LScriptHookContext,
): Promise<void> {
  if (hook === undefined) return;
  await hook(ctx);
}

/**
 * Returns the absolute paths of every regular file directly inside `dir`
 * (non-recursive; subdirectories are skipped). Returns an empty array when
 * `dir` does not exist — a script with no input or config files is a normal,
 * not exceptional, case.
 */
function listRegularFiles(dir: string): readonly string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing/unreadable directory: nothing to archive from here. A genuine
    // permissions problem will resurface loudly if the caller later tries to
    // read the same directory for another purpose; silently skipping
    // archival of a directory that does not exist is not itself an error.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${dir}/${entry.name}`);
}

/**
 * The single entry point for every automation script and Lambda handler.
 *
 * `M3LScript` is instantiated once with a {@link M3LScriptOptions} object; its
 * constructor wires together configuration, logging, and prompts (and
 * registers signal handlers, outside AWS-managed environments). Call
 * {@link M3LScript.run} for CLI execution or
 * {@link M3LScript.createLambdaHandler} to obtain a Lambda-compatible handler
 * — both drive the same nine-stage pipeline documented on `run`.
 *
 * @example
 * ```ts
 * import { M3LScript } from "@m3l-automation/m3l-common/core";
 *
 * const script = new M3LScript({
 *   metadata: { name: "report-builder", version: "1.0.0" },
 *   hooks: {
 *     onAfterConfigLoad: (ctx) => {
 *       console.log(ctx.config.get("region"));
 *     },
 *   },
 * });
 *
 * await script.run(async () => {
 *   // user code
 * });
 * ```
 */
export class M3LScript {
  private readonly hooks: M3LScriptLifecycleHooks;
  private readonly schema: M3LConfigSchema | undefined;
  private readonly configLoader = new M3LScriptConfigLoader();
  private readonly paths = new M3LPaths();

  /** Reset per Lambda invocation; `true` once stage 1 has run at least once. */
  private initialized = false;
  /** Reset per Lambda invocation; `true` once config has been loaded. */
  private configLoaded = false;
  /** Reset per Lambda invocation: the live resolved-configuration store. */
  private config = new M3LConfig();
  /** The most recently produced stage-9 archive report, if `run` has completed at least once. */
  private lastArchiveReport: M3LFileCopyReport | undefined;

  /** The logger facade wired for this script instance. */
  readonly logger: M3LLogger;

  /** The interactive-prompt facade wired for this script instance. */
  readonly prompt: M3LPrompt;

  /**
   * Creates a new `M3LScript`.
   *
   * Construction wires the logger and prompt facilities, and — outside
   * AWS-managed environments — registers `SIGTERM`/`SIGINT`/`SIGQUIT`
   * handlers for graceful shutdown. It performs no config load and does not
   * invoke `mainFn`; that only happens once {@link M3LScript.run} (or the
   * handler from {@link M3LScript.createLambdaHandler}) is called.
   *
   * @param options - The script's metadata, optional config schema, hooks,
   *   and facility overrides.
   */
  constructor(options: M3LScriptOptions) {
    this.hooks = options.hooks ?? {};
    this.schema =
      options.config !== undefined
        ? new M3LConfigSchema(options.config.params)
        : undefined;

    this.logger =
      options.logger ?? new M3LLogger([new M3LConsoleLoggerHandler()]);
    this.prompt = options.prompt ?? new M3LPrompt();

    const env = M3LExecutionEnvironment.detect();
    if (!env.isAWSManaged) {
      // One instance per process is the supported usage pattern:
      // `registerShutdownSignals` installs a fresh, independent set of
      // `SIGTERM`/`SIGINT`/`SIGQUIT` listeners on every call, so constructing
      // multiple `M3LScript`s in one process accumulates listeners rather
      // than replacing them.
      registerShutdownSignals(() => this.runCleanup("signal-shutdown"));
    }
  }

  /**
   * Returns the current resolved configuration store, loading it first if
   * this is the first call for the current run/invocation.
   *
   * @returns The live {@link M3LConfig} store.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * const config = await script.getConfiguration();
   * ```
   */
  async getConfiguration(): Promise<M3LConfig> {
    if (!this.configLoaded) {
      await this.loadConfig();
    }
    return this.config;
  }

  /**
   * Runs the nine-stage execution pipeline around `mainFn`:
   *
   * 1. {@link M3LExecutionEnvironment.detect} (environment detection).
   * 2. `onBeforeInit` / `onAfterInit` hooks.
   * 3. Configuration load (walks the provider chain; resolves
   *    `asyncFallback`s).
   * 4. `onBeforeConfigLoad` / `onAfterConfigLoad` hooks.
   * 5. The AWS credential seam — a no-op unless the config schema declares
   *    an `aws.profile` parameter, in which case this stage throws (AWS
   *    credential management is not yet implemented).
   * 6. `onBeforeRun` hook.
   * 7. `mainFn()`.
   * 8. `onAfterRun` / `onCleanup` hooks.
   * 9. File archival — copies any files registered during the run into the
   *    execution output directory.
   *
   * `onError` fires, with the same {@link M3LScriptHookContext} plus the
   * triggering error, when any stage throws; the ORIGINAL error is always
   * re-thrown afterward, even if `onError` itself throws or rejects — an
   * `onError` failure is recorded as a best-effort diagnostic (never thrown)
   * so it can never shadow the real failure. `onCleanup` always runs too,
   * whether or not `onError` succeeded.
   *
   * Note: when a stage AFTER stage 8 fails (currently only stage 9, file
   * archival), `onCleanup` has already run once as part of stage 8 and then
   * runs a second time as part of this best-effort error handling — this is
   * intentional (cleanup must still be attempted on the error path even
   * though it already ran once) rather than an accidental double-invocation.
   *
   * @param mainFn - The user function to run at stage 7. May be synchronous
   *   or asynchronous; an asynchronous `mainFn` is awaited before stage 8.
   * @returns A promise that resolves once every stage (including cleanup and
   *   archival) has completed.
   * @throws The original error from whichever stage failed — always, and
   *   always after `onError` and `onCleanup` have both been given a chance
   *   to run.
   */
  async run(mainFn: () => void | Promise<void>): Promise<void> {
    try {
      await this.runPipeline(mainFn);
    } catch (cause) {
      await this.runOnErrorBestEffort(cause);
      await this.runCleanup("onError");
      throw cause;
    }
  }

  /**
   * Creates an AWS Lambda-compatible handler wrapping the same nine-stage
   * pipeline as {@link M3LScript.run}.
   *
   * Each invocation resets the `initialized`/`configLoaded` flags and clears
   * the config store, so configuration is re-resolved fresh on every
   * invocation; SDK client state (not yet present in this package) is
   * intentionally left untouched across invocations so warm starts keep
   * reusing existing connections.
   *
   * @typeParam TEvent - The Lambda event payload type.
   * @typeParam TResult - The value `mainFn` resolves to and the handler
   *   returns.
   * @typeParam TContext - The Lambda context object type; defaults to
   *   `unknown` so a two-generic call site (`createLambdaHandler<E, R>`)
   *   still compiles.
   * @param mainFn - The user function invoked at stage 7; receives the raw
   *   `event` and `context` and returns `TResult`.
   * @returns A handler function suitable for use as a Lambda entry point.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * interface MyEvent { readonly id: string }
   * interface MyResult { readonly ok: boolean }
   *
   * const script = new M3LScript({
   *   metadata: { name: "report-builder", version: "1.0.0" },
   * });
   *
   * export const handler = script.createLambdaHandler<MyEvent, MyResult>(
   *   async () => ({ ok: true }),
   * );
   * ```
   */
  createLambdaHandler<TEvent, TResult, TContext = unknown>(
    mainFn: (event: TEvent, context: TContext) => Promise<TResult>,
  ): (event: TEvent, context: TContext) => Promise<TResult> {
    return async (event: TEvent, context: TContext): Promise<TResult> => {
      this.resetForInvocation();
      let result: TResult | undefined;
      await this.run(async () => {
        result = await mainFn(event, context);
      });
      // `run` either throws (never reaching here) or resolves after mainFn
      // has assigned `result` — the assertion the type system cannot itself
      // express is that `run`'s success path guarantees `mainFn` completed.
      return result as TResult;
    };
  }

  /** Resets per-invocation state ahead of a Lambda handler call. */
  private resetForInvocation(): void {
    this.initialized = false;
    this.configLoaded = false;
    this.config = new M3LConfig();
  }

  /** Builds the hook context carrying the live config store. */
  private hookContext(): M3LScriptHookContext {
    return { config: this.config };
  }

  /** Stage 3: loads configuration via {@link M3LScriptConfigLoader}. */
  private async loadConfig(): Promise<void> {
    this.config = await this.configLoader.load({
      params: this.schema?.parameters ?? [],
    });
    this.configLoaded = true;
  }

  /**
   * Stage 5: the AWS credential seam. A strict no-op unless the config
   * schema declares an `aws.profile` parameter, in which case it throws
   * {@link M3LAWSUnavailableError} — AWS credential management is not yet
   * implemented in this package.
   */
  private checkAwsCredentialSeam(): void {
    if (this.schema?.has(AWS_PROFILE_PARAM_NAME) === true) {
      throw new M3LAWSUnavailableError(
        "AWS credential management is not yet available: the script declares " +
          `an "${AWS_PROFILE_PARAM_NAME}" config parameter, but this package ` +
          "does not yet implement AWS credential resolution.",
      );
    }
  }

  /**
   * Stage 9: archives the script's input and config files into the
   * execution output directory.
   *
   * "Input and config files" is interpreted here as every regular file
   * directly present in {@link M3LPaths.getInputDir} and
   * {@link M3LPaths.getConfigDir} at the time this stage runs (each grouped
   * under its conventional archive subdirectory via
   * {@link getDefaultSubdirForPathType}) — the two directories the rest of
   * this package treats as the canonical location for a script's input data
   * and configuration/preset files. `M3LFileCopier`'s own path-traversal and
   * size/overwrite guards are exercised exactly as they would be for a
   * manually registered file; only file *discovery* is automatic here.
   *
   * A fresh `M3LFileCopier` is created for every call — the copier's
   * registration queue is call-scoped, not instance-scoped, so a warm-start
   * `createLambdaHandler` reusing this `M3LScript` across invocations gets an
   * independent, empty queue each time instead of re-registering (and
   * re-reporting) the same files on every invocation.
   *
   * The resulting report is stored so callers (and tests) can observe what
   * was actually archived via {@link M3LScript.getLastArchiveReport}.
   */
  private async archiveFiles(): Promise<void> {
    const fileCopier = new M3LFileCopier();
    for (const sourcePath of listRegularFiles(this.paths.getInputDir())) {
      fileCopier.registerFile(sourcePath, {
        subdir: getDefaultSubdirForPathType("input"),
      });
    }
    for (const sourcePath of listRegularFiles(this.paths.getConfigDir())) {
      fileCopier.registerFile(sourcePath, {
        subdir: getDefaultSubdirForPathType("config"),
      });
    }
    this.lastArchiveReport = await fileCopier.finalizeRegisteredFiles();
  }

  /**
   * The report produced by the most recently completed stage-9 archival, or
   * `undefined` before `run` has completed at least once.
   *
   * @returns The last archive report, or `undefined`.
   */
  getLastArchiveReport(): M3LFileCopyReport | undefined {
    return this.lastArchiveReport;
  }

  /** Runs stages 1-9, without any error/cleanup handling (that lives in `run`). */
  private async runPipeline(mainFn: () => void | Promise<void>): Promise<void> {
    // Stage 1: environment detection. The result itself is not needed here
    // (M3LPaths and the signal-handler gate already captured it at
    // construction) — this call exists so stage 1 is independently
    // observable, and re-runs on every `run`/Lambda invocation, per the
    // documented pipeline order.
    M3LExecutionEnvironment.detect();
    this.initialized = true;

    // Stage 2: init hooks.
    await runHook(this.hooks.onBeforeInit, this.hookContext());
    await runHook(this.hooks.onAfterInit, this.hookContext());

    // Stage 3 + 4: config load + hooks.
    await runHook(this.hooks.onBeforeConfigLoad, this.hookContext());
    await this.loadConfig();
    await runHook(this.hooks.onAfterConfigLoad, this.hookContext());

    // Stage 5: AWS credential seam.
    this.checkAwsCredentialSeam();

    // Stage 6 + 7: onBeforeRun, mainFn.
    await runHook(this.hooks.onBeforeRun, this.hookContext());
    await mainFn();

    // Stage 8: onAfterRun, onCleanup.
    await runHook(this.hooks.onAfterRun, this.hookContext());
    await runHook(this.hooks.onCleanup, this.hookContext());

    // Stage 9: file archival.
    await this.archiveFiles();
  }

  /**
   * Invokes the `onError` hook (if any) with the triggering `cause`,
   * isolating any failure of the hook itself: an `onError` that throws or
   * rejects is recorded as a best-effort diagnostic rather than propagated,
   * so it can never replace or shadow the original error `run` is about to
   * re-throw.
   */
  private async runOnErrorBestEffort(cause: unknown): Promise<void> {
    try {
      await this.hooks.onError?.(this.hookContext(), cause);
    } catch (onErrorFailure) {
      logBestEffortDiagnostic(
        "onError hook failure",
        serializeError(onErrorFailure),
      );
    }
  }

  /**
   * Best-effort `onCleanup` invocation shared by both the `run` error path
   * and the shutdown-signal path. A failing `onCleanup` is recorded as a
   * best-effort diagnostic (never thrown) — from `run`'s catch branch this
   * ensures cleanup failure can never shadow the original error being
   * re-thrown; from the signal path it ensures a failing handler can never
   * block process shutdown.
   *
   * @param label - Identifies the call site in the diagnostic (e.g.
   *   `"onError"`, `"signal-shutdown"`).
   */
  private async runCleanup(label: string): Promise<void> {
    try {
      await runHook(this.hooks.onCleanup, this.hookContext());
    } catch (cleanupFailure) {
      logBestEffortDiagnostic(
        `onCleanup failure (${label})`,
        serializeError(cleanupFailure),
      );
    }
  }
}
