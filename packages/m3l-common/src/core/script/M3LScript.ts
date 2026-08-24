/**
 * `core/script/M3LScript` — the single entry point for every automation
 * script and Lambda handler.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { extname, join } from "node:path";

import {
  M3LConfig,
  M3LConfigSchema,
  M3LJSONConfigProvider,
  M3LLambdaEventConfigProvider,
  M3LPresetConfigProvider,
  M3LYAMLConfigProvider,
  deriveSecretsSpecifier,
  type M3LConfigProvider,
  type M3LSecretsSpecifier,
} from "../config/index.js";
import {
  M3L_RECOVERY_LIMIT,
  type M3LRunRecoveryEntry,
  type M3LSerializedError,
} from "../diagnostics/index.js";
import { M3LError } from "../errors/index.js";
import { M3LExecutionEnvironment } from "../environment/index.js";
import type { M3LFileCopyReport } from "../files/index.js";
import { M3LFileCopier, getDefaultSubdirForPathType } from "../files/index.js";
import { M3LConsoleLoggerHandler, M3LLogger } from "../logging/index.js";
import { M3LPrompt } from "../prompt/index.js";
import type { M3LDestructiveTarget } from "../prompt/index.js";
import { M3LPaths, isEnoentError } from "../utils/index.js";

import { runDirectoryName } from "../../internal/diagnostics/runDirectoryName.js";
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
import {
  addProcessGuardSecretNames,
  serializeError,
  setProcessGuardRequestId,
} from "./process-guards.js";
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
  const candidate = (context as Record<string, unknown>)["awsRequestId"];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/** File extensions dispatched to `M3LYAMLConfigProvider` by {@link buildConfigFileProviders}. */
const YAML_CONFIG_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".yaml",
  ".yml",
]);

/** The file extension dispatched to `M3LJSONConfigProvider` by {@link buildConfigFileProviders}. */
const JSON_CONFIG_FILE_EXTENSION = ".json";

/**
 * Validates that `configFilePath` carries a recognized config-file
 * extension (`.json`, `.yaml`, or `.yml`, case-insensitive) — called eagerly,
 * for every entry of `options.configFiles`, from the {@link M3LScript}
 * constructor, so an unrecognized extension (including an empty string, i.e.
 * no extension) fails loud at construction time rather than surfacing later
 * from {@link M3LScript.buildConfigFileProviders} during stage 3.
 *
 * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` naming the
 *   offending path when the extension is not recognized.
 */
