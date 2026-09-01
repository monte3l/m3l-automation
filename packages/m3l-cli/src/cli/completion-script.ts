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
 * One operation-declaring parameter of a script (ADR-0055): the flags that
 * select it, and the operation names that are its valid values.
 *
 * @example
 * ```ts
 * const set: M3LCliCompletionOperationSet = {
 *   flags: ["--command", "-c"],
 *   operations: ["drain", "replay"],
 * };
 * ```
 */
export interface M3LCliCompletionOperationSet {
  /** The declaring parameter's flags — `--<name>` plus each declared alias. */
  readonly flags: readonly string[];
  /** The declared operation names, in declaration order. */
  readonly operations: readonly string[];
}

/**
 * One discovered `scripts/*` package as the renderers see it. A script whose
 * config would not load degrades to name-only (`flags` and `operationSets`
 * empty, `loadError` set) rather than aborting generation — the same
 * tolerance `m3l list` gives a single unloadable script.
 *
 * Deliberately carries no parameter **default**: a `secret: true`
 * parameter's `defaultValue` renders as a mask, and completion needs flag
 * *names* only, so the value never enters this shape at all.
 *
 * @example
 * ```ts
 * const script: M3LCliCompletionScript = {
 *   name: "sqs-etl",
 *   flags: ["--queue", "--command"],
 *   operationSets: [{ flags: ["--command"], operations: ["drain"] }],
 *   loadError: null,
 * };
 * ```
 */
export interface M3LCliCompletionScript {
  /** The script's name (its directory basename). */
  readonly name: string;
  /** Every completable flag: `--<name>` plus each alias, for each parameter. */
  readonly flags: readonly string[];
  /** One entry per operation-declaring parameter; `[]` when none declares one. */
  readonly operationSets: readonly M3LCliCompletionOperationSet[];
  /** The config-load failure message, or `null` when the config loaded. */
  readonly loadError: string | null;
}

/**
 * Everything a renderer bakes into its emitted script. Built by
 * `commands/completion.ts` from `discoverScripts` + `loadParametersCached`;
 * kept as plain data so a renderer can be unit-tested against a fixed model
 * with no discovery involved.
 *
 * @example
 * ```ts
 * const model: M3LCliCompletionModel = {
 *   commands: ["completion", "list"],
 *   scriptCommands: ["inspect"],
 *   scripts: [
 *     { name: "sqs-etl", flags: [], operationSets: [], loadError: null },
 *   ],
 *   globalFlags: ["--json"],
 *   dynamicFlags: ["--in-process"],
 * };
 * ```
 */
