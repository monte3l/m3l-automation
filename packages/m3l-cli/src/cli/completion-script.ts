/**
 * `cli/completion-script` — the three pure shell-completion renderers
 * (`bash`/`zsh`/`fish`) behind `m3l completion <shell>` (U12, issue #536).
 *
 * Every `m3l` invocation costs roughly half a second of Node startup and
 * module load, so completion is **generated statically**: the command set,
 * the discovered script names and (U12 slice 2) each script's parameter
 * flags are baked into the emitted script rather than resolved by a
 * callback on every TAB press. Regenerating after adding a script is the
 * price; zero TAB latency is what it buys.
 *
 * These renderers do no I/O, so their exact emitted text is unit-assertable.
 * They are also the last line of defence against shell injection: every
 * interpolated token is filtered through {@link isSafeCompletionToken} and
 * quoted regardless, because script names reach here from `scripts/*`
 * package directories and get written into an executable shell script.
 *
 * @packageDocumentation
 */

/**
 * The shells `m3l completion` can generate a script for, in the order
 * `printUsage` and the docs list them.
 */
export const M3L_CLI_COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

/**
 * One of the shells {@link M3L_CLI_COMPLETION_SHELLS} names — the closed set
 * `m3l completion`'s positional accepts.
 *
 * @example
 * ```ts
 * const shell: M3LCliCompletionShell = "zsh";
 * ```
 */
export type M3LCliCompletionShell = (typeof M3L_CLI_COMPLETION_SHELLS)[number];

/**
 * Everything a renderer bakes into its emitted script. Built by
 * `commands/completion.ts` from `discoverScripts`; kept as plain string
 * arrays so a renderer can be unit-tested against a fixed model with no
 * discovery involved.
 *
 * @example
 * ```ts
 * const model: M3LCliCompletionModel = {
 *   commands: ["completion", "list"],
 *   scriptCommands: ["inspect"],
 *   scripts: ["sqs-etl"],
 *   globalFlags: ["--json"],
 *   scriptFlags: ["--in-process"],
 * };
 * ```
 */
export interface M3LCliCompletionModel {
  /** The static command names, sorted — `main.ts`'s `STATIC_COMMAND_NAMES`. */
  readonly commands: readonly string[];
  /** The {@link commands} subset taking an existing `<script>` positional. */
  readonly scriptCommands: readonly string[];
  /** The discovered `scripts/*` package names, sorted. */
  readonly scripts: readonly string[];
  /** CLI-reserved flags valid on any invocation. */
  readonly globalFlags: readonly string[];
  /** CLI-reserved flags valid only on dynamic per-script dispatch. */
  readonly scriptFlags: readonly string[];
}

/**
 * The only shape a token may have to reach the generated script: ASCII
 * alphanumerics plus `.`, `_`, `:` and `-`, with an optional leading `--`
 * or `-` flag prefix. Deliberately an allowlist — a denylist of shell
 * metacharacters would have to be exhaustive across three shells to be
 * correct, and this covers every name the ADR-0028 naming convention and
 * the CLI's own flag surface can produce.
 */
const SAFE_TOKEN_PATTERN = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Characters a rejected token is scrubbed down to before it is named in a comment. */
const COMMENT_SAFE_PATTERN = /[^A-Za-z0-9._:-]/g;

/** The placeholder a scrubbed character becomes in a skip comment. */
const SCRUB_PLACEHOLDER = "?";

/**
 * Checks whether `token` may be interpolated into a generated completion
 * script. Script, parameter and operation names originate in `scripts/*`
 * config modules and land inside an executable file, so anything outside
 * {@link SAFE_TOKEN_PATTERN} is skipped rather than escaped — there is no
 * legitimate name this rejects.
 *
 * @param token - The candidate token (a command, script, flag or operation name).
 * @returns Whether `token` is safe to emit.
 *
 * @example
 * ```ts
 * isSafeCompletionToken("sqs-etl"); // true
 * isSafeCompletionToken("a;rm -rf /"); // false
 * ```
 */
export function isSafeCompletionToken(token: string): boolean {
  return SAFE_TOKEN_PATTERN.test(token);
}

