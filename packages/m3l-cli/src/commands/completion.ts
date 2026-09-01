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
  M3LCliCompletionShell,
} from "../cli/completion-script.js";
import { discoverScripts } from "../discovery/discover.js";
import { RESERVED_CLI_NAMES } from "../scaffold/manifest.js";

/** Exit code for a usage error, mirroring `main.ts`'s own constant. */
const USAGE_EXIT_CODE: M3LCliExitCode = 2;

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
const SCRIPT_FLAGS: readonly string[] = [IN_PROCESS_FLAG, "--dry-run"];

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
 * Builds the model the renderers bake in: the ADR-0042 reserved command
 * names (`scaffold/manifest.ts`'s `RESERVED_CLI_NAMES`, the source of truth
 * `main.ts`/`dynamic.ts`/`doctor.ts` all mirror) plus the discovered script
 * names, both sorted so the generated script is byte-stable across runs.
 */
function buildModel(context: M3LCliCommandContext): M3LCliCompletionModel {
  const scripts = discoverScripts(context.workspaceRoot).map(
    (candidate) => candidate.name,
  );
  return {
    commands: [...RESERVED_CLI_NAMES].toSorted((a, b) => a.localeCompare(b)),
    scriptCommands: SCRIPT_POSITIONAL_COMMANDS,
    scripts: scripts.toSorted((a, b) => a.localeCompare(b)),
    globalFlags: GLOBAL_FLAGS,
    scriptFlags: SCRIPT_FLAGS,
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
 * const exitCode = runCompletion(context, ["zsh"]);
 * // 0 — the zsh completion script is on stdout
 * ```
 */
export function runCompletion(
  context: M3LCliCommandContext,
  rawArgs: readonly string[],
): M3LCliExitCode {
  const positional = firstPositional(rawArgs);
  if (positional === undefined) {
    context.output.error(
      `completion requires a <shell> positional — usage: m3l completion <${M3L_CLI_COMPLETION_SHELLS.join("|")}>`,
    );
    return USAGE_EXIT_CODE;
  }

  const shell = resolveShell(positional);
  const lines = RENDERERS[shell](buildModel(context));

  if (context.jsonOutput) {
    context.output.info(JSON.stringify({ shell, script: lines.join("\n") }));
    return 0;
  }

  for (const line of lines) {
    context.output.info(line);
  }
  return 0;
}
