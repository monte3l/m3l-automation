/**
 * `config/paths` — resolves the console server's embedded-store database
 * path (ADR-0069). Pure path computation: this module never touches the
 * filesystem. Directory creation is the store's open step's job, not the
 * config layer's.
 *
 * @packageDocumentation
 */

import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/** The single error code every rejection in this module raises. */
const CODE = "ERR_CONSOLE_CONFIG_INVALID";

/** Dotted config key named in every rejection message. */
const DB_PATH_KEY = "m3l.console.db.path";

/** The path segments appended to the data dir for the default database path. */
const DEFAULT_DB_RELATIVE_SEGMENTS = ["console", "console.sqlite"] as const;

/** Dotted config key named in every session-artifact-root rejection message. */
const ARTIFACT_ROOT_KEY = "m3l.console.sessions.artifact.root";

/** The path segments appended to the data dir for the default session artifact root. */
const DEFAULT_ARTIFACT_ROOT_RELATIVE_SEGMENTS = [
  "console",
  "artifacts",
] as const;

/** Dotted config key named in every human-action-audit-root rejection message. */
const AUDIT_ROOT_KEY = "m3l.console.audit.root";

/**
 * The path segments appended to the data dir for the default human-action
 * audit root (X7 slice 3, ADR-0070). A SIBLING of the session artifact root,
 * never a child: the artifact store owns everything beneath its own root, and
 * an audit trail may not live inside a directory another subsystem prunes.
 */
const DEFAULT_AUDIT_ROOT_RELATIVE_SEGMENTS = ["console", "audit"] as const;

/** Dotted config key named in every runs-output-root rejection message. */
const RUNS_OUTPUT_ROOT_KEY = "m3l.console.runs.output.root";

/**
 * The path segments appended to the data dir for the default runs output root
 * (X7d, ADR-0070). A SIBLING of the artifact and audit roots, for the same
 * reason each of those is a sibling of the others: a spawned script owns
 * everything beneath its own per-run directory, and neither an artifact store
 * nor an audit trail may live inside a tree another subsystem writes into.
 */
const DEFAULT_RUNS_OUTPUT_ROOT_RELATIVE_SEGMENTS = ["console", "runs"] as const;

/**
 * The literal SQLite in-memory sentinel, rejected as a `configuredPath`.
 * In-memory storage is available only programmatically, via
 * `openConsoleStore({ location: ":memory:" })` — never through configuration
 * — so that an operator's persistent deployment and a test's ephemeral
 * fixture stay cleanly separated: a stray env var can never silently drop an
 * operator into a non-durable store.
 */
const MEMORY_SENTINEL = ":memory:";

/** Rejected as a `configuredPath` prefix — a URI, not a filesystem path. */
const FILE_URI_PREFIX = "file:";

/**
 * Returns `true` when `value` ends in a path separator (either `/` or `\`,
 * regardless of the host platform) — such a value names a directory, not a
 * database file, and SQLite would refuse to open it.
 */
function endsWithPathSeparator(value: string): boolean {
  return value.endsWith("/") || value.endsWith("\\");
}

/**
 * Validates a supplied `configuredPath`, throwing {@link M3LConsoleError}
 * (never echoing `configuredPath` itself) when it is blank, the literal
 * {@link MEMORY_SENTINEL}, a `file:`-prefixed URI, or ends in a path
 * separator.
 */
function rejectUnsafeConfiguredPath(configuredPath: string): void {
  if (configuredPath.trim().length === 0) {
    throw new M3LConsoleError(
      CODE,
      `configuration key '${DB_PATH_KEY}' must not be blank`,
      { context: { key: DB_PATH_KEY } },
    );
  }
  if (configuredPath === MEMORY_SENTINEL) {
    throw new M3LConsoleError(
      CODE,
      `configuration key '${DB_PATH_KEY}' does not accept an in-memory store; use openConsoleStore's location option programmatically instead`,
      { context: { key: DB_PATH_KEY } },
    );
  }
  if (configuredPath.startsWith(FILE_URI_PREFIX)) {
    throw new M3LConsoleError(
      CODE,
      `configuration key '${DB_PATH_KEY}' must be a filesystem path, not a 'file:' URI`,
      { context: { key: DB_PATH_KEY } },
    );
  }
  if (endsWithPathSeparator(configuredPath)) {
    throw new M3LConsoleError(
      CODE,
      `configuration key '${DB_PATH_KEY}' must name a file, not a directory (it must not end in a path separator)`,
      { context: { key: DB_PATH_KEY } },
    );
  }
}

