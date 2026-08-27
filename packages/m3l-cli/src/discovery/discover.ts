/**
 * `discovery/discover` — workspace-root resolution and `scripts/*` candidate
 * enumeration.
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";

/** The `package.json` field this module reads to enumerate declared workspace dependencies. */
interface M3LCliOwnManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** The `@m3l-automation/*` scope prefix a declared dependency name must carry to be considered a script. */
const SCOPE_PREFIX = "@m3l-automation/";

/** The one `@m3l-automation/*` dependency that is the library, never a script. */
const LIBRARY_PACKAGE_NAME = "@m3l-automation/m3l-common";

/**
 * Reads this CLI package's own `package.json`, resolved relative to this
 * module's own `import.meta.url` — two directories up from
 * `src/discovery/discover.ts` (and, identically, from the compiled
 * `dist/discovery/discover.js`), i.e. `packages/m3l-cli/package.json`.
 */
function readOwnManifestDefault(): M3LCliOwnManifest {
  const manifestPath = new URL("../../package.json", import.meta.url);
  if (!existsSync(manifestPath)) {
    return {};
  }
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as M3LCliOwnManifest;
}

/**
 * Checks whether `error` is a Node `ErrnoException` carrying
 * `MODULE_NOT_FOUND` — the only errno code a failed `require.resolve` for a
 * declared-but-not-yet-`pnpm install`ed workspace link is expected to raise.
 * Any other caught value (e.g. `ERR_PACKAGE_PATH_NOT_EXPORTED`, `EACCES`, or
 * an error with no `.code` at all) signals a genuine, unexpected resolution
 * failure rather than a tolerable "not installed yet" condition, and must
 * propagate rather than be silently swallowed. Mirrors `commands/doctor`'s
 * own `isPermissionDenied` narrowing pattern.
 *
 * @param error - The caught value to check.
 * @returns Whether `error` represents a module-not-found condition.
 */
function isModuleNotFound(error: unknown): boolean {
  return Core.isNodeError(error) && error.code === "MODULE_NOT_FOUND";
}

/**
 * Resolves a declared dependency's `package.json` via real Node module
 * resolution, returning `undefined` (never throwing) only when the
 * resolution failure is a `MODULE_NOT_FOUND` — e.g. a
 * declared-but-not-yet-`pnpm install`ed workspace link. Any other resolution
 * failure (a malformed subpath export, a permissions error, etc.) is an
 * unexpected condition and propagates rather than being classified as
 * "unresolved".
 *
 * @param depName - The declared dependency's package name, e.g.
 *   `"@m3l-automation/json-etl"`.
 */
