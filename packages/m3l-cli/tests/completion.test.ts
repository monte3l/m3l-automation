import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { runCompletion } from "../src/commands/completion.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { M3LCliError } from "../src/cli/errors.js";
import {
  M3L_CLI_COMPLETION_SHELLS,
  isSafeCompletionToken,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
} from "../src/cli/completion-script.js";
import type {
  M3LCliCompletionModel,
  M3LCliCompletionScript,
  M3LCliCompletionShell,
} from "../src/cli/completion-script.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";

/**
 * Contract: `src/commands/completion.ts` + `src/cli/completion-script.ts` —
 * `m3l completion <bash|zsh|fish>` (U12, issue #536) prints a self-contained,
 * statically generated completion script carrying the command set, the
 * discovered script names, each script's parameter flags and each
 * operation-declaring parameter's operation values. The renderers are pure,
 * so their exact emitted text is asserted directly; the command is asserted
 * for positional validation, suggestions, model building and the `--json`
 * envelope. See the pinned contract at `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
});

/** Minimal structural stand-in for `M3LCliOutput` — a simple call collector. */
function createOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
  readonly infoLines: string[];
  readonly errorLines: string[];
} {
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  return {
    output: {
      colorEnabled: false,
      info: (text: string) => {
        infoLines.push(text);
      },
      error: (text: string) => {
        errorLines.push(text);
      },
      heading: () => {
        /* not used by completion */
      },
    },
    infoLines,
    errorLines,
  };
}

function buildContext(overrides: Partial<M3LCliCommandContext> = {}): {
  context: M3LCliCommandContext;
  infoLines: string[];
  errorLines: string[];
} {
  const { output, infoLines, errorLines } = createOutputCollector();
  const context: M3LCliCommandContext = {
    workspaceRoot: "/workspace",
    output,
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
    outputDirPath: "/workspace/data/output",
    env: {},
    envFile: { kind: "auto" },
    ...overrides,
  };
  return { context, infoLines, errorLines };
}

function candidate(name: string): M3LCliScriptCandidate {
  return { name, directory: `/workspace/scripts/${name}`, description: "" };
}

/** Builds a descriptor with the non-completion fields at benign defaults. */
function parameter(
  overrides: Partial<M3LCliParameterDescriptor> & { name: string },
): M3LCliParameterDescriptor {
  return {
    aliases: [],
    type: "STRING",
    required: false,
    defaultValue: undefined,
    description: "",
    secret: false,
    operations: [],
    ...overrides,
  };
}

/**
 * A deliberately small fixed model — the three renderer assertions below pin
 * the exact emitted text against it, so a rendering change has to be made on
 * purpose. It covers all four interesting cases at once: a script with plain
 * flags, an alias pair (`--command`/`-c`), an operation set reachable through
 * both of those flags, and a script whose config would not load.
 */
const fixedModel: M3LCliCompletionModel = {
  commands: ["completion", "list"],
  scriptCommands: ["inspect"],
  scripts: [
    {
      name: "sqs-etl",
      flags: ["--queue", "--command", "-c"],
      operationSets: [
        { flags: ["--command", "-c"], operations: ["drain", "replay"] },
      ],
      loadError: null,
    },
    {
      name: "broken-etl",
      flags: [],
      operationSets: [],
      loadError: "config import failed",
    },
  ],
  globalFlags: ["--json", "-h"],
  dynamicFlags: ["--in-process"],
};

/** A script entry with everything empty — the base for a one-field variation. */
function scriptEntry(
  overrides: Partial<M3LCliCompletionScript> & { name: string },
): M3LCliCompletionScript {
  return { flags: [], operationSets: [], loadError: null, ...overrides };
}

describe("isSafeCompletionToken", () => {
  test.each(["sqs-etl", "list", "--in-process", "-h", "a.b_c:d", "json-etl2"])(
    "accepts the legitimate token %s",
    (token) => {
      expect(isSafeCompletionToken(token)).toBe(true);
    },
  );

  test.each([
    "a;rm -rf /",
    "a b",
    "$(id)",
    "`id`",
    "a\nb",
    "a'b",
    'a"b',
    "a|b",
    "a&b",
    "",
    "-",
    "--",
  ])("rejects the unsafe token %j", (token) => {
    expect(isSafeCompletionToken(token)).toBe(false);
  });
});

