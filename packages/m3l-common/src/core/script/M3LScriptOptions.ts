/**
 * `core/script/M3LScriptOptions` — constructor options and supporting shape
 * declarations for {@link M3LScript}.
 *
 * @packageDocumentation
 */

import type { M3LConfig, M3LConfigParameter } from "../config/index.js";
import type { M3LLogger } from "../logging/index.js";
import type { M3LPrompt } from "../prompt/index.js";

/**
 * The identifying metadata for a script or Lambda function, required on
 * every {@link M3LScriptOptions}.
 *
 * @example
 * ```ts
 * import type { M3LScriptMetadata } from "@m3l-automation/m3l-common/core";
 *
 * const metadata: M3LScriptMetadata = {
 *   name: "report-builder",
 *   version: "1.0.0",
 * };
 * ```
 */
export interface M3LScriptMetadata {
  /** The script's human-readable name, e.g. `"report-builder"`. */
  readonly name: string;
  /** The script's version string, e.g. `"1.0.0"`. */
  readonly version: string;
}

/**
 * The configuration schema declaration accepted by {@link M3LScriptOptions.config}.
 *
 * Mirrors {@link M3LConfigSchema}'s own constructor argument shape (a bag of
 * declared {@link M3LConfigParameter} instances) so a caller can pass either
 * a pre-built `M3LConfigSchema` or this plain-object form without importing
 * an extra symbol.
 *
 * Not exported from the `script` barrel — it is only ever supplied inline as
 * `M3LScriptOptions.config`, so callers never need to name this shape
 * directly.
 */
interface M3LScriptConfigDeclaration {
  /** The declared configuration parameters for this script. */
  readonly params: readonly M3LConfigParameter[];
}

/**
 * A read-only view over a {@link M3LConfig} store — every read accessor
 * (`get`/`has`/`sourceOf`), none of the mutating ones (`set`). Used to type
 * {@link M3LScriptHookContext.config} so a lifecycle hook can read
 * already-resolved configuration but cannot mutate the live store mid-pipeline,
 * even though the same `M3LConfig` instance backs it at runtime.
 *
 * Not exported from the `script` barrel — it exists purely to narrow
 * `M3LScriptHookContext.config`'s compile-time type.
 */
type M3LReadonlyConfig = Pick<M3LConfig, "get" | "has" | "sourceOf">;

/**
 * The context object passed to every {@link M3LScriptLifecycleHooks} hook.
 *
 * Carries a read-only view over the live {@link M3LConfig} store so a hook
 * running at any stage can read already-resolved configuration values —
 * `config` exposes only `get`/`has`/`sourceOf`, not `set`, so a hook cannot
 * mutate the resolved store mid-pipeline.
 *
 * @example
 * ```ts
 * import type { M3LScriptHookContext } from "@m3l-automation/m3l-common/core";
 *
 * function onAfterConfigLoad(ctx: M3LScriptHookContext): void {
 *   console.log(ctx.config.get("region"));
 * }
 * ```
 */
export interface M3LScriptHookContext {
  /** A read-only view of the resolved configuration store for the current run/invocation. */
  readonly config: M3LReadonlyConfig;
  /**
   * The run's resolved correlation id — always a non-empty string by the
   * time the first hook fires. Either the verbatim
   * {@link M3LScriptOptions.correlationId} supplied by the caller, or a
   * generated `crypto.randomUUID()` when omitted — see the script module's
   * Correlation IDs reference for the full resolution precedence.
   */
  readonly correlationId: string;
  /**
   * Whether the current run is a dry run (see {@link M3LScriptRunOptions.dryRun}).
   * Required, never optional: a hook needs to branch on this value directly
   * (`if (ctx.dryRun) { ... }`) without a `?? false` fallback at every call
   * site, and `false` is itself meaningful information (this run performs
   * real work) rather than an absence of information — so it is always
   * present, `false` on every normal run and on every
   * {@link M3LScript.createLambdaHandler} invocation (dry-run only applies to
   * {@link M3LScript.run}).
   */
  readonly dryRun: boolean;
}

/** The signature shared by every {@link M3LScriptLifecycleHooks} hook except `onError`. */
type M3LScriptHook = (ctx: M3LScriptHookContext) => void | Promise<void>;

/**
 * The signature of the `onError` lifecycle hook. Unlike the other seven
 * hooks, it also receives the `error` that triggered the failure (the same
 * value {@link M3LScript.run} ultimately re-throws), so error-handling logic
 * can actually observe what went wrong instead of only the pipeline stage's
 * config snapshot.
 */
type M3LScriptErrorHook = (
  ctx: M3LScriptHookContext,
  error: unknown,
) => void | Promise<void>;

/**
 * The eight optional lifecycle hooks {@link M3LScript.run} (and
 * {@link M3LScript.createLambdaHandler}) invoke around each stage of
 * execution.
 *
 * All hooks are optional; an empty object is a valid `M3LScriptLifecycleHooks`.
 * Every hook receives the same {@link M3LScriptHookContext} shape and may
 * return `void` or a `Promise<void>` — an async hook is awaited before the
 * next stage begins.
 *
 * @example
 * ```ts
 * import type { M3LScriptLifecycleHooks } from "@m3l-automation/m3l-common/core";
 *
 * const hooks: M3LScriptLifecycleHooks = {
 *   onAfterConfigLoad: (ctx) => {
 *     console.log("config loaded:", ctx.config.get("region"));
 *   },
 *   onError: (ctx) => {
 *     console.error("run failed", ctx.config.get("region"));
 *   },
 * };
 * ```
 */
