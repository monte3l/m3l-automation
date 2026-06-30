/**
 * `core/environment` — runtime environment detection for automation scripts.
 *
 * Detects the current execution context (local developer machine, CI pipeline,
 * or managed AWS runtime) by inspecting process signals and the filesystem.
 * All detection is fully synchronous and results are cached as a
 * process-global singleton so the expensive walk-up only runs once.
 *
 * The primary entry point is {@link M3LExecutionEnvironment} (aliased as
 * {@link M3LEnv} for brevity). Call {@link M3LExecutionEnvironment.detect} to
 * retrieve the cached {@link M3LExecutionEnvironmentInfo}, or
 * {@link M3LExecutionEnvironment.detectFresh} to discard the cache and
 * re-detect (useful in tests and long-lived processes that span environment
 * transitions).
 *
 * @packageDocumentation
 */

import * as fs from "fs";
import * as path from "path";

import { M3LError } from "../errors/index.js";

// ---------------------------------------------------------------------------
// Const-object enums (no runtime enum overhead; full literal inference)
// ---------------------------------------------------------------------------

/**
 * Identifies the execution environment in which the process is running.
 *
 * Values are detected in priority order by
 * {@link M3LExecutionEnvironment.detect}. Use the companion `type` to narrow
 * a received value:
 *
 * @example
 * ```ts
 * import {
 *   M3LExecutionEnvironmentType,
 *   M3LEnv,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const { environmentType } = M3LEnv.detect();
 * if (environmentType === M3LExecutionEnvironmentType.CI) {
 *   // skip interactive prompts
 * }
 * ```
 */
export const M3LExecutionEnvironmentType = {
  /** A developer terminal session with stdout attached to a TTY. */
  LOCAL_INTERACTIVE: "LOCAL_INTERACTIVE",
  /** A continuous-integration runner (GitHub Actions, CircleCI, etc.). */
  CI: "CI",
  /** AWS Lambda function execution environment. */
  AWS_LAMBDA: "AWS_LAMBDA",
  /** AWS Elastic Container Service task. */
  AWS_ECS: "AWS_ECS",
  /** AWS EC2 instance. */
  AWS_EC2: "AWS_EC2",
  /** AWS CodeBuild build container. */
  AWS_CODEBUILD: "AWS_CODEBUILD",
  /** Could not determine the execution environment. */
  UNKNOWN: "UNKNOWN",
} as const;

/**
 * Union of all {@link M3LExecutionEnvironmentType} values.
 *
 * @example
 * ```ts
 * import type { M3LExecutionEnvironmentType } from "@m3l-automation/m3l-common/core";
 *
 * function describe(t: M3LExecutionEnvironmentType): string {
 *   return `Running in: ${t}`;
 * }
 * ```
 */
export type M3LExecutionEnvironmentType =
  (typeof M3LExecutionEnvironmentType)[keyof typeof M3LExecutionEnvironmentType];

// ---------------------------------------------------------------------------

/**
 * Indicates whether the package is consumed inside a monorepo (pnpm/npm/yarn
 * workspaces) or as a standalone installation.
 *
 * Detection is based on a walk-up from `process.cwd()` looking for
 * `pnpm-workspace.yaml` or a `package.json` with a `workspaces` field.
 *
 * @example
 * ```ts
 * import {
 *   M3LDeploymentMode,
 *   M3LEnv,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const { deploymentMode } = M3LEnv.detect();
 * if (deploymentMode === M3LDeploymentMode.MONOREPO) {
 *   // paths anchor to workspace root
 * }
 * ```
 */
export const M3LDeploymentMode = {
  /** Package is part of a monorepo workspace. */
  MONOREPO: "MONOREPO",
  /** Package is installed standalone outside any workspace. */
  STANDALONE: "STANDALONE",
} as const;

/**
 * Union of all {@link M3LDeploymentMode} values.
 *
 * @example
 * ```ts
 * import type { M3LDeploymentMode } from "@m3l-automation/m3l-common/core";
 *
 * function label(mode: M3LDeploymentMode): string {
 *   return mode === "MONOREPO" ? "workspace" : "standalone";
 * }
 * ```
 */
export type M3LDeploymentMode =
  (typeof M3LDeploymentMode)[keyof typeof M3LDeploymentMode];

// ---------------------------------------------------------------------------