describe("renderBashCompletion", () => {
  test("emits the exact expected script for a fixed model", () => {
    expect(renderBashCompletion(fixedModel)).toEqual([
      "# m3l bash completion — generated by `m3l completion bash`.",
      "# Regenerate after adding a script or changing a script's parameters.",
      "# Do not edit by hand.",
      "",
      "# broken-etl: parameters unavailable (config import failed) — completing by name only",
      "_m3l_commands='completion list'",
      "_m3l_scripts='sqs-etl broken-etl'",
      "_m3l_script_commands='inspect'",
      "_m3l_global_flags='--json -h'",
      "_m3l_dynamic_flags='--in-process'",
      "_m3l_shells='bash zsh fish'",
      "",
      "_m3l_flags_for_script() {",
      '  case "$1" in',
      "    'sqs-etl') echo '--queue --command -c' ;;",
      "  esac",
      "}",
      "",
      "_m3l_operations_for_flag() {",
      '  case "$1 $2" in',
      "    'sqs-etl --command') echo 'drain replay' ;;",
      "    'sqs-etl -c') echo 'drain replay' ;;",
      "  esac",
      "}",
      "",
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
    ]);
  });
});

describe("renderZshCompletion", () => {
  test("emits the exact expected script for a fixed model", () => {
    expect(renderZshCompletion(fixedModel)).toEqual([
      "#compdef m3l",
      "# m3l zsh completion — generated by `m3l completion zsh`.",
      "# Regenerate after adding a script or changing a script's parameters.",
      "# Do not edit by hand.",
      "",
      "# broken-etl: parameters unavailable (config import failed) — completing by name only",
      "_m3l_flags_for_script() {",
      '  case "$1" in',
      "    'sqs-etl') echo '--queue --command -c' ;;",
      "  esac",
      "}",
      "",
      "_m3l_operations_for_flag() {",
      '  case "$1 $2" in',
      "    'sqs-etl --command') echo 'drain replay' ;;",
      "    'sqs-etl -c') echo 'drain replay' ;;",
      "  esac",
      "}",
      "",
      "_m3l() {",
      "  local -a m3l_commands m3l_scripts m3l_script_commands m3l_global_flags m3l_dynamic_flags m3l_shells",
      "  m3l_commands=('completion' 'list')",
      "  m3l_scripts=('sqs-etl' 'broken-etl')",
      "  m3l_script_commands=('inspect')",
      "  m3l_global_flags=('--json' '-h')",
      "  m3l_dynamic_flags=('--in-process')",
      "  m3l_shells=('bash' 'zsh' 'fish')",
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
    ]);
  });
});

