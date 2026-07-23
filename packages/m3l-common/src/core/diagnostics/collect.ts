/**
 * `core/diagnostics/collect` — a best-effort snapshot of the process/runtime
 * environment, paths, and config fingerprint, redacted by construction.
 *
 * Every section is collected independently: a section whose collection
 * throws (e.g. `new M3LPaths()` throwing {@link M3LPathResolutionError}, or
 * `M3LExecutionEnvironment.detect()` throwing) is simply omitted from the
 * snapshot, never partially filled. {@link collectDiagnostics} itself never
 * throws.
 *
 * @packageDocumentation
 */

import type {
  M3LCredentialSource,
  M3LExecutionEnvironmentInfo,
  M3LExecutionEnvironmentType,
} from "../environment/index.js";
import {
  M3LDeploymentMode,
  M3LExecutionEnvironment,
} from "../environment/index.js";
import { M3LPaths } from "../utils/index.js";

import { readPackageVersion } from "../../internal/diagnostics/packageVersion.js";
import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";

// ---------------------------------------------------------------------------
// Config ports — satisfied structurally by `M3LConfigSchema`/`M3LConfig` with
// zero adaptation. `core/diagnostics` must never import `core/config`
// directly (Zone B, ADR-0009): these ports exist precisely so this module
// can consume a schema/config without depending on the `core/script`-facing
// concrete classes.
// ---------------------------------------------------------------------------

/**
 * The minimal shape {@link collectDiagnostics} needs from a config schema:
 * enumerating every declared parameter name (and alias).
 *
 * A real `M3LConfigSchema` satisfies this structurally.
 *
 * @example
 * ```ts
 * import type { M3LConfigSchemaPort } from "@m3l-automation/m3l-common/core";
 *
 * const schema: M3LConfigSchemaPort = {
 *   declaredNames: () => ["apiKey", "region"],
 * };
 * ```
 */
export interface M3LConfigSchemaPort {
  /** Returns every declared parameter name, including aliases. */
  declaredNames(): readonly string[];
}

/**
 * The minimal shape {@link collectDiagnostics} needs from a resolved config:
 * looking up which source supplied a given parameter's value, without
 * exposing the value itself.
 *
 * A real `M3LConfig` satisfies this structurally.
 *
 * @example
 * ```ts
 * import type { M3LConfigSourcePort } from "@m3l-automation/m3l-common/core";
 *
 * const config: M3LConfigSourcePort = {
 *   sourceOf: (name) => (name === "apiKey" ? "environment-variable" : undefined),
 * };
 * ```
 */
export interface M3LConfigSourcePort {
  /** Returns the source that supplied `name`'s value, or `undefined` if unset. */
  sourceOf(name: string): string | undefined;
}

/**
 * The minimal shape {@link collectDiagnostics} needs from a paths resolver:
 * the five standard directory getters. A real `M3LPaths` satisfies this
 * structurally.
 *
 * @example
 * ```ts
 * import type { M3LPathsPort } from "@m3l-automation/m3l-common/core";
 *
 * const paths: M3LPathsPort = {
 *   getDataDir: () => "/data",
 *   getConfigDir: () => "/data/config",
 *   getInputDir: () => "/data/input",
 *   getOutputDir: () => "/data/output",
 *   getCacheDir: () => "/data/cache",
 * };
 * ```
 */
export interface M3LPathsPort {
  /** The data root directory. */
  getDataDir(): string;
  /** The configuration directory. */
  getConfigDir(): string;
  /** The input directory. */
  getInputDir(): string;
  /** The output directory. */
  getOutputDir(): string;
  /** The cache directory. */
  getCacheDir(): string;
}

/**
 * One entry in the config fingerprint: a declared parameter's name and the
 * source that supplied its value — **never** the value itself. The
 * redaction here is structural: this type has no `value` field at all.
 *
 * **The `value?: never` field below is a compile-time guard only — it is
 * erased at runtime and does not, by itself, stop a value from reaching a
 * persisted snapshot.** It only blocks *type-level* pass-through (excess-property
 * checking rejects a fresh object literal that adds a `value` key); a cast, a
 * widened variable, or a hostile/buggy {@link M3LConfigSourcePort} at runtime
 * is not caught by the type at all. The actual enforcement is the runtime
 * projection in this module: every entry is built as a fresh `{ name, source }`
 * literal (never a spread of a caller-supplied object), and `source` is
 * validated to look like a short label before being stored — see
 * `sanitizeSourceLabel` in this file. Do not assume the type alone is
 * sufficient; it isn't.
 *
 * @example
 * ```ts
 * import type { M3LConfigFingerprintEntry } from "@m3l-automation/m3l-common/core";
 *
 * const entry: M3LConfigFingerprintEntry = { name: "apiKey", source: "cli" };
 * ```
 */