/**
 * Renders a rejected token for a `#` comment line, replacing every
 * character outside the allowlist (crucially including newlines, which
 * would otherwise end the comment and start a new statement) with
 * {@link SCRUB_PLACEHOLDER}.
 */
function scrubForComment(token: string): string {
  return token.replace(COMMENT_SAFE_PATTERN, SCRUB_PLACEHOLDER);
}

/** A token list split into what may be emitted and what was rejected. */
interface PartitionedTokens {
  readonly safe: readonly string[];
  readonly rejected: readonly string[];
}

/** Splits `tokens` on {@link isSafeCompletionToken}, preserving order. */
function partitionTokens(tokens: readonly string[]): PartitionedTokens {
  const safe: string[] = [];
  const rejected: string[] = [];
  for (const token of tokens) {
    if (isSafeCompletionToken(token)) {
      safe.push(token);
    } else {
      rejected.push(token);
    }
  }
  return { safe, rejected };
}

/**
 * Builds the `# skipped …` comment lines for `rejected`, one per token, so
 * a name that cannot be completed is visible in the generated file instead
 * of silently absent.
 */
function skipComments(
  rejected: readonly string[],
  label: string,
): readonly string[] {
  return rejected.map(
    (token) =>
      `# skipped ${label} '${scrubForComment(token)}' — name is not shell-safe`,
  );
}

/** The two-line provenance header every generated script opens with. */
function header(shell: M3LCliCompletionShell): readonly string[] {
  return [
    `# m3l ${shell} completion — generated by \`m3l completion ${shell}\`.`,
    "# Regenerate after adding a script or changing a script's parameters.",
    "# Do not edit by hand.",
    "",
  ];
}

/** Joins tokens for a bash `compgen -W` word list. */
function bashWords(tokens: readonly string[]): string {
  return tokens.join(" ");
}

/**
 * Renders the bash completion script for `model`.
 *
 * The emitted script registers `_m3l_complete` via `complete -F`, completing
 * the command set plus the discovered script names at the first positional,
 * the shell names after `completion`, a script name after each
 * `scriptCommands` entry, and the CLI-reserved flags everywhere else.
 *
 * @param model - The baked-in command/script/flag surface.
 * @returns The script's lines, without trailing newlines.
 *
 * @example
 * ```ts
 * const lines = renderBashCompletion(model);
 * // lines.at(-1) === "complete -F _m3l_complete m3l"
 * ```
 */
export function renderBashCompletion(
  model: M3LCliCompletionModel,
): readonly string[] {
  const commands = partitionTokens(model.commands);
  const scripts = partitionTokens(model.scripts);
  const scriptCommands = partitionTokens(model.scriptCommands);
  const globalFlags = partitionTokens(model.globalFlags);
  const scriptFlags = partitionTokens(model.scriptFlags);

  return [
    ...header("bash"),
    ...skipComments(commands.rejected, "command"),
    ...skipComments(scripts.rejected, "script"),
    ...skipComments(scriptCommands.rejected, "script command"),
    ...skipComments(globalFlags.rejected, "flag"),
    ...skipComments(scriptFlags.rejected, "flag"),
    `_m3l_commands='${bashWords(commands.safe)}'`,
    `_m3l_scripts='${bashWords(scripts.safe)}'`,
    `_m3l_script_commands='${bashWords(scriptCommands.safe)}'`,
    `_m3l_global_flags='${bashWords(globalFlags.safe)}'`,
    `_m3l_script_flags='${bashWords(scriptFlags.safe)}'`,
    `_m3l_shells='${bashWords(M3L_CLI_COMPLETION_SHELLS)}'`,
    "",
    "_m3l_complete() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    '  local command="${COMP_WORDS[1]}"',
    "  COMPREPLY=()",
    "",
    '  if [ "${COMP_CWORD}" -eq 1 ]; then',
    "    # shellcheck disable=SC2207",
    '    COMPREPLY=($(compgen -W "${_m3l_commands} ${_m3l_scripts} ${_m3l_global_flags}" -- "${cur}"))',
    "    return 0",
    "  fi",
    "",
    '  if [ "${command}" = "completion" ]; then',
    "    # shellcheck disable=SC2207",
    '    COMPREPLY=($(compgen -W "${_m3l_shells}" -- "${cur}"))',
    "    return 0",
    "  fi",
    "",
    '  if [ "${COMP_CWORD}" -eq 2 ] && [[ " ${_m3l_script_commands} " == *" ${command} "* ]]; then',
    "    # shellcheck disable=SC2207",
    '    COMPREPLY=($(compgen -W "${_m3l_scripts}" -- "${cur}"))',
    "    return 0",
    "  fi",
    "",
    '  if [[ " ${_m3l_scripts} " == *" ${command} "* ]]; then',
    "    # shellcheck disable=SC2207",
    '    COMPREPLY=($(compgen -W "${_m3l_global_flags} ${_m3l_script_flags}" -- "${cur}"))',
    "    return 0",
    "  fi",
    "",
    "  # shellcheck disable=SC2207",
    '  COMPREPLY=($(compgen -W "${_m3l_global_flags}" -- "${cur}"))',
    "  return 0",
    "}",
    "",
    "complete -F _m3l_complete m3l",
  ];
}