export interface M3LCliCompletionModel {
  /** The static command names, sorted — `main.ts`'s `STATIC_COMMAND_NAMES`. */
  readonly commands: readonly string[];
  /** The {@link commands} subset taking an existing `<script>` positional. */
  readonly scriptCommands: readonly string[];
  /** The discovered `scripts/*` packages, sorted by name. */
  readonly scripts: readonly M3LCliCompletionScript[];
  /** CLI-reserved flags valid on any invocation. */
  readonly globalFlags: readonly string[];
  /** CLI-reserved flags valid only on dynamic per-script dispatch. */
  readonly dynamicFlags: readonly string[];
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

/**
 * Characters a rejected token or a config-load reason is scrubbed down to
 * before it is named in a `#` comment. A space is permitted (a load reason is
 * prose, and unreadable without one) but nothing else outside the token
 * allowlist is — crucially not a newline, which would end the comment and let
 * the rest of the text start a statement.
 */
const COMMENT_SAFE_PATTERN = /[^A-Za-z0-9._:\- ]/g;

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

/**
 * A script reduced to what the renderers can safely emit: its own name (or
 * `null` when even that is unsafe), its allowlist-filtered flags, its
 * allowlist-filtered operation sets, and every `#` comment line explaining
 * what was dropped or why parameters are missing.
 */
interface SafeScript {
  readonly name: string | null;
  readonly flags: readonly string[];
  readonly operationSets: readonly M3LCliCompletionOperationSet[];
  readonly comments: readonly string[];
}

/**
 * Filters one script through {@link isSafeCompletionToken}, collecting a
 * comment line for every rejected token and for a config-load failure.
 *
 * A load failure is **named in the generated file**, not swallowed: the
 * script still completes by name, and the reason says why its flags are
 * absent. The reason is scrubbed like any other untrusted text.
 */
function toSafeScript(script: M3LCliCompletionScript): SafeScript {
  const comments: string[] = [];
  if (!isSafeCompletionToken(script.name)) {
    return {
      name: null,
      flags: [],
      operationSets: [],
      comments: [
        `# skipped script '${scrubForComment(script.name)}' — name is not shell-safe`,
      ],
    };
  }
  if (script.loadError !== null) {
    comments.push(
      `# ${script.name}: parameters unavailable (${scrubForComment(script.loadError)}) — completing by name only`,
    );
  }

  const flags = partitionTokens(script.flags);
  comments.push(
    ...skipComments(flags.rejected, `${script.name} parameter flag`),
  );

  const operationSets: M3LCliCompletionOperationSet[] = [];
  for (const set of script.operationSets) {
    const setFlags = partitionTokens(set.flags);
    const operations = partitionTokens(set.operations);
    comments.push(
      ...skipComments(setFlags.rejected, `${script.name} parameter flag`),
      ...skipComments(operations.rejected, `${script.name} operation`),
    );
    if (setFlags.safe.length > 0 && operations.safe.length > 0) {
      operationSets.push({ flags: setFlags.safe, operations: operations.safe });
    }
  }

  return { name: script.name, flags: flags.safe, operationSets, comments };
}

/** Filters every script in `model`, preserving order. */
function toSafeScripts(
  scripts: readonly M3LCliCompletionScript[],
): readonly SafeScript[] {
  return scripts.map(toSafeScript);
}

/** The names of the scripts that survived filtering. */
function safeScriptNames(scripts: readonly SafeScript[]): readonly string[] {
  return scripts
    .map((script) => script.name)
    .filter((name): name is string => name !== null);
}

/** Every comment line the filtered scripts produced, in order. */
function safeScriptComments(scripts: readonly SafeScript[]): readonly string[] {
  return scripts.flatMap((script) => script.comments);
}

/** Joins tokens for a bash `compgen -W` word list. */
function bashWords(tokens: readonly string[]): string {
  return tokens.join(" ");
}

/**
 * Renders the `case` arms of `_m3l_flags_for_script` — one per script that
 * declares at least one safe flag. A script with none (or whose config
 * failed to load) simply has no arm, so the lookup returns empty and the
 * caller falls back to the CLI-reserved flags alone.
 */
function bashFlagArms(scripts: readonly SafeScript[]): readonly string[] {
  return scripts
    .filter((script) => script.name !== null && script.flags.length > 0)
    .map(
      (script) =>
        `    '${script.name ?? ""}') echo '${bashWords(script.flags)}' ;;`,
    );
}

/**
 * Renders the `case` arms of `_m3l_operations_for_flag`, keyed on
 * `"<script> <flag>"`. Every flag of an operation-declaring parameter gets
 * its own arm (aliases included), so `--command` and `-c` both complete the
 * same operation set.
 */
function bashOperationArms(scripts: readonly SafeScript[]): readonly string[] {
  return scripts.flatMap((script) =>
    script.operationSets.flatMap((set) =>
      set.flags.map(
        (flag) =>
          `    '${script.name ?? ""} ${flag}') echo '${bashWords(set.operations)}' ;;`,
      ),
    ),
  );
}

/**
 * The model-independent tail of the bash script: the completion function
 * itself, over the variables and lookup functions the renderer emits above
 * it. Hoisted out of {@link renderBashCompletion} to keep that function
 * under the ESLint `max-lines-per-function` ceiling — nothing is
 * interpolated into any line here.
 */
const BASH_COMPLETE_BODY: readonly string[] = [
  "_m3l_complete() {",
  '  local cur="${COMP_WORDS[COMP_CWORD]}"',
  '  local prev="${COMP_WORDS[COMP_CWORD-1]}"',
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
  "    local operations",
  '    operations="$(_m3l_operations_for_flag "${command}" "${prev}")"',
  '    if [ -n "${operations}" ]; then',
  "      # shellcheck disable=SC2207",
  '      COMPREPLY=($(compgen -W "${operations}" -- "${cur}"))',
  "      return 0",
  "    fi",
  "    local flags",
  '    flags="$(_m3l_flags_for_script "${command}")"',
  "    # shellcheck disable=SC2207",
  '    COMPREPLY=($(compgen -W "${flags} ${_m3l_global_flags} ${_m3l_dynamic_flags}" -- "${cur}"))',
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

/**
 * Renders the bash completion script for `model`.
 *
 * The emitted script registers `_m3l_complete` via `complete -F`, completing
 * the command set plus the discovered script names at the first positional,
 * the shell names after `completion`, a script name after each
 * `scriptCommands` entry, and — after a script name — that script's own
 * parameter flags, or the operation values of whichever flag precedes the
 * cursor.
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
  const scriptCommands = partitionTokens(model.scriptCommands);
  const globalFlags = partitionTokens(model.globalFlags);
  const dynamicFlags = partitionTokens(model.dynamicFlags);
  const scripts = toSafeScripts(model.scripts);

  return [
    ...header("bash"),
    ...skipComments(commands.rejected, "command"),
    ...skipComments(scriptCommands.rejected, "script command"),
    ...skipComments(globalFlags.rejected, "flag"),
    ...skipComments(dynamicFlags.rejected, "flag"),
    ...safeScriptComments(scripts),
    `_m3l_commands='${bashWords(commands.safe)}'`,
    `_m3l_scripts='${bashWords(safeScriptNames(scripts))}'`,
    `_m3l_script_commands='${bashWords(scriptCommands.safe)}'`,
    `_m3l_global_flags='${bashWords(globalFlags.safe)}'`,
    `_m3l_dynamic_flags='${bashWords(dynamicFlags.safe)}'`,
    `_m3l_shells='${bashWords(M3L_CLI_COMPLETION_SHELLS)}'`,
    "",
    "_m3l_flags_for_script() {",
    '  case "$1" in',
    ...bashFlagArms(scripts),
    "  esac",
    "}",
    "",
    "_m3l_operations_for_flag() {",
    '  case "$1 $2" in',
    ...bashOperationArms(scripts),
    "  esac",
    "}",
    "",
    ...BASH_COMPLETE_BODY,
  ];
}

/** Joins tokens for a zsh array literal, quoting each. */
function zshWords(tokens: readonly string[]): string {
  return tokens.map((token) => `'${token}'`).join(" ");
}

/** Renders the `case` arms of the zsh `_m3l_flags_for_script` lookup. */
function zshFlagArms(scripts: readonly SafeScript[]): readonly string[] {
  return scripts
    .filter((script) => script.name !== null && script.flags.length > 0)
    .map(
      (script) =>
        `    '${script.name ?? ""}') echo '${script.flags.join(" ")}' ;;`,
    );
}

/** Renders the `case` arms of the zsh `_m3l_operations_for_flag` lookup. */
function zshOperationArms(scripts: readonly SafeScript[]): readonly string[] {
  return scripts.flatMap((script) =>
    script.operationSets.flatMap((set) =>
      set.flags.map(
        (flag) =>
          `    '${script.name ?? ""} ${flag}') echo '${set.operations.join(" ")}' ;;`,
      ),
    ),
  );
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
  '    local prev="${words[CURRENT-1]}"',
  "    local -a m3l_operations m3l_parameters",
  '    m3l_operations=(${(z)"$(_m3l_operations_for_flag "${command}" "${prev}")"})',
  "    if (( ${#m3l_operations} )); then",
  "      _describe -t operations 'operation' m3l_operations",
  "      return",
  "    fi",
  '    m3l_parameters=(${(z)"$(_m3l_flags_for_script "${command}")"})',
  "    _describe -t flags 'm3l parameter' m3l_parameters",
  "    _describe -t flags 'm3l flag' m3l_global_flags",
  "    _describe -t flags 'm3l script flag' m3l_dynamic_flags",
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

/**
 * Renders the zsh completion script for `model`.
 *
 * The emitted script carries a `#compdef m3l` header so it autoloads when
 * saved as `_m3l` on `$fpath`, and its trailing dispatch also registers
 * itself via `compdef` when the file is simply `source`d after `compinit`.
 * After a script name it completes that script's parameter flags, or the
 * operation values of whichever flag precedes the cursor.
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
  const scriptCommands = partitionTokens(model.scriptCommands);
  const globalFlags = partitionTokens(model.globalFlags);
  const dynamicFlags = partitionTokens(model.dynamicFlags);
  const scripts = toSafeScripts(model.scripts);

  return [
    "#compdef m3l",
    ...header("zsh"),
    ...skipComments(commands.rejected, "command"),
    ...skipComments(scriptCommands.rejected, "script command"),
    ...skipComments(globalFlags.rejected, "flag"),
    ...skipComments(dynamicFlags.rejected, "flag"),
    ...safeScriptComments(scripts),
    "_m3l_flags_for_script() {",
    '  case "$1" in',
    ...zshFlagArms(scripts),
    "  esac",
    "}",
    "",
    "_m3l_operations_for_flag() {",
    '  case "$1 $2" in',
    ...zshOperationArms(scripts),
    "  esac",
    "}",
    "",
    "_m3l() {",
    "  local -a m3l_commands m3l_scripts m3l_script_commands m3l_global_flags m3l_dynamic_flags m3l_shells",
    `  m3l_commands=(${zshWords(commands.safe)})`,
    `  m3l_scripts=(${zshWords(safeScriptNames(scripts))})`,
    `  m3l_script_commands=(${zshWords(scriptCommands.safe)})`,
    `  m3l_global_flags=(${zshWords(globalFlags.safe)})`,
    `  m3l_dynamic_flags=(${zshWords(dynamicFlags.safe)})`,
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
 * Renders every per-script registration: the script's own parameter flags,
 * and each operation-declaring parameter's operation values gated on
 * `__fish_prev_arg_in` over that parameter's flags.
 */
function fishScriptLines(scripts: readonly SafeScript[]): readonly string[] {
  return scripts.flatMap((script) => {
    if (script.name === null) return [];
    const seen = `__fish_seen_subcommand_from ${script.name}`;
    return [
      ...fishFlags(script.flags, seen, `${script.name} parameter`),
      ...script.operationSets.flatMap((set) =>
        fishCandidates(
          set.operations,
          `${seen}; and __fish_prev_arg_in ${set.flags.join(" ")}`,
          `${script.name} operation`,
        ),
      ),
    ];
  });
}

/**
 * Renders the fish completion script for `model`.
 *
 * fish has no single completion function: the emitted script is a flat list
 * of `complete -c m3l` registrations, each gated by a `__fish_use_subcommand`,
 * `__fish_seen_subcommand_from` or `__fish_prev_arg_in` condition.
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
  const scriptCommands = partitionTokens(model.scriptCommands);
  const globalFlags = partitionTokens(model.globalFlags);
  const dynamicFlags = partitionTokens(model.dynamicFlags);
  const scripts = toSafeScripts(model.scripts);
  const scriptNames = safeScriptNames(scripts);

  const afterScriptCommand =
    scriptCommands.safe.length > 0
      ? `__fish_seen_subcommand_from ${scriptCommands.safe.join(" ")}`
      : "false";
  const afterScript =
    scriptNames.length > 0
      ? `__fish_seen_subcommand_from ${scriptNames.join(" ")}`
      : "false";

  return [
    ...header("fish"),
    ...skipComments(commands.rejected, "command"),
    ...skipComments(scriptCommands.rejected, "script command"),
    ...skipComments(globalFlags.rejected, "flag"),
    ...skipComments(dynamicFlags.rejected, "flag"),
    ...safeScriptComments(scripts),
    "complete -c m3l -e",
    "",
    ...fishCandidates(commands.safe, "__fish_use_subcommand", "m3l command"),
    ...fishCandidates(scriptNames, "__fish_use_subcommand", "m3l script"),
    "",
    ...fishCandidates(
      M3L_CLI_COMPLETION_SHELLS,
      "__fish_seen_subcommand_from completion",
      "shell",
    ),
    "",
    ...fishCandidates(scriptNames, afterScriptCommand, "m3l script"),
    "",
    ...fishFlags(globalFlags.safe, "true", "m3l flag"),
    ...fishFlags(dynamicFlags.safe, afterScript, "m3l script flag"),
    "",
    ...fishScriptLines(scripts),
  ];
}