/**
 * Validates a supplied DIRECTORY-root `configuredPath`, throwing
 * {@link M3LConsoleError} (never echoing `configuredPath` itself) when it is
 * blank or a `file:`-prefixed URI. `key` names the config key the rejection
 * message and context report, so the session artifact root and the
 * human-action audit root share one guard rather than two copies that could
 * drift: the two resolvers are the same shape over a different default, and a
 * divergence between them would itself be the defect.
 *
 * Unlike {@link rejectUnsafeConfiguredPath} (the database FILE path's
 * validator), this deliberately does NOT reject the `":memory:"` literal or a
 * trailing path separator — neither check is meaningful for a directory
 * target: a directory path may legitimately end in a separator, and there is
 * no in-memory-store sentinel to guard against for a filesystem root.
 */
function rejectUnsafeDirectoryRootPath(
  configuredPath: string,
  key: string,
): void {
  if (configuredPath.trim().length === 0) {
    throw new M3LConsoleError(
      CODE,
      `configuration key '${key}' must not be blank`,
      { context: { key } },
    );
  }
  if (configuredPath.startsWith(FILE_URI_PREFIX)) {
    throw new M3LConsoleError(
      CODE,
      `configuration key '${key}' must be a filesystem path, not a 'file:' URI`,
      { context: { key } },
    );
  }
}

/** The default `resolveDataDir`, unwrapped — {@link runResolveDataDir} wraps its failures. */
function defaultResolveDataDir(): string {
  return new Core.M3LPaths().getDataDir();
}

/**
 * Runs `resolveDataDir` (default or injected), wrapping any thrown failure as
 * {@link M3LConsoleError}. The default calls `Core.M3LPaths`'s constructor,
 * which can throw `M3LEnvironmentDetectionError` or `M3LPathResolutionError`
 * — neither is an `M3LConsoleError`, so left unwrapped either would escape
 * this module's documented all-failures-are-`ERR_CONSOLE_CONFIG_INVALID`
 * contract. An already-typed `M3LConsoleError` is re-thrown unchanged rather
 * than double-wrapped.
 *
 * `key` is the CALLING resolver's dotted config key, not a constant: every
 * resolver here shares this data-dir step, so hard-coding one key sent an
 * operator whose audit-root resolution failed to fix `m3l.console.db.path`
 * — a key they never set. Same drift class the sibling
 * {@link rejectUnsafeDirectoryRootPath} guard takes its `key` for.
 */
function runResolveDataDir(resolveDataDir: () => string, key: string): string {
  try {
    return resolveDataDir();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw new M3LConsoleError(
      CODE,
      `failed to resolve the data directory for configuration key '${key}'`,
      { cause, context: { key } },
    );
  }
}

/**
 * Constructor options for {@link resolveStoreDatabasePath}.
 *
 * @example
 * ```ts
 * const options: ResolveStoreDatabasePathOptions = {
 *   configuredPath: "custom/store.sqlite",
 * };
 * ```
 */
export interface ResolveStoreDatabasePathOptions {
  /** The operator-supplied path, if any (typically from `M3L_CONSOLE_DB_PATH`). */
  readonly configuredPath?: string | undefined;
  /** Resolves the base data directory; defaults to `Core.M3LPaths().getDataDir()`. */
  readonly resolveDataDir?: () => string;
}

/**
 * Resolves the console server's embedded-store database path (ADR-0069).
 *
 * Performs no filesystem I/O whatsoever — it is a pure path computation.
 * Creating the parent directory (and the database file itself) is the
 * store's open step's responsibility, not this module's.
 *
 * When `options.configuredPath` is absent, the result defaults to
 * `<dataDir>/console/console.sqlite`. A relative `configuredPath` resolves
 * against the data directory; an absolute one passes through
 * {@link path.resolve} unchanged.
 *
 * A `configuredPath` that is blank/whitespace-only, the literal
 * `":memory:"`, `file:`-prefixed, or ends in a path separator is rejected —
 * see {@link rejectUnsafeConfiguredPath}. In-memory storage remains
 * available, but only programmatically via
 * `openConsoleStore({ location: ":memory:" })`, which keeps an operator's
 * durable deployment and a test's ephemeral fixture cleanly separated.
 *
 * @param options - See {@link ResolveStoreDatabasePathOptions}.
 * @returns The resolved, absolute database path.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_CONFIG_INVALID` — for a
 * rejected `configuredPath`, or when `resolveDataDir` throws.
 *
 * @example
 * ```ts
 * import { resolveStoreDatabasePath } from "./config/paths.js";
 *
 * const dbPath = resolveStoreDatabasePath({
 *   configuredPath: process.env["M3L_CONSOLE_DB_PATH"],
 * });
 * ```
 */
