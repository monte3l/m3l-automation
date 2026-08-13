/**
 * `discovery/discover` — workspace-root resolution and `scripts/*` candidate
 * enumeration.
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { M3LCliError } from "../cli/errors.js";

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
 * a `package.json`.
 *
 * @param workspaceRoot - The resolved workspace root (see
 *   {@link resolveWorkspaceRoot}).
 * @returns The discovered candidates, sorted by `name`; `[]` when
 *   `scripts/` does not exist.
 *
 * @example
 * ```ts
 * const candidates = discoverScripts("/path/to/workspace");
 * // one M3LCliScriptCandidate per scripts/* directory holding a package.json
 * ```
 */
export function discoverScripts(
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