export interface M3LScriptLifecycleHooks {
  /** Runs before environment detection results are consulted. */
  onBeforeInit?: M3LScriptHook;
  /** Runs after stage-1 initialization completes. */
  onAfterInit?: M3LScriptHook;
  /** Runs immediately before configuration is loaded. */
  onBeforeConfigLoad?: M3LScriptHook;
  /** Runs immediately after configuration has been loaded. */
  onAfterConfigLoad?: M3LScriptHook;
  /** Runs immediately before `mainFn` is invoked. */
  onBeforeRun?: M3LScriptHook;
  /** Runs immediately after `mainFn` resolves successfully. */
  onAfterRun?: M3LScriptHook;
  /**
   * Runs when any stage throws; receives the same hook context plus the
   * error that triggered the failure.
   */
  onError?: M3LScriptErrorHook;
  /** Runs last, regardless of success or failure (best-effort teardown). */
  onCleanup?: M3LScriptHook;
}

/**
 * Constructor options for {@link M3LScript}.
 *
 * Only `metadata` is required. `config` declares the script's configuration
 * schema (needed for preset validation and the AWS-credential seam's
 * `aws.profile` detection); `hooks` wires the eight lifecycle callbacks;
 * `logger`/`prompt` let a caller inject pre-built facade instances (useful in
 * tests) instead of relying on the defaults constructed internally.
 *
 * @example
 * ```ts
 * import type { M3LScriptOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LScriptOptions = {
 *   metadata: { name: "report-builder", version: "1.0.0" },
 *   hooks: {
 *     onAfterConfigLoad: (ctx) => {
 *       console.log(ctx.config.get("region"));
 *     },
 *   },
 * };
 * ```
 */
export interface M3LScriptOptions {
  /** The script's identifying metadata. Required. */
  readonly metadata: M3LScriptMetadata;
  /** The declared configuration schema, if any. */
  readonly config?: M3LScriptConfigDeclaration;
  /** Lifecycle hooks invoked around each stage of {@link M3LScript.run}. */
  readonly hooks?: M3LScriptLifecycleHooks;
  /**
   * A pre-built logger instance to use instead of the default
   * {@link M3LLogger} (a single {@link M3LConsoleLoggerHandler}). Useful in
   * tests that need to assert on emitted log events.
   */
  readonly logger?: M3LLogger;
  /**
   * A pre-built prompt facade to use instead of the default `M3LPrompt`.
   * Useful in tests that need to assert on or stub interactive prompts
   * without a real TTY.
   */
  readonly prompt?: M3LPrompt;
  /**
   * An optional per-run correlation id used verbatim for the whole run when
   * supplied (a blank string is treated as omitted). When omitted,
   * {@link M3LScript.run} generates one via `crypto.randomUUID()`;
   * {@link M3LScript.createLambdaHandler} resolves a fresh id per invocation
   * (preferring `context.awsRequestId` over a generated id) unless this
   * option is set, in which case it wins over both — see the script module's
   * Correlation IDs reference for the full resolution precedence.
   */
  readonly correlationId?: string;
  /**
   * An optional path to a YAML/JSON preset file. When supplied,
   * {@link M3LScript} loads it (validated against the declared `config.params`)
   * and inserts its values into configuration resolution at precedence level
   * 6 — below CLI/env, above static `defaultValue`s. When omitted, no preset
   * provider is added and no preset file is read (no behavior change).
   *
   * The preset is validated against the schema declared via `config`, so it
   * is meant to be supplied alongside a declared `config`. If `preset` is
   * supplied without `config`, there is no schema to validate against —
   * every top-level key in the preset file is then treated as unknown, and
   * `M3LScriptPresetLoader` throws `M3LPresetUnknownKeysError`.
   *
   * An empty string is treated as **present**, not absent, and will fail at
   * load time with an `M3LError` coded `"ERR_PRESET_LOAD"` (an empty path
   * cannot be read as a preset file). Omit the field entirely — do not pass
   * `""` — to mean "no preset."
   */
  readonly preset?: string;
}

/**
 * Per-call options for {@link M3LScript.run}, distinct from the once-per-instance
 * {@link M3LScriptOptions} passed to the constructor.
 *
 * @example
 * ```ts
 * import { M3LScript } from "@m3l-automation/m3l-common/core";
 *
 * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
 *
 * // Exercise stages 1-5 (env detect, hooks, config load, AWS provisioning)
 * // without invoking mainFn or archiving files — useful for a `--dry-run`
 * // CLI flag that validates configuration/credentials without side effects.
 * await script.run(async () => {}, { dryRun: true });
 * ```
 */
export interface M3LScriptRunOptions {
  /**
   * When `true`, {@link M3LScript.run} stops after stage 5 (AWS provisioning):
   * `onBeforeRun`, `mainFn`, the `onAfterRun` half of stage 8, and stage 9
   * (file archival) are all skipped. `onCleanup` still runs — see
   * {@link M3LScript.run}'s own TSDoc for why. Defaults to `false`.
   */
  readonly dryRun?: boolean;
}
