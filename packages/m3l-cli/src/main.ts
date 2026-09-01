/**
 * `main` — the m3l CLI's composition root: parses `argv`, dispatches to the
 * static `help`/`--version` commands, lazily to `list`/`inspect`/`run`, or
 * (for any other first positional) lazily to `commands/dynamic.js`'s
 * runtime-registered per-script dispatch, and maps every outcome (including
 * a thrown `M3LCliError` or an unexpected value) to a process exit code
 * without ever throwing or calling `process.exit` itself.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { M3LCliError, exitCodeForError } from "./cli/errors.js";
import { partitionEnvFileFlags, partitionJsonFlag } from "./cli/flags.js";
import type { M3LCliEnvFileSetting } from "./cli/flags.js";
import { printUsage } from "./cli/usage.js";
import {
  resolveCacheFilePath,
  resolveHistoryFilePath,
  resolveOutputDirPath,
} from "./cli/paths.js";
import type { M3LCliExitCode } from "./cli/errors.js";
import type { M3LCliOutput, M3LCliOutputStream } from "./cli/output.js";
import { createOutput } from "./cli/output.js";
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

/**
 * The reserved command names `main.ts` always dispatches statically — these
 * always win over dynamic per-script dispatch (8d), so a script can never be
 * reached under one of these names.
 *
 * A deliberately narrower subset of the full ADR-0042 reserved-name list
 * (`doctor.ts`'s `RESERVED_COMMAND_NAMES`, `commands/dynamic.ts`'s
 * `STATIC_COMMAND_NAMES`, and `bin/lib/script-scaffold.mjs`'s
 * `RESERVED_CLI_NAMES`). `"new"` is dispatched statically here like every
 * other reserved name (U9, issue #533).
 */