/**
 * The mechanism through which AWS credentials are expected to be supplied in
 * the detected environment.
 *
 * This drives decisions such as whether to prompt the user for an SSO login,
 * inject credentials from environment variables, or rely on the EC2 instance
 * metadata service.
 *
 * @example
 * ```ts
 * import {
 *   M3LCredentialSource,
 *   M3LEnv,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const { credentialSource } = M3LEnv.detect();
 * if (credentialSource === M3LCredentialSource.SSO_PROFILE) {
 *   // prompt user to run aws sso login
 * }
 * ```
 */
export const M3LCredentialSource = {
  /** Developer machine SSO profile via `aws sso login`. */
  SSO_PROFILE: "SSO_PROFILE",
  /** Credentials injected as environment variables (CI). */
  ENVIRONMENT: "ENVIRONMENT",
  /** ECS container credential endpoint. */
  CONTAINER: "CONTAINER",
  /** EC2 instance metadata service (IMDS). */
  INSTANCE_METADATA: "INSTANCE_METADATA",
  /** OIDC / web identity token file (Lambda). */
  WEB_IDENTITY: "WEB_IDENTITY",
  /** AWS SDK default provider chain — fall through all mechanisms. */
  DEFAULT_CHAIN: "DEFAULT_CHAIN",
  /** No credentials available or applicable. */
  NONE: "NONE",
} as const;

/**
 * Union of all {@link M3LCredentialSource} values.
 *
 * @example
 * ```ts
 * import type { M3LCredentialSource } from "@m3l-automation/m3l-common/core";
 *
 * function needsLogin(source: M3LCredentialSource): boolean {
 *   return source === "SSO_PROFILE";
 * }
 * ```
 */
export type M3LCredentialSource =
  (typeof M3LCredentialSource)[keyof typeof M3LCredentialSource];

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link M3LEnvironmentDetectionError}.
 *
 * `code` is always `"ERR_ENVIRONMENT_DETECTION"`. `cause` carries the
 * underlying filesystem or OS error.
 *
 * @example
 * ```ts
 * import { M3LEnvironmentDetectionError } from "@m3l-automation/m3l-common/core";
 *
 * throw new M3LEnvironmentDetectionError("cannot read directory", {
 *   code: "ERR_ENVIRONMENT_DETECTION",
 *   cause: fsError,
 * });
 * ```
 */
interface M3LEnvironmentDetectionErrorOptions {
  /** Always `"ERR_ENVIRONMENT_DETECTION"`. */
  readonly code: "ERR_ENVIRONMENT_DETECTION";
  /** The underlying OS or filesystem error that triggered the failure. */
  readonly cause?: unknown;
}

/**
 * Thrown when environment detection cannot proceed due to an unrecoverable
 * filesystem condition — for example, an `EACCES` error encountered during
 * the monorepo walk-up.
 *
 * Callers that need to handle detection failures gracefully should catch this
 * type specifically. All other {@link M3LError} subclasses from this package
 * represent different failure domains.
 *
 * @example
 * ```ts
 * import {
 *   M3LEnv,
 *   M3LEnvironmentDetectionError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   const info = M3LEnv.detect();
 * } catch (e) {
 *   if (e instanceof M3LEnvironmentDetectionError) {
 *     // filesystem permission denied during walk-up
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LEnvironmentDetectionError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_ENVIRONMENT_DETECTION"`. */
  override readonly code: "ERR_ENVIRONMENT_DETECTION";

  /**
   * Creates a new `M3LEnvironmentDetectionError`.
   *
   * @param message - Human-readable description of what failed.
   * @param options - Options bag; `code` must be `"ERR_ENVIRONMENT_DETECTION"`;
   *   `cause` carries the underlying OS/filesystem error.
   */
  constructor(message: string, options: M3LEnvironmentDetectionErrorOptions) {
    super(message, { code: options.code, cause: options.cause });
    this.code = options.code;
  }
}

// ---------------------------------------------------------------------------
// Detection-detail and info interfaces
// ---------------------------------------------------------------------------