/**
 * The model-independent tail of the zsh script: the dispatch logic over the
 * arrays {@link renderZshCompletion} declares, plus the autoload-or-`compdef`
 * registration trailer. Hoisted out of that renderer purely to keep it under
 * the ESLint `max-lines-per-function` ceiling — every line here is a fixed
 * string with nothing interpolated into it.
 */
const ZSH_DISPATCH_BODY: readonly string[] = [
  "",
  "  if (( CURRENT == 2 )); then",
  "    _describe -t commands 'm3l command' m3l_commands",
  "    _describe -t scripts 'm3l script' m3l_scripts",
  "    _describe -t flags 'm3l flag' m3l_global_flags",
  "    return",
  "  fi",
  "",
  '  local command="${words[2]}"',
  "",
  '  if [[ "${command}" == completion ]]; then',
  "    _describe -t shells 'shell' m3l_shells",
  "    return",
  "  fi",
  "",
  "  if (( CURRENT == 3 )) && (( ${m3l_script_commands[(I)${command}]} )); then",
  "    _describe -t scripts 'm3l script' m3l_scripts",
  "    return",
  "  fi",
  "",
  "  if (( ${m3l_scripts[(I)${command}]} )); then",
  "    _describe -t flags 'm3l flag' m3l_global_flags",
  "    _describe -t flags 'm3l script flag' m3l_script_flags",
  "    return",
  "  fi",
  "",
  "  _describe -t flags 'm3l flag' m3l_global_flags",
  "}",
  "",
  "# Autoloaded from $fpath as `_m3l`, zsh calls this file as the completion",
  "# function itself; sourced by hand, it has to register itself instead.",
  'if [[ "${funcstack[1]}" == _m3l ]]; then',
  '  _m3l "$@"',
  "else",
  "  compdef _m3l m3l",
  "fi",
];

/** Joins tokens for a zsh array literal, quoting each. */
function zshWords(tokens: readonly string[]): string {
  return tokens.map((token) => `'${token}'`).join(" ");
}

/**
 * Renders the zsh completion script for `model`.
 *
 * The emitted script carries a `#compdef m3l` header so it autoloads when
 * saved as `_m3l` on `$fpath`, and its trailing dispatch also registers
 * itself via `compdef` when the file is simply `source`d after `compinit`.
 *
 * @param model - The baked-in command/script/flag surface.
 * @returns The script's lines, without trailing newlines.
 *
 * @example
 * ```ts
 * const lines = renderZshCompletion(model);
 * // lines[0] === "#compdef m3l"
 * ```
 */
