/**
 * `core/script/M3LScript` — the single entry point for every automation
 * script and Lambda handler.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import {
  M3LConfig,
  M3LConfigSchema,
  M3LPresetConfigProvider,
  type M3LConfigProvider,
} from "../config/index.js";
import { M3LExecutionEnvironment } from "../environment/index.js";
import type { M3LFileCopyReport } from "../files/index.js";
import { M3LFileCopier, getDefaultSubdirForPathType } from "../files/index.js";
import { M3LConsoleLoggerHandler, M3LLogger } from "../logging/index.js";
import { M3LPrompt } from "../prompt/index.js";
import { M3LPaths, isEnoentError } from "../utils/index.js";

import { resolveLogLevelFloor } from "../../internal/logging/resolveLogLevelFloor.js";
import { M3LAWSProvisioningError } from "../../internal/script/M3LAWSProvisioningError.js";
import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";
import { registerShutdownSignals } from "../../internal/script/signalHandlers.js";

import {
  AWS_PROFILE_PARAM_NAME,
  AWS_REGION_PARAM_NAME,
} from "./aws-param-names.js";
import { M3LScriptConfigLoader } from "./M3LScriptConfigLoader.js";
import { M3LScriptPresetLoader } from "./M3LScriptPresetLoader.js";
import { serializeError, setProcessGuardRequestId } from "./process-guards.js";
import type {
  M3LScriptHookContext,
  M3LScriptLifecycleHooks,
  M3LScriptMetadata,
  M3LScriptOptions,
  M3LScriptRunOptions,
} from "./M3LScriptOptions.js";

// Type-only imports: erased at compile time, so importing the types here
// does NOT create a static core -> aws module cycle and non-AWS scripts stay
// tree-shakeable. The runtime values are loaded dynamically, see
// `provisionAws` / `resolveAwsIdentity` below.
import type { AWSProvider } from "../../aws/clients/index.js";
import type { M3LAWSProfile, M3LAWSRegion } from "../../aws/models/index.js";

/**
 * The nine pipeline stages {@link M3LScript.runPipeline} drives through, in
 * order, plus the dry-run-only `"cleanup"` label. Kept as a non-exported
 * union (rather than surfacing it through {@link M3LScriptOptions.js}) so the
 * labels cannot drift out of sync with the stages that set them —
 * {@link M3LScript.getLastFailureStage} widens the return type to plain
 * `string` so this internal type never leaks into the emitted `.d.ts`,
 * matching {@link M3LRunReportInput.stage}'s own `string | undefined` shape.
 *
 * `"cleanup"` is the tenth member, distinct from `"after-run"`: a dry run's
 * early-return branch runs `onCleanup` without ever having run the normal
 * `"after-run"` stage (`onAfterRun`), so labeling a throwing dry-run
 * `onCleanup` as `"after-run"` would misreport a stage that never ran. It is
 * used ONLY by the dry-run branch — the normal (non-dry-run) path's
 * `onCleanup` call keeps the pre-existing `"after-run"` label, since 9
 * existing test labels are already pinned to that value.
 */
type M3LScriptPipelineStage =
  | "environment"
  | "init-hooks"
  | "config-load"
  | "config-hooks"
  | "aws-provisioning"
  | "before-run"
  | "main"
  | "after-run"
  | "archive"
  | "cleanup";

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
 * Defensively narrows an unknown Lambda `context` value to extract
 * `awsRequestId` when present as a string, without an unchecked cast. Used by
 * {@link M3LScript.createLambdaHandler}'s per-invocation correlation id
 * resolution — `TContext` defaults to `unknown`, so the property cannot be
 * accessed directly.
 */