/**
 * Raw signals captured during a single detection run.
 *
 * These values reflect the state of the process at the moment
 * {@link M3LExecutionEnvironment.detect} or
 * {@link M3LExecutionEnvironment.detectFresh} was called. They are exposed so
 * callers can audit the inputs that drove the higher-level
 * {@link M3LExecutionEnvironmentInfo} properties.
 *
 * @example
 * ```ts
 * import { M3LEnv } from "@m3l-automation/m3l-common/core";
 *
 * const { detectionDetails } = M3LEnv.detect();
 * console.log("stdout is TTY:", detectionDetails.stdoutIsTTY);
 * ```
 */
export interface M3LEnvironmentDetectionDetails {
  /** Whether `process.stdout.isTTY` was `true` at detection time. */
  readonly stdoutIsTTY: boolean;
  /** Whether `process.stderr.isTTY` was `true` at detection time. */
  readonly stderrIsTTY: boolean;
  /**
   * Whether CI signals (`CI`, `GITHUB_ACTIONS`, `JENKINS_URL`) were present.
   */
  readonly isCiEnvironment: boolean;
  /** Whether `AWS_LAMBDA_TASK_ROOT` was set to a non-empty value. */
  readonly hasLambdaTaskRoot: boolean;
  /**
   * Whether `ECS_CONTAINER_METADATA_URI_V4` or `ECS_CONTAINER_METADATA_URI`
   * was set to a non-empty value.
   */
  readonly hasEcsMetadataUri: boolean;
  /** Whether `CODEBUILD_BUILD_ID` was set to a non-empty value. */
  readonly hasCodeBuildBuildId: boolean;
  /**
   * The absolute path to the workspace marker file (`pnpm-workspace.yaml` or
   * `package.json`) found during the walk-up, or `undefined` when no marker
   * was found.
   */
  readonly workspaceMarkerPath: string | undefined;
}

/**
 * Fields common to both deployment modes.
 *
 * @internal Not re-exported; the public type is {@link M3LExecutionEnvironmentInfo}.
 */
interface M3LExecutionEnvironmentInfoBase {
  /** Detected execution environment type. */
  readonly environmentType: M3LExecutionEnvironmentType;
  /** `true` when running in a local interactive terminal session. */
  readonly isInteractive: boolean;
  /** `true` when running on an AWS-managed compute service. */
  readonly isAWSManaged: boolean;
  /** `true` when both stdout and stdin are attached to TTYs. */
  readonly canPromptUser: boolean;
  /** `true` when a browser can be opened on the local machine. */
  readonly canOpenBrowser: boolean;
  /** `true` when credentials require an explicit `aws sso login`. */
  readonly requiresAwsProfile: boolean;
  /** How AWS credentials are expected to be supplied. */
  readonly credentialSource: M3LCredentialSource;
  /** Raw signals captured during detection for auditability. */
  readonly detectionDetails: M3LEnvironmentDetectionDetails;
}

/**
 * Snapshot of the execution environment at detection time.
 *
 * Retrieved via {@link M3LExecutionEnvironment.detect} (cached) or
 * {@link M3LExecutionEnvironment.detectFresh} (fresh). All properties are
 * `readonly` — consumers should not mutate this object.
 *
 * The type is a discriminated union on `deploymentMode`: narrowing to
 * `M3LDeploymentMode.MONOREPO` also narrows `monorepoRoot` to `string`
 * (never `undefined`); narrowing to `M3LDeploymentMode.STANDALONE` narrows
 * `monorepoRoot` to `undefined`.
 *
 * @example
 * ```ts
 * import { M3LEnv, M3LDeploymentMode } from "@m3l-automation/m3l-common/core";
 * import type { M3LExecutionEnvironmentInfo } from "@m3l-automation/m3l-common/core";
 *
 * const info: M3LExecutionEnvironmentInfo = M3LEnv.detect();
 * if (info.deploymentMode === M3LDeploymentMode.MONOREPO) {
 *   // info.monorepoRoot is string here — never undefined
 *   console.log(info.monorepoRoot);
 * }
 * ```
 */
export type M3LExecutionEnvironmentInfo = M3LExecutionEnvironmentInfoBase &
  (
    | {
        /** Package is deployed inside a monorepo workspace. */
        readonly deploymentMode: typeof M3LDeploymentMode.MONOREPO;
        /** Absolute path to the monorepo root directory. */
        readonly monorepoRoot: string;
      }
    | {
        /** Package is installed standalone outside any workspace. */
        readonly deploymentMode: typeof M3LDeploymentMode.STANDALONE;
        /** Always `undefined` in STANDALONE mode. */
        readonly monorepoRoot: undefined;
      }
  );

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum number of directories inspected (startDir + ancestors) during the monorepo walk-up. */
const MAX_DIRECTORIES_CHECKED = 50;