describe("renderFishCompletion", () => {
  test("emits the exact expected script for a fixed model", () => {
    expect(renderFishCompletion(fixedModel)).toEqual([
      "# m3l fish completion — generated by `m3l completion fish`.",
      "# Regenerate after adding a script or changing a script's parameters.",
      "# Do not edit by hand.",
      "",
      "# broken-etl: parameters unavailable (config import failed) — completing by name only",
      "complete -c m3l -e",
      "",
      "complete -c m3l -f -n '__fish_use_subcommand' -a 'completion' -d 'm3l command'",
      "complete -c m3l -f -n '__fish_use_subcommand' -a 'list' -d 'm3l command'",
      "complete -c m3l -f -n '__fish_use_subcommand' -a 'sqs-etl' -d 'm3l script'",
      "complete -c m3l -f -n '__fish_use_subcommand' -a 'broken-etl' -d 'm3l script'",
      "",
      "complete -c m3l -f -n '__fish_seen_subcommand_from completion' -a 'bash' -d 'shell'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from completion' -a 'zsh' -d 'shell'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from completion' -a 'fish' -d 'shell'",
      "",
      "complete -c m3l -f -n '__fish_seen_subcommand_from inspect' -a 'sqs-etl' -d 'm3l script'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from inspect' -a 'broken-etl' -d 'm3l script'",
      "",
      "complete -c m3l -f -n 'true' -l 'json' -d 'm3l flag'",
      "complete -c m3l -f -n 'true' -s 'h' -d 'm3l flag'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from sqs-etl broken-etl' -l 'in-process' -d 'm3l script flag'",
      "",
      "complete -c m3l -f -n '__fish_seen_subcommand_from sqs-etl' -l 'queue' -d 'sqs-etl parameter'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from sqs-etl' -l 'command' -d 'sqs-etl parameter'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from sqs-etl' -s 'c' -d 'sqs-etl parameter'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from sqs-etl; and __fish_prev_arg_in --command -c' -a 'drain' -d 'sqs-etl operation'",
      "complete -c m3l -f -n '__fish_seen_subcommand_from sqs-etl; and __fish_prev_arg_in --command -c' -a 'replay' -d 'sqs-etl operation'",
    ]);
  });

  test("falls back to a `false` condition when no script command is safe", () => {
    const lines = renderFishCompletion({
      ...fixedModel,
      scriptCommands: ["in;spect"],
      scripts: [],
    });
    expect(lines).toContain(
      "# skipped script command 'in?spect' — name is not shell-safe",
    );
    expect(
      lines.some((line) =>
        line.includes("__fish_seen_subcommand_from inspect"),
      ),
    ).toBe(false);
  });
});

describe("every renderer — shell-injection safety", () => {
  const hostileModel: M3LCliCompletionModel = {
    commands: ["list", "a; rm -rf /"],
    scriptCommands: ["inspect"],
    scripts: [
      scriptEntry({ name: "ok-script", flags: ["--fine"] }),
      scriptEntry({ name: "$(id)" }),
      scriptEntry({ name: "bad\nname" }),
    ],
    globalFlags: ["--json"],
    dynamicFlags: ["--in-process"],
  };

  test.each([
    ["bash", renderBashCompletion],
    ["zsh", renderZshCompletion],
    ["fish", renderFishCompletion],
  ] as const)("%s never interpolates an unsafe token", (_shell, render) => {
    const text = render(hostileModel).join("\n");
    expect(text).toContain("ok-script");
    expect(text).not.toContain("rm -rf /");
    expect(text).not.toContain("$(id)");
    expect(text).not.toContain("bad\nname");
    expect(text).toContain("— name is not shell-safe");
  });

  test("a newline in a rejected script name cannot escape its comment line", () => {
    const lines = renderBashCompletion({
      ...hostileModel,
      scripts: [scriptEntry({ name: "evil\nrm -rf /" })],
    });
    expect(lines).toContain(
      "# skipped script 'evil?rm -rf ?' — name is not shell-safe",
    );
  });

  // The expected "kept" forms differ per shell: bash and zsh emit the flag
  // token verbatim, fish re-spells `--x` as `-l 'x'`.
  test.each([
    ["bash", renderBashCompletion, ["--safe", "--also-safe"]],
    ["zsh", renderZshCompletion, ["--safe", "--also-safe"]],
    ["fish", renderFishCompletion, ["-l 'safe'", "-l 'also-safe'"]],
  ] as const)(
    "%s skips a parameter flag containing a shell metacharacter, and says so",
    (_shell, render, kept) => {
      const text = render({
        ...fixedModel,
        scripts: [
          scriptEntry({
            name: "sqs-etl",
            flags: ["--safe", "--evil;rm -rf /", "--also-safe"],
          }),
        ],
      }).join("\n");

      for (const form of kept) {
        expect(text).toContain(form);
      }
      expect(text).not.toContain("rm -rf /");
      expect(text).toContain(
        "# skipped sqs-etl parameter flag '--evil?rm -rf ?' — name is not shell-safe",
      );
    },
  );

  test("an operation value containing a metacharacter is skipped, not emitted", () => {
    const text = renderBashCompletion({
      ...fixedModel,
      scripts: [
        scriptEntry({
          name: "sqs-etl",
          flags: ["--command"],
          operationSets: [
            { flags: ["--command"], operations: ["drain", "$(id)"] },
          ],
        }),
      ],
    }).join("\n");

    expect(text).toContain("echo 'drain'");
    expect(text).not.toContain("$(id)");
    expect(text).toContain("# skipped sqs-etl operation");
  });

  test("an operation set whose only flag is unsafe emits no arm at all", () => {
    const text = renderBashCompletion({
      ...fixedModel,
      scripts: [
        scriptEntry({
          name: "sqs-etl",
          operationSets: [{ flags: ["--a;b"], operations: ["drain"] }],
        }),
      ],
    }).join("\n");

    expect(text).not.toContain("drain");
    expect(text).toContain("# skipped sqs-etl parameter flag");
  });
});

