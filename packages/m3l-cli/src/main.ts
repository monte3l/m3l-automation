/**
 * `main` — the m3l CLI's composition root: parses `argv`, dispatches to the
 * static `help`/`--version` commands or lazily to `list`/`inspect`, and maps
 * every outcome (including a thrown `M3LCliError` or an unexpected value) to
 * a process exit code without ever throwing or calling `process.exit`
 * itself.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { M3LCliError, exitCodeForError } from "./cli/errors.js";
import type { M3LCliExitCode } from "./cli/errors.js";
import type { M3LCliOutput, M3LCliOutputStream } from "./cli/output.js";
import { createOutput } from "./cli/output.js";
import { suggestNames } from "./cli/suggest.js";
import type { M3LCliCommandContext } from "./commands/context.js";
import { resolveWorkspaceRoot } from "./discovery/discover.js";

/** Optional overrides `runCli` accepts in place of the real process globals. */
export interface M3LCliRunOptions {
  /** The stream `info`/`heading` output writes to; defaults to `process.stdout`. */
  readonly stdout?: M3LCliOutputStream;
  /** The stream `error` output writes to; defaults to `process.stderr`. */
  readonly stderr?: M3LCliOutputStream;
  /** The environment consulted for color-override precedence; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The working directory workspace resolution starts from; defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** Exit code for a usage error (unknown command, missing required positional). */
const USAGE_EXIT_CODE: M3LCliExitCode = 2;

/** The command names `main.ts` currently dispatches statically (phase 8c). */
const STATIC_COMMAND_NAMES: readonly string[] = [
  "list",
  "inspect",
  "run",
  "help",
];

/**
 * The minimal shape this module trusts `package.json` to declare — read
 * relative to this module's own location (`src/main.ts` and, once compiled,
 * `dist/main.js` both sit exactly one directory below the package root, so
 * the same `../package.json` traversal resolves correctly either way).
 */
interface M3LCliPackageManifest {
  readonly version: string;
}

/** Reads this package's own declared `version` for `--version`. */
function readCliVersion(): string {
  const packageJsonPath = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const manifest = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  ) as M3LCliPackageManifest;
  return manifest.version;
}

/** Prints the hand-written usage text (`parseArgs` generates none). */
function printUsage(output: M3LCliOutput): void {
  output.info("Usage: m3l <command> [options]");
  output.info("");
  output.info("Commands:");
  output.info("  list                       List every scripts/* package");
  output.info(
    "  inspect <script>           Show a script's declared parameters",
  );
  output.info(
    "  run <script> -- [args...]  Run a script, forwarding args after '--' verbatim",
  );
  output.info("  help                       Show this help message");
  output.info("");
  output.info("Flags:");
  output.info("  --json      Machine-readable output");
  output.info("  --version   Print the CLI version");
  output.info("  -h, --help  Show this help message");
}

/**
 * Splits `argv` at the first bare `--`, so `parseArgs` never sees anything
 * after it — the m3l-cli 8c contract for `run <script> -- [args...]`:
 * everything after the first `--` passes through to the spawned script
 * verbatim, even flags shaped like `main.ts`'s own (`--json`, `--help`).
 */
function splitAtFirstDoubleDash(argv: readonly string[]): {
  readonly beforeArgs: readonly string[];
  readonly passthroughArgs: readonly string[];
} {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return { beforeArgs: argv, passthroughArgs: [] };
  }
  return {
    beforeArgs: argv.slice(0, separatorIndex),
    passthroughArgs: argv.slice(separatorIndex + 1),
  };
}

/**
 * The environment variable `@m3l-automation/m3l-common`'s `M3LPaths`
 * honors to redirect its cache directory (see
 * `M3LPathEnvironmentVariables.CACHE_DIR` in `core/utils/M3LPaths.ts`).
 * Consulted directly here — rather
 * than by constructing an `M3LPaths` instance — because `M3LPaths` detects
 * its base via the `M3LExecutionEnvironment` process-global singleton, which
 * would ignore the `cwd` this module already threads through for
 * testability.
 */
const CACHE_DIR_ENV_VAR = "M3L_CACHE_DIR";

/**
 * Resolves the discovery cache file's absolute path: under the
 * {@link CACHE_DIR_ENV_VAR} override when set in `env`, otherwise under
 * `<workspaceRoot>/data/cache`.
 */
function resolveCacheFilePath(
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const cacheDirOverride = env[CACHE_DIR_ENV_VAR];
  const cacheDir =
    cacheDirOverride !== undefined && cacheDirOverride !== ""
      ? cacheDirOverride
      : join(workspaceRoot, "data", "cache");
  return join(cacheDir, "m3l-cli", "discovery.json");
}

/** Builds the shared per-command context, resolving the workspace root. */
function buildCommandContext(
  cwd: string,
  output: M3LCliOutput,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
): M3LCliCommandContext {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return {
    workspaceRoot,
    output,
    jsonOutput,
    cacheFilePath: resolveCacheFilePath(workspaceRoot, env),
  };
}