/**
 * Returns `true` when the string is non-empty (i.e. the env var was set and
 * not blank).
 */
function isNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Classifies the running process into one of the known
 * {@link M3LExecutionEnvironmentType} values by inspecting environment
 * variables and TTY state. Priority follows B5 in the contract.
 */
function classifyEnvironmentType(): M3LExecutionEnvironmentType {
  // Priority 1: AWS Lambda
  if (isNonEmpty(process.env["AWS_LAMBDA_TASK_ROOT"])) {
    return M3LExecutionEnvironmentType.AWS_LAMBDA;
  }
  // Priority 2: AWS ECS
  if (hasEcsSignal()) {
    return M3LExecutionEnvironmentType.AWS_ECS;
  }
  // Priority 3: AWS CodeBuild
  if (isNonEmpty(process.env["CODEBUILD_BUILD_ID"])) {
    return M3LExecutionEnvironmentType.AWS_CODEBUILD;
  }
  // Priority 4: AWS EC2
  if (process.env["AWS_EXECUTION_ENV"]?.includes("EC2") === true) {
    return M3LExecutionEnvironmentType.AWS_EC2;
  }
  // Priority 5: CI
  if (detectIsCiEnvironment()) {
    return M3LExecutionEnvironmentType.CI;
  }
  // Priority 6: Local interactive
  if (process.stdout.isTTY === true) {
    return M3LExecutionEnvironmentType.LOCAL_INTERACTIVE;
  }
  // Priority 7: Unknown
  return M3LExecutionEnvironmentType.UNKNOWN;
}

/**
 * Returns `true` when CI-related environment signals are present. This mirrors
 * the CI branch of {@link classifyEnvironmentType} but is callable independently
 * so `detectionDetails.isCiEnvironment` can be populated regardless of whether
 * higher-priority AWS signals overrode the type.
 */
function detectIsCiEnvironment(): boolean {
  const ci = process.env["CI"];
  if (ci === "true" || ci === "1") {
    return true;
  }
  return (
    process.env["GITHUB_ACTIONS"] === "true" ||
    isNonEmpty(process.env["JENKINS_URL"])
  );
}

/**
 * Returns `true` when any AWS ECS metadata URI environment variable is set.
 * Extracted to reduce complexity of {@link classifyEnvironmentType}.
 */
function hasEcsSignal(): boolean {
  return (
    isNonEmpty(process.env["ECS_CONTAINER_METADATA_URI_V4"]) ||
    isNonEmpty(process.env["ECS_CONTAINER_METADATA_URI"])
  );
}

/**
 * Maps {@link M3LExecutionEnvironmentType} to the expected
 * {@link M3LCredentialSource} for that environment.
 */
function resolveCredentialSource(
  envType: M3LExecutionEnvironmentType,
): M3LCredentialSource {
  switch (envType) {
    case M3LExecutionEnvironmentType.LOCAL_INTERACTIVE:
      return M3LCredentialSource.SSO_PROFILE;
    case M3LExecutionEnvironmentType.CI:
      return M3LCredentialSource.ENVIRONMENT;
    case M3LExecutionEnvironmentType.AWS_LAMBDA:
      return M3LCredentialSource.WEB_IDENTITY;
    case M3LExecutionEnvironmentType.AWS_ECS:
      return M3LCredentialSource.CONTAINER;
    case M3LExecutionEnvironmentType.AWS_EC2:
      return M3LCredentialSource.INSTANCE_METADATA;
    case M3LExecutionEnvironmentType.AWS_CODEBUILD:
      return M3LCredentialSource.ENVIRONMENT;
    case M3LExecutionEnvironmentType.UNKNOWN:
      return M3LCredentialSource.DEFAULT_CHAIN;
    default: {
      const _exhaustive: never = envType;
      throw new M3LEnvironmentDetectionError(
        `Unhandled environment type: ${String(_exhaustive)}`,
        { code: "ERR_ENVIRONMENT_DETECTION" },
      );
    }
  }
}