export interface M3LConfigFingerprintEntry {
  /** The declared parameter name (or alias). */
  readonly name: string;
  /** The source that supplied this parameter's value, or `undefined` if unset. */
  readonly source: string | undefined;
  /**
   * Always absent. Present in the type solely to make a config *value*
   * structurally unrepresentable: without it, excess-property checking
   * protects only fresh object literals, so a widened object carrying a
   * `value` could be assigned in and reach the persisted run report. This is
   * a compile-time-only guard — see the interface-level note above for what
   * actually enforces it at runtime.
   */
  readonly value?: never;
}

// ---------------------------------------------------------------------------
// M3LDiagnosticsEnvironment — mirrors M3LExecutionEnvironmentInfo, minus
// `detectionDetails` (a raw, unredacted env-signal blob deliberately not
// embedded in a diagnostics snapshot).
// ---------------------------------------------------------------------------

/** Fields shared by both `deploymentMode` branches of {@link M3LDiagnosticsEnvironment}. */
interface M3LDiagnosticsEnvironmentBase {
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
  readonly credentialSource: Exclude<M3LCredentialSource, "NONE">;
}

/**
 * A diagnostics-safe projection of `M3LExecutionEnvironmentInfo`, omitting
 * its raw `detectionDetails` signal blob. Discriminated on `deploymentMode`,
 * exactly like the source type: narrowing to `"MONOREPO"` narrows
 * `monorepoRoot` to `string`; narrowing to `"STANDALONE"` narrows it to
 * `undefined`.
 *
 * @example
 * ```ts
 * import type { M3LDiagnosticsEnvironment } from "@m3l-automation/m3l-common/core";
 *
 * function describe(env: M3LDiagnosticsEnvironment): string {
 *   return env.deploymentMode === "MONOREPO" ? env.monorepoRoot : "standalone";
 * }
 * ```
 */
export type M3LDiagnosticsEnvironment = M3LDiagnosticsEnvironmentBase &
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

/** Projects an `M3LExecutionEnvironmentInfo` into its diagnostics-safe form. */
function toDiagnosticsEnvironment(
  info: M3LExecutionEnvironmentInfo,
): M3LDiagnosticsEnvironment {
  const shared: M3LDiagnosticsEnvironmentBase = {
    environmentType: info.environmentType,
    isInteractive: info.isInteractive,
    isAWSManaged: info.isAWSManaged,
    canPromptUser: info.canPromptUser,
    canOpenBrowser: info.canOpenBrowser,
    requiresAwsProfile: info.requiresAwsProfile,
    credentialSource: info.credentialSource,
  };
  if (info.deploymentMode === M3LDeploymentMode.MONOREPO) {
    return {
      ...shared,
      deploymentMode: info.deploymentMode,
      monorepoRoot: info.monorepoRoot,
    };
  }
  return {
    ...shared,
    deploymentMode: info.deploymentMode,
    monorepoRoot: info.monorepoRoot,
  };
}

// ---------------------------------------------------------------------------
// M3LDiagnosticsPaths / M3LDiagnosticsSnapshot / M3LCollectDiagnosticsOptions
// ---------------------------------------------------------------------------

/**
 * The five standard directories, as read from an injected
 * {@link M3LPathsPort} (or a lazily-constructed real `M3LPaths`).
 *
 * @example
 * ```ts
 * import type { M3LDiagnosticsPaths } from "@m3l-automation/m3l-common/core";
 *
 * const paths: M3LDiagnosticsPaths = {
 *   dataDir: "/data",
 *   configDir: "/data/config",
 *   inputDir: "/data/input",
 *   outputDir: "/data/output",
 *   cacheDir: "/data/cache",
 * };
 * ```
 */
export interface M3LDiagnosticsPaths {
  /** The data root directory. */
  readonly dataDir: string;
  /** The configuration directory. */
  readonly configDir: string;
  /** The input directory. */
  readonly inputDir: string;
  /** The output directory. */
  readonly outputDir: string;
  /** The cache directory. */
  readonly cacheDir: string;
}

