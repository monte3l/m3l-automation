/**
 * `runs/resolver` — resolves a requested script name to its on-disk
 * directory under the run governor's configured scripts root, and detects
 * whether it carries an ADR-0022-shaped `src/command.ts` entry point.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { M3LConsoleError } from "../errors/console-error.js";
import type { RunExecutionMode } from "../store/runs-repository.js";

import { SCRIPT_NAME_PATTERN } from "./parameters.js";

/**
 * The longest caller-supplied `scriptName` ever echoed into a
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` message. A pattern-valid name can
 * still be attacker-chosen and arbitrarily long (the pattern only bounds
 * the character set, not the length), and `message` crosses the HTTP
 * boundary unbounded via the error envelope — so it is truncated here
 * before being interpolated, the same way `http/routes/runs.ts`'s
 * `MAX_ECHOED_STATUS_LENGTH` bounds a rejected `?status=` value.
 */
const MAX_ECHOED_SCRIPT_NAME_LENGTH = 32;

/**
 * A script resolved against the run governor's scripts root.
 *
 * @example
 * ```ts
 * const resolved: M3LResolvedScript = {
 *   name: "sqs-etl",
 *   scriptsRoot: "/opt/scripts",
 *   scriptDir: "/opt/scripts/sqs-etl",
 *   hasCommandModule: true,
 * };
 * ```
 */
export interface M3LResolvedScript {
  /** The requested script name. */
  readonly name: string;
  /** The scripts root it was resolved against. */
  readonly scriptsRoot: string;
  /** The script's resolved directory, `path.join(scriptsRoot, name)`. */
  readonly scriptDir: string;
  /** Whether `<scriptDir>/dist/command.js` exists (ADR-0022's script entry point). */
  readonly hasCommandModule: boolean;
}

/**
 * Truncates `scriptName` to {@link MAX_ECHOED_SCRIPT_NAME_LENGTH} characters
 * for safe interpolation into a caller-facing error message.
 */
function truncateEchoedName(scriptName: string): string {
  return scriptName.slice(0, MAX_ECHOED_SCRIPT_NAME_LENGTH);
}

/**
 * Whether `scriptDir`'s final path component (the `scriptName` directory
 * entry itself) is a symlink. `scriptName` is already validated against
 * {@link SCRIPT_NAME_PATTERN} (no `/`, no `..`), so the only place an
 * attacker can plant a symlink within `scriptDir` is this last segment —
 * an already-trusted, operator-configured `scriptsRoot` (which may itself
 * sit behind a symlinked parent path, see {@link isContained}) is not part
 * of the attack surface this guards.
 *
 * Fails **closed**: when `lstatSync` itself throws, the entry cannot be
 * classified and is treated as if it *were* a symlink, so
 * {@link isContainedSymlink}'s realpath equality check still runs rather
 * than being skipped. This matters beyond the `ENOENT` TOCTOU case (where
 * nothing remains at the path to import) — an `EACCES`-style failure means
 * something still *does* exist at `scriptDir` that simply could not be
 * stat'd (e.g. a permission-denied intermediate directory), and trusting an
 * un-classifiable entry by default would be exactly the fail-open bug
 * containment exists to prevent. `m3l-common`'s `safeIsSecret` follows the
 * same convention: an unclassifiable input is treated as the more
 * restrictive case, never the more permissive one. The cost of failing
 * closed here is that an un-statable-but-legitimate directory now degrades
 * to `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` (via {@link isContainedSymlink}'s
 * own fail-closed `catch`) instead of resolving — a 404 rather than a
 * possible escape, which is the correct direction for this control.
 */
function isSymlinkEntry(scriptDir: string): boolean {
  try {
    return fs.lstatSync(scriptDir).isSymbolicLink();
  } catch {
    return true;
  }
}

/**
 * Whether a `scriptDir` whose final entry is a symlink still realpath's to
 * exactly `path.join(realpath(scriptsRoot), scriptName)` — i.e. resolves to
 * a real, direct child of the real scripts root, not an escape to
 * somewhere else on disk or an alias of a sibling script directory. Full
 * realpath equality (not a `startsWith` prefix check) is required so that
 * a `scriptsRoot` itself reached through a symlinked parent path still
 * resolves its real children correctly — realpath'ing both sides handles
 * that case, a `startsWith` against the raw root would not. A
 * `realpathSync` failure (dangling symlink target, vanished directory) is
 * treated as "not contained" rather than propagating a raw `Error`.
 */