function extractAwsRequestId(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  if (!("awsRequestId" in context)) return undefined;
  const candidate = (context as Record<string, unknown>).awsRequestId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/**
 * Returns the absolute paths of every regular file directly inside `dir`
 * (non-recursive; subdirectories are skipped). Returns an empty array when
 * `dir` does not exist (`ENOENT`) — a script with no input or config files is
 * a normal, not exceptional, case. Any other filesystem error (e.g. `EACCES`
 * / `EPERM` from a genuine permissions fault) is re-thrown: a directory that
 * exists but cannot be read must surface loudly, not masquerade as an empty
 * archive report.
 */
function listRegularFiles(dir: string): readonly string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Tolerate only a missing dir; re-throw every other errno.
    if (isEnoentError(error)) {
      return [];
    }
    throw error;
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
  readonly #paths = new M3LPaths();

  /** The caller-supplied `options.metadata`, returned verbatim by {@link M3LScript.metadata}. */
  private readonly scriptMetadata: M3LScriptMetadata;

  /** Reset per Lambda invocation; `true` once stage 1 has run at least once. */
  private initialized = false;
  /** Reset per Lambda invocation; `true` once config has been loaded. */
  private configLoaded = false;
  /** Reset per Lambda invocation: the live resolved-configuration store. */
  private config = new M3LConfig();
  /** The most recently produced stage-9 archive report, if `run` has completed at least once. */
  private lastArchiveReport: M3LFileCopyReport | undefined;
  /**
   * The provisioned AWS facade, or `undefined` before stage 5 has provisioned
   * it (or when the config schema never declares `aws.profile`). NOT reset by
   * `resetForInvocation` — see {@link M3LScript.provisionAws}.
   */
  private awsProvider: AWSProvider | undefined;

  /**
   * Whether the run currently in progress was started with `{ dryRun: true }`
   * — mirrored onto every {@link M3LScriptHookContext.dryRun} built during
   * that run. Reset at the top of every {@link M3LScript.runPipeline} call
   * (including a Lambda invocation, which never passes `dryRun`), so it
   * always reflects the CURRENT run rather than leaking a prior one's value.
   */
  private currentDryRun = false;

  /**
   * The stage {@link M3LScript.runPipeline} most recently BEGAN — updated as
   * each stage starts, not as it completes, so a throw from within a stage
   * still finds the right label already recorded. Captured into
   * {@link M3LScript.lastFailureStage} from `runWithErrorHandling`'s catch
   * block; not itself part of the public surface.
   */
  private currentStage: M3LScriptPipelineStage | undefined;

  /**
   * The stage that was in progress when the most recently completed `run`/
   * Lambda invocation threw, or `undefined` on a fresh script or after a
   * successful run — see {@link M3LScript.getLastFailureStage}.
   */
  private lastFailureStage: M3LScriptPipelineStage | undefined;

  /**
   * The caller-supplied `options.correlationId`, used verbatim for every run
   * and every Lambda invocation when present. `undefined` means "generate (or
   * prefer the platform request id for) each run/invocation".
   */
  private readonly configuredCorrelationId: string | undefined;

  /**
   * The current run's/invocation's resolved correlation id. Resolved before
   * the first hook fires (see {@link M3LScript.resolveCorrelationId}) and
   * stable for the remainder of that run; re-resolved on the next `run()`
   * call or Lambda invocation.
   */
  private currentCorrelationId: string | undefined;

  /**
   * The caller-supplied `options.preset` path, or `undefined` when no preset
   * was configured. `undefined` means stage 3 never reads a preset file and
   * adds no `presetProviders` entry — see {@link M3LScript.loadConfig}.
   */
  private readonly preset: string | undefined;

  /** The logger facade wired for this script instance. */
  readonly logger: M3LLogger;

  /** The interactive-prompt facade wired for this script instance. */
  readonly prompt: M3LPrompt;

  /**
   * The AWS client facade provisioned by stage 5 of {@link M3LScript.run}, or
   * `undefined` if it has not been provisioned yet.
   *
   * Provisioning only happens when the config schema declares an
   * `aws.profile` parameter; scripts that never declare it keep this
   * `undefined` for their entire lifetime. Once provisioned, the same
   * instance is reused for every subsequent call on this `M3LScript` —
   * including warm `createLambdaHandler` invocations — since AWS SDK clients
   * are safe (and preferable) to keep alive across invocations.
   *
   * @returns The provisioned {@link AWSProvider}, or `undefined`.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * await script.run(async () => {
   *   const s3 = script.aws?.clients.s3;
   * });
   * ```
   */
  get aws(): AWSProvider | undefined {
    return this.awsProvider;
  }

  /**
   * The script's own {@link M3LPaths} instance, resolved once at
   * construction time and reused for every stage of this script's lifetime
   * (including {@link M3LScript.archiveFiles}'s use of
   * {@link M3LPaths.getInputDir} / {@link M3LPaths.getConfigDir}).
   *
   * Exposed so `mainFn`/hooks can resolve the canonical `data/` tree —
   * including {@link M3LPaths.resolveInput} / {@link M3LPaths.resolveOutput}
   * — without constructing a second, independent `new M3LPaths()`.
   *
   * @returns This script's {@link M3LPaths} instance.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * await script.run(async () => {
   *   const src = script.paths.resolveInput("records.jsonl");
   * });
   * ```
   */
  get paths(): M3LPaths {
    return this.#paths;
  }

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
   * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when
   *   `options.logger` is omitted and the ambient CLI/env log-level chain
   *   (`--log-level`/`M3L_LOG_LEVEL`) carries an out-of-vocabulary value, or
   *   `--log-level` is present with no value — see
   *   {@link resolveLogLevelFloor}. Never thrown when `options.logger` is
   *   supplied: a caller-supplied logger opts out of that resolution entirely.
   */
  constructor(options: M3LScriptOptions) {
    this.scriptMetadata = options.metadata;
    this.hooks = options.hooks ?? {};
    this.schema =
      options.config !== undefined
        ? new M3LConfigSchema(options.config.params)
        : undefined;

    this.configuredCorrelationId = options.correlationId;
    this.preset = options.preset;
    this.logger = options.logger ?? this.buildDefaultLogger();
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
   * Builds the default logger used when the caller omits
   * `options.logger` — a single {@link M3LConsoleLoggerHandler} with
   * `minLevel` set to whatever {@link resolveLogLevelFloor} resolves from
   * the ambient CLI/env chain. Only called from the `??` branch of the
   * constructor's logger assignment, so a caller-supplied logger never
   * triggers (or is affected by) this resolution.
   */
  private buildDefaultLogger(): M3LLogger {
    const resolvedLogLevelFloor = resolveLogLevelFloor();
    return new M3LLogger(
      [new M3LConsoleLoggerHandler()],
      resolvedLogLevelFloor !== undefined
        ? { minLevel: resolvedLogLevelFloor }
        : undefined,
    );
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
   * The script's identifying metadata, exactly as supplied to the
   * constructor's `options.metadata` — e.g. so a `runScript` composition
   * root can label a persisted run report with the script's name/version
   * without the caller re-threading the same value it already gave the
   * constructor.
   *
   * @returns The constructor's `options.metadata`, verbatim.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * console.log(script.metadata.name); // "x"
   * ```
   */
  get metadata(): M3LScriptMetadata {
    return this.scriptMetadata;
  }

  /**
   * The current run's/invocation's resolved correlation id, or `undefined`
   * before {@link M3LScript.run} (or the handler from
   * {@link M3LScript.createLambdaHandler}) has been called at least once.
   * Mirrors the same id every hook observes via
   * {@link M3LScriptHookContext.correlationId} during that run.
   *
   * @returns The resolved correlation id, or `undefined`.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * await script.run(async () => {});
   * console.log(script.correlationId); // a resolved id, e.g. a UUID
   * ```
   */
  get correlationId(): string | undefined {
    return this.currentCorrelationId;
  }

  /**
   * The pipeline stage that was in progress when the most recently completed
   * `run`/Lambda invocation threw. `undefined` on a fresh script and after a
   * successful run — cleared at the start of every {@link M3LScript.runPipeline}
   * call, not only set on failure, so a success following an earlier failure
   * reports `undefined` rather than the previous run's stale stage.
   *
   * @returns One of `"environment"`, `"init-hooks"`, `"config-load"`,
   *   `"config-hooks"`, `"aws-provisioning"`, `"before-run"`, `"main"`,
   *   `"after-run"`, `"archive"`, or `undefined`. `"cleanup"` is also
   *   possible, but dry-run only — a throwing `onCleanup` during a dry run's
   *   early-return branch (which never runs the normal `"after-run"` stage)
   *   surfaces as `"cleanup"` rather than `"after-run"`.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * try {
   *   await script.run(async () => {
   *     throw new Error("boom");
   *   });
   * } catch {
   *   console.log(script.getLastFailureStage()); // "main"
   * }
   * ```
   */
  getLastFailureStage(): string | undefined {
    return this.lastFailureStage;
  }

  /**
   * Runs the nine-stage execution pipeline around `mainFn`:
   *
   * 1. {@link M3LExecutionEnvironment.detect} (environment detection).
   * 2. `onBeforeInit` / `onAfterInit` hooks.
   * 3. Configuration load (walks the provider chain; resolves
   *    `asyncFallback`s).
   * 4. `onBeforeConfigLoad` / `onAfterConfigLoad` hooks.
   * 5. AWS client provisioning — a no-op unless the config schema declares
   *    an `aws.profile` parameter, in which case this stage provisions
   *    {@link M3LScript.aws} from the resolved `aws.profile`/`aws.region`
   *    config values (memoized: a warm `script.aws` from a prior invocation
   *    is reused rather than rebuilt).
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
   * When `options.dryRun` is `true`, the pipeline stops after stage 5 (AWS
   * provisioning): `onBeforeRun`, `mainFn`, the `onAfterRun` half of stage 8,
   * and stage 9 (file archival) are all skipped. `onCleanup` still runs —
   * every OTHER terminal path (success, error, shutdown signal) runs cleanup,
   * so a dry run that skipped it would be the one path that leaks whatever
   * stages 1-5 allocated (e.g. a provisioned {@link M3LScript.aws} facade).
   * Do not "fix" this by skipping `onCleanup` too.
   *
   * @param mainFn - The user function to run at stage 7. May be synchronous
   *   or asynchronous; an asynchronous `mainFn` is awaited before stage 8.
   * @param options - Per-call run options; see {@link M3LScriptRunOptions}.
   * @returns A promise that resolves once every stage (including cleanup and
   *   archival, unless skipped by `dryRun`) has completed.
   * @throws The original error from whichever stage failed — always, and
   *   always after `onError` and `onCleanup` have both been given a chance
   *   to run.
   */
  async run(
    mainFn: () => void | Promise<void>,
    options?: M3LScriptRunOptions,
  ): Promise<void> {
    await this.runWithErrorHandling(
      mainFn,
      undefined,
      options?.dryRun ?? false,
    );
  }

  /**
   * Shared error/cleanup wrapper around {@link M3LScript.runPipeline} used by
   * both {@link M3LScript.run} and {@link M3LScript.createLambdaHandler} — the
   * latter additionally threads a preferred correlation id (the platform
   * request id) through to {@link M3LScript.resolveCorrelationId} without
   * widening `run`'s own public signature. Also clears
   * {@link M3LScript.lastFailureStage} before every run so a success
   * following an earlier failure reports `undefined`, not the stale stage.
   */
  private async runWithErrorHandling(
    mainFn: () => void | Promise<void>,
    preferredCorrelationId?: string,
    dryRun = false,
  ): Promise<void> {
    this.lastFailureStage = undefined;
    try {
      await this.runPipeline(mainFn, preferredCorrelationId, dryRun);
    } catch (cause) {
      this.lastFailureStage = this.currentStage;
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
   * invocation; the provisioned {@link M3LScript.aws} facade (and the AWS SDK
   * clients it lazily constructs) is intentionally left untouched across
   * invocations so warm starts keep reusing existing connections.
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
      // Per-invocation correlation id resolution
      // (docs/reference/core/script.md#correlation-ids): an explicit
      // `options.correlationId` always wins (handled inside
      // `resolveCorrelationId`); otherwise prefer the platform request id
      // over generating a fresh UUID, so logs line up with the Lambda
      // request in CloudWatch.
      const preferredCorrelationId = extractAwsRequestId(context);
      await this.runWithErrorHandling(async () => {
        result = await mainFn(event, context);
      }, preferredCorrelationId);
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

  /**
   * Resolves and caches the current run's/invocation's correlation id —
   * called once, at the very top of {@link M3LScript.runPipeline} (before
   * stage 1), so `currentCorrelationId` is guaranteed set before any stage
   * can throw. Resolution precedence: `options.correlationId` (verbatim,
   * when non-empty), then `preferredId` (the platform request id, e.g.
   * Lambda's `context.awsRequestId`, when the caller supplied one via
   * {@link M3LScript.createLambdaHandler}), then a freshly generated
   * `crypto.randomUUID()`. A blank (empty-string) configured id or preferred
   * id is treated as absent — mirroring `extractAwsRequestId`'s own
   * `length > 0` guard — so the resolved id is always a non-empty string.
   *
   * Also aligns {@link setProcessGuardRequestId} to the same id.
   *
   * @param preferredId - An optional platform-supplied id (e.g.
   *   `context.awsRequestId`) to prefer over generating a new one, when no
   *   explicit `options.correlationId` was configured.
   */
  private resolveCorrelationId(preferredId?: string): string {
    const configured =
      this.configuredCorrelationId !== undefined &&
      this.configuredCorrelationId.length > 0
        ? this.configuredCorrelationId
        : undefined;
    const preferred =
      preferredId !== undefined && preferredId.length > 0
        ? preferredId
        : undefined;
    const resolved = configured ?? preferred ?? randomUUID();
    this.currentCorrelationId = resolved;
    setProcessGuardRequestId(resolved);
    return resolved;
  }

  /**
   * Builds the hook context carrying the live config store, resolved
   * correlation id, and the current run's dry-run flag.
   */
  private hookContext(): M3LScriptHookContext {
    // `currentCorrelationId` is resolved at the very top of `runPipeline`,
    // before stage 1, so by the time any hook fires (including `onError` from
    // the earliest possible stage failure) it is already guaranteed set —
    // this fallback exists purely as a defensive guard against a future stage
    // being reordered ahead of that resolution.
    return {
      config: this.config,
      correlationId: this.currentCorrelationId ?? this.resolveCorrelationId(),
      // `currentDryRun` defaults to `false` and is only ever set `true` for
      // the duration of a `run(mainFn, { dryRun: true })` call — a hook
      // invoked from `createLambdaHandler` (which never threads `dryRun`) or
      // outside any run always observes `false`.
      dryRun: this.currentDryRun,
    };
  }

  /**
   * Builds the level-6 `presetProviders` entry for {@link loadConfig} when
   * `options.preset` was configured; `undefined` when it was not (so
   * `loadConfig` reads no preset file and adds no provider). Split out of
   * `loadConfig` to keep that method pure orchestration, mirroring the
   * {@link resolveAwsIdentity} extraction below.
   *
   * Loads the preset via {@link M3LScriptPresetLoader}, validated against
   * the declared schema when one is present. Any throw from the loader
   * (e.g. `M3LPresetUnknownKeysError`, or an `M3LError` coded
   * `"ERR_PRESET_LOAD"` for a missing/malformed file) propagates unchanged —
   * this method does not catch/swallow it.
   */
  private buildPresetProviders(): readonly M3LConfigProvider[] | undefined {
    if (this.preset === undefined) return undefined;

    const presetLoader = new M3LScriptPresetLoader({
      ...(this.schema !== undefined ? { schema: this.schema } : {}),
    });
    return [new M3LPresetConfigProvider(presetLoader.load(this.preset))];
  }

  /**
   * Stage 3: loads configuration via {@link M3LScriptConfigLoader}.
   *
   * When `options.preset` was configured, the preset file is loaded (and
   * validated against the declared schema) via {@link M3LScriptPresetLoader}
   * first, and its values are wired in as a lowest-priority
   * `presetProviders` entry. Any throw from the preset loader (e.g.
   * `M3LPresetUnknownKeysError`, or an `M3LError` coded `"ERR_PRESET_LOAD"`
   * for a missing/malformed file) propagates unchanged — F8 introduces no
   * new error types and this method does not catch/swallow it.
   */
  private async loadConfig(): Promise<void> {
    const presetProviders = this.buildPresetProviders();

    this.config = await this.configLoader.load({
      params: this.schema?.parameters ?? [],
      ...(presetProviders !== undefined ? { presetProviders } : {}),
    });
    this.configLoaded = true;
  }

  /**
   * Resolves and validates the configured `aws.profile`/`aws.region` values
   * into their branded `M3LAWSProfile`/`M3LAWSRegion` types, each used only
   * when it resolves to a non-empty string. Split out of {@link provisionAws}
   * so a malformed value's `M3LAWSIdentityError` propagates BEFORE that
   * method's provisioning try/catch begins, and to keep `provisionAws`
   * itself under the method-complexity budget.
   *
   * The `aws/models` module is imported dynamically — not statically at the
   * top of this file — so that scripts which never declare `aws.profile`
   * never pull the `aws` namespace into their bundle, and so `core` has no
   * static import-time dependency on `aws` (avoiding a core-and-aws module
   * cycle).
   */
  private async resolveAwsIdentity(): Promise<{
    readonly profile: M3LAWSProfile | undefined;
    readonly region: M3LAWSRegion | undefined;
  }> {
    const profile = this.config.get(AWS_PROFILE_PARAM_NAME);
    const region = this.config.get(AWS_REGION_PARAM_NAME);
    const hasProfile = typeof profile === "string" && profile.length > 0;
    const hasRegion = typeof region === "string" && region.length > 0;

    const { parseAWSProfile, parseAWSRegion } =
      await import("../../aws/models/index.js");
    return {
      profile: hasProfile ? parseAWSProfile(profile) : undefined,
      region: hasRegion ? parseAWSRegion(region) : undefined,
    };
  }

  /**
   * Stage 5: AWS client provisioning. A strict no-op unless the config
   * schema declares an `aws.profile` parameter. When it does, this
   * memoizes: a warm `script.aws` (already provisioned on a prior `run`/
   * Lambda invocation) is reused as-is, so the underlying AWS SDK clients
   * survive across invocations instead of being rebuilt on every call.
   *
   * On first provisioning, resolves and validates `aws.profile`/`aws.region`
   * via {@link resolveAwsIdentity} and constructs the {@link AWSProvider}
   * facade. The facade module is imported dynamically — not statically at
   * the top of this file — so that scripts which never declare
   * `aws.profile` never pull the `aws` namespace into their bundle, and so
   * `core` has no static import-time dependency on `aws` (avoiding a
   * core-and-aws module cycle).
   *
   * A malformed configured `aws.profile`/`aws.region` value fails loud as an
   * `M3LAWSIdentityError` — it propagates unchanged rather than being folded
   * into the generic provisioning failure below, so callers can narrow on
   * its `code` (`ERR_AWS_INVALID_PROFILE` / `ERR_AWS_INVALID_REGION`) to tell
   * a configuration mistake apart from an AWS SDK facade failure. Any other
   * failure — the dynamic import itself or the `AWSProvider` constructor —
   * is wrapped in an internal `M3LAWSProvisioningError`
   * (`code === "ERR_AWS_PROVISIONING"`), chaining the original failure as
   * `cause`, rather than propagating a raw untyped error.
   */
  private async provisionAws(): Promise<void> {
    if (this.schema?.has(AWS_PROFILE_PARAM_NAME) !== true) return;
    if (this.awsProvider !== undefined) return;

    // `aws.profile` resolving to an empty/missing value is still a valid
    // config: provisioning still occurs and the AWSProvider defers to the
    // SDK's default credential chain, rather than this seam duplicating
    // credential validation. Resolved and validated BEFORE the try/catch
    // below, so a malformed value's `M3LAWSIdentityError` propagates
    // unchanged instead of being folded into `M3LAWSProvisioningError`.
    const { profile, region } = await this.resolveAwsIdentity();

    let provider: AWSProvider;
    try {
      const { AWSProvider } = await import("../../aws/clients/index.js");
      provider = new AWSProvider({
        ...(profile !== undefined ? { profile } : {}),
        ...(region !== undefined ? { region } : {}),
      });
    } catch (cause) {
      throw new M3LAWSProvisioningError(
        "failed to provision the AWS client facade",
        { cause },
      );
    }
    this.awsProvider = provider;
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
    for (const sourcePath of listRegularFiles(this.#paths.getInputDir())) {
      fileCopier.registerFile(sourcePath, {
        subdir: getDefaultSubdirForPathType("input"),
      });
    }
    for (const sourcePath of listRegularFiles(this.#paths.getConfigDir())) {
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

  /**
   * Runs stages 1-9, without any error/cleanup handling (that lives in
   * `run`). Tracks the currently-running stage in {@link M3LScript.currentStage}
   * (read by `runWithErrorHandling`'s catch block on failure) and, when
   * `dryRun` is `true`, stops after stage 5 — see {@link M3LScript.run}'s
   * TSDoc for the full dry-run contract.
   */
  private async runPipeline(
    mainFn: () => void | Promise<void>,
    preferredCorrelationId?: string,
    dryRun = false,
  ): Promise<void> {
    // Reset per-run state that must never leak a prior run's value: the
    // dry-run flag every hook's `ctx.dryRun` reads, and the in-progress-stage
    // marker `runWithErrorHandling`'s catch block captures on failure.
    this.currentDryRun = dryRun;
    this.currentStage = undefined;

    // Resolve the run's correlation id before ANY stage runs — including
    // stage 1 (environment detection) below — so `ctx.correlationId` is a
    // stable, non-empty string on every hook this run invokes, even
    // `onError` from the earliest possible stage failure (see the script
    // module's Correlation IDs reference).
    this.resolveCorrelationId(preferredCorrelationId);

    // Stage 1: environment detection. The result itself is not needed here
    // (M3LPaths and the signal-handler gate already captured it at
    // construction) — this call exists so stage 1 is independently
    // observable, and re-runs on every `run`/Lambda invocation, per the
    // documented pipeline order.
    this.currentStage = "environment";
    M3LExecutionEnvironment.detect();
    this.initialized = true;

    // Stage 2: init hooks.
    this.currentStage = "init-hooks";
    await runHook(this.hooks.onBeforeInit, this.hookContext());
    await runHook(this.hooks.onAfterInit, this.hookContext());

    // Stage 3 + 4: config load + hooks. `currentStage` is (re-)set
    // immediately before each of the three calls below so a throw from any
    // one of them is attributed to the right label regardless of call order
    // (the hooks bracket the load, not follow it).
    this.currentStage = "config-hooks";
    await runHook(this.hooks.onBeforeConfigLoad, this.hookContext());
    this.currentStage = "config-load";
    await this.loadConfig();
    this.currentStage = "config-hooks";
    await runHook(this.hooks.onAfterConfigLoad, this.hookContext());

    // Stage 5: AWS client provisioning.
    this.currentStage = "aws-provisioning";
    await this.provisionAws();

    if (dryRun) {
      // Dry run: stages 6-9 (onBeforeRun, mainFn, onAfterRun, archival) are
      // all skipped. `onCleanup` still runs, though — every OTHER terminal
      // path (success, error, shutdown signal) runs cleanup, so a dry run
      // that skipped it would be the one path that leaks whatever stages 1-5
      // allocated (e.g. a provisioned `aws` facade or acquired resources).
      // Do not "fix" this by skipping `onCleanup` too.
      //
      // Labeled `"cleanup"`, NOT the normal path's `"after-run"`: this branch
      // never ran `onAfterRun` (the other half of stage 8), so a throwing
      // `onCleanup` here must not be misreported as a failure of a stage that
      // never executed.
      this.currentStage = "cleanup";
      await runHook(this.hooks.onCleanup, this.hookContext());
      return;
    }

    // Stage 6 + 7: onBeforeRun, mainFn.
    this.currentStage = "before-run";
    await runHook(this.hooks.onBeforeRun, this.hookContext());
    this.currentStage = "main";
    await mainFn();

    // Stage 8: onAfterRun, onCleanup.
    this.currentStage = "after-run";
    await runHook(this.hooks.onAfterRun, this.hookContext());
    await runHook(this.hooks.onCleanup, this.hookContext());

    // Stage 9: file archival.
    this.currentStage = "archive";
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