/**
 * Result of the walk-up scan; either a found marker or the absent case.
 */
type WalkUpResult =
  | { readonly found: true; readonly root: string; readonly markerPath: string }
  | { readonly found: false };

/**
 * Returns `true` when the `package.json` at `pkgJsonPath` declares a
 * `workspaces` field. Returns `false` when the file cannot be read or
 * the JSON is malformed (OP-7: silent skip on parse failure).
 */
function packageJsonHasWorkspaces(pkgJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" && parsed !== null && "workspaces" in parsed
    );
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    ) {
      throw new M3LEnvironmentDetectionError(
        `Cannot read package.json during environment detection: ${pkgJsonPath}`,
        { code: "ERR_ENVIRONMENT_DETECTION", cause },
      );
    }
    // Malformed JSON, ENOENT, or other non-permission errors — silently skip per OP-7
    return false;
  }
}

/**
 * Walks up the directory tree from `startDir` looking for a workspace marker.
 *
 * - `pnpm-workspace.yaml` at a directory level — pnpm monorepo marker.
 * - `package.json` with a `workspaces` field — npm/yarn monorepo marker.
 *
 * Stops as soon as a marker is found, at the filesystem root, or after
 * inspecting {@link MAX_DIRECTORIES_CHECKED} directories to handle pathological cases.
 *
 * Throws {@link M3LEnvironmentDetectionError} when a directory is unreadable
 * (EACCES/EPERM), so the caller can surface permission failures cleanly.
 * Malformed `package.json` files are silently skipped (contract OP-7).
 */
function walkUpForWorkspaceMarker(startDir: string): WalkUpResult {
  let current = startDir;
  let steps = 0;

  while (steps < MAX_DIRECTORIES_CHECKED) {
    // Check for pnpm-workspace.yaml
    const pnpmMarker = path.join(current, "pnpm-workspace.yaml");
    if (fs.existsSync(pnpmMarker)) {
      return { found: true, root: current, markerPath: pnpmMarker };
    }

    // Check for package.json with workspaces field
    const pkgJsonPath = path.join(current, "package.json");
    if (fs.existsSync(pkgJsonPath) && packageJsonHasWorkspaces(pkgJsonPath)) {
      return { found: true, root: current, markerPath: pkgJsonPath };
    }

    // Ascend one level
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
    steps++;
  }

  return { found: false };
}

/** Error codes that are safe to ignore during the directory readability check. */
const IGNORABLE_DIR_ERRORS = new Set(["ENOENT"]);

/**
 * Checks whether the directory exists and is readable by attempting to list
 * its contents. Throws {@link M3LEnvironmentDetectionError} on any OS error
 * except ENOENT (which indicates the cwd was deleted mid-run, a safe-to-ignore
 * transient race). All other errors — EACCES, EPERM, EIO, EMFILE, ENOTDIR,
 * ELOOP, etc. — represent genuine system failures and are surfaced to the
 * caller.
 */
function assertDirReadable(dir: string): void {
  try {
    fs.readdirSync(dir);
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (!IGNORABLE_DIR_ERRORS.has(String(code))) {
      throw new M3LEnvironmentDetectionError(
        `Cannot read directory during environment detection: ${dir}`,
        { code: "ERR_ENVIRONMENT_DETECTION", cause },
      );
    }
    // ENOENT only: cwd may have been deleted mid-run; safe to ignore.
  }
}

/** Typed result variant for MONOREPO deployment mode. */
type MonorepoDetectionResult = {
  readonly deploymentMode: typeof M3LDeploymentMode.MONOREPO;
  readonly monorepoRoot: string;
  readonly workspaceMarkerPath: string | undefined;
};

/** Typed result variant for STANDALONE deployment mode. */
type StandaloneDetectionResult = {
  readonly deploymentMode: typeof M3LDeploymentMode.STANDALONE;
  readonly monorepoRoot: undefined;
  readonly workspaceMarkerPath: undefined;
};

/**
 * Performs the full monorepo deployment-mode detection, respecting the
 * `M3L_DEPLOYMENT_MODE` environment variable override.
 *
 * Returns a discriminated result so {@link runDetection} can construct a
 * well-typed {@link M3LExecutionEnvironmentInfo} union member.
 */