const STATIC_COMMAND_NAMES: readonly string[] = [
  "list",
  "inspect",
  "run",
  "doctor",
  "presets",
  "history",
  "new",
  "wizard",
  "completion",
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

/** Builds the shared per-command context, resolving the workspace root. */
function buildCommandContext(
  cwd: string,
  output: M3LCliOutput,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): M3LCliCommandContext {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return {
    workspaceRoot,
    output,
    jsonOutput,
    cacheFilePath: resolveCacheFilePath(workspaceRoot, env),
    historyFilePath: resolveHistoryFilePath(workspaceRoot, env),
    outputDirPath: resolveOutputDirPath(workspaceRoot, env),
    env,
    envFile,
  };
}

/** Lazily loads and runs `list`, so `help`/`--version` never import discovery. */
async function runListCommand(
  output: M3LCliOutput,
  cwd: string,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<M3LCliExitCode> {
  const { runList } = await import("./commands/list.js");
  return runList(buildCommandContext(cwd, output, jsonOutput, env, envFile));
}

/** Lazily loads and runs `inspect`; a missing `<script>` positional is a usage error. */
async function runInspectCommand(
  output: M3LCliOutput,
  cwd: string,
  scriptName: string | undefined,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<M3LCliExitCode> {
  if (scriptName === undefined) {
    output.error(
      "inspect requires a <script> positional — usage: m3l inspect <script>",
    );
    return USAGE_EXIT_CODE;
  }
  const { runInspect } = await import("./commands/inspect.js");
  return runInspect(
    buildCommandContext(cwd, output, jsonOutput, env, envFile),
    scriptName,
  );
}

/**
 * Lazily loads and runs `new`, parsing its own flag surface from the raw
 * post-command argument slice (bypassing `parseStaticCommandArgs`'s
 * json/help-only parser, which would misparse `new`'s own `--purpose`/
 * `--variant` value flags as bare booleans and split their values into
 * `positionals` — the same reason {@link runDynamicCommand} bypasses it
 * for scripts).
 */
async function runNewCommand(
  output: M3LCliOutput,
  cwd: string,
  rawArgs: readonly string[],
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<M3LCliExitCode> {
  const { runNew } = await import("./commands/new.js");
  return runNew(
    buildCommandContext(cwd, output, jsonOutput, env, envFile),
    rawArgs,
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
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  if (scriptName === undefined) {
    output.error(
      "run requires a <script> positional — usage: m3l run <script> -- [args...]",
    );
    return USAGE_EXIT_CODE;
  }
  const { runRun } = await import("./commands/run.js");
  return runRun(
    buildCommandContext(cwd, output, jsonOutput, env, envFile),
    scriptName,
    passthroughArgs,
  );
}

/**
 * Lazily loads and runs `doctor`. Its return type is the general `number`
 * (like {@link runRunCommand}'s), not the narrower {@link M3LCliExitCode} —
 * `runDoctor` always resolves `0`/`1` in practice, but nothing in its own
 * contract restricts that, so this wrapper doesn't assert a narrower type
 * than the callee declares.
 */
async function runDoctorCommand(
  output: M3LCliOutput,
  cwd: string,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const { runDoctor } = await import("./commands/doctor.js");
  return runDoctor(buildCommandContext(cwd, output, jsonOutput, env, envFile));
}

/** Lazily loads and runs `presets`; a missing `<script>` positional is a usage error. */
async function runPresetsCommand(
  output: M3LCliOutput,
  cwd: string,
  scriptName: string | undefined,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<M3LCliExitCode> {
  if (scriptName === undefined) {
    output.error(
      "presets requires a <script> positional — usage: m3l presets <script>",
    );
    return USAGE_EXIT_CODE;
  }
  const { runPresets } = await import("./commands/presets.js");
  return runPresets(
    buildCommandContext(cwd, output, jsonOutput, env, envFile),
    scriptName,
  );
}

/** Lazily loads and runs `history` — no positional required. */
async function runHistoryCommand(
  output: M3LCliOutput,
  cwd: string,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const { runHistory } = await import("./commands/history.js");
  return runHistory(buildCommandContext(cwd, output, jsonOutput, env, envFile));
}

/** Lazily loads and runs `wizard` — no positional required. */
async function runWizardCommand(
  output: M3LCliOutput,
  cwd: string,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const { runWizard } = await import("./commands/wizard.js");
  return runWizard(buildCommandContext(cwd, output, jsonOutput, env, envFile));
}

/**
 * Lazily loads and runs `completion` (U12), parsing its own `<shell>`
 * positional out of the raw post-command argument slice — the same
 * `parseStaticCommandArgs` bypass {@link runNewCommand} uses, so a
 * `--json`-adjacent token can never be mistaken for the positional.
 */
async function runCompletionCommand(
  output: M3LCliOutput,
  cwd: string,
  rawArgs: readonly string[],
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const { runCompletion } = await import("./commands/completion.js");
  return runCompletion(
    buildCommandContext(cwd, output, jsonOutput, env, envFile),
    rawArgs,
  );
}

/**
 * Lazily loads and delegates to `commands/dynamic.js`'s `runDynamic` — the
 * fallback for any first positional that isn't a
 * {@link STATIC_COMMAND_NAMES} entry (8d). Its `--help`/`-h`, unknown-script,
 * and unknown-parameter handling all live in `dynamic.ts`; this wrapper only
 * builds the shared context and threads the raw (unparsed by `main.ts`)
 * pre-`--` argument slice through.
 */
async function runDynamicCommand(
  output: M3LCliOutput,
  cwd: string,
  scriptName: string,
  args: readonly string[],
  passthroughArgs: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const { runDynamic } = await import("./commands/dynamic.js");
  const { jsonOutput } = partitionJsonFlag(args);
  return runDynamic(
    buildCommandContext(cwd, output, jsonOutput, env, envFile),
    scriptName,
    args,
    passthroughArgs,
  );
}

/**
 * Parses the static-command flag surface (`--json`/`--help`) out of
 * `beforeArgs`. Only ever invoked once `beforeArgs[0]` is confirmed to be a
 * recognized static command — for any other (dynamic-script) first
 * positional, `parseArgs`'s non-strict mode would misparse an unrecognized
 * `--flag value` pair (absorbing the flag as a bare boolean and splitting
 * its value into `positionals`), so dynamic dispatch bypasses this
 * entirely and threads the raw `beforeArgs` slice through instead.
 */
function parseStaticCommandArgs(beforeArgs: readonly string[]): {
  readonly positionals: readonly string[];
  readonly jsonOutput: boolean;
  readonly helpRequested: boolean;
} {
  const { values, positionals } = parseArgs({
    args: [...beforeArgs],
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  return {
    positionals,
    jsonOutput: values["json"] === true,
    helpRequested: values["help"] === true,
  };
}

/** The shared inputs every {@link StaticCommandHandler} may draw from. */
interface StaticCommandHandlerArgs {
  readonly positionals: readonly string[];
  readonly beforeArgs: readonly string[];
  readonly passthroughArgs: readonly string[];
  readonly output: M3LCliOutput;
  readonly cwd: string;
  readonly jsonOutput: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envFile: M3LCliEnvFileSetting;
}

/** One entry of {@link STATIC_COMMAND_HANDLERS}. */
type StaticCommandHandler = (args: StaticCommandHandlerArgs) => Promise<number>;

/**
 * Maps each {@link STATIC_COMMAND_NAMES} entry (other than `help`, handled
 * earlier in {@link dispatch}) to its dispatcher — a lookup table rather than
 * a `switch` so {@link dispatchStaticCommandByName} stays a single indexed
 * lookup, keeping its cyclomatic complexity under the ESLint `complexity`
 * ceiling as the static command table grows (8f added `presets`/`history`;
 * U9 added `new`); no behavioral difference from a `switch` would make.
 */
const STATIC_COMMAND_HANDLERS: Readonly<Record<string, StaticCommandHandler>> =
  {
    inspect: ({ positionals, output, cwd, jsonOutput, env, envFile }) =>
      runInspectCommand(output, cwd, positionals[1], jsonOutput, env, envFile),
    run: ({
      positionals,
      passthroughArgs,
      output,
      cwd,
      jsonOutput,
      env,
      envFile,
    }) =>
      runRunCommand(
        output,
        cwd,
        positionals[1],
        passthroughArgs,
        jsonOutput,
        env,
        envFile,
      ),
    list: ({ output, cwd, jsonOutput, env, envFile }) =>
      runListCommand(output, cwd, jsonOutput, env, envFile),
    doctor: ({ output, cwd, jsonOutput, env, envFile }) =>
      runDoctorCommand(output, cwd, jsonOutput, env, envFile),
    presets: ({ positionals, output, cwd, jsonOutput, env, envFile }) =>
      runPresetsCommand(output, cwd, positionals[1], jsonOutput, env, envFile),
    history: ({ output, cwd, jsonOutput, env, envFile }) =>
      runHistoryCommand(output, cwd, jsonOutput, env, envFile),
    new: ({ beforeArgs, output, cwd, jsonOutput, env, envFile }) =>
      runNewCommand(output, cwd, beforeArgs.slice(1), jsonOutput, env, envFile),
    wizard: ({ output, cwd, jsonOutput, env, envFile }) =>
      runWizardCommand(output, cwd, jsonOutput, env, envFile),
    completion: ({ beforeArgs, output, cwd, jsonOutput, env, envFile }) =>
      runCompletionCommand(
        output,
        cwd,
        beforeArgs.slice(1),
        jsonOutput,
        env,
        envFile,
      ),
  };

/**
 * Dispatches by the already-confirmed static command name via
 * {@link STATIC_COMMAND_HANDLERS} — split out of {@link dispatchStaticCommand}
 * purely to keep that caller's own complexity down; no behavioral difference
 * from inlining the lookup would make.
 *
 * `command` can only be
 * `"list"`/`"inspect"`/`"run"`/`"doctor"`/`"presets"`/`"history"`/`"new"`/
 * `"wizard"`/`"completion"` at runtime (see {@link dispatchStaticCommand}'s doc) — anything else is a
 * caller contract violation, not a normal path, and `command`'s static type
 * is the general `string | undefined` (not a literal union `parseArgs`'s
 * `positionals` can't express), so this can't be a compile-checked `never`
 * exhaustiveness assertion.
 */
async function dispatchStaticCommandByName(
  command: string | undefined,
  positionals: readonly string[],
  beforeArgs: readonly string[],
  passthroughArgs: readonly string[],
  output: M3LCliOutput,
  cwd: string,
  jsonOutput: boolean,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const handler =
    command === undefined ? undefined : STATIC_COMMAND_HANDLERS[command];
  if (handler === undefined) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_COMMAND",
      `unreachable dispatchStaticCommand command '${command ?? ""}'`,
    );
  }
  return handler({
    positionals,
    beforeArgs,
    passthroughArgs,
    output,
    cwd,
    jsonOutput,
    env,
    envFile,
  });
}

/**
 * Dispatches one of the `list`/`inspect`/`run`/`doctor`/`presets`/`history`
 * static commands — invoked only once `beforeArgs[0]` is confirmed to be a
 * {@link STATIC_COMMAND_NAMES} entry other than `help` (handled earlier in
 * {@link dispatch}), so `positionals[0]` can only ever be one of those names
 * by the time {@link dispatchStaticCommandByName}'s switch runs.
 *
 * Also restores the pre-8d behavior of recognizing a `--version` flag
 * anywhere in `beforeArgs` (not just as the very first token, which
 * {@link dispatch} already handles before this function is ever called) —
 * e.g. `m3l list --version` prints the version instead of running `list`.
 * This is confined to the static-command path: a dynamic script invocation
 * never reaches this function, so a script's own `--version` parameter is
 * never intercepted.
 *
 * V2 slice 1 (#539 / ADR-0063): `run <script> --help` redirects to
 * `inspect <script>` instead of the generic usage text — the same
 * `--help`/`-h` symmetry `commands/dynamic.ts` already has for dynamic
 * dispatch. Only `run` with a `<script>` positional present redirects; every
 * other static command's `--help` (including bare `run --help`) still prints
 * generic usage.
 */
async function dispatchStaticCommand(
  beforeArgs: readonly string[],
  passthroughArgs: readonly string[],
  output: M3LCliOutput,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  envFile: M3LCliEnvFileSetting,
): Promise<number> {
  const { positionals, jsonOutput, helpRequested } =
    parseStaticCommandArgs(beforeArgs);

  if (helpRequested) {
    if (positionals[0] === "run" && positionals[1] !== undefined) {
      return runInspectCommand(
        output,
        cwd,
        positionals[1],
        jsonOutput,
        env,
        envFile,
      );
    }
    printUsage(output);
    return 0;
  }

  if (beforeArgs.includes("--version")) {
    output.info(readCliVersion());
    return 0;
  }

  return dispatchStaticCommandByName(
    positionals[0],
    positionals,
    beforeArgs,
    passthroughArgs,
    output,
    cwd,
    jsonOutput,
    env,
    envFile,
  );
}

/** Parses `argv` and dispatches to the matching static, lazy, or dynamic command. */
async function dispatch(
  argv: readonly string[],
  output: M3LCliOutput,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const { beforeArgs: rawBeforeArgs, passthroughArgs } =
    splitAtFirstDoubleDash(argv);
  // Stripped here, ahead of the static/dynamic split, for a correctness
  // reason and not just tidiness: `parseStaticCommandArgs` parses with
  // `strict: false`, so a detached `--env-file staging.env` would be absorbed
  // as a bare boolean and its value would land in `positionals` — making
  // `m3l run --env-file staging.env json-etl` resolve "staging.env" as the
  // script name.
  const { envFile, rest: beforeArgs } = partitionEnvFileFlags(
    rawBeforeArgs,
    cwd,
  );

  if (beforeArgs.length === 0) {
    printUsage(output);
    return 0;
  }

  const firstToken = beforeArgs[0] ?? "";
  if (firstToken === "help" || firstToken === "--help" || firstToken === "-h") {
    printUsage(output);
    return 0;
  }
  if (firstToken === "--version") {
    output.info(readCliVersion());
    return 0;
  }

  if (STATIC_COMMAND_NAMES.includes(firstToken)) {
    return dispatchStaticCommand(
      beforeArgs,
      passthroughArgs,
      output,
      cwd,
      env,
      envFile,
    );
  }

  return runDynamicCommand(
    output,
    cwd,
    firstToken,
    beforeArgs.slice(1),
    passthroughArgs,
    env,
    envFile,
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