describe("runCompletion — model building", () => {
  test("enumerates each script's parameter flags, aliases included", async () => {
    discoverScriptsMock.mockReturnValue([candidate("sqs-etl")]);
    loadParametersCachedMock.mockResolvedValue([
      parameter({ name: "queue" }),
      parameter({ name: "command", aliases: ["c", "cmd"] }),
    ]);
    const { context, infoLines } = buildContext();

    expect(await runCompletion(context, ["bash"])).toBe(0);
    expect(infoLines).toContain(
      "    'sqs-etl') echo '--queue --command -c --cmd' ;;",
    );
  });

  test("emits an operation-declaring parameter's operations as its value set", async () => {
    discoverScriptsMock.mockReturnValue([candidate("sqs-etl")]);
    loadParametersCachedMock.mockResolvedValue([
      parameter({
        name: "command",
        aliases: ["c"],
        required: true,
        operations: [
          { name: "drain", description: "", requiredParameters: [] },
          { name: "replay", description: "", requiredParameters: ["queue"] },
        ],
      }),
    ]);
    const { context, infoLines } = buildContext();

    await runCompletion(context, ["bash"]);
    expect(infoLines).toContain(
      "    'sqs-etl --command') echo 'drain replay' ;;",
    );
    expect(infoLines).toContain("    'sqs-etl -c') echo 'drain replay' ;;");
  });

  test("a parameter declaring no operations contributes no operation arm", async () => {
    discoverScriptsMock.mockReturnValue([candidate("json-etl")]);
    loadParametersCachedMock.mockResolvedValue([parameter({ name: "input" })]);
    const { context, infoLines } = buildContext();

    await runCompletion(context, ["bash"]);
    const arms = infoLines.filter((line) => line.includes("') echo"));
    expect(arms).toEqual(["    'json-etl') echo '--input' ;;"]);
  });

  test("a secret parameter's flag completes but its default appears nowhere", async () => {
    discoverScriptsMock.mockReturnValue([candidate("sqs-etl")]);
    loadParametersCachedMock.mockResolvedValue([
      parameter({ name: "token", secret: true, defaultValue: "********" }),
      parameter({ name: "endpoint", defaultValue: "https://example.invalid" }),
    ]);
    const { context, infoLines } = buildContext();

    await runCompletion(context, ["bash"]);
    const text = infoLines.join("\n");

    expect(text).toContain("--token");
    expect(text).toContain("--endpoint");
    // Completion covers flag NAMES only. A masked secret must never reach the
    // generated file, and neither must any other default.
    expect(text).not.toContain("********");
    expect(text).not.toContain("https://example.invalid");
  });

  test("a config-load failure degrades to name-only plus a named comment", async () => {
    discoverScriptsMock.mockReturnValue([
      candidate("broken-etl"),
      candidate("sqs-etl"),
    ]);
    loadParametersCachedMock.mockImplementation((name: string) =>
      name === "broken-etl"
        ? Promise.reject(
            new M3LCliError("ERR_CLI_CONFIG_IMPORT", "dist missing"),
          )
        : Promise.resolve([parameter({ name: "queue" })]),
    );
    const { context, infoLines } = buildContext();

    expect(await runCompletion(context, ["bash"])).toBe(0);
    // Still completable by name…
    expect(infoLines).toContain("_m3l_scripts='broken-etl sqs-etl'");
    // …but the failure is recorded in the generated file, not swallowed.
    expect(infoLines).toContain(
      "# broken-etl: parameters unavailable (dist missing) — completing by name only",
    );
    expect(infoLines).not.toContain("    'broken-etl') echo '' ;;");
    // …and one script's failure never suppresses another's flags.
    expect(infoLines).toContain("    'sqs-etl') echo '--queue' ;;");
  });

  test("a non-Error rejection still names a reason rather than [object Object]", async () => {
    discoverScriptsMock.mockReturnValue([candidate("odd-etl")]);
    loadParametersCachedMock.mockRejectedValue("plain string failure");
    const { context, infoLines } = buildContext();

    await runCompletion(context, ["bash"]);
    expect(infoLines).toContain(
      "# odd-etl: parameters unavailable (plain string failure) — completing by name only",
    );
  });

  test("sorts discovered scripts so the generated script is byte-stable", async () => {
    discoverScriptsMock.mockReturnValue([
      candidate("zeta"),
      candidate("alpha"),
    ]);
    loadParametersCachedMock.mockResolvedValue([]);
    const { context, infoLines } = buildContext();

    await runCompletion(context, ["bash"]);
    expect(infoLines).toContain("_m3l_scripts='alpha zeta'");
  });

  test("bakes in `completion` itself as a completable command", async () => {
    discoverScriptsMock.mockReturnValue([]);
    const { context, infoLines } = buildContext();

    await runCompletion(context, ["bash"]);
    const commandsLine = infoLines.find((line) =>
      line.startsWith("_m3l_commands="),
    );
    expect(commandsLine).toContain("completion");
  });
});

