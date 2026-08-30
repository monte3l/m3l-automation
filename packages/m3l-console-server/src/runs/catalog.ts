/**
 * `runs/catalog` — enumerates the "launchable scripts" under the run
 * governor's configured scripts root, and reads a single one by name. A
 * directory counts as a launchable script only when its name is kebab-case
 * AND `Core.resolveConfigModulePath` can resolve a config module for it —
 * this keeps `listScriptSummaries` and `readScriptSummary` consistent, so
 * the UI can never render a row from the list endpoint that then 404s from
 * the detail endpoint.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

import { SCRIPT_NAME_PATTERN } from "./parameters.js";
import { executionModeForScript, resolveScript } from "./resolver.js";
import type { M3LResolvedScript } from "./resolver.js";
import type { RunExecutionMode } from "../store/runs-repository.js";

/**
 * Maximum number of characters a script's `package.json` `description`
 * field renders as before being truncated. This is script-authored text
 * crossing an HTTP boundary, so the response must stay bounded regardless
 * of how large the sibling `package.json` file declares its description.
 */
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * A launchable script's summary, as returned by `GET /api/v1/scripts` and
 * embedded in `readScriptSummary`'s result.
 *
 * @example
 * ```ts
 * const summary: M3LScriptSummary = {
 *   name: "sqs-etl",
 *   description: "Extracts data from SQS.",
 *   hasCommandModule: false,
 *   executionMode: "spawn",
 * };
 * ```
 */
export interface M3LScriptSummary {
  /** The script's kebab-case directory name. */
  readonly name: string;
  /**
   * The script's `package.json` `description`, verbatim, truncated to
   * {@link MAX_DESCRIPTION_LENGTH} characters. `""` when the field is
   * missing, unreadable, invalid JSON, or not a string.
   */
  readonly description: string;
  /** Whether `<scriptDir>/dist/command.js` exists (ADR-0022's script entry point). */
  readonly hasCommandModule: boolean;
  /** The execution mode {@link executionModeForScript} derives from `hasCommandModule`. */
  readonly executionMode: RunExecutionMode;
}

/**
 * Reads a script directory's `package.json` `description` field.
 *
 * Deliberate best-effort fallback, not a swallowed fault: the description is
 * cosmetic display metadata for a catalog listing, and one malformed
 * sibling `package.json` (missing file, unreadable, invalid JSON, or a
 * non-string `description`) must not take down the whole catalog. Every
 * failure mode below returns `""` on purpose.
 *
 * @param scriptDir - The script's absolute directory.
 * @returns The description, truncated to {@link MAX_DESCRIPTION_LENGTH}
 *   characters, or `""` on any failure.
 */
function readScriptDescription(scriptDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(scriptDir, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return "";
    }
    const description = (parsed as Record<string, unknown>)["description"];
    if (!Core.isString(description)) {
      return "";
    }
    return description.slice(0, MAX_DESCRIPTION_LENGTH);
  } catch {
    // Best-effort fallback (see this function's own TSDoc): any failure —
    // missing file, unreadable, invalid JSON — degrades to "" rather than
    // failing the whole catalog listing.
    return "";
  }
}

/** Builds an {@link M3LScriptSummary} from an already-resolved script. */
function buildSummary(resolved: M3LResolvedScript): M3LScriptSummary {
  return {
    name: resolved.name,
    description: readScriptDescription(resolved.scriptDir),
    hasCommandModule: resolved.hasCommandModule,
    executionMode: executionModeForScript(resolved),
  };
}

/**
 * Whether `entry` is a directory that both matches {@link SCRIPT_NAME_PATTERN}
 * and has a resolvable config module — i.e. is a "launchable script" per
 * this module's own header TSDoc.
 *
 * A symlinked directory is deliberately excluded: `Dirent.isDirectory()`
 * reports `false` for a symlink (`isSymbolicLink()` reports `true` instead),
 * so a symlinked script directory never enters the catalog. This is the
 * intended, fail-closed behaviour, not an oversight.
 */
function isLaunchableScriptEntry(
  entry: fs.Dirent,
  scriptsRoot: string,
): boolean {
  if (!entry.isDirectory()) {
    return false;
  }
  if (!SCRIPT_NAME_PATTERN.test(entry.name)) {
    return false;
  }
  try {
    Core.resolveConfigModulePath(path.join(scriptsRoot, entry.name));
    return true;
  } catch (cause) {
    if (
      cause instanceof Core.M3LError &&
      cause.code === "ERR_CONFIG_MODULE_NOT_FOUND"
    ) {
      return false;
    }
    throw cause;
  }
}

/**
 * Lists every launchable script under `scriptsRoot`, sorted ascending by
 * name.
 *
 * A direct child directory qualifies when its name matches
 * {@link SCRIPT_NAME_PATTERN} AND `Core.resolveConfigModulePath` resolves a
 * config module for it without throwing — a directory with neither
 * `dist/config.js` nor `src/config.ts` is not a launchable script and is
 * excluded, so this list and {@link readScriptSummary} stay consistent.
 *
 * Sorted with a plain `<`/`>` comparison, not `localeCompare`, so ordering
 * does not depend on the server's locale.
 *
 * @param scriptsRoot - The run governor's configured scripts root.
 * @returns Every launchable script's summary, ascending by name.
 * @throws {@link M3LConsoleError} with code
 *   `"ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED"` when the scripts root
 *   itself cannot be enumerated.
 *
 * @example
 * ```ts
 * import { listScriptSummaries } from "./runs/catalog.js";
 *
 * const summaries = listScriptSummaries("/opt/scripts");
 * // [{ name: "sqs-etl", description: "...", hasCommandModule: false, executionMode: "spawn" }, ...]
 * ```
 */
export function listScriptSummaries(
  scriptsRoot: string,
): readonly M3LScriptSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scriptsRoot, { withFileTypes: true });
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
      "failed to enumerate the scripts directory",
      { cause, context: { scriptsRoot } },
    );
  }

  const names = entries
    .filter((entry) => isLaunchableScriptEntry(entry, scriptsRoot))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return names.map((name) => buildSummary(resolveScript(name, scriptsRoot)));
}

/**
 * Reads a single launchable script's summary by name.
 *
 * Resolves `name` via {@link resolveScript} first — a non-kebab-case name or
 * a missing directory propagates unchanged as `"ERR_CONSOLE_BAD_REQUEST"` or
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` respectively. A directory that
 * exists but carries no config module maps to
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` as well: that is a caller-facing 404
 * (no launchable script by that name), not a server fault.
 *
 * @param name - The requested script's kebab-case name.
 * @param scriptsRoot - The run governor's configured scripts root.
 * @returns The script's summary.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` for a
 *   non-kebab-case name, or `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` when no
 *   launchable script exists under that name.
 *
 * @example
 * ```ts
 * import { readScriptSummary } from "./runs/catalog.js";
 *
 * const summary = readScriptSummary("sqs-etl", "/opt/scripts");
 * // { name: "sqs-etl", description: "...", hasCommandModule: false, executionMode: "spawn" }
 * ```
 */
export function readScriptSummary(
  name: string,
  scriptsRoot: string,
): M3LScriptSummary {
  const resolved = resolveScript(name, scriptsRoot);

  try {
    Core.resolveConfigModulePath(resolved.scriptDir);
  } catch (cause) {
    if (
      cause instanceof Core.M3LError &&
      cause.code === "ERR_CONFIG_MODULE_NOT_FOUND"
    ) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
        `no launchable script named '${name}'`,
        { cause, context: { name, scriptDir: resolved.scriptDir } },
      );
    }
    throw cause;
  }

  return buildSummary(resolved);
}
