/**
 * `core/utils/M3LPaths` — canonical directory-path resolver for automation scripts.
 *
 * Computes the standard `data/`, `config/`, `input/`, `output/`, and `cache/`
 * directory paths by anchoring them to the monorepo root (MONOREPO mode) or to
 * `process.cwd()` / `M3L_BASE_DIR` (STANDALONE mode). All paths are snapshotted
 * at construction time and can be overridden individually via per-kind environment
 * variables — no filesystem I/O is performed.
 *
 * @packageDocumentation
 */

import * as path from "node:path";

import { M3LError } from "../errors/index.js";
import {
  M3LDeploymentMode,
  M3LExecutionEnvironment,
} from "../environment/index.js";

// ---------------------------------------------------------------------------
// M3LPathType
// ---------------------------------------------------------------------------

/**
 * The five standard directory kinds managed by {@link M3LPaths}.
 *
 * Each kind maps to a getter on the {@link M3LPaths} class and can be
 * overridden independently via a per-kind environment variable.
 *
 * @example
 * ```ts
 * import type { M3LPathType } from "@m3l-automation/m3l-common/core";
 *
 * function label(kind: M3LPathType): string {
 *   return `directory kind: ${kind}`;
 * }
 * ```
 */
export type M3LPathType = "data" | "config" | "input" | "output" | "cache";

// ---------------------------------------------------------------------------
// M3LPathEnvironmentVariables
// ---------------------------------------------------------------------------

/**
 * The environment variable names that {@link M3LPaths} reads at construction
 * time to override default path resolution.
 *
 * The object doubles as a namespace (for `M3LPathEnvironmentVariables.DATA_DIR`)
 * and the companion `type` is the union of all seven string literals (for
 * narrowing a received variable name).
 *
 * @example
 * ```ts
 * import { M3LPathEnvironmentVariables } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3LPathEnvironmentVariables.DATA_DIR); // "M3L_DATA_DIR"
 * ```
 */
export const M3LPathEnvironmentVariables = {
  /** Overrides the computed data directory. */
  DATA_DIR: "M3L_DATA_DIR",
  /** Overrides the computed config directory. */
  CONFIG_DIR: "M3L_CONFIG_DIR",
  /** Overrides the computed input directory. */
  INPUT_DIR: "M3L_INPUT_DIR",
  /** Overrides the computed output directory. */
  OUTPUT_DIR: "M3L_OUTPUT_DIR",
  /** Overrides the computed cache directory. */
  CACHE_DIR: "M3L_CACHE_DIR",
  /** Overrides the standalone base directory (STANDALONE mode only). */
  BASE_DIR: "M3L_BASE_DIR",
  /** Forces a specific deployment mode (`"standalone"` or `"monorepo"`). */
  DEPLOYMENT_MODE: "M3L_DEPLOYMENT_MODE",
} as const;

/**
 * Union of all {@link M3LPathEnvironmentVariables} value strings.
 *
 * @example
 * ```ts
 * import type { M3LPathEnvironmentVariables } from "@m3l-automation/m3l-common/core";
 *
 * function isPathVar(v: string): v is M3LPathEnvironmentVariables {
 *   return Object.values({ DATA_DIR: "M3L_DATA_DIR" }).includes(v);
 * }
 * ```
 */
export type M3LPathEnvironmentVariables =
  (typeof M3LPathEnvironmentVariables)[keyof typeof M3LPathEnvironmentVariables];

// ---------------------------------------------------------------------------
// M3LPathResolutionError
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link M3LPathResolutionError}.
 *
 * `cause` is optional; the error code is always `"ERR_PATH_RESOLUTION"` and
 * is set automatically — callers must not supply it.
 */
interface M3LPathResolutionErrorOptions {
  /** The underlying error that triggered the resolution failure. */
  readonly cause?: unknown;
}