describe("runCompletion", () => {
  test("prints the bash script line by line and exits 0", async () => {
    discoverScriptsMock.mockReturnValue([candidate("sqs-etl")]);
    loadParametersCachedMock.mockResolvedValue([]);
    const { context, infoLines } = buildContext();

    expect(await runCompletion(context, ["bash"])).toBe(0);
    expect(infoLines[0]).toBe(
      "# m3l bash completion — generated by `m3l completion bash`.",
    );
    expect(infoLines.at(-1)).toBe("complete -F _m3l_complete m3l");
    expect(infoLines).toContain("_m3l_scripts='sqs-etl'");
  });

  test("a bare `m3l completion` is a usage error, exits 2, emits no script", async () => {
    discoverScriptsMock.mockReturnValue([]);
    const { context, infoLines, errorLines } = buildContext();

    expect(await runCompletion(context, [])).toBe(2);
    expect(errorLines).toEqual([
      "completion requires a <shell> positional — usage: m3l completion <bash|zsh|fish>",
    ]);
    expect(infoLines).toEqual([]);
    expect(discoverScriptsMock).not.toHaveBeenCalled();
  });

  test("an unknown shell throws ERR_CLI_INVALID_PARAMETER_VALUE", async () => {
    discoverScriptsMock.mockReturnValue([]);
    const { context } = buildContext();

    await expect(runCompletion(context, ["powershell"])).rejects.toThrow(
      M3LCliError,
    );
    await expect(runCompletion(context, ["powershell"])).rejects.toMatchObject({
      code: "ERR_CLI_INVALID_PARAMETER_VALUE",
    });
  });

  test("a near-miss shell name suggests the real one", async () => {
    discoverScriptsMock.mockReturnValue([]);
    const { context } = buildContext();

    let thrown: unknown;
    try {
      await runCompletion(context, ["zshh"]);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as M3LCliError).suggestions).toContain("zsh");
  });

  test("finds the positional regardless of where --json sits", async () => {
    discoverScriptsMock.mockReturnValue([]);
    const { context, infoLines } = buildContext({ jsonOutput: true });

    expect(await runCompletion(context, ["--json", "fish"])).toBe(0);
    expect(infoLines).toHaveLength(1);
    expect(JSON.parse(infoLines[0] ?? "")).toMatchObject({ shell: "fish" });
  });

  test("--json emits exactly one object carrying `shell` and `script`", async () => {
    discoverScriptsMock.mockReturnValue([candidate("sqs-etl")]);
    loadParametersCachedMock.mockResolvedValue([parameter({ name: "queue" })]);
    const { context, infoLines } = buildContext({ jsonOutput: true });

    expect(await runCompletion(context, ["zsh", "--json"])).toBe(0);
    expect(infoLines).toHaveLength(1);
    const parsed = JSON.parse(infoLines[0] ?? "") as {
      shell: string;
      script: string;
    };
    expect(parsed.shell).toBe("zsh");
    expect(parsed.script.startsWith("#compdef m3l\n")).toBe(true);
    expect(parsed.script).toContain("--queue");
  });

  test.each(M3L_CLI_COMPLETION_SHELLS)(
    "%s is accepted and produces a non-empty script",
    async (shell) => {
      discoverScriptsMock.mockReturnValue([]);
      const { context, infoLines } = buildContext();

      expect(await runCompletion(context, [shell])).toBe(0);
      expect(infoLines.length).toBeGreaterThan(0);
    },
  );
});