function detectDeploymentMode():
  MonorepoDetectionResult | StandaloneDetectionResult {
  const modeOverride = process.env["M3L_DEPLOYMENT_MODE"];

  // B10: standalone override — skip walk-up entirely
  if (
    typeof modeOverride === "string" &&
    modeOverride.toLowerCase() === "standalone"
  ) {
    return {
      deploymentMode: M3LDeploymentMode.STANDALONE,
      monorepoRoot: undefined,
      workspaceMarkerPath: undefined,
    };
  }

  const startDir = process.cwd();
  assertDirReadable(startDir);

  const walkResult = walkUpForWorkspaceMarker(startDir);

  // B10: monorepo override — walk result must confirm a workspace root exists
  if (
    typeof modeOverride === "string" &&
    modeOverride.toLowerCase() === "monorepo"
  ) {
    if (!walkResult.found) {
      throw new M3LEnvironmentDetectionError(
        "M3L_DEPLOYMENT_MODE=monorepo is set but no workspace marker (pnpm-workspace.yaml or package.json#workspaces) was found during walk-up",
        { code: "ERR_ENVIRONMENT_DETECTION" },
      );
    }
    return {
      deploymentMode: M3LDeploymentMode.MONOREPO,
      monorepoRoot: walkResult.root,
      workspaceMarkerPath: walkResult.markerPath,
    };
  }

  // Normal walk-up result
  if (walkResult.found) {
    return {
      deploymentMode: M3LDeploymentMode.MONOREPO,
      monorepoRoot: walkResult.root,
      workspaceMarkerPath: walkResult.markerPath,
    };
  }

  return {
    deploymentMode: M3LDeploymentMode.STANDALONE,
    monorepoRoot: undefined,
    workspaceMarkerPath: undefined,
  };
}

/**
 * Runs full synchronous detection and assembles the
 * {@link M3LExecutionEnvironmentInfo} object.
 */
function runDetection(): M3LExecutionEnvironmentInfo {
  const environmentType = classifyEnvironmentType();
  const credentialSource = resolveCredentialSource(environmentType);
  const isInteractive =
    environmentType === M3LExecutionEnvironmentType.LOCAL_INTERACTIVE;
  const isAWSManaged =
    environmentType === M3LExecutionEnvironmentType.AWS_LAMBDA ||
    environmentType === M3LExecutionEnvironmentType.AWS_ECS ||
    environmentType === M3LExecutionEnvironmentType.AWS_EC2 ||
    environmentType === M3LExecutionEnvironmentType.AWS_CODEBUILD;
  const canOpenBrowser = isInteractive;
  const canPromptUser = isInteractive && process.stdin.isTTY === true;
  const requiresAwsProfile =
    credentialSource === M3LCredentialSource.SSO_PROFILE;

  const deploymentResult = detectDeploymentMode();

  const detectionDetails: M3LEnvironmentDetectionDetails = {
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    isCiEnvironment: detectIsCiEnvironment(),
    hasLambdaTaskRoot: isNonEmpty(process.env["AWS_LAMBDA_TASK_ROOT"]),
    hasEcsMetadataUri:
      isNonEmpty(process.env["ECS_CONTAINER_METADATA_URI_V4"]) ||
      isNonEmpty(process.env["ECS_CONTAINER_METADATA_URI"]),
    hasCodeBuildBuildId: isNonEmpty(process.env["CODEBUILD_BUILD_ID"]),
    workspaceMarkerPath: deploymentResult.workspaceMarkerPath,
  };

  const base: M3LExecutionEnvironmentInfoBase = {
    environmentType,
    isInteractive,
    isAWSManaged,
    canPromptUser,
    canOpenBrowser,
    requiresAwsProfile,
    credentialSource,
    detectionDetails,
  };

  const { workspaceMarkerPath: _wmp, ...deploymentFields } = deploymentResult;
  return { ...base, ...deploymentFields };
}

// ---------------------------------------------------------------------------
// Module-level cache (B7 — no side effects at import time)
// ---------------------------------------------------------------------------