/**
 * Thrown when {@link M3LPaths} cannot resolve a requested directory path.
 *
 * The most common case is calling {@link M3LPaths.getProjectRoot} while running
 * in STANDALONE mode, where no monorepo root is available.
 *
 * @example
 * ```ts
 * import {
 *   M3LPaths,
 *   M3LPathResolutionError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   const paths = new M3LPaths();
 *   const root = paths.getProjectRoot();
 * } catch (e) {
 *   if (e instanceof M3LPathResolutionError) {
 *     // getProjectRoot() is unavailable in standalone mode
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LPathResolutionError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_PATH_RESOLUTION"`. */
  override readonly code: "ERR_PATH_RESOLUTION";

  /**
   * Creates a new `M3LPathResolutionError`.
   *
   * @param message - Human-readable description of the resolution failure.
   * @param options - Optional options bag; `cause` carries the underlying error.
   *   The error code is always `"ERR_PATH_RESOLUTION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LPathResolutionErrorOptions) {
    super(message, { code: "ERR_PATH_RESOLUTION", cause: options?.cause });
    this.code = "ERR_PATH_RESOLUTION";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the environment variable value when it is a non-empty string,
 * otherwise returns `undefined`. Used to test per-kind overrides.
 */
function readEnvOverride(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Derives the standalone base directory from `M3L_BASE_DIR` (when set) or
 * `process.cwd()`.
 */
function resolveStandaloneBase(): string {
  return readEnvOverride(M3LPathEnvironmentVariables.BASE_DIR) ?? process.cwd();
}

// ---------------------------------------------------------------------------
// M3LPaths
// ---------------------------------------------------------------------------

/**
 * Resolves the canonical data-directory tree for the current execution context.
 *
 * On construction, {@link M3LExecutionEnvironment.detect} is called once and
 * all relevant environment variables are snapshotted. Subsequent calls to the
 * getters are O(1) path-join operations with no I/O.
 *
 * **Path layout**
 *
 * | Getter | Default (MONOREPO) | Default (STANDALONE) |
 * |---|---|---|
 * | `getDataDir()` | `<monorepoRoot>/data` | `<base>/data` |
 * | `getConfigDir()` | `<monorepoRoot>/data/config` | `<base>/data/config` |
 * | `getInputDir()` | `<monorepoRoot>/data/input` | `<base>/data/input` |
 * | `getOutputDir()` | `<monorepoRoot>/data/output` | `<base>/data/output` |
 * | `getCacheDir()` | `<monorepoRoot>/data/cache` | `<base>/data/cache` |
 * | `getProjectRoot()` | `<monorepoRoot>` | throws {@link M3LPathResolutionError} |
 *
 * The standalone `<base>` is `M3L_BASE_DIR` when set, otherwise `process.cwd()`.
 *
 * Each getter also respects its own per-kind override environment variable
 * (`M3L_DATA_DIR`, `M3L_CONFIG_DIR`, etc.), snapshotted at construction time.
 *
 * @example
 * ```ts
 * import { M3LPaths } from "@m3l-automation/m3l-common/core";
 *
 * const paths = new M3LPaths();
 * console.log(paths.getDataDir());   // e.g. "/workspace/data"
 * console.log(paths.getConfigDir()); // e.g. "/workspace/data/config"
 * ```
 */
export class M3LPaths {
  /** Resolved base directory (monorepo root or standalone base). */
  private readonly base: string;

  /** Monorepo root, present only in MONOREPO mode. */
  private readonly monorepoRoot: string | undefined;

  /** Deployment mode snapshotted at construction time. */
  private readonly deploymentMode: string;

  /** Resolved data directory (override or computed). */
  private readonly dataDir: string;

  /** Resolved config directory (override or computed). */
  private readonly configDir: string;

  /** Resolved input directory (override or computed). */
  private readonly inputDir: string;

  /** Resolved output directory (override or computed). */
  private readonly outputDir: string;

  /** Resolved cache directory (override or computed). */
  private readonly cacheDir: string;

  /**
   * Creates a new `M3LPaths` instance.
   *
   * Calls {@link M3LExecutionEnvironment.detect} and snapshots all path-related
   * environment variables. No filesystem I/O is performed.
   *
   * @example
   * ```ts
   * import { M3LPaths } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * ```
   */
  constructor() {
    const info = M3LExecutionEnvironment.detect();
    this.deploymentMode = info.deploymentMode;

    if (info.deploymentMode === M3LDeploymentMode.MONOREPO) {
      this.monorepoRoot = info.monorepoRoot;
      this.base = info.monorepoRoot;
    } else {
      this.monorepoRoot = undefined;
      this.base = resolveStandaloneBase();
    }

    // Snapshot all per-kind overrides at construction time so getters are O(1).
    this.dataDir =
      readEnvOverride(M3LPathEnvironmentVariables.DATA_DIR) ??
      path.join(this.base, "data");
    this.configDir =
      readEnvOverride(M3LPathEnvironmentVariables.CONFIG_DIR) ??
      path.join(this.base, "data", "config");
    this.inputDir =
      readEnvOverride(M3LPathEnvironmentVariables.INPUT_DIR) ??
      path.join(this.base, "data", "input");
    this.outputDir =
      readEnvOverride(M3LPathEnvironmentVariables.OUTPUT_DIR) ??
      path.join(this.base, "data", "output");
    this.cacheDir =
      readEnvOverride(M3LPathEnvironmentVariables.CACHE_DIR) ??
      path.join(this.base, "data", "cache");
  }

  /**
   * Returns the absolute path to the data root directory.
   *
   * Defaults to `<base>/data`; overridden by the `M3L_DATA_DIR` environment
   * variable (snapshotted at construction time).
   *
   * @returns Absolute path to the data directory.
   *
   * @example
   * ```ts
   * import { M3LPaths } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * console.log(paths.getDataDir()); // e.g. "/workspace/data"
   * ```
   */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Returns the absolute path to the configuration directory.
   *
   * Defaults to `<base>/data/config`; overridden by the `M3L_CONFIG_DIR`
   * environment variable (snapshotted at construction time).
   *
   * @returns Absolute path to the config directory.
   *
   * @example
   * ```ts
   * import { M3LPaths } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * console.log(paths.getConfigDir()); // e.g. "/workspace/data/config"
   * ```
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Returns the absolute path to the input directory.
   *
   * Defaults to `<base>/data/input`; overridden by the `M3L_INPUT_DIR`
   * environment variable (snapshotted at construction time).
   *
   * @returns Absolute path to the input directory.
   *
   * @example
   * ```ts
   * import { M3LPaths } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * console.log(paths.getInputDir()); // e.g. "/workspace/data/input"
   * ```
   */
  getInputDir(): string {
    return this.inputDir;
  }

  /**
   * Returns the absolute path to the output directory.
   *
   * Defaults to `<base>/data/output`; overridden by the `M3L_OUTPUT_DIR`
   * environment variable (snapshotted at construction time).
   *
   * @returns Absolute path to the output directory.
   *
   * @example
   * ```ts
   * import { M3LPaths } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * console.log(paths.getOutputDir()); // e.g. "/workspace/data/output"
   * ```
   */
  getOutputDir(): string {
    return this.outputDir;
  }

  /**
   * Returns the absolute path to the cache directory.
   *
   * Defaults to `<base>/data/cache`; overridden by the `M3L_CACHE_DIR`
   * environment variable (snapshotted at construction time).
   *
   * @returns Absolute path to the cache directory.
   *
   * @example
   * ```ts
   * import { M3LPaths } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * console.log(paths.getCacheDir()); // e.g. "/workspace/data/cache"
   * ```
   */
  getCacheDir(): string {
    return this.cacheDir;
  }

  /**
   * Returns the absolute path to the monorepo/project root.
   *
   * Available only in MONOREPO mode. Throws {@link M3LPathResolutionError} in
   * STANDALONE mode because no single project root can be determined without
   * a workspace marker.
   *
   * @returns Absolute path to the project root (monorepo root).
   * @throws {@link M3LPathResolutionError} When called in STANDALONE mode.
   *
   * @example
   * ```ts
   * import {
   *   M3LPaths,
   *   M3LPathResolutionError,
   * } from "@m3l-automation/m3l-common/core";
   *
   * const paths = new M3LPaths();
   * try {
   *   console.log(paths.getProjectRoot());
   * } catch (e) {
   *   if (e instanceof M3LPathResolutionError) {
   *     // running in standalone mode — project root is unavailable
   *   }
   * }
   * ```
   */
  getProjectRoot(): string {
    if (this.deploymentMode === M3LDeploymentMode.MONOREPO) {
      // In MONOREPO mode monorepoRoot is always a string — the discriminated
      // union on M3LExecutionEnvironmentInfo guarantees this. We checked
      // deploymentMode above, so the assignment in the constructor always set
      // this.monorepoRoot to a non-undefined string. The explicit check
      // below keeps the return type narrowed without a non-null assertion.
      const root = this.monorepoRoot;
      if (root !== undefined) {
        return root;
      }
    }
    throw new M3LPathResolutionError(
      "getProjectRoot() is unavailable in standalone mode: no monorepo workspace marker was found",
    );
  }
}