export function resolveStoreDatabasePath(
  options: ResolveStoreDatabasePathOptions = {},
): string {
  const resolveDataDir = options.resolveDataDir ?? defaultResolveDataDir;
  const configuredPath = options.configuredPath;

  if (configuredPath === undefined) {
    return path.join(
      runResolveDataDir(resolveDataDir, DB_PATH_KEY),
      ...DEFAULT_DB_RELATIVE_SEGMENTS,
    );
  }

  rejectUnsafeConfiguredPath(configuredPath);
  return path.resolve(
    runResolveDataDir(resolveDataDir, DB_PATH_KEY),
    configuredPath,
  );
}

/**
 * Constructor options for {@link resolveSessionArtifactRoot}.
 *
 * @example
 * ```ts
 * const options: ResolveSessionArtifactRootOptions = {
 *   configuredPath: "custom/artifacts",
 * };
 * ```
 */
export interface ResolveSessionArtifactRootOptions {
  /** The operator-supplied path, if any (typically from `M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT`). */
  readonly configuredPath?: string | undefined;
  /** Resolves the base data directory; defaults to `Core.M3LPaths().getDataDir()`. */
  readonly resolveDataDir?: () => string;
}

/**
 * Resolves the console server's session artifact storage root (X6 workbench-
 * sessions module, slice 3, ADR-0068/ADR-0069) — the directory under which
 * {@link "../sessions/artifacts.js".createSessionArtifactStore} writes
 * file-backed artifacts.
 *
 * Performs no filesystem I/O whatsoever — it is a pure path computation,
 * mirroring {@link resolveStoreDatabasePath}'s own shape. Creating the
 * directory itself is the artifact store's own responsibility, not this
 * module's.
 *
 * When `options.configuredPath` is absent, the result defaults to
 * `<dataDir>/console/artifacts`. A relative `configuredPath` resolves against
 * the data directory; an absolute one passes through {@link path.resolve}
 * unchanged.
 *
 * A `configuredPath` that is blank/whitespace-only or `file:`-prefixed is
 * rejected — see {@link rejectUnsafeDirectoryRootPath}. Unlike
 * {@link resolveStoreDatabasePath}'s FILE-path validator, this deliberately
 * does not reject the `":memory:"` literal or a trailing path separator:
 * neither check is meaningful for a directory root.
 *
 * @param options - See {@link ResolveSessionArtifactRootOptions}.
 * @returns The resolved, absolute session artifact root directory.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_CONFIG_INVALID` — for a
 * rejected `configuredPath`, or when `resolveDataDir` throws.
 *
 * @example
 * ```ts
 * import { resolveSessionArtifactRoot } from "./config/paths.js";
 *
 * const root = resolveSessionArtifactRoot({
 *   configuredPath: process.env["M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT"],
 * });
 * ```
 */
export function resolveSessionArtifactRoot(
  options: ResolveSessionArtifactRootOptions = {},
): string {
  const resolveDataDir = options.resolveDataDir ?? defaultResolveDataDir;
  const configuredPath = options.configuredPath;

  if (configuredPath === undefined) {
    return path.join(
      runResolveDataDir(resolveDataDir, ARTIFACT_ROOT_KEY),
      ...DEFAULT_ARTIFACT_ROOT_RELATIVE_SEGMENTS,
    );
  }

  rejectUnsafeDirectoryRootPath(configuredPath, ARTIFACT_ROOT_KEY);
  return path.resolve(
    runResolveDataDir(resolveDataDir, ARTIFACT_ROOT_KEY),
    configuredPath,
  );
}

/**
 * Constructor options for {@link resolveAuditStreamRoot}.
 *
 * @example
 * ```ts
 * const options: ResolveAuditStreamRootOptions = {
 *   configuredPath: "custom/audit",
 * };
 * ```
 */
export interface ResolveAuditStreamRootOptions {
  /** The operator-supplied path, if any (typically from `M3L_CONSOLE_AUDIT_ROOT`). */
  readonly configuredPath?: string | undefined;
  /** Resolves the base data directory; defaults to `Core.M3LPaths().getDataDir()`. */
  readonly resolveDataDir?: () => string;
}

/**
 * Resolves the console server's human-action audit stream root (X7, slice 3,
 * ADR-0070) — the directory `createHumanActionAuditStream` writes its
 * append-only JSONL segments into.
 *
 * The same shape as {@link resolveSessionArtifactRoot} over a different
 * default, down to sharing its unsafe-path guard: performs no filesystem I/O
 * whatsoever, and creating the directory is the stream's own job (the Core
 * primitive creates it on its first append).
 *
 * When `options.configuredPath` is absent, the result defaults to
 * `<dataDir>/console/audit` — a sibling of the artifact root, never inside
 * it. A relative `configuredPath` resolves against the data directory; an
 * absolute one passes through {@link path.resolve} unchanged.
 *
 * A `configuredPath` that is blank/whitespace-only or `file:`-prefixed is
 * rejected — see {@link rejectUnsafeDirectoryRootPath}.
 *
 * @param options - See {@link ResolveAuditStreamRootOptions}.
 * @returns The resolved, absolute audit stream root directory.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_CONFIG_INVALID` — for a
 * rejected `configuredPath`, or when `resolveDataDir` throws.
 *
 * @example
 * ```ts
 * import { resolveAuditStreamRoot } from "./config/paths.js";
 *
 * const root = resolveAuditStreamRoot({
 *   configuredPath: process.env["M3L_CONSOLE_AUDIT_ROOT"],
 * });
 * ```
 */