/** Lazily loads and runs `list`, so `help`/`--version` never import discovery. */
async function runListCommand(
  output: M3LCliOutput,
  cwd: string,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Promise<M3LCliExitCode> {
  const { runList } = await import("./commands/list.js");
  return runList(buildCommandContext(cwd, output, jsonOutput, env));
}

/** Lazily loads and runs `inspect`; a missing `<script>` positional is a usage error. */
async function runInspectCommand(
  output: M3LCliOutput,
  cwd: string,
  scriptName: string | undefined,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Promise<M3LCliExitCode> {
  if (scriptName === undefined) {
    output.error(
      "inspect requires a <script> positional — usage: m3l inspect <script>",
    );
    return USAGE_EXIT_CODE;
  }
  const { runInspect } = await import("./commands/inspect.js");
  return runInspect(
    buildCommandContext(cwd, output, jsonOutput, env),
    scriptName,
  );
}

/**
 * Lazily loads and runs `run`; a missing `<script>` positional is a usage
 * error. The spawned script's exit code propagates verbatim (not clamped to
 * `M3LCliExitCode`).
 */
async function runRunCommand(
  output: M3LCliOutput,
  cwd: string,
  scriptName: string | undefined,
  passthroughArgs: readonly string[],
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (scriptName === undefined) {
    output.error(
      "run requires a <script> positional — usage: m3l run <script> -- [args...]",
    );
    return USAGE_EXIT_CODE;
  }
  const { runRun } = await import("./commands/run.js");
  return runRun(
    buildCommandContext(cwd, output, jsonOutput, env),
    scriptName,
    passthroughArgs,
  );
}

/** Parses `argv` and dispatches to the matching static or lazy command. */
async function dispatch(
  argv: readonly string[],
  output: M3LCliOutput,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const { beforeArgs, passthroughArgs } = splitAtFirstDoubleDash(argv);

  const { values, positionals } = parseArgs({
    args: [...beforeArgs],
    options: {
      json: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0];
  if (
    beforeArgs.length === 0 ||
    command === "help" ||
    values["help"] === true
  ) {
    printUsage(output);
    return 0;
  }
  if (values["version"] === true) {
    output.info(readCliVersion());
    return 0;
  }

  const jsonOutput = values["json"] === true;
  if (command === "list") {
    return runListCommand(output, cwd, jsonOutput, env);
  }
  if (command === "inspect") {
    return runInspectCommand(output, cwd, positionals[1], jsonOutput, env);
  }
  if (command === "run") {
    return runRunCommand(
      output,
      cwd,
      positionals[1],
      passthroughArgs,
      jsonOutput,
      env,
    );
  }

  const unknownCommand = command ?? "";
  throw new M3LCliError(
    "ERR_CLI_UNKNOWN_COMMAND",
    `unknown command '${unknownCommand}'`,
    { suggestions: suggestNames(unknownCommand, STATIC_COMMAND_NAMES) },
  );
}

/**
 * Formats an `M3LCliError`'s message, appending a "Did you mean" hint when
 * suggestions exist and a `caused by:` line when its `cause` is an `Error`
 * (one level deep — the cause's own `cause`, if any, is not recursed into).
 */
function formatCliErrorMessage(error: M3LCliError): string {
  let message = error.message;
  if (error.suggestions.length > 0) {
    message += `\nDid you mean: ${error.suggestions.join(", ")}?`;
  }
  if (error.cause instanceof Error) {
    message += `\n  caused by: ${error.cause.message}`;
  }
  return message;
}

/** Maps any caught value to its process exit code, printing it via `output.error`. */
function reportError(output: M3LCliOutput, error: unknown): M3LCliExitCode {
  if (error instanceof M3LCliError) {
    output.error(formatCliErrorMessage(error));
  } else {
    output.error(String(error));
  }
  return exitCodeForError(error);
}

/**
 * Runs the m3l CLI: parses `argv`, dispatches to the matching command, and
 * resolves to a process exit code. Never throws and never calls
 * `process.exit` — callers (the `bin/m3l.mjs` wrapper) assign the resolved
 * number to `process.exitCode` themselves.
 *
 * The return type is the general `number`, not the narrower
 * {@link M3LCliExitCode}: every CLI-originated outcome (success, a usage
 * error, an `M3LCliError` mapped through `exitCodeForError`) still resolves
 * to `0`/`1`/`2`, but `run <script>` propagates the spawned child's raw exit
 * code verbatim, which is not restricted to that range.
 *
 * @param argv - The CLI arguments, excluding the `node`/script path
 *   (typically `process.argv.slice(2)`).
 * @param options - Optional stream/env/cwd overrides; each defaults to the
 *   corresponding `process` global.
 * @returns `0` on success, `2` for a usage error (unknown command, unknown
 *   script, missing required positional), `1` for every other CLI-originated
 *   failure; for `run <script>`, the spawned child's exit code verbatim.
 *
 * @example
 * ```ts
 * // as `bin/m3l.mjs` calls it against the compiled dist/main.js
 * const { runCli } = await import("../dist/main.js");
 * process.exitCode = await runCli(process.argv.slice(2));
 * ```
 */
export async function runCli(
  argv: readonly string[],
  options: M3LCliRunOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const output = createOutput({
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env,
  });
  const cwd = options.cwd ?? process.cwd();

  try {
    return await dispatch(argv, output, cwd, env);
  } catch (error) {
    return reportError(output, error);
  }
}