export function renderZshCompletion(
  model: M3LCliCompletionModel,
): readonly string[] {
  const commands = partitionTokens(model.commands);
  const scripts = partitionTokens(model.scripts);
  const scriptCommands = partitionTokens(model.scriptCommands);
  const globalFlags = partitionTokens(model.globalFlags);
  const scriptFlags = partitionTokens(model.scriptFlags);

  return [
    "#compdef m3l",
    ...header("zsh"),
    ...skipComments(commands.rejected, "command"),
    ...skipComments(scripts.rejected, "script"),
    ...skipComments(scriptCommands.rejected, "script command"),
    ...skipComments(globalFlags.rejected, "flag"),
    ...skipComments(scriptFlags.rejected, "flag"),
    "_m3l() {",
    "  local -a m3l_commands m3l_scripts m3l_script_commands m3l_global_flags m3l_script_flags m3l_shells",
    `  m3l_commands=(${zshWords(commands.safe)})`,
    `  m3l_scripts=(${zshWords(scripts.safe)})`,
    `  m3l_script_commands=(${zshWords(scriptCommands.safe)})`,
    `  m3l_global_flags=(${zshWords(globalFlags.safe)})`,
    `  m3l_script_flags=(${zshWords(scriptFlags.safe)})`,
    `  m3l_shells=(${zshWords(M3L_CLI_COMPLETION_SHELLS)})`,
    ...ZSH_DISPATCH_BODY,
  ];
}

/** Renders one `complete -c m3l` line per token under a shared condition. */
function fishCandidates(
  tokens: readonly string[],
  condition: string,
  description: string,
): readonly string[] {
  return tokens.map(
    (token) =>
      `complete -c m3l -f -n '${condition}' -a '${token}' -d '${description}'`,
  );
}

/** Renders one `complete -c m3l` line per flag token, mapping `-x`/`--x` to `-s`/`-l`. */
function fishFlags(
  tokens: readonly string[],
  condition: string,
  description: string,
): readonly string[] {
  return tokens.map((token) => {
    const form = token.startsWith("--")
      ? `-l '${token.replace(/^--/, "")}'`
      : `-s '${token.replace(/^-/, "")}'`;
    return `complete -c m3l -f -n '${condition}' ${form} -d '${description}'`;
  });
}

/**
 * Renders the fish completion script for `model`.
 *
 * fish has no single completion function: the emitted script is a flat list
 * of `complete -c m3l` registrations, each gated by a `__fish_use_subcommand`
 * or `__fish_seen_subcommand_from` condition.
 *
 * @param model - The baked-in command/script/flag surface.
 * @returns The script's lines, without trailing newlines.
 *
 * @example
 * ```ts
 * const lines = renderFishCompletion(model);
 * // lines.includes("complete -c m3l -e")
 * ```
 */
export function renderFishCompletion(
  model: M3LCliCompletionModel,
): readonly string[] {
  const commands = partitionTokens(model.commands);
  const scripts = partitionTokens(model.scripts);
  const scriptCommands = partitionTokens(model.scriptCommands);
  const globalFlags = partitionTokens(model.globalFlags);
  const scriptFlags = partitionTokens(model.scriptFlags);

  const scriptCommandCondition =
    scriptCommands.safe.length > 0
      ? `__fish_seen_subcommand_from ${scriptCommands.safe.join(" ")}`
      : "false";
  const scriptCondition =
    scripts.safe.length > 0
      ? `__fish_seen_subcommand_from ${scripts.safe.join(" ")}`
      : "false";

  return [
    ...header("fish"),
    ...skipComments(commands.rejected, "command"),
    ...skipComments(scripts.rejected, "script"),
    ...skipComments(scriptCommands.rejected, "script command"),
    ...skipComments(globalFlags.rejected, "flag"),
    ...skipComments(scriptFlags.rejected, "flag"),
    "complete -c m3l -e",
    "",
    ...fishCandidates(commands.safe, "__fish_use_subcommand", "m3l command"),
    ...fishCandidates(scripts.safe, "__fish_use_subcommand", "m3l script"),
    "",
    ...fishCandidates(
      M3L_CLI_COMPLETION_SHELLS,
      "__fish_seen_subcommand_from completion",
      "shell",
    ),
    "",
    ...fishCandidates(scripts.safe, scriptCommandCondition, "m3l script"),
    "",
    ...fishFlags(globalFlags.safe, "true", "m3l flag"),
    ...fishFlags(scriptFlags.safe, scriptCondition, "m3l script flag"),
  ];
}