export function resolveAuditStreamRoot(
  options: ResolveAuditStreamRootOptions = {},
): string {
  const resolveDataDir = options.resolveDataDir ?? defaultResolveDataDir;
  const configuredPath = options.configuredPath;

  if (configuredPath === undefined) {
    return path.join(
      runResolveDataDir(resolveDataDir, AUDIT_ROOT_KEY),
      ...DEFAULT_AUDIT_ROOT_RELATIVE_SEGMENTS,
    );
  }

  rejectUnsafeDirectoryRootPath(configuredPath, AUDIT_ROOT_KEY);
  return path.resolve(
    runResolveDataDir(resolveDataDir, AUDIT_ROOT_KEY),
    configuredPath,
  );
}

/**
 * Constructor options for {@link resolveRunsOutputRoot}.
 *
 * @example
 * ```ts
 * const options: ResolveRunsOutputRootOptions = {
 *   configuredPath: "custom/runs",
 * };
 * ```
 */
export interface ResolveRunsOutputRootOptions {
  /** The operator-supplied path, if any (typically from `M3L_CONSOLE_RUNS_OUTPUT_ROOT`). */
  readonly configuredPath?: string | undefined;
  /** Resolves the base data directory; defaults to `Core.M3LPaths().getDataDir()`. */
  readonly resolveDataDir?: () => string;
}

/**
 * Resolves the console server's runs output root (X7d, ADR-0070) — the
 * directory each console-launched run gets its own `<runId>/` subdirectory
 * under, handed to the spawned child as `M3L_OUTPUT_DIR`.
 *
 * The same shape as {@link resolveSessionArtifactRoot} and
 * {@link resolveAuditStreamRoot} over a different default, down to sharing
 * their unsafe-path guard: performs no filesystem I/O whatsoever. Creating
 * the per-run directory is the spawned script's own job — `M3LRunReporter`
 * and stage-9 archival both `mkdir` beneath the output dir they are given.
 *
 * **This root is what makes a run report addressable at all.** Without a
 * per-run directory every console-launched run writes into one shared
 * `data/output`, where `<runDirectoryName(startedAt)>/run-report.json` cannot
 * be attributed back to a run id — the console records neither the child's
 * own `startedAt` nor its output dir. Pinning the dir per run is the seam
 * `GET /api/v1/runs/:id/report` reads through.
 *
 * When `options.configuredPath` is absent, the result defaults to
 * `<dataDir>/console/runs`. A relative `configuredPath` resolves against the
 * data directory; an absolute one passes through {@link path.resolve}
 * unchanged.
 *
 * A `configuredPath` that is blank/whitespace-only or `file:`-prefixed is
 * rejected — see {@link rejectUnsafeDirectoryRootPath}.
 *
 * @param options - See {@link ResolveRunsOutputRootOptions}.
 * @returns The resolved, absolute runs output root directory.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_CONFIG_INVALID` — for a
 * rejected `configuredPath`, or when `resolveDataDir` throws.
 *
 * @example
 * ```ts
 * import { resolveRunsOutputRoot } from "./config/paths.js";
 *
 * const root = resolveRunsOutputRoot({
 *   configuredPath: process.env["M3L_CONSOLE_RUNS_OUTPUT_ROOT"],
 * });
 * ```
 */
export function resolveRunsOutputRoot(
  options: ResolveRunsOutputRootOptions = {},
): string {
  const resolveDataDir = options.resolveDataDir ?? defaultResolveDataDir;
  const configuredPath = options.configuredPath;

  if (configuredPath === undefined) {
    return path.join(
      runResolveDataDir(resolveDataDir, RUNS_OUTPUT_ROOT_KEY),
      ...DEFAULT_RUNS_OUTPUT_ROOT_RELATIVE_SEGMENTS,
    );
  }

  rejectUnsafeDirectoryRootPath(configuredPath, RUNS_OUTPUT_ROOT_KEY);
  return path.resolve(
    runResolveDataDir(resolveDataDir, RUNS_OUTPUT_ROOT_KEY),
    configuredPath,
  );
}