/** Process-global singleton; populated lazily on first call to `detect()`. */
let cached: M3LExecutionEnvironmentInfo | undefined;

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Static-only façade that provides synchronous, cached detection of the
 * execution environment.
 *
 * Detection inspects `process.env`, `process.stdout.isTTY`, and the
 * filesystem (walk-up from `process.cwd()`) to classify the runtime into one
 * of the {@link M3LExecutionEnvironmentType} values and derive a rich
 * {@link M3LExecutionEnvironmentInfo} snapshot.
 *
 * Results are stored as a process-global singleton; subsequent calls to
 * {@link M3LExecutionEnvironment.detect} are O(1). Use
 * {@link M3LExecutionEnvironment.detectFresh} to discard the cache — essential
 * in tests that change `process.env` between assertions, and in long-lived
 * processes where the environment may change.
 *
 * @example
 * ```ts
 * import {
 *   M3LExecutionEnvironment,
 *   M3LExecutionEnvironmentType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const info = M3LExecutionEnvironment.detect();
 * if (info.environmentType === M3LExecutionEnvironmentType.CI) {
 *   // disable interactive features
 * }
 * ```
 */
export class M3LExecutionEnvironment {
  /** Prevent instantiation — all methods are static. */
  private constructor() {
    // static-only class
  }

  /**
   * Returns the cached {@link M3LExecutionEnvironmentInfo} for the current
   * process. Runs detection on the first call; subsequent calls return the
   * same object reference (B1).
   *
   * @returns The cached detection result.
   *
   * @example
   * ```ts
   * import { M3LExecutionEnvironment } from "@m3l-automation/m3l-common/core";
   *
   * const info = M3LExecutionEnvironment.detect();
   * console.log(info.environmentType);
   * ```
   */
  static detect(): M3LExecutionEnvironmentInfo {
    if (cached === undefined) {
      cached = runDetection();
    }
    return cached;
  }

  /**
   * Discards the cached detection result, re-runs detection, stores the new
   * result, and returns it (B2).
   *
   * Use this in tests after modifying `process.env`, or in long-lived
   * processes that detect environment transitions.
   *
   * @returns A freshly computed {@link M3LExecutionEnvironmentInfo}.
   *
   * @example
   * ```ts
   * import { M3LExecutionEnvironment } from "@m3l-automation/m3l-common/core";
   *
   * process.env["CI"] = "true";
   * const fresh = M3LExecutionEnvironment.detectFresh();
   * console.log(fresh.environmentType); // "CI"
   * ```
   */
  static detectFresh(): M3LExecutionEnvironmentInfo {
    cached = runDetection();
    return cached;
  }

  /**
   * Convenience shortcut; equivalent to `M3LExecutionEnvironment.detect().isInteractive`.
   *
   * Returns `true` when the process is running in a local interactive terminal
   * (stdout attached to a TTY, no CI or AWS signals).
   *
   * @returns `true` when the environment is {@link M3LExecutionEnvironmentType.LOCAL_INTERACTIVE}.
   *
   * @example
   * ```ts
   * import { M3LExecutionEnvironment } from "@m3l-automation/m3l-common/core";
   *
   * if (M3LExecutionEnvironment.isInteractive()) {
   *   // show progress spinner
   * }
   * ```
   */
  static isInteractive(): boolean {
    return M3LExecutionEnvironment.detect().isInteractive;
  }

  /**
   * Clears the cached detection result without running detection.
   *
   * Prefer this over {@link detectFresh} in `beforeEach` test hooks where
   * the purpose is cache invalidation only — each test's own `detectFresh()`
   * call runs with mocks already installed, avoiding real filesystem I/O in
   * the shared hook.
   *
   * @example
   * ```ts
   * import { M3LExecutionEnvironment } from "@m3l-automation/m3l-common/core";
   *
   * beforeEach(() => {
   *   M3LExecutionEnvironment.resetForTesting();
   * });
   * ```
   */
  static resetForTesting(): void {
    cached = undefined;
  }
}

// ---------------------------------------------------------------------------
// Value alias
// ---------------------------------------------------------------------------

/**
 * Convenience alias for {@link M3LExecutionEnvironment}.
 *
 * Both names refer to the same class and share the same process-global
 * singleton cache. Prefer `M3LEnv` in application code for brevity; use
 * the full name in library code to keep intent explicit.
 *
 * @example
 * ```ts
 * import { M3LEnv } from "@m3l-automation/m3l-common/core";
 *
 * if (M3LEnv.isInteractive()) {
 *   // show progress spinner
 * }
 * ```
 */
export const M3LEnv = M3LExecutionEnvironment;