describe("completion — type contract", () => {
  test("M3LCliCompletionShell is the three-member bash|zsh|fish union", () => {
    expectTypeOf<M3LCliCompletionShell>().toEqualTypeOf<
      "bash" | "zsh" | "fish"
    >();
  });
});

/**
 * The renderers are pure string builders, so nothing above proves the text
 * they emit is *valid* shell. These spawn the real parsers. `fish` is not
 * installed on the development host and is not assumed in CI either, so the
 * fish renderer is covered by the exact-text assertions above only — its
 * syntax is never machine-checked here.
 */
describe("generated scripts parse under their own shell", () => {
  const richModel: M3LCliCompletionModel = {
    commands: ["completion", "doctor", "help", "inspect", "list", "run"],
    scriptCommands: ["inspect", "presets", "run"],
    scripts: [
      scriptEntry({ name: "json-etl", flags: ["--input", "--output"] }),
      scriptEntry({
        name: "sqs-etl",
        flags: ["--queue", "--command", "-c"],
        operationSets: [
          { flags: ["--command", "-c"], operations: ["drain", "replay"] },
        ],
      }),
      scriptEntry({ name: "broken-etl", loadError: "dist missing" }),
    ],
    globalFlags: ["--json", "--help", "-h", "--version"],
    dynamicFlags: ["--in-process", "--dry-run"],
  };

  function hasShell(shell: string): boolean {
    return spawnSync(shell, ["--version"], { stdio: "ignore" }).status === 0;
  }

  function syntaxCheck(
    shell: string,
    lines: readonly string[],
    basename: string,
  ): { status: number | null; stderr: string } {
    const directory = mkdtempSync(join(tmpdir(), "m3l-completion-"));
    try {
      const file = join(directory, basename);
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
      const result = spawnSync(shell, ["-n", file], { encoding: "utf8" });
      return { status: result.status, stderr: result.stderr };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test.skipIf(!hasShell("bash"))("bash -n accepts the bash script", () => {
    const { status, stderr } = syntaxCheck(
      "bash",
      renderBashCompletion(richModel),
      "m3l.bash",
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test.skipIf(!hasShell("zsh"))("zsh -n accepts the zsh script", () => {
    const { status, stderr } = syntaxCheck(
      "zsh",
      renderZshCompletion(richModel),
      "_m3l",
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test.skipIf(!hasShell("bash"))(
    "bash -n accepts a script with no scripts at all (empty `case`)",
    () => {
      const { status, stderr } = syntaxCheck(
        "bash",
        renderBashCompletion({ ...richModel, scripts: [] }),
        "m3l.bash",
      );
      expect(stderr).toBe("");
      expect(status).toBe(0);
    },
  );

  test.skipIf(!hasShell("zsh"))(
    "zsh -n accepts a script with no scripts at all (empty `case`)",
    () => {
      const { status, stderr } = syntaxCheck(
        "zsh",
        renderZshCompletion({ ...richModel, scripts: [] }),
        "_m3l",
      );
      expect(stderr).toBe("");
      expect(status).toBe(0);
    },
  );
});
