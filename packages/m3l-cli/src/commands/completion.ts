/**
 * `commands/completion` — `m3l completion <bash|zsh|fish>` (U12, issue #536):
 * prints a self-contained shell-completion script with the command set and
 * the discovered script names baked in.
 *
 * Statically generated, not callback-driven: a `m3l`-invoking completion
 * callback would put the CLI's full Node startup cost on every TAB press,
 * and everything this command completes is knowable at generation time. The
 * cost is that the script goes stale — regenerate after adding a
 * `scripts/*` package.
 *
 * @packageDocumentation
 */

import type { M3LCliCommandContext } from "./context.js";
import { M3LCliError } from "../cli/errors.js";
import type { M3LCliExitCode } from "../cli/errors.js";
import { IN_PROCESS_FLAG, JSON_FLAG } from "../cli/flags.js";
import { suggestNames } from "../cli/suggest.js";
import {
  M3L_CLI_COMPLETION_SHELLS,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
} from "../cli/completion-script.js";
import type {
  M3LCliCompletionModel,
  M3LCliCompletionOperationSet,
  M3LCliCompletionScript,
  M3LCliCompletionShell,
} from "../cli/completion-script.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";
import { RESERVED_CLI_NAMES } from "../scaffold/manifest.js";

/** Exit code for a usage error, mirroring `main.ts`'s own constant. */
const USAGE_EXIT_CODE: M3LCliExitCode = 2;

/** An alias of this length renders as `-x`; anything longer renders as `--xy`. */
const SHORT_FLAG_LENGTH = 1;

/**
 * The static commands that take an **existing** `<script>` positional, so
 * completion offers discovered script names at position 2. `new` is
 * deliberately absent: its positional is a name that must *not* exist yet.
 */
const SCRIPT_POSITIONAL_COMMANDS: readonly string[] = [
  "inspect",
  "presets",
  "run",
];

/**
 * The CLI-reserved flags valid on any invocation. `--version` and
 * `--help`/`-h` are recognized by `main.ts` itself; `--json` is stripped by
 * `parseStaticCommandArgs` and `partitionJsonFlag` before any command sees
 * it.
 */
const GLOBAL_FLAGS: readonly string[] = [
  JSON_FLAG,
  "--help",
  "-h",
  "--version",
];

/**
 * The CLI-reserved flags valid only on dynamic per-script dispatch (ADR-0054
 * U7, ADR-0063). `--dry-run` is not a direct flag — it is honoured among the
 * tokens after the `--` separator — but it is a token a user types on a
 * script invocation line, so completion offers it there.
 */
const DYNAMIC_FLAGS: readonly string[] = [IN_PROCESS_FLAG, "--dry-run"];

/** The renderer for each accepted shell. */
const RENDERERS: Readonly<
  Record<
    M3LCliCompletionShell,
    (model: M3LCliCompletionModel) => readonly string[]
  >
> = {
  bash: renderBashCompletion,
  zsh: renderZshCompletion,
  fish: renderFishCompletion,
};

/** Narrows an arbitrary token to a supported shell name. */
function isCompletionShell(token: string): token is M3LCliCompletionShell {
  return (M3L_CLI_COMPLETION_SHELLS as readonly string[]).includes(token);
}

/**
 * Picks the `<shell>` positional out of the raw post-command argument slice,
 * skipping flag-shaped tokens (`--json` can precede or follow it).
 */
function firstPositional(rawArgs: readonly string[]): string | undefined {
  return rawArgs.find((token) => !token.startsWith("-"));
}

/**
 * Resolves the requested shell, or throws the usage-class error an
 * unrecognized name deserves.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_INVALID_PARAMETER_VALUE` (exit
 *   `2`) when `token` is not one of {@link M3L_CLI_COMPLETION_SHELLS}.
 */
function resolveShell(token: string): M3LCliCompletionShell {
  if (isCompletionShell(token)) {
    return token;
  }
  throw new M3LCliError(
    "ERR_CLI_INVALID_PARAMETER_VALUE",
    `unknown shell '${token}' — m3l completion supports ${M3L_CLI_COMPLETION_SHELLS.join(", ")}`,
    { suggestions: suggestNames(token, [...M3L_CLI_COMPLETION_SHELLS]) },
  );
}

/**
 * Projects one declared parameter to its completable flags: `--<name>` plus
 * every declared alias, each alias prefixed by `-` or `--` according to its
 * length (the same one-vs-many-character convention the CLI's own flags use).
 *
 * Deliberately reads `name`, `aliases` and `operations` only — never
 * `defaultValue`. A `secret: true` parameter's default renders as a mask,
 * and completion is about flag names, so the value must not reach the
 * generated file at all.
 */
