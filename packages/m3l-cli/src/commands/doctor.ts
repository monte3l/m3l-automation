/**
 * `commands/doctor` — runs an ordered health-check suite over the resolved
 * workspace (Node version, workspace root, one row per discovered
 * `scripts/*` candidate immediately followed by its `command-module:<name>`
 * row (U7, ADR-0054 — never `"fail"`, only `"ok"`/`"warn"`), a reserved-names
 * audit, and the discovery cache's/run-history file's writability/integrity)
 * and renders it via `context.output`, JSON or an aligned CHECK/STATUS/DETAIL
 * table.
 *
 * @packageDocumentation
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { formatAlignedTable } from "../cli/table.js";
import { M3LCliError } from "../cli/errors.js";
import type { M3LCliCommandContext } from "./context.js";
import {
  diagnoseDependencyGraph,
  discoverScripts,
} from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadScriptParameters } from "../discovery/load-config.js";
import { configMtimes, readDiscoveryCache } from "../discovery/cache.js";
import type { M3LCliConfigMtimes } from "../discovery/cache.js";
import { readHistory } from "../history/store.js";
import { loadCommandModule } from "../run/in-process.js";

/**
 * A single check's outcome: `"ok"` (healthy), `"warn"` (diagnosable but not
 * blocking — never affects `runDoctor`'s exit code), or `"fail"` (blocking —
 * any `"fail"` row makes `runDoctor` resolve to exit code `1`).
 *
 * @example
 * ```ts
 * function isBlocking(status: M3LCliDoctorStatus): boolean {
 *   return status === "fail";
 * }
 * ```
 */
export type M3LCliDoctorStatus = "ok" | "warn" | "fail";

/**
 * One row of `runDoctor`'s check suite.
 *
 * @example
 * ```ts
 * const row: M3LCliDoctorCheck = {
 *   name: "node-version",
 *   status: "ok",
 *   detail: "v24.0.0 (requires >= v24)",
 * };
 * ```
 */
export interface M3LCliDoctorCheck {
  /** The check's stable identifier, e.g. `"node-version"` or `"script:exporter"`. */
  readonly name: string;
  /** The check's outcome. */
  readonly status: M3LCliDoctorStatus;
  /** A human-readable explanation of the outcome. */
  readonly detail: string;
}

/** Numeric severity for combining sub-check outcomes; higher wins ties toward `"fail"`. */
const STATUS_SEVERITY: Readonly<Record<M3LCliDoctorStatus, number>> = {
  ok: 0,
  warn: 1,
  fail: 2,
};

/** The minimum Node.js major version this CLI supports (see the repo's `.node-version`). */
const NODE_VERSION_FLOOR = 24;

/** Matches a `process.version` string's leading major-version component, e.g. `"v24"` in `"v24.0.0"`. */
const NODE_MAJOR_VERSION_PATTERN = /^v(\d+)\./;

/**
 * The static command names a discovered script's name must never collide
 * with — mirrors `bin/lib/script-scaffold.mjs`'s `RESERVED_CLI_NAMES` (the
 * ADR-0042 reserved-CLI-name list scaffold/checker both enforce at script
 * creation time; this check re-audits the workspace's current state).
 */
const RESERVED_COMMAND_NAMES: readonly string[] = [
  "list",
  "inspect",
  "run",
  "doctor",
  "presets",
  "history",
  "wizard",
  "new",
  "help",
];

/**
 * `M3LCliCommandContext` plus the run-history file's absolute path (8f) —
 * `runDoctor`'s own parameter type, narrower than the shared base so the
 * "history" check can read `context.historyFilePath` without a cast.
 */
interface M3LCliDoctorCommandContext extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

/** Checks the running Node.js major version against {@link NODE_VERSION_FLOOR}. */
function checkNodeVersion(): M3LCliDoctorCheck {
  const majorVersion = Number(
    NODE_MAJOR_VERSION_PATTERN.exec(process.version)?.[1] ?? "0",
  );
  const status: M3LCliDoctorStatus =
    majorVersion >= NODE_VERSION_FLOOR ? "ok" : "fail";
  return {
    name: "node-version",
    status,
    detail: `${process.version} (requires >= v${String(NODE_VERSION_FLOOR)})`,
  };
}

/** Renders the already-resolved workspace root; cannot fail from here (resolution ran before `runDoctor`). */
function checkWorkspaceRoot(context: M3LCliCommandContext): M3LCliDoctorCheck {
  return {
    name: "workspace-root",
    status: "ok",
    detail: context.workspaceRoot,
  };
}