/**
 * A best-effort snapshot of the process/runtime environment, produced by
 * {@link collectDiagnostics}. Every optional section is present only when
 * its collection succeeded.
 *
 * @example
 * ```ts
 * import { collectDiagnostics } from "@m3l-automation/m3l-common/core";
 *
 * const snapshot = collectDiagnostics({ correlationId: "run-42" });
 * console.log(snapshot.packageVersion, snapshot.nodeVersion);
 * ```
 */
export interface M3LDiagnosticsSnapshot {
  /** ISO-8601 timestamp captured when the snapshot was produced. */
  readonly capturedAt: string;
  /** The library's own declared package version, or `"unknown"` on failure. */
  readonly packageVersion: string;
  /** `process.version`. */
  readonly nodeVersion: string;
  /** `process.platform`. */
  readonly platform: string;
  /** `process.arch`. */
  readonly arch: string;
  /** The detected execution environment, omitted if detection threw. */
  readonly environment?: M3LDiagnosticsEnvironment;
  /** The five standard directories, omitted if resolution threw. */
  readonly paths?: M3LDiagnosticsPaths;
  /** The caller-supplied correlation id, echoed verbatim when provided. */
  readonly correlationId?: string;
  /** The config fingerprint (names + sources only), present only with a `schema` port. */
  readonly config?: readonly M3LConfigFingerprintEntry[];
}

/**
 * Options for {@link collectDiagnostics}.
 *
 * @example
 * ```ts
 * import type { M3LCollectDiagnosticsOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LCollectDiagnosticsOptions = { correlationId: "run-42" };
 * ```
 */
export interface M3LCollectDiagnosticsOptions {
  /** A config schema port; without it, `config` is omitted entirely. */
  readonly schema?: M3LConfigSchemaPort;
  /** A config source port; without it, every fingerprint entry's `source` is `undefined`. */
  readonly config?: M3LConfigSourcePort;
  /** A paths port; without it, a real `M3LPaths` is constructed lazily. */
  readonly paths?: M3LPathsPort;
  /** A caller-supplied correlation id, echoed verbatim onto the snapshot. */
  readonly correlationId?: string;
}

// ---------------------------------------------------------------------------
// Section collectors — each independently guarded so one failing section
// never prevents the others from populating.
// ---------------------------------------------------------------------------

/** Collects the environment section, or `undefined` if detection throws. */
function tryCollectEnvironment(): M3LDiagnosticsEnvironment | undefined {
  try {
    return toDiagnosticsEnvironment(M3LExecutionEnvironment.detect());
  } catch {
    return undefined;
  }
}

/**
 * Collects the paths section from `port`, or from a lazily-constructed real
 * `M3LPaths` when no port was injected. Returns `undefined` if resolution
 * throws (e.g. a hostile port, or `M3LPathResolutionError`).
 */
function tryCollectPaths(
  port: M3LPathsPort | undefined,
): M3LDiagnosticsPaths | undefined {
  try {
    const resolved = port ?? new M3LPaths();
    return {
      dataDir: resolved.getDataDir(),
      configDir: resolved.getConfigDir(),
      inputDir: resolved.getInputDir(),
      outputDir: resolved.getOutputDir(),
      cacheDir: resolved.getCacheDir(),
    };
  } catch {
    return undefined;
  }
}

/**
 * The longest string tolerated as a config source *label*. Every label this
 * library itself produces (`"cli"`, `"environment-variable"`, `"json-file"`,
 * ...) is well under this bound; a value this long is treated as implausible
 * for a label and rejected.
 */
const MAX_SOURCE_LABEL_LENGTH = 32;

/**
 * The shape of a plausible source label: one or more lowercase words joined
 * by single hyphens, matching every label this library itself produces
 * (`"cli"`, `"environment-variable"`, `"json-file"`). No digits, uppercase,
 * or other punctuation — the kind of characters an actual secret/token value
 * (mixed case, digits, base64/JWT punctuation) would almost always contain.
 */
const SOURCE_LABEL_PATTERN = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * Validates that `raw` — a {@link M3LConfigSourcePort.sourceOf} return value
 * — is a plausible source *label* rather than a smuggled config *value*.
 *
 * This is the runtime enforcement that backs
 * {@link M3LConfigFingerprintEntry}'s `value?: never` field: that field is a
 * compile-time-only guard, erased at runtime, so a hostile or buggy port
 * could return the config value itself where a source label is expected.
 * Anything that isn't a short, lowercase, hyphenated identifier is rejected
 * outright — **never truncated**, since a truncated secret is still a leaked
 * secret — and the caller falls back to `undefined`.
 *
 * `raw` is accepted as `unknown` (not the port's declared return type of
 * `string | undefined`) because a hostile/misbehaving port is exactly the
 * threat this function defends against; trusting the static type here would
 * defeat the purpose.
 */