function resolveScriptManifestDefault(depName: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(`${depName}/package.json`);
  } catch (error) {
    if (isModuleNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Injectable overrides {@link discoverScriptsFromDependencyGraph} and
 * {@link diagnoseDependencyGraph} accept in place of reading this CLI
 * package's real `package.json` and performing real Node module resolution
 * against the live workspace — mirrors `M3LCliInProcessImportOptions`
 * (`run/in-process.ts`) and `M3LCliSpawnOptions` (`run/spawn.ts`).
 */
export interface M3LCliDependencyGraphOptions {
  /** Reads this CLI package's own manifest; defaults to the real `package.json` on disk. */
  readonly readOwnManifest?: () => M3LCliOwnManifest;
  /**
   * Resolves a declared dependency name to its `package.json` absolute path,
   * or `undefined` when it cannot be resolved; defaults to real Node module
   * resolution via `createRequire(...).resolve(...)`.
   */
  readonly resolveScriptManifest?: (depName: string) => string | undefined;
}

/**
 * Filters this CLI's own declared `dependencies` down to the
 * `@m3l-automation/*` script package names (excluding the library itself),
 * stripped of their scope prefix.
 */
function declaredScriptDependencyNames(
  options: M3LCliDependencyGraphOptions | undefined,
): readonly string[] {
  const readOwnManifest = options?.readOwnManifest ?? readOwnManifestDefault;
  const dependencies = readOwnManifest().dependencies ?? {};
  return Object.keys(dependencies).filter(
    (depName) =>
      depName.startsWith(SCOPE_PREFIX) && depName !== LIBRARY_PACKAGE_NAME,
  );
}

/**
 * A discovered `scripts/*` candidate: a directory containing a
 * `package.json`.
 */
export interface M3LCliScriptCandidate {
  /** The script's name, i.e. its directory's basename. */
  readonly name: string;
  /** The script's absolute directory path. */
  readonly directory: string;
  /** The script's manifest `description`, or `""` when absent. */
  readonly description: string;
}

/**
 * Walks up from `cwd` to the nearest ancestor directory containing
 * `pnpm-workspace.yaml`.
 *
 * @param cwd - The directory to start the search from.
 * @returns The resolved workspace root.
 * @throws {@link M3LCliError} with code `ERR_CLI_WORKSPACE_NOT_FOUND` when no
 *   ancestor directory contains `pnpm-workspace.yaml`.
 *
 * @example
 * ```ts
 * const root = resolveWorkspaceRoot(process.cwd());
 * // e.g. "/repo" — the nearest ancestor holding pnpm-workspace.yaml
 * ```
 */
export function resolveWorkspaceRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new M3LCliError(
        "ERR_CLI_WORKSPACE_NOT_FOUND",
        `no pnpm-workspace.yaml found in '${cwd}' or any ancestor directory`,
      );
    }
    current = parent;
  }
}

/**
 * Reads a script directory's `description` field from its `package.json`,
 * tolerating a manifest without one.
 *
 * @param packageJsonPath - The absolute path to the manifest to read.
 * @returns The manifest's `description`, or `""` when absent/not a string.
 */
function readScriptDescription(packageJsonPath: string): string {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    Object.hasOwn(parsed, "description") &&
    typeof (parsed as Record<string, unknown>)["description"] === "string"
  ) {
    return (parsed as Record<string, unknown>)["description"] as string;
  }
  return "";
}

/**
 * Enumerates every `scripts/*` directory under `workspaceRoot` that contains
 * a `package.json` — the filesystem-scan discovery path, unchanged from its
 * pre-U7 behavior.
 *
 * @param workspaceRoot - The resolved workspace root (see
 *   {@link resolveWorkspaceRoot}).
 * @returns The discovered candidates, sorted by `name`; `[]` when
 *   `scripts/` does not exist.
 */