/** A named sub-check's outcome, before it's attached to a check row's `name`. */
interface M3LCliDoctorSubResult {
  readonly status: M3LCliDoctorStatus;
  readonly detail: string;
}

/** Fails when neither `src/config.ts` nor `dist/config.js` exists for a script. */
function checkDirShape(mtimes: M3LCliConfigMtimes): M3LCliDoctorSubResult {
  if (mtimes.srcMtimeMs === null && mtimes.distMtimeMs === null) {
    return {
      status: "fail",
      detail: "neither src/config.ts nor dist/config.js was found",
    };
  }
  return { status: "ok", detail: "a config module is present" };
}

/** Warns when the compiled `dist/config.js` is missing or stale relative to `src/config.ts`. */
function checkDistFreshness(mtimes: M3LCliConfigMtimes): M3LCliDoctorSubResult {
  if (mtimes.distMtimeMs === null) {
    return {
      status: "warn",
      detail: "dist/config.js is missing — run 'pnpm build'",
    };
  }
  if (mtimes.srcMtimeMs !== null && mtimes.distMtimeMs < mtimes.srcMtimeMs) {
    return {
      status: "warn",
      detail: "dist/config.js is older than src/config.ts — run 'pnpm build'",
    };
  }
  return { status: "ok", detail: "dist/config.js is up to date" };
}

/**
 * Fails when the script's config module cannot be imported — through the
 * real {@link loadScriptParameters} loader, never the discovery cache, so a
 * stale cache entry can never mask a genuinely broken config module.
 */