function sanitizeSourceLabel(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > MAX_SOURCE_LABEL_LENGTH) {
    return undefined;
  }
  return SOURCE_LABEL_PATTERN.test(raw) ? raw : undefined;
}

/**
 * Reads `name`'s source from `port`, tolerating a throwing port and
 * sanitizing the result through {@link sanitizeSourceLabel} so an
 * implausible (i.e. potentially secret-shaped) return value is never stored.
 */
function readSourceOf(
  port: M3LConfigSourcePort | undefined,
  name: string,
): string | undefined {
  if (port === undefined) return undefined;
  try {
    return sanitizeSourceLabel(port.sourceOf(name));
  } catch {
    return undefined;
  }
}

/**
 * Builds a single fingerprint entry as a fresh object literal (name and
 * source, and nothing else). This is deliberate, not incidental: it is the
 * other half of the runtime enforcement behind
 * {@link M3LConfigFingerprintEntry}'s `value?: never` field. A type-level
 * guard cannot stop a widened or cast object from being spread in at
 * runtime, so this function never spreads or passes through a caller/port-
 * supplied object — every entry is constructed field-by-field here.
 */
function buildFingerprintEntry(
  name: string,
  config: M3LConfigSourcePort | undefined,
): M3LConfigFingerprintEntry {
  return { name, source: readSourceOf(config, name) };
}

/**
 * Reduces a thrown value from `schema.declaredNames()` to the shape
 * {@link logBestEffortDiagnostic} accepts. Guarded independently of its
 * caller's `catch` so a hostile `toString()` on a non-`Error` thrown value
 * cannot itself escape unswallowed.
 */
function describeConfigSchemaFailure(cause: unknown): { message: string } {
  if (cause instanceof Error) return { message: cause.message };
  try {
    return { message: String(cause) };
  } catch {
    return { message: "[unrepresentable config schema error]" };
  }
}

/**
 * Collects the config fingerprint from `schema`/`config`. Without a
 * `schema` port, `config` is omitted entirely — a config port alone cannot
 * enumerate parameter names, and there is nothing to diagnose. When a
 * `schema` port *is* supplied but `declaredNames()` throws, that is a real
 * bug (not merely "no schema wired") and is routed to
 * {@link logBestEffortDiagnostic} before `config` is still omitted from the
 * snapshot.
 */
function tryCollectConfig(
  schema: M3LConfigSchemaPort | undefined,
  config: M3LConfigSourcePort | undefined,
): readonly M3LConfigFingerprintEntry[] | undefined {
  if (schema === undefined) return undefined;
  try {
    return schema
      .declaredNames()
      .map((name) => buildFingerprintEntry(name, config));
  } catch (cause) {
    logBestEffortDiagnostic(
      "collectDiagnostics.config",
      describeConfigSchemaFailure(cause),
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// collectDiagnostics
// ---------------------------------------------------------------------------

/**
 * Produces a best-effort {@link M3LDiagnosticsSnapshot} of the current
 * process/runtime environment.
 *
 * Never throws: each section (environment, paths, config) is collected
 * independently, and a section whose collection fails is simply omitted
 * from the result — never partially filled.
 *
 * @param options - Optional injected ports and a correlation id.
 * @returns The best-effort snapshot.
 *
 * @example
 * ```ts
 * import { collectDiagnostics } from "@m3l-automation/m3l-common/core";
 *
 * const snapshot = collectDiagnostics({ correlationId: "run-42" });
 * console.log(snapshot.nodeVersion, snapshot.platform);
 * ```
 */
export function collectDiagnostics(
  options: M3LCollectDiagnosticsOptions = {},
): M3LDiagnosticsSnapshot {
  const environment = tryCollectEnvironment();
  const paths = tryCollectPaths(options.paths);
  const config = tryCollectConfig(options.schema, options.config);

  return {
    capturedAt: new Date().toISOString(),
    packageVersion: readPackageVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    ...(environment !== undefined && { environment }),
    ...(paths !== undefined && { paths }),
    ...(options.correlationId !== undefined && {
      correlationId: options.correlationId,
    }),
    ...(config !== undefined && { config }),
  };
}
