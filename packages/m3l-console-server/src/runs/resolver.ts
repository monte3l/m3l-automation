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

import { SCRIPT_NAME_PATTERN } from "./parameters.js";

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
 * Resolves `scriptName` to its directory under `scriptsRoot`.
 *
 * Validates `scriptName` against the same kebab-case pattern
 * `runs/parameters`'s `parseRunRequest` enforces, rejecting an invalid
 * pattern with `"ERR_CONSOLE_BAD_REQUEST"` before ever touching the
 * filesystem. Rejects a `scriptName` with no corresponding directory with
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"`.
 *
 * @param scriptName - The requested script's kebab-case name.
 * @param scriptsRoot - The run governor's configured scripts root.
 * @returns The resolved {@link M3LResolvedScript}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `scriptName` fails the kebab-case pattern, or
 *   `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` when no directory exists for it.
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
  if (!fs.existsSync(scriptDir)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      `no script directory was found for '${scriptName}'`,
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