function parameterFlags(
  parameter: M3LCliParameterDescriptor,
): readonly string[] {
  return [
    `--${parameter.name}`,
    ...parameter.aliases.map((alias) =>
      alias.length === SHORT_FLAG_LENGTH ? `-${alias}` : `--${alias}`,
    ),
  ];
}

/** Collects every parameter's flags, in declaration order. */
function allParameterFlags(
  parameters: readonly M3LCliParameterDescriptor[],
): readonly string[] {
  return parameters.flatMap(parameterFlags);
}

/**
 * Collects one {@link M3LCliCompletionOperationSet} per operation-declaring
 * parameter (ADR-0055), pairing that parameter's flags with its declared
 * operation names. A parameter declaring no operations contributes nothing.
 */
function operationSets(
  parameters: readonly M3LCliParameterDescriptor[],
): readonly M3LCliCompletionOperationSet[] {
  return parameters
    .filter((parameter) => parameter.operations.length > 0)
    .map((parameter) => ({
      flags: parameterFlags(parameter),
      operations: parameter.operations.map((operation) => operation.name),
    }));
}

/**
 * Resolves one discovered script to its completion entry, reading through
 * {@link loadParametersCached}.
 *
 * A config-load failure degrades the script to name-only rather than
 * aborting generation — the same tolerance `m3l list` gives a single
 * unloadable script — and the reason is carried on `loadError` so the
 * renderer can name it in a comment inside the generated file. It is
 * recorded, never swallowed.
 */
async function resolveScript(
  candidate: M3LCliScriptCandidate,
  context: M3LCliCommandContext,
): Promise<M3LCliCompletionScript> {
  try {
    const parameters = await loadParametersCached(
      candidate.name,
      candidate.directory,
      context.cacheFilePath,
    );
    return {
      name: candidate.name,
      flags: allParameterFlags(parameters),
      operationSets: operationSets(parameters),
      loadError: null,
    };
  } catch (error) {
    return {
      name: candidate.name,
      flags: [],
      operationSets: [],
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Builds the model the renderers bake in: the ADR-0042 reserved command
 * names (`scaffold/manifest.ts`'s `RESERVED_CLI_NAMES`, the source of truth
 * `main.ts`/`dynamic.ts`/`doctor.ts` all mirror) plus the discovered
 * scripts with their parameter flags and operation values, both sorted so
 * the generated script is byte-stable across runs.
 */
async function buildModel(
  context: M3LCliCommandContext,
): Promise<M3LCliCompletionModel> {
  const candidates = discoverScripts(context.workspaceRoot).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const scripts: M3LCliCompletionScript[] = [];
  for (const candidate of candidates) {
    scripts.push(await resolveScript(candidate, context));
  }
  return {
    commands: [...RESERVED_CLI_NAMES].toSorted((a, b) => a.localeCompare(b)),
    scriptCommands: SCRIPT_POSITIONAL_COMMANDS,
    scripts,
    globalFlags: GLOBAL_FLAGS,
    dynamicFlags: DYNAMIC_FLAGS,
  };
}

/**
 * Generates and prints a shell-completion script for `m3l`.
 *
 * Emits through `context.output.info` one line at a time (never
 * `process.stdout` directly), so the rendered text is capturable in tests
 * and honours the shared output layer. Under `--json`, emits exactly one
 * object instead: `{ "shell": "<shell>", "script": "<full text>" }`. The
 * `<shell>` positional is required in both modes — there is no `$SHELL`
 * auto-detection.
 *
 * @param context - The command context to run against.
 * @param rawArgs - The raw post-command argument slice (`m3l completion`'s
 *   own arguments, `--json` included).
 * @returns `0` on success; `2` when the `<shell>` positional is missing.
 * @throws {@link M3LCliError} coded `ERR_CLI_INVALID_PARAMETER_VALUE` (exit
 *   `2`) for an unrecognized shell, with Damerau–Levenshtein suggestions;
 *   whatever `discoverScripts` throws (e.g. `ERR_CLI_WORKSPACE_NOT_FOUND`),
 *   unwrapped.
 *
 * @example
 * ```ts
 * const exitCode = await runCompletion(context, ["zsh"]);
 * // 0 — the zsh completion script is on stdout
 * ```
 */
export async function runCompletion(
  context: M3LCliCommandContext,
  rawArgs: readonly string[],
): Promise<M3LCliExitCode> {
  const positional = firstPositional(rawArgs);
  if (positional === undefined) {
    context.output.error(
      `completion requires a <shell> positional — usage: m3l completion <${M3L_CLI_COMPLETION_SHELLS.join("|")}>`,
    );
    return USAGE_EXIT_CODE;
  }

  const shell = resolveShell(positional);
  const lines = RENDERERS[shell](await buildModel(context));

  if (context.jsonOutput) {
    context.output.info(JSON.stringify({ shell, script: lines.join("\n") }));
    return 0;
  }

  for (const line of lines) {
    context.output.info(line);
  }
  return 0;
}