async function checkImportability(
  scriptDirectory: string,
): Promise<M3LCliDoctorSubResult> {
  let parameters;
  try {
    parameters = await loadScriptParameters(scriptDirectory);
  } catch (error) {
    return {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "ok",
    detail: `${String(parameters.length)} parameter(s) declared`,
  };
}

/**
 * Combines ordered sub-check outcomes into one: the first entry at the
 * highest severity wins, so `[importability, dirShape, freshness]` prefers
 * the import failure's own message when both a stale dist and a failing
 * import are present.
 */
function combineSubResults(
  subResults: readonly M3LCliDoctorSubResult[],
): M3LCliDoctorSubResult {
  return subResults.reduce((best, candidate) =>
    STATUS_SEVERITY[candidate.status] > STATUS_SEVERITY[best.status]
      ? candidate
      : best,
  );
}

/** Builds one `script:<name>` row from its dir-shape, freshness, and importability sub-checks. */
async function buildScriptCheck(
  candidate: M3LCliScriptCandidate,
): Promise<M3LCliDoctorCheck> {
  const mtimes = configMtimes(candidate.directory);
  const importability = await checkImportability(candidate.directory);
  const dirShape = checkDirShape(mtimes);
  const freshness = checkDistFreshness(mtimes);
  const { status, detail } = combineSubResults([
    importability,
    dirShape,
    freshness,
  ]);
  return { name: `script:${candidate.name}`, status, detail };
}

/**
 * Builds a `command-module:<name>` row from {@link loadCommandModule} (U7,
 * ADR-0054). This check can **never** resolve `"fail"`: absence of an
 * adopted in-process command module is the expected, optional state for
 * every fleet script that hasn't opted in yet — only `"ok"` (a valid module
 * was found) or `"warn"` (no module, or it failed to import) are possible.
 */
async function checkCommandModule(
  candidate: M3LCliScriptCandidate,
): Promise<M3LCliDoctorCheck> {
  let commandModule;
  try {
    commandModule = await loadCommandModule(candidate.directory);
  } catch {
    // Deliberately fixed and content-free: loadCommandModule propagates a
    // genuine import failure unwrapped, so the caught error's own message
    // could carry arbitrary content from the script's own dist/command.js —
    // never interpolate it into this rendered detail (plain-text table AND
    // --json), or that content leaks straight to the operator's terminal.
    return {
      name: `command-module:${candidate.name}`,
      status: "warn",
      detail:
        "dist/command.js failed to import — run 'pnpm build' or inspect the script directly",
    };
  }
  return commandModule === undefined
    ? {
        name: `command-module:${candidate.name}`,
        status: "warn",
        detail: "no in-process command module (optional, ADR-0054)",
      }
    : {
        name: `command-module:${candidate.name}`,
        status: "ok",
        detail: "in-process command module available",
      };
}

/**
 * Builds the `dependency-graph` row (U7, ADR-0054) from
 * {@link diagnoseDependencyGraph}, reporting how many declared
 * `@m3l-automation/*` script dependencies resolved successfully vs. how many
 * are declared-but-unresolvable. This check can **never** resolve `"fail"`:
 * an unresolvable dependency is recoverable via `pnpm install`, not a hard
 * failure. An unexpected `diagnoseDependencyGraph` failure (e.g. a
 * non-`MODULE_NOT_FOUND` resolution error) is isolated to this one row too —
 * mirrors {@link checkCommandModule}'s isolation pattern exactly — and never
 * aborts the rest of the `runDoctor` suite.
 */
function checkDependencyGraph(): M3LCliDoctorCheck {
  let status;
  try {
    status = diagnoseDependencyGraph();
  } catch (cause) {
    // Deliberately message-free: diagnoseDependencyGraph propagates a genuine
    // resolution failure unwrapped, so the caught error's own message could
    // carry arbitrary content (e.g. a malformed package export's path) —
    // never interpolate the message into this rendered detail (plain-text
    // table AND --json), mirrors checkCommandModule's own catch-block detail
    // safety posture exactly. The error's *type* is safe to surface.
    return {
      name: "dependency-graph",
      status: "warn",
      detail: `dependency-graph diagnosis failed unexpectedly (${cause instanceof Error ? cause.name : typeof cause}) — run 'pnpm install' or inspect the workspace manifest directly`,
    };
  }
  return status.unresolved.length === 0
    ? {
        name: "dependency-graph",
        status: "ok",
        detail: `${String(status.resolved.length)} script(s) resolved via the declared dependency graph`,
      }
    : {
        name: "dependency-graph",
        status: "warn",
        detail: `unresolved: ${status.unresolved.join(", ")} — run 'pnpm install'`,
      };
}

/** Fails when a discovered script's name collides with a {@link RESERVED_COMMAND_NAMES} entry. */
function checkReservedNames(
  candidates: readonly M3LCliScriptCandidate[],
): M3LCliDoctorCheck {
  const collisions = candidates
    .map((candidate) => candidate.name)
    .filter((name) => RESERVED_COMMAND_NAMES.includes(name));

  if (collisions.length > 0) {
    return {
      name: "reserved-names",
      status: "fail",
      detail: `script name(s) collide with reserved command name(s): ${collisions.join(", ")}`,
    };
  }
  return { name: "reserved-names", status: "ok", detail: "no collisions" };
}

/**
 * Walks up from `directory` to the nearest ancestor that exists, so a
 * not-yet-created cache directory's writability can still be probed against
 * its nearest existing parent.
 */
function nearestExistingAncestor(directory: string): string {
  let current = directory;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/**
 * Checks whether `error` is a Node `ErrnoException` carrying `EACCES` or
 * `EPERM` — the only errno codes a permission-denied probe is expected to
 * raise. Any other caught value signals a genuine, unexpected failure of the
 * probe itself rather than a diagnosable permissions condition.
 *
 * @param error - The caught value to check.
 * @returns Whether `error` represents a permission-denied condition.
 */
function isPermissionDenied(error: unknown): boolean {
  return (
    Core.isNodeError(error) &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

/**
 * Checks whether `value` is a raw, unfiltered cache payload's plain-object
 * shape — parsed independently of {@link readDiscoveryCache}, whose
 * per-entry filtering and blanket failure fallback (both to `{}`) make a
 * genuinely empty-but-valid cache file indistinguishable from a corrupted
 * one once routed through it.
 *
 * @param value - The parsed JSON payload to check.
 * @returns Whether `value` is a non-array plain object.
 */
function isRawCachePayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the discovery cache's parent-directory writability and, when the
 * cache file exists, its readability/validity.
 *
 * The writability probe narrows its caught value: `EACCES`/`EPERM` render
 * the existing "not writable" warn row, since a permission fault is a normal,
 * diagnosable workspace condition; any other failure is unexpected and is
 * raised as an {@link M3LCliError} rather than folded into the same warn row.
 *
 * The cache file's validity is determined by parsing it directly here (not
 * through {@link readDiscoveryCache}, which folds "genuinely empty" and
 * "corrupted" alike into `{}`) — a legitimately empty JSON object is `"ok"`
 * with `0` entries, never a `"warn"`.
 */
function checkCache(cacheFilePath: string): M3LCliDoctorCheck {
  const ancestor = nearestExistingAncestor(dirname(cacheFilePath));

  try {
    accessSync(ancestor, constants.W_OK);
  } catch (error) {
    if (isPermissionDenied(error)) {
      return {
        name: "cache",
        status: "warn",
        detail: `cache directory is not writable: '${cacheFilePath}'`,
      };
    }
    throw new M3LCliError(
      "ERR_CLI_DOCTOR_FAILED",
      "cache-writability probe failed",
      { cause: error },
    );
  }

  if (!existsSync(cacheFilePath)) {
    return {
      name: "cache",
      status: "ok",
      detail: `cache file will be created at '${cacheFilePath}'`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cacheFilePath, "utf8"));
  } catch {
    return {
      name: "cache",
      status: "warn",
      detail: `cache file '${cacheFilePath}' is unreadable/invalid — will be rebuilt`,
    };
  }
  if (!isRawCachePayload(parsed)) {
    return {
      name: "cache",
      status: "warn",
      detail: `cache file '${cacheFilePath}' is unreadable/invalid — will be rebuilt`,
    };
  }

  const entryCount = Object.keys(readDiscoveryCache(cacheFilePath)).length;
  return {
    name: "cache",
    status: "ok",
    detail: `cache file '${cacheFilePath}' holds ${String(entryCount)} entr${entryCount === 1 ? "y" : "ies"}`,
  };
}

/**
 * Checks whether `value` is a raw, unfiltered history payload's array shape —
 * parsed independently of {@link readHistory}, whose per-entry filtering and
 * blanket failure fallback (both to `[]`) make a genuinely empty-but-valid
 * history file indistinguishable from a corrupted one once routed through it.
 *
 * @param value - The parsed JSON payload to check.
 * @returns Whether `value` is an array.
 */
function isRawHistoryPayload(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Checks the run-history file's parent-directory writability and, when the
 * file exists, its readability/validity — mirrors {@link checkCache}'s
 * absent/valid/invalid arms exactly, swapping the cache's non-array
 * plain-object shape for history's array shape (see
 * {@link isRawHistoryPayload}).
 */
function checkHistory(historyFilePath: string): M3LCliDoctorCheck {
  const ancestor = nearestExistingAncestor(dirname(historyFilePath));

  try {
    accessSync(ancestor, constants.W_OK);
  } catch (error) {
    if (isPermissionDenied(error)) {
      return {
        name: "history",
        status: "warn",
        detail: `history directory is not writable: '${historyFilePath}'`,
      };
    }
    throw new M3LCliError(
      "ERR_CLI_DOCTOR_FAILED",
      "history-writability probe failed",
      { cause: error },
    );
  }

  if (!existsSync(historyFilePath)) {
    return {
      name: "history",
      status: "ok",
      detail: `history file will be created at '${historyFilePath}'`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(historyFilePath, "utf8"));
  } catch {
    return {
      name: "history",
      status: "warn",
      detail: `history file '${historyFilePath}' is unreadable/invalid — will be rebuilt`,
    };
  }
  if (!isRawHistoryPayload(parsed)) {
    return {
      name: "history",
      status: "warn",
      detail: `history file '${historyFilePath}' is unreadable/invalid — will be rebuilt`,
    };
  }

  const entryCount = readHistory(historyFilePath).length;
  return {
    name: "history",
    status: "ok",
    detail: `history file '${historyFilePath}' holds ${String(entryCount)} entr${entryCount === 1 ? "y" : "ies"}`,
  };
}

/**
 * Discovers `scripts/*` candidates, tolerating an unexpected dependency-graph
 * resolution failure (e.g. `EACCES`, `ERR_PACKAGE_PATH_NOT_EXPORTED`) from
 * {@link discoverScripts}'s own unguarded first attempt. `discoverScripts`
 * shares its resolver with {@link diagnoseDependencyGraph} (both wrap
 * `discover.ts`'s module-private `resolveScriptManifestDefault`, which
 * deliberately propagates any non-`MODULE_NOT_FOUND` resolution error), so
 * without this retry a resolver blowup here would abort the whole
 * `runDoctor` suite before {@link checkDependencyGraph} ever gets a chance to
 * report the same problem as its own isolated `"warn"` row.
 *
 * The retry forces `resolveScriptManifest` to report every declared
 * dependency as unresolved without performing any real resolution, so it can
 * never throw again — the result degrades to filesystem-only candidates
 * (`discoverScriptsFromFilesystem`'s results only).
 */
function discoverScriptCandidates(
  workspaceRoot: string,
): readonly M3LCliScriptCandidate[] {
  try {
    return discoverScripts(workspaceRoot);
  } catch {
    return discoverScripts(workspaceRoot, {
      resolveScriptManifest: () => undefined,
    });
  }
}

/** The human-readable rendering's column headers. */
const HEADER = ["CHECK", "STATUS", "DETAIL"] as const;

/** Renders the resolved checks through `context.output`, JSON or an aligned table. */
function renderChecks(
  context: M3LCliCommandContext,
  checks: readonly M3LCliDoctorCheck[],
): void {
  if (context.jsonOutput) {
    context.output.info(JSON.stringify(checks));
    return;
  }

  context.output.heading("Doctor");
  const rows = checks.map((check) => [check.name, check.status, check.detail]);
  for (const line of formatAlignedTable(HEADER, rows)) {
    context.output.info(line);
  }
}

/**
 * Runs the m3l CLI's health-check suite and renders it via `context.output`.
 *
 * Checks, in order: `node-version`, `workspace-root`, per discovered
 * candidate a `script:<name>` row (dir shape, dist freshness, config
 * importability through the real {@link loadScriptParameters} loader — never
 * the discovery cache) immediately followed by its `command-module:<name>`
 * row (U7, ADR-0054 — built from {@link checkCommandModule}, which can never
 * resolve `"fail"`: no adopted in-process command module is an optional,
 * expected state), then `reserved-names`, `cache`, and `history` (8f —
 * mirrors `cache`'s absent/valid/invalid arms over
 * `context.historyFilePath`). Never throws for an unhealthy check — an
 * unhealthy-but-diagnosable workspace is a normal result, rendered as a
 * `"warn"`/`"fail"` row, not an exception. An unexpected failure in a check's
 * own collaborator (e.g. `discoverScripts` itself throwing) propagates as an
 * {@link M3LCliError} with code `"ERR_CLI_DOCTOR_FAILED"` rather than being
 * swallowed into a `"fail"` row — an already-typed `M3LCliError` (e.g. from
 * {@link checkCache}'s or {@link checkHistory}'s writability probe) passes
 * through unwrapped. `discoverScripts` shares its dependency-graph resolver
 * with {@link checkDependencyGraph}'s own isolated call, so an unexpected
 * resolution failure (e.g. `EACCES`) there is tolerated the same way: the
 * candidate discovery is retried with `resolveScriptManifest` forced to
 * report every declared dependency as unresolved, degrading to
 * filesystem-only candidates rather than aborting the whole run —
 * `checkDependencyGraph` still reports the same underlying problem as its
 * own `"warn"` row.
 *
 * @param context - The command context to run against; must carry
 *   `historyFilePath`.
 * @returns `0` when no check resolved `"fail"` (a `"warn"`-only or fully
 *   `"ok"` result still exits `0`); `1` when at least one check resolved
 *   `"fail"`.
 *
 * @example
 * ```ts
 * const exitCode = await runDoctor(context);
 * // 0 unless some check resolved "fail"; renders CHECK/STATUS/DETAIL rows
 * // (or a JSON array when context.jsonOutput is true)
 * ```
 */
export async function runDoctor(
  context: M3LCliDoctorCommandContext,
): Promise<number> {
  let checks: M3LCliDoctorCheck[];
  try {
    const candidates = discoverScriptCandidates(context.workspaceRoot);

    checks = [
      checkNodeVersion(),
      checkWorkspaceRoot(context),
      checkDependencyGraph(),
    ];
    for (const candidate of candidates) {
      checks.push(await buildScriptCheck(candidate));
      checks.push(await checkCommandModule(candidate));
    }
    checks.push(checkReservedNames(candidates));
    checks.push(checkCache(context.cacheFilePath));
    checks.push(checkHistory(context.historyFilePath));
  } catch (error) {
    if (error instanceof M3LCliError) {
      throw error;
    }
    throw new M3LCliError("ERR_CLI_DOCTOR_FAILED", "doctor failed to run", {
      cause: error,
    });
  }

  renderChecks(context, checks);

  return checks.some((check) => check.status === "fail") ? 1 : 0;
}