function discoverScriptsFromFilesystem(
  workspaceRoot: string,
): readonly M3LCliScriptCandidate[] {
  const scriptsDirectory = join(workspaceRoot, "scripts");
  if (!existsSync(scriptsDirectory)) {
    return [];
  }

  const entries = readdirSync(scriptsDirectory, { withFileTypes: true });
  const candidates: M3LCliScriptCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = join(scriptsDirectory, entry.name);
    const packageJsonPath = join(directory, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    candidates.push({
      name: entry.name,
      directory,
      description: readScriptDescription(packageJsonPath),
    });
  }

  return candidates.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves every `scripts/*` candidate reachable through this CLI package's
 * own declared dependency graph (U7, ADR-0054) — the `package.json`
 * `dependencies` entries scoped `@m3l-automation/*` (excluding the library
 * itself), each resolved to its real, `pnpm install`-linked `package.json`
 * via Node module resolution. A declared dependency that fails to resolve
 * (e.g. before `pnpm install` has linked it) is silently skipped, never
 * thrown.
 *
 * @param options - Injectable overrides for the manifest read and the
 *   per-dependency resolution; defaults to the real `package.json` on disk
 *   and real Node module resolution.
 * @returns The resolved candidates, in declaration order.
 *
 * @example
 * ```ts
 * const candidates = discoverScriptsFromDependencyGraph();
 * // one M3LCliScriptCandidate per @m3l-automation/* dependency this CLI
 * // package declares (excluding @m3l-automation/m3l-common) that resolves
 * ```
 */
export function discoverScriptsFromDependencyGraph(
  options?: M3LCliDependencyGraphOptions,
): readonly M3LCliScriptCandidate[] {
  const resolveScriptManifest =
    options?.resolveScriptManifest ?? resolveScriptManifestDefault;

  const candidates: M3LCliScriptCandidate[] = [];
  for (const depName of declaredScriptDependencyNames(options)) {
    const resolvedPath = resolveScriptManifest(depName);
    if (resolvedPath === undefined) continue;

    candidates.push({
      name: depName.replace(SCOPE_PREFIX, ""),
      directory: dirname(resolvedPath),
      description: readScriptDescription(resolvedPath),
    });
  }
  return candidates;
}

/**
 * The declared dependency graph's resolution status: which declared
 * `@m3l-automation/*` script dependencies resolved successfully, and which
 * did not.
 */
export interface M3LCliDependencyGraphStatus {
  /** Script names (unscoped) that resolved successfully. */
  readonly resolved: readonly string[];
  /** Script names (unscoped) that were declared but failed to resolve. */
  readonly unresolved: readonly string[];
}

/**
 * Classifies every `@m3l-automation/*` dependency this CLI package declares
 * (excluding the library itself) as resolved or unresolved, without building
 * full {@link M3LCliScriptCandidate} objects — the diagnostic counterpart to
 * {@link discoverScriptsFromDependencyGraph}, used by the `doctor` command's
 * `dependency-graph` check.
 *
 * @param options - Injectable overrides; see
 *   {@link discoverScriptsFromDependencyGraph}.
 * @returns The resolved/unresolved script names (unscoped), each in
 *   declaration order.
 */
export function diagnoseDependencyGraph(
  options?: M3LCliDependencyGraphOptions,
): M3LCliDependencyGraphStatus {
  const resolveScriptManifest =
    options?.resolveScriptManifest ?? resolveScriptManifestDefault;

  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const depName of declaredScriptDependencyNames(options)) {
    const scriptName = depName.replace(SCOPE_PREFIX, "");
    if (resolveScriptManifest(depName) === undefined) {
      unresolved.push(scriptName);
    } else {
      resolved.push(scriptName);
    }
  }
  return { resolved, unresolved };
}

/**
 * Enumerates every discoverable `scripts/*` candidate, merging the
 * dependency-graph resolution (U7, ADR-0054) with the filesystem scan: the
 * graph is resolved first and wins on a name collision, then filesystem-only
 * candidates (not yet declared as a CLI dependency) are added, and the
 * merged result is sorted by `name`.
 *
 * @param workspaceRoot - The resolved workspace root (see
 *   {@link resolveWorkspaceRoot}).
 * @param graphOptions - Injectable overrides forwarded to
 *   {@link discoverScriptsFromDependencyGraph}.
 * @returns The discovered candidates, sorted by `name`.
 *
 * @example
 * ```ts
 * const candidates = discoverScripts("/path/to/workspace");
 * // one M3LCliScriptCandidate per script resolvable via the declared
 * // dependency graph or found under scripts/*, graph candidates winning ties
 * ```
 */
export function discoverScripts(
  workspaceRoot: string,
  graphOptions?: M3LCliDependencyGraphOptions,
): readonly M3LCliScriptCandidate[] {
  const merged = new Map<string, M3LCliScriptCandidate>();
  for (const candidate of discoverScriptsFromDependencyGraph(graphOptions)) {
    merged.set(candidate.name, candidate);
  }
  for (const candidate of discoverScriptsFromFilesystem(workspaceRoot)) {
    if (!merged.has(candidate.name)) {
      merged.set(candidate.name, candidate);
    }
  }
  return [...merged.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