function validateConfigFileExtension(configFilePath: string): void {
  const extension = extname(configFilePath).toLowerCase();
  if (
    extension === JSON_CONFIG_FILE_EXTENSION ||
    YAML_CONFIG_FILE_EXTENSIONS.has(extension)
  ) {
    return;
  }
  throw new M3LError(
    `configFiles entry '${configFilePath}' has an unrecognized extension; expected .json, .yaml, or .yml`,
    { code: "ERR_INVALID_ARGUMENT" },
  );
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
 * Reads one field from a possibly-hostile record, wrapping any thrown getter
 * in an `M3LError` so raw errors never escape.
 */
function readRecoveryField(
  raw: Record<string, unknown>,
  key: string,
  msg: string,
): unknown {
  try {
    return raw[key];
  } catch {
    throw new M3LError(msg, { code: "ERR_INVALID_ARGUMENT" });
  }
}

/**
 * Validates and projects a raw {@link M3LRunRecoveryEntry} argument — guards
 * every field read against a throwing getter, throws `M3LError` with
 * `ERR_INVALID_ARGUMENT` on any violation, and returns a copy whose `error`
 * array and per-element objects are independent of the caller's originals.
 */
function projectReportedRecoveryEntry(
  entry: M3LRunRecoveryEntry,
): M3LRunRecoveryEntry {
  if (
    entry === null ||
    typeof entry !== "object" ||
    !Object.hasOwn(entry, "item")
  ) {
    throw new M3LError(
      "reportRecovery: entry must be a non-null object with a string 'item' field",
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
  const raw = entry as unknown as Record<string, unknown>;
  const ITEM_MSG =
    "reportRecovery: entry must be a non-null object with a string 'item' field";
  const item = readRecoveryField(raw, "item", ITEM_MSG);
  if (typeof item !== "string") {
    throw new M3LError(ITEM_MSG, { code: "ERR_INVALID_ARGUMENT" });
  }
  const ERROR_MSG = "reportRecovery: entry must have an 'error' array field";
  const errorRaw = readRecoveryField(raw, "error", ERROR_MSG);
  if (!Array.isArray(errorRaw)) {
    throw new M3LError(ERROR_MSG, { code: "ERR_INVALID_ARGUMENT" });
  }
  const AT_MSG = "reportRecovery: entry must have a string 'recordedAt' field";
  const recordedAt = readRecoveryField(raw, "recordedAt", AT_MSG);
  if (typeof recordedAt !== "string") {
    throw new M3LError(AT_MSG, { code: "ERR_INVALID_ARGUMENT" });
  }
  // Shallow-copy the array and each element so caller mutations to the
  // original cannot reach stored state.
  const error: M3LSerializedError[] = (errorRaw as readonly unknown[]).map(
    (e) =>
      typeof e === "object" && e !== null
        ? ({ ...e } as M3LSerializedError)
        : (e as M3LSerializedError),
  );
  return { item, error, recordedAt };
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
  /** Derived once from {@link M3LScript.schema}; widens best-effort diagnostics. */
  private readonly secrets: M3LSecretsSpecifier | undefined;
  private readonly configLoader = new M3LScriptConfigLoader();
  readonly #paths = new M3LPaths();
  readonly #controller = new AbortController();

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
   * The resolved AWS target, stored atomically with {@link M3LScript.awsProvider}
   * inside {@link M3LScript.provisionAws} once the `AWSProvider` construction
   * `try`/`catch` succeeds. Undefined before stage 5 runs, when the
   * `AWSProvider` constructor threw (`M3LAWSProvisioningError`), or when
   * `aws.profile` resolved empty (deferring to the SDK's default credential
   * chain — no identity to grade on).
   *
   * Stored separately from {@link M3LScript.awsProvider} only so that
   * {@link M3LScript.awsTarget} can surface the already-resolved identity
   * without re-reading the config store — see the atomic-storage rationale in
   * that accessor's TSDoc.
   */
  private resolvedAwsTarget: M3LDestructiveTarget | undefined;

  /**
   * Whether the run currently in progress was started with `{ dryRun: true }`
   * — mirrored onto every {@link M3LScriptHookContext.dryRun} built during
   * that run. Reset at the top of every {@link M3LScript.runPipeline} call
   * (including a Lambda invocation, which never passes `dryRun`), so it
   * always reflects the CURRENT run rather than leaking a prior one's value.
   */
  private currentDryRun = false;

  /**
   * The raw Lambda event payload for the invocation currently being served —
   * mirrored into the level-5 config provider chain by
   * {@link M3LScript.buildEventProviders}. Reset via
   * {@link M3LScript.resetForInvocation} at the top of every
   * {@link M3LScript.createLambdaHandler} invocation AND at the top of every
   * {@link M3LScript.run} call (which always resets it to `undefined`, since
   * `run` never receives an event), so it always reflects the CURRENT
   * invocation and never leaks a prior Lambda invocation's event into a
   * later `run()`/handler call. `undefined` means "no event this
   * invocation" — either the CLI `run()` path, or a Lambda invocation that
   * genuinely received `undefined` as its event.
   */
  private currentLambdaEvent: unknown = undefined;

  /**
   * The current run's/invocation's start timestamp — mirrored onto
   * {@link M3LScript.runStartedAt}. Reset at the top of every
   * {@link M3LScript.runPipeline} call (including a Lambda invocation),
   * BEFORE stage 1, so it is set on every run (success, failure, or
   * dry-run) and never leaks a prior run's value. Both stage-9 archival
   * ({@link M3LScript.archiveFiles}) and the run report
   * (`core/script/run-script.ts`) derive their co-located per-run directory
   * from this same timestamp via `runDirectoryName`.
   */
  private currentRunStartedAt: Date | undefined;

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

  /**
   * The caller-supplied `options.configFiles` list, already validated (every
   * entry's extension checked) by the constructor, or `undefined` when no
   * config files were configured. `undefined` means stage 3 reads no config
   * file and adds no `configFileProviders` entry — see
   * {@link M3LScript.buildConfigFileProviders}.
   */
  private readonly configFiles: readonly string[] | undefined;

  /**
   * Ring buffer of absorbed per-item failures recorded via
   * {@link M3LScript.reportRecovery}. Bounded at {@link M3L_RECOVERY_LIMIT}:
   * when the buffer is full, the oldest entry is evicted so the most recent
   * ones are always retained. Reset at the start of each invocation by
   * {@link M3LScript.resetForInvocation} so entries are strictly per-run.
   */
  private recoveryEntries: M3LRunRecoveryEntry[] = [];

  /**
   * The total count of every entry passed to {@link M3LScript.reportRecovery}
   * in the current run, retained or evicted. Reset at the start of each
   * invocation by {@link M3LScript.resetForInvocation}. When it exceeds
   * {@link M3LScript.recoveryEntries}.length the ring buffer has been
   * truncated and a reader can detect it via `recoveryTotal > recovery.length`.
   */
  private recoveryTotalCount = 0;

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
   * The resolved AWS identity this script's clients were provisioned with,
   * shaped as an {@link M3LDestructiveTarget} for direct use with
   * {@link confirmDestructive}. Returns `{ profile }`, plus `region` only when
   * one resolved — the **same** values stage 5 handed to the
   * {@link AWSProvider}, not a re-read of the config store.
   *
   * Returns `undefined` when no AWS identity was provisioned. A resolved
   * target implies a provisioned provider — `awsTarget !== undefined` ⟹
   * `aws !== undefined` — but **not** the converse. Stage 5 also provisions
   * when an `aws.profile` parameter is declared and resolves empty, deferring
   * to the SDK's default credential chain; there is no identity to grade on
   * in that case, so `awsTarget` stays `undefined` while `script.aws` is
   * set. The `region` key is **absent** (not merely `undefined`) when no
   * region was declared, because `exactOptionalPropertyTypes` is enabled and
   * an explicit `{ region: undefined }` would be a distinct, rejected shape.
   *
   * The resolved target is stored **atomically with the {@link AWSProvider}**
   * after the construction `try`/`catch` in {@link M3LScript.provisionAws}
   * succeeds. Were it stored before that `try`/`catch`, a run whose
   * `AWSProvider` constructor throws (`M3LAWSProvisioningError`) would leave a
   * stale target behind; a later successful run would reprovision from fresh
   * config while the stale target still reported the previous identity — the
   * gate would then grade on an identity the clients never used. This is the
   * "co-locate by a shared value, not by shared code" rule applied to a
   * pair of fields that must always agree.
   *
   * @returns The resolved {@link M3LDestructiveTarget}, or `undefined` when
   *   no AWS identity was provisioned.
   *
   * @example
   * ```ts
   * import { M3LLogger, M3LScript, confirmDestructive, runScript, sensitiveTargets } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * const logger = new M3LLogger([]);
   *
   * await runScript(script, async () => {
   *   await confirmDestructive({
   *     prompt: script.prompt,
   *     logger,
   *     description: "delete stack my-stack",
   *     yes: false,
   *     code: "ERR_ABORTED",
   *     ...(script.awsTarget !== undefined ? { target: script.awsTarget } : {}),
   *     isSensitiveTarget: sensitiveTargets({ profiles: ["prod"] }),
   *   });
   * });
   * ```
   */
  get awsTarget(): M3LDestructiveTarget | undefined {
    return this.resolvedAwsTarget;
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
   * The `AbortSignal` from this script's internally owned `AbortController`.
   *
   * On the **first** shutdown signal (`SIGTERM`/`SIGINT`/`SIGQUIT`), the
   * controller is aborted before {@link M3LScript.run}'s cleanup hook is
   * invoked — so a cleanup hook that itself awaits a poll or AWS waiter can
   * observe `signal.aborted === true` and stop immediately rather than
   * starting a fresh multi-minute wait during shutdown (ADR-0049).
   *
   * Thread this signal into a {@link M3LPoller} or AWS waiter option bag via
   * `signal: script.signal` to make long-running operations cooperative with
   * the script lifecycle. In an AWS-managed environment the controller is
   * never aborted (Lambda does not honour process signals), but the accessor
   * is still present and always returns a non-aborted signal — callers need
   * no environment-specific branch.
   *
   * The returned instance is stable: every call returns the same `AbortSignal`
   * object, mirroring the accessor identity guarantee of {@link M3LScript.paths}.
   *
   * @returns This script's `AbortSignal`.
   *
   * @example
   * ```ts
   * import { M3LScript, runScript, M3LPoller, M3LBackoff } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   *
   * await runScript(script, async () => {
   *   const poller = new M3LPoller({
   *     backoff: M3LBackoff.constant(5_000),
   *     signal: script.signal,
   *   });
   *   await poller.poll(checkJobStatus);
   * });
   * ```
   */
  get signal(): AbortSignal {
    return this.#controller.signal;
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
   * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when any entry
   *   of `options.configFiles` has an unrecognized file extension (anything
   *   other than `.json`, `.yaml`, or `.yml`, case-insensitive, including an
   *   empty string) — see {@link M3LScript.buildConfigFileProviders}.
   */
  constructor(options: M3LScriptOptions) {
    this.scriptMetadata = options.metadata;
    this.hooks = options.hooks ?? {};
    this.schema =
      options.config !== undefined
        ? new M3LConfigSchema(options.config.params, options.config.validate)
        : undefined;
    this.secrets =
      this.schema === undefined
        ? undefined
        : deriveSecretsSpecifier(this.schema);
    // Registers this script's own declared secret names into the
    // process-global union `addProcessGuardSecretNames` maintains, mirroring
    // `run-script.ts`'s `runScript()` call site — but here unconditionally at
    // construction time, not only when a run goes through `runScript()`. A
    // script driven via `createLambdaHandler()` or a bare `script.run()`
    // never calls `runScript()`, so without this call its schema-derived
    // secret names would never reach whatever fault guards the caller has
    // installed, even though `this.secrets` already has them. This does NOT
    // install the guards itself — `installProcessGuards()` remains
    // exclusively `runScript()`'s (or the caller's) responsibility; this only
    // ensures the names are available once guards ARE installed by whatever
    // means.
    if (this.secrets !== undefined) {
      addProcessGuardSecretNames(this.secrets.secretNames);
    }

    this.configuredCorrelationId = options.correlationId;
    this.preset = options.preset;
    this.configFiles = options.configFiles;
    if (this.configFiles !== undefined) {
      for (const configFilePath of this.configFiles) {
        validateConfigFileExtension(configFilePath);
      }
    }
    this.logger = options.logger ?? this.buildDefaultLogger();
    this.prompt = options.prompt ?? new M3LPrompt();

    const env = M3LExecutionEnvironment.detect();
    if (!env.isAWSManaged) {
      // One instance per process is the supported usage pattern:
      // `registerShutdownSignals` installs a fresh, independent set of
      // `SIGTERM`/`SIGINT`/`SIGQUIT` listeners on every call, so constructing
      // multiple `M3LScript`s in one process accumulates listeners rather
      // than replacing them.
      registerShutdownSignals(() => {
        // Abort BEFORE cleanup so a cleanup hook observing `signal.aborted`
        // already sees `true` — preventing it from starting a fresh long-running
        // wait while the process is shutting down (ADR-0049).
        this.#controller.abort();
        return this.runCleanup("signal-shutdown");
      }, this.secrets);
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
   * The declared config schema, exactly as constructed from the
   * constructor's `options.config.params`, or `undefined` when no schema was
   * declared at all — e.g. so a `runScript` composition root can build a
   * config-fingerprint diagnostics port only when there is a schema to
   * enumerate names from.
   *
   * @returns This script's {@link M3LConfigSchema}, or `undefined`.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * console.log(script.configSchema); // undefined — no config declared
   * ```
   */
  get configSchema(): M3LConfigSchema | undefined {
    return this.schema;
  }

  /**
   * The current run's/invocation's live resolved-configuration store — the
   * exact same instance {@link M3LScript.getConfiguration} returns once
   * loaded, but readable synchronously without triggering a load. Empty
   * before the first load, reset per Lambda invocation and at the top of
   * every {@link M3LScript.run} call (see {@link M3LScript.resetForInvocation}),
   * same as `getConfiguration`.
   *
   * @returns The live {@link M3LConfig} store.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * await script.getConfiguration();
   * console.log(script.currentConfig.get("region"));
   * ```
   */
  get currentConfig(): M3LConfig {
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
   * The current run's/invocation's start timestamp. `undefined` before
   * {@link M3LScript.run} (or the handler from
   * {@link M3LScript.createLambdaHandler}) has been called at least once;
   * refreshed at the top of every run thereafter, so a later run's value is
   * always strictly later than an earlier one's.
   *
   * Both stage-9 file archival and the persisted run report
   * (`core/script/run-script.ts`'s `runScript`) derive their co-located
   * per-run `<outputDir>/<timestamp>/` directory from this same value.
   *
   * Instance-scoped, one-in-flight-run-at-a-time state — see
   * {@link M3LScript.run}'s TSDoc for why overlapping `run`/`runScript` calls
   * on the SAME instance are unsupported.
   *
   * @returns The current run's start time, or `undefined`.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "x", version: "1.0.0" } });
   * await script.run(async () => {});
   * console.log(script.runStartedAt); // a Date
   * ```
   */
  get runStartedAt(): Date | undefined {
    return this.currentRunStartedAt;
  }

  /**
   * Records an absorbed per-item failure into this script's bounded ring
   * buffer of recovery entries, incrementing {@link M3LScript.recoveryTotal}
   * regardless of whether the entry was retained or evicted.
   *
   * Call this from `mainFn` for every item-level failure the run absorbs and
   * continues past. {@link runScript} consults {@link M3LScript.recovery} on
   * the non-throwing path: one or more entries shift the outcome from
   * `"success"` to `"partial"` with exit code `6` (`M3L_EXIT_CODES.PARTIAL`).
   *
   * A propagating throw still wins: an error that escapes `mainFn` resolves
   * to `"failure"` (or `"interrupted"` for a cooperative abort) regardless of
   * how many recovery entries were recorded — recovery describes failures the
   * run survived, not what ended it.
   *
   * The buffer is bounded at {@link M3L_RECOVERY_LIMIT}: once full, the
   * oldest entry is evicted to make room for the newest one. Read
   * `recoveryTotal > recovery.length` to detect truncation.
   *
   * @param entry - The absorbed failure to record. Must be a non-null object
   *   with at least a non-null `item` field (the caller-supplied identifier of
   *   what failed).
   * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when `entry` is
   *   `null`, not an object, or is missing the required `item` field.
   *
   * @example
   * ```ts
   * import { M3LScript, runScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "batch", version: "1.0.0" } });
   *
   * await runScript(script, async () => {
   *   for (const id of ["a", "b", "c"]) {
   *     try {
   *       await processRecord(id);
   *     } catch (cause) {
   *       script.reportRecovery({
   *         item: id,
   *         error: [{ name: "Error", message: String(cause) }],
   *         recordedAt: new Date().toISOString(),
   *       });
   *     }
   *   }
   * });
   * ```
   */
  reportRecovery(entry: M3LRunRecoveryEntry): void {
    const stored = projectReportedRecoveryEntry(entry);
    this.recoveryEntries.push(stored);
    this.recoveryTotalCount += 1;
    if (this.recoveryEntries.length > M3L_RECOVERY_LIMIT) {
      this.recoveryEntries.shift();
    }
  }

  /**
   * A snapshot of the absorbed per-item failures recorded via
   * {@link M3LScript.reportRecovery}, oldest first, bounded at
   * {@link M3L_RECOVERY_LIMIT}.
   *
   * A fresh snapshot is returned on every call — mutations to the returned
   * array or to any entry's `error` array do not reach internal state, and a
   * later {@link M3LScript.reportRecovery} call never retroactively changes a
   * snapshot already returned. Each entry is a copy with its `error` array
   * independently shallow-copied so that a caller cannot push to or remove
   * from the stored chain.
   *
   * When `recovery.length < recoveryTotal`, the buffer was truncated: the
   * oldest entries were evicted and only the most recent ones were retained.
   *
   * @returns A snapshot of the current recovery entries, empty before the
   *   first {@link M3LScript.reportRecovery} call.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "batch", version: "1.0.0" } });
   * console.log(script.recovery.length); // 0 before any reportRecovery call
   * ```
   */
  get recovery(): readonly M3LRunRecoveryEntry[] {
    return this.recoveryEntries.map((e) => ({ ...e, error: [...e.error] }));
  }

  /**
   * The total count of every entry passed to
   * {@link M3LScript.reportRecovery} in the current run, whether retained in
   * the ring buffer or evicted. Reset to zero at the start of each run by
   * {@link M3LScript.resetForInvocation}.
   *
   * `recoveryTotal > recovery.length` means the buffer was truncated — the
   * full per-run failure count is this value even though only the most recent
   * {@link M3L_RECOVERY_LIMIT} entries are kept.
   *
   * @returns The per-run count of reported recovery entries.
   *
   * @example
   * ```ts
   * import { M3LScript } from "@m3l-automation/m3l-common/core";
   *
   * const script = new M3LScript({ metadata: { name: "batch", version: "1.0.0" } });
   * console.log(script.recoveryTotal); // 0 before any reportRecovery call
   * ```
   */
  get recoveryTotal(): number {
    return this.recoveryTotalCount;
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
   * A single `M3LScript` instance supports only ONE in-flight run at a time:
   * `currentRunStartedAt`/`currentDryRun`/`currentStage`/`currentCorrelationId`/
   * `config` are instance-scoped mutable state, reset at the top of every
   * call, not per-call-scoped — there is no reentrancy guard. Calling `run`
   * (or `runScript`) a second time on the SAME instance while an earlier call
   * is still in flight is unsupported: the later call's reset overwrites the
   * earlier call's state out from under it (e.g. a later run's
   * {@link M3LScript.runStartedAt} clobbering the value the earlier run's
   * stage-9 archival is about to read, silently misplacing that earlier
   * run's archived files under the LATER run's directory). Concurrent runs
   * must use separate `M3LScript` instances.
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
    // Mirrors the Lambda-handler path's reset call, so a script instance
    // that previously served a Lambda invocation resolves no leftover event
    // values here — `run` never supplies an event, so this always clears
    // `currentLambdaEvent` to `undefined`.
    this.resetForInvocation();
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
   * Unlike {@link M3LScript.run}, the received `event` is wired into stage 3
   * (config load) as a level-5 provider (see
   * {@link M3LScript.buildEventProviders}): a top-level event key resolves a
   * declared config parameter, below the command-line/config-file/environment
   * tiers but above a preset. `run()` never supplies an event, so config
   * resolution never reaches level 5 under the CLI path — a behavioral
   * asymmetry between the two entry points worth revisiting under a future
   * ADR-0018 update.
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
      this.resetForInvocation(event);
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

  /**
   * Resets per-invocation state — the single assignment site for
   * {@link M3LScript.currentLambdaEvent}, so the "reset, then assign the new
   * event" ordering is structurally guaranteed rather than relying on two
   * call sites staying in sync. Called from the very top of
   * {@link M3LScript.createLambdaHandler}'s returned closure (passing the
   * just-received `event`) and from the very top of {@link M3LScript.run}
   * (with no argument, clearing `currentLambdaEvent` to `undefined` since
   * `run` never supplies an event).
   *
   * @param event - The just-received Lambda event, when called from the
   *   Lambda-handler path; omitted (clearing `currentLambdaEvent`) when
   *   called from `run()`.
   */
  private resetForInvocation(event?: unknown): void {
    this.initialized = false;
    this.configLoaded = false;
    this.config = new M3LConfig();
    this.currentLambdaEvent = event;
    // Recovery state is per-run: a second invocation on the same instance
    // (warm Lambda container, test harness) must not inherit absorbed
    // failures from an earlier run.
    this.recoveryEntries = [];
    this.recoveryTotalCount = 0;
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
   * Builds the level-2/3 `configFileProviders` entries for {@link loadConfig}
   * when `options.configFiles` was configured; `undefined` when it was not
   * (so `loadConfig` reads no config file and adds no provider). Split out of
   * `loadConfig` to keep that method pure orchestration, mirroring the
   * {@link buildPresetProviders} extraction above.
   *
   * Each already-extension-validated path (validated eagerly by the
   * constructor, see {@link validateConfigFileExtension}) is dispatched by
   * extension to `M3LJSONConfigProvider` (`.json`) or `M3LYAMLConfigProvider`
   * (`.yaml`/`.yml`, case-insensitive). This is where the providers'
   * constructors actually run — each does a synchronous eager
   * `readFileSync` + parse and can throw `M3LConfigParseError` /
   * `M3LUnsafeConfigKeyError`, which propagates unchanged out of stage 3, not
   * out of `M3LScript`'s constructor.
   */
  private buildConfigFileProviders(): readonly M3LConfigProvider[] | undefined {
    if (this.configFiles === undefined || this.configFiles.length === 0) {
      return undefined;
    }

    return this.configFiles.map((configFilePath) =>
      YAML_CONFIG_FILE_EXTENSIONS.has(extname(configFilePath).toLowerCase())
        ? new M3LYAMLConfigProvider(configFilePath)
        : new M3LJSONConfigProvider(configFilePath),
    );
  }

  /**
   * Builds the level-5 `extraProviders` entry for {@link loadConfig} when the
   * current run/invocation carries a Lambda event (see
   * {@link M3LScript.currentLambdaEvent}); `undefined` when it does not — the
   * CLI `run()` path (which always clears `currentLambdaEvent`), or a Lambda
   * invocation that genuinely received `undefined` as its event — so
   * `loadConfig` adds no event provider. Split out of `loadConfig` to keep
   * that method pure orchestration, mirroring the {@link buildPresetProviders}
   * / {@link buildConfigFileProviders} extractions above.
   *
   * `M3LLambdaEventConfigProvider`'s own constructor screens every top-level
   * event key against the prototype-pollution guard; a dangerous key's
   * `M3LUnsafeConfigKeyError` propagates unchanged out of stage 3, not out of
   * this method.
   */
  private buildEventProviders(): readonly M3LConfigProvider[] | undefined {
    if (this.currentLambdaEvent === undefined) return undefined;
    return [new M3LLambdaEventConfigProvider(this.currentLambdaEvent)];
  }

  /**
   * Stage 3: loads configuration via {@link M3LScriptConfigLoader}.
   *
   * Precedence, highest first: command-line arguments (level 1), config-file
   * providers (levels 2-3, when `options.configFiles` was configured — see
   * {@link buildConfigFileProviders}), environment variables (level 4), the
   * current Lambda event (level 5, when {@link M3LScript.createLambdaHandler}
   * is the entry point — see {@link buildEventProviders}), a loaded preset
   * (level 6, when `options.preset` was configured — see
   * {@link buildPresetProviders}), a parameter's `defaultValue` (level 7),
   * then its `asyncFallback` (level 8).
   *
   * When `options.preset` was configured, the preset file is loaded (and
   * validated against the declared schema) via {@link M3LScriptPresetLoader}
   * first, and its values are wired in as a lowest-priority
   * `presetProviders` entry. When `options.configFiles` was configured, each
   * entry is dispatched to a `M3LJSONConfigProvider`/`M3LYAMLConfigProvider`
   * (see {@link buildConfigFileProviders}) and wired in at precedence levels
   * 2-3 — below the command-line provider, above the environment-variable
   * provider. Any throw from the preset loader (e.g.
   * `M3LPresetUnknownKeysError`, or an `M3LError` coded `"ERR_PRESET_LOAD"`
   * for a missing/malformed file), from a config-file provider or the event
   * provider (e.g. `M3LConfigParseError`/`M3LUnsafeConfigKeyError`), or from
   * the subsequent {@link M3LConfigSchema.validate} call (an
   * `M3LConfigValidationError` coded `"ERR_CONFIG_VALIDATION"` when a
   * schema-level validator rejects the resolved store), propagates
   * unchanged — this method does not catch/swallow any of them.
   */
  private async loadConfig(): Promise<void> {
    const presetProviders = this.buildPresetProviders();
    const configFileProviders = this.buildConfigFileProviders();
    const eventProviders = this.buildEventProviders();

    this.config = await this.configLoader.load({
      params: this.schema?.parameters ?? [],
      ...(configFileProviders !== undefined ? { configFileProviders } : {}),
      ...(eventProviders !== undefined
        ? { extraProviders: eventProviders }
        : {}),
      ...(presetProviders !== undefined ? { presetProviders } : {}),
    });
    this.schema?.validate(this.config);
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
    // Store the resolved target atomically with the provider: both are set
    // here, after the try/catch, so a constructor throw leaves NEITHER set.
    // Were resolvedAwsTarget stored before the try/catch, a failed run would
    // leave a stale target while awsProvider stayed undefined — the pair
    // would be out of sync and `awsTarget !== undefined` would no longer
    // imply `aws !== undefined`.
    this.awsProvider = provider;
    this.resolvedAwsTarget =
      profile !== undefined
        ? { profile, ...(region !== undefined ? { region } : {}) }
        : undefined;
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
   *
   * Files land under this run's own `<outputDir>/<runDirectoryName>/`
   * subdirectory — the same directory the persisted run report
   * (`core/script/run-script.ts`) is written to — rather than a flat
   * `<outputDir>/inputs|configs`, so a run's full output (archived files
   * plus its report) is co-located (ADR-0035 phase 5, A5 part 1). Falls
   * back to a freshly-captured `new Date()` in the (unreachable in
   * practice) case this runs before {@link M3LScript.currentRunStartedAt}
   * has been set.
   */
  private async archiveFiles(): Promise<void> {
    const runStartedAt = this.currentRunStartedAt ?? new Date();
    const runOutputDir = join(
      this.#paths.getOutputDir(),
      runDirectoryName(runStartedAt),
    );
    const fileCopier = new M3LFileCopier({
      paths: { getOutputDir: () => runOutputDir },
    });
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
    this.currentRunStartedAt = new Date();

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
        { secrets: this.secrets },
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
        { secrets: this.secrets },
      );
    }
  }
}