function isContainedSymlink(
  scriptDir: string,
  scriptsRoot: string,
  scriptName: string,
): boolean {
  try {
    const realScriptsRoot = fs.realpathSync(scriptsRoot);
    const realScriptDir = fs.realpathSync(scriptDir);
    return realScriptDir === path.join(realScriptsRoot, scriptName);
  } catch {
    return false;
  }
}

/**
 * Whether `scriptDir` is safe to resolve `scriptName` to: either it is not
 * a symlink at all (an ordinary directory, always contained), or it is a
 * symlink that still realpath's inside `scriptsRoot` under its own name
 * (see {@link isContainedSymlink}).
 */
function isContained(
  scriptDir: string,
  scriptsRoot: string,
  scriptName: string,
): boolean {
  if (!isSymlinkEntry(scriptDir)) {
    return true;
  }
  return isContainedSymlink(scriptDir, scriptsRoot, scriptName);
}

/**
 * Resolves `scriptName` to its directory under `scriptsRoot`.
 *
 * Validates `scriptName` against the same kebab-case pattern
 * `runs/parameters`'s `parseRunRequest` enforces, rejecting an invalid
 * pattern with `"ERR_CONSOLE_BAD_REQUEST"` before ever touching the
 * filesystem. Rejects a `scriptName` with no corresponding directory with
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"`.
 *
 * **Symlink containment (defends against a confirmed exploit):** both
 * `scriptsRoot` and the resolved `scriptDir` are realpath'd, and the real
 * script directory must equal `path.join(realpath(scriptsRoot), scriptName)`
 * exactly — not merely share a parent directory. Without this, a symlink
 * planted inside `scriptsRoot` (or aliasing a sibling script directory)
 * resolves via a plain `fs.existsSync`/`path.join`, which follows symlinks,
 * letting a request for the symlink's name reach and execute whatever
 * config module sits at the symlink's target — on the X4 run-launch path,
 * that target gets imported and run. Realpath'ing both sides (rather than a
 * `startsWith` check against the raw root) also keeps a `scriptsRoot` that
 * is itself reached through a symlinked parent resolving its real children
 * correctly. A `realpathSync` failure (a dangling symlink, or the target
 * having vanished) is treated the same as "not found", never allowed to
 * escape as a raw `Error`.
 *
 * @param scriptName - The requested script's kebab-case name.
 * @param scriptsRoot - The run governor's configured scripts root.
 * @returns The resolved {@link M3LResolvedScript}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `scriptName` fails the kebab-case pattern, or
 *   `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` when no directory exists for it, or
 *   the resolved directory escapes `scriptsRoot` via a symlink.
 *
 * @example
 * ```ts
 * import { resolveScript } from "./runs/resolver.js";
 *
 * const resolved = resolveScript("sqs-etl", "/opt/scripts");
 * // { name: "sqs-etl", scriptsRoot: "/opt/scripts", scriptDir: "/opt/scripts/sqs-etl", hasCommandModule: true }
 * ```
 */
export function resolveScript(
  scriptName: string,
  scriptsRoot: string,
): M3LResolvedScript {
  if (!SCRIPT_NAME_PATTERN.test(scriptName)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid script name '${scriptName}': must be a kebab-case identifier`,
      { context: { scriptName } },
    );
  }

  const scriptDir = path.join(scriptsRoot, scriptName);
  if (
    !fs.existsSync(scriptDir) ||
    !isContained(scriptDir, scriptsRoot, scriptName)
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      `no script directory was found for '${truncateEchoedName(scriptName)}'`,
      { context: { scriptName, scriptDir } },
    );
  }

  const hasCommandModule = fs.existsSync(
    path.join(scriptDir, "dist", "command.js"),
  );

  return {
    name: scriptName,
    scriptsRoot,
    scriptDir,
    hasCommandModule,
  };
}

/**
 * Whether a resolved script runs as a spawned subprocess or in-process
 * (ADR-0054): a script that ships a `dist/command.js` entry point runs
 * in-process, every other script runs as a spawned subprocess.
 *
 * @param resolved - The script previously resolved by {@link resolveScript}.
 * @returns `"in-process"` when `resolved.hasCommandModule` is `true`,
 *   otherwise `"spawn"`.
 *
 * @example
 * ```ts
 * import { executionModeForScript, resolveScript } from "./runs/resolver.js";
 *
 * const resolved = resolveScript("sqs-etl", "/opt/scripts");
 * const mode = executionModeForScript(resolved);
 * // "in-process" | "spawn"
 * ```
 */
export function executionModeForScript(
  resolved: M3LResolvedScript,
): RunExecutionMode {
  return resolved.hasCommandModule ? "in-process" : "spawn";
}
