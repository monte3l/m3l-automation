import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import * as path from "node:path";

import { runCli } from "../src/main.js";
import type { M3LCliRunOptions } from "../src/main.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliErrorCode } from "../src/cli/errors.js";
import { runList } from "../src/commands/list.js";
import { runInspect } from "../src/commands/inspect.js";
import { runRun } from "../src/commands/run.js";
import { runDynamic } from "../src/commands/dynamic.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runPresets } from "../src/commands/presets.js";
import { runHistory } from "../src/commands/history.js";
import { resolveWorkspaceRoot } from "../src/discovery/discover.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";

/**
 * `M3LCliCommandContext` gains `historyFilePath` per the 8f contract — not
 * yet present on the type until `commands/context.ts` is extended. A local
 * extension (rather than an `as` cast) keeps assertions type-checked against
 * a real declared shape in RED, and becomes an identical (harmless)
 * extension of the real field once GREEN lands.
 */
interface M3LCliCommandContextWithHistory extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

/**
 * Contract: `src/main.ts` — `runCli` parses `argv` with `node:util`
 * `parseArgs`-style dispatch (help/--version are static, never touch
 * discovery; `list`/`inspect <script>` lazily import their command modules,
 * build an `M3LCliCommandContext`, and propagate the command's return code;
 * a thrown `M3LCliError` maps through `exitCodeForError` and prints its
 * message plus "Did you mean" suggestions; any other thrown value maps to
 * exit 1 via `String(error)`). `runCli` never throws and never calls
 * `process.exit`. See the pinned contract at
 * `docs/reference/cli.md`.
 */

vi.mock("../src/commands/list.js", () => ({ runList: vi.fn() }));
vi.mock("../src/commands/inspect.js", () => ({ runInspect: vi.fn() }));
vi.mock("../src/commands/run.js", () => ({ runRun: vi.fn() }));
vi.mock("../src/commands/dynamic.js", () => ({ runDynamic: vi.fn() }));
vi.mock("../src/commands/doctor.js", () => ({ runDoctor: vi.fn() }));
vi.mock("../src/commands/presets.js", () => ({ runPresets: vi.fn() }));
vi.mock("../src/commands/history.js", () => ({ runHistory: vi.fn() }));
vi.mock("../src/discovery/discover.js", () => ({
  resolveWorkspaceRoot: vi.fn(),
}));

const runListMock = vi.mocked(runList);
const runInspectMock = vi.mocked(runInspect);
const runRunMock = vi.mocked(runRun);
const runDynamicMock = vi.mocked(runDynamic);
const runDoctorMock = vi.mocked(runDoctor);
const runPresetsMock = vi.mocked(runPresets);
const runHistoryMock = vi.mocked(runHistory);
const resolveWorkspaceRootMock = vi.mocked(resolveWorkspaceRoot);

afterEach(() => {
  runListMock.mockReset();
  runInspectMock.mockReset();
  runRunMock.mockReset();
  runDynamicMock.mockReset();
  runDoctorMock.mockReset();
  runPresetsMock.mockReset();
  runHistoryMock.mockReset();
  resolveWorkspaceRootMock.mockReset();
});

interface M3LCliOutputStreamLike {
  write(text: string): unknown;
  readonly isTTY?: boolean | undefined;
}

function createStream(): { stream: M3LCliOutputStreamLike; lines: string[] } {
  const lines: string[] = [];
  return {
    stream: {
      write: (text: string) => {
        lines.push(text);
        return true;
      },
      isTTY: false,
    },
    lines,
  };
}

function buildOptions(): {
  options: M3LCliRunOptions;
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdout = createStream();
  const stderr = createStream();
  return {
    options: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {},
      cwd: "/workspace",
    },
    stdoutLines: stdout.lines,
    stderrLines: stderr.lines,
  };
}

describe("runCli — static commands never touch discovery", () => {
  test.each<[string, readonly string[]]>([
    ["no arguments", []],
    ["the help command", ["help"]],
    ["the --help flag", ["--help"]],
    ["the -h flag", ["-h"]],
  ])("prints usage and returns 0 for %s", async (_label, argv) => {
    const { options, stdoutLines } = buildOptions();

    const code = await runCli(argv, options);

    expect(code).toBe(0);
    expect(resolveWorkspaceRootMock).not.toHaveBeenCalled();
    expect(runListMock).not.toHaveBeenCalled();
    expect(runInspectMock).not.toHaveBeenCalled();
    const rendered = stdoutLines.join("\n");
    expect(rendered).toContain("list");
    expect(rendered).toContain("inspect");
    expect(rendered).toContain("help");
  });

  test("--version prints a semver-shaped version string and returns 0", async () => {
    const { options, stdoutLines } = buildOptions();

    const code = await runCli(["--version"], options);

    expect(code).toBe(0);
    expect(resolveWorkspaceRootMock).not.toHaveBeenCalled();
    expect(runListMock).not.toHaveBeenCalled();
    expect(runInspectMock).not.toHaveBeenCalled();
    expect(stdoutLines.join("\n")).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("runCli — --version/--help anywhere in a static command's args (8d restored behavior)", () => {
  test("['list', '--version'] prints the version and returns 0 without dispatching runList", async () => {
    const { options, stdoutLines } = buildOptions();

    const code = await runCli(["list", "--version"], options);

    expect(code).toBe(0);
    expect(runListMock).not.toHaveBeenCalled();
    expect(stdoutLines.join("\n")).toMatch(/\d+\.\d+\.\d+/);
  });

  test("['list', '--help'] renders usage and returns 0 without dispatching runList", async () => {
    const { options, stdoutLines } = buildOptions();

    const code = await runCli(["list", "--help"], options);

    expect(code).toBe(0);
    expect(runListMock).not.toHaveBeenCalled();
    const rendered = stdoutLines.join("\n");
    expect(rendered).toContain("Usage: m3l");
  });
});

describe("runCli — unknown command", () => {
  test("returns 2 with a 'Did you mean' suggestion for a near-miss unknown command", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDynamicMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_UNKNOWN_SCRIPT", "unknown script 'lsit'", {
        suggestions: ["list"],
      }),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["lsit"], options);

    expect(code).toBe(2);
    const rendered = stderrLines.join("\n");
    expect(rendered).toContain("lsit");
    expect(rendered).toContain("Did you mean");
    expect(rendered).toContain("list");
    expect(runListMock).not.toHaveBeenCalled();
    expect(runInspectMock).not.toHaveBeenCalled();
  });

  test("returns 2 with no suggestion for a completely unrelated unknown command", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDynamicMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_UNKNOWN_SCRIPT", "unknown script 'zzzzzqqqq'", {
        suggestions: [],
      }),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["zzzzzqqqq"], options);

    expect(code).toBe(2);
    const rendered = stderrLines.join("\n");
    expect(rendered).toContain("zzzzzqqqq");
    expect(rendered).not.toContain("Did you mean");
  });
});

describe("runCli — inspect with a missing script positional", () => {
  test("returns 2 as a usage error without invoking runInspect", async () => {
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["inspect"], options);

    expect(code).toBe(2);
    expect(runInspectMock).not.toHaveBeenCalled();
    expect(stderrLines.join("\n")).toContain("inspect");
  });
});

describe("runCli — list dispatch", () => {
  test("lazily builds a context from resolveWorkspaceRoot and propagates runList's return code", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(2);
    const { options } = buildOptions();

    const code = await runCli(["list"], options);

    expect(code).toBe(2);
    expect(resolveWorkspaceRootMock).toHaveBeenCalledWith("/workspace");
    expect(runListMock).toHaveBeenCalledTimes(1);
    const [context] = runListMock.mock.calls[0] as [M3LCliCommandContext];
    expect(context.workspaceRoot).toBe("/workspace-root");
    expect(context.jsonOutput).toBe(false);
  });

  test("sets jsonOutput true in the context when --json is passed", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list", "--json"], options);

    const [context] = runListMock.mock.calls[0] as [M3LCliCommandContext];
    expect(context.jsonOutput).toBe(true);
  });

  test("builds a cacheFilePath ending in m3l-cli/discovery.json, path-separator agnostic", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], options);

    const [context] = runListMock.mock.calls[0] as [M3LCliCommandContext];
    const normalized = context.cacheFilePath.split(path.sep).join("/");
    expect(normalized.endsWith("m3l-cli/discovery.json")).toBe(true);
  });
});

describe("runCli — M3L_CACHE_DIR override", () => {
  test("builds a cacheFilePath under the M3L_CACHE_DIR env override", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], {
      ...options,
      env: { M3L_CACHE_DIR: "/custom/cache" },
    });

    const [context] = runListMock.mock.calls[0] as [M3LCliCommandContext];
    const normalized = context.cacheFilePath.split(path.sep).join("/");
    expect(normalized.endsWith("/custom/cache/m3l-cli/discovery.json")).toBe(
      true,
    );
  });
});

describe("runCli — no options argument", () => {
  test("resolves 0 for ['help'] using the process.stdout/stderr/env/cwd defaults", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      const code = await runCli(["help"]);
      expect(code).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("runCli — inspect dispatch", () => {
  test("lazily builds a context and passes the script positional through, propagating the return code", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runInspectMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(["inspect", "exporter"], options);

    expect(code).toBe(0);
    expect(runInspectMock).toHaveBeenCalledTimes(1);
    const [context, scriptName] = runInspectMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
    ];
    expect(context.workspaceRoot).toBe("/workspace-root");
    expect(scriptName).toBe("exporter");
  });
});

describe("runCli — M3LCliError mapping", () => {
  test("maps a usage-class M3LCliError (with suggestions) to exit 2 and prints 'Did you mean'", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_UNKNOWN_SCRIPT", "unknown script 'foo'", {
        suggestions: ["importer", "exporter"],
      }),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["list"], options);

    expect(code).toBe(2);
    const rendered = stderrLines.join("\n");
    expect(rendered).toContain("unknown script 'foo'");
    expect(rendered).toContain("Did you mean");
    expect(rendered).toContain("importer");
  });

  test("maps a non-usage M3LCliError (no suggestions) to exit 1 without a 'Did you mean' line", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_CONFIG_IMPORT", "cannot import config"),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["list"], options);

    expect(code).toBe(1);
    const rendered = stderrLines.join("\n");
    expect(rendered).toContain("cannot import config");
    expect(rendered).not.toContain("Did you mean");
  });
});

describe("runCli — unexpected non-M3LCliError failures", () => {
  test("maps an unexpected Error to exit 1 and prints String(error) to stderr", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockRejectedValue(new Error("boom"));
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["list"], options);

    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain("boom");
  });

  test("maps an unexpected non-Error thrown value to exit 1 without ever rejecting itself", async () => {
    resolveWorkspaceRootMock.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify runCli's unknown-error channel normalizes via String(error) instead of throwing
      throw "workspace lookup exploded";
    });
    const { options, stderrLines } = buildOptions();

    await expect(runCli(["list"], options)).resolves.toBe(1);
    expect(stderrLines.join("\n")).toContain("workspace lookup exploded");
  });
});

/**
 * m3l-cli 8c addendum — `run <script> -- [args...]`: everything after the
 * FIRST bare `--` in argv passes through verbatim, sliced off before
 * `parseArgs` ever sees it, so passthrough flags (even ones shaped like
 * `main.ts`'s own `--json`/`--help`) never get parsed or rejected.
 */
describe("runCli — run dispatch", () => {
  test("lazily builds a context, resolves the script positional, and passes everything after the first '--' as passthroughArgs verbatim", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(
      ["run", "json-etl", "--", "--limit", "5"],
      options,
    );

    expect(code).toBe(0);
    expect(runRunMock).toHaveBeenCalledTimes(1);
    const [context, scriptName, passthroughArgs] = runRunMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
    ];
    expect(context.workspaceRoot).toBe("/workspace-root");
    expect(scriptName).toBe("json-etl");
    expect(passthroughArgs).toEqual(["--limit", "5"]);
  });

  test("passes flags after '--' through unparsed, even ones shaped like main's own flags", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(
      ["run", "json-etl", "--", "--json", "--help"],
      options,
    );

    expect(code).toBe(0);
    const [, , passthroughArgs] = runRunMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
    ];
    expect(passthroughArgs).toEqual(["--json", "--help"]);
  });

  test("passes an empty passthroughArgs array when '--' is present with nothing after it", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["run", "json-etl", "--"], options);

    const [, , passthroughArgs] = runRunMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
    ];
    expect(passthroughArgs).toEqual([]);
  });

  test("passes an empty passthroughArgs array when there is no '--' at all", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["run", "json-etl"], options);

    const [, , passthroughArgs] = runRunMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
    ];
    expect(passthroughArgs).toEqual([]);
  });

  test("propagates the child's raw exit code (e.g. 7) verbatim, not clamped to 0/1/2", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockResolvedValue(7);
    const { options } = buildOptions();

    const code = await runCli(["run", "json-etl", "--"], options);

    expect(code).toBe(7);
  });

  test("passes everything after the FIRST '--' verbatim, including a second bare '--' inside passthroughArgs", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(
      ["run", "script", "--", "--limit", "--", "5"],
      options,
    );

    expect(code).toBe(0);
    const [, , passthroughArgs] = runRunMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
    ];
    expect(passthroughArgs).toEqual(["--limit", "--", "5"]);
  });
});

describe("runCli — run with a missing script positional", () => {
  test("returns 2 as a usage error without invoking runRun", async () => {
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["run"], options);

    expect(code).toBe(2);
    expect(runRunMock).not.toHaveBeenCalled();
    expect(stderrLines.join("\n")).toContain("run");
  });

  test("returns 2 without invoking runRun even when a trailing '--' is present but no script precedes it", async () => {
    const { options } = buildOptions();

    const code = await runCli(["run", "--"], options);

    expect(code).toBe(2);
    expect(runRunMock).not.toHaveBeenCalled();
  });
});

describe("runCli — run.js is loaded lazily, never touched by unrelated dispatch paths", () => {
  test.each<[string, readonly string[]]>([
    ["no arguments", []],
    ["the help command", ["help"]],
    ["the --version flag", ["--version"]],
  ])("%s never calls runRun", async (_label, argv) => {
    const { options } = buildOptions();

    await runCli(argv, options);

    expect(runRunMock).not.toHaveBeenCalled();
  });

  test("the list command never calls runRun", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], options);

    expect(runRunMock).not.toHaveBeenCalled();
  });
});

/**
 * m3l-cli 8d addendum — a non-static first positional lazily dispatches to
 * `commands/dynamic.js`'s `runDynamic`, receiving the args between the
 * script name and the first bare `--` plus everything after it as
 * `passthroughArgs`; the static command table (list/inspect/run/help) always
 * wins over dynamic dispatch.
 */
describe("runCli — dynamic dispatch (8d)", () => {
  test("lazily builds a context and delegates to runDynamic with the script name, pre-'--' args, and passthroughArgs", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDynamicMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(
      ["json-etl", "--region", "us-east-1", "--", "--limit", "5"],
      options,
    );

    expect(code).toBe(0);
    expect(runDynamicMock).toHaveBeenCalledTimes(1);
    const [context, scriptName, args, passthroughArgs] = runDynamicMock.mock
      .calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
      readonly string[],
    ];
    expect(context.workspaceRoot).toBe("/workspace-root");
    expect(scriptName).toBe("json-etl");
    expect(args).toEqual(["--region", "us-east-1"]);
    expect(passthroughArgs).toEqual(["--limit", "5"]);
  });

  test("passes an empty args array and empty passthroughArgs when the script name is the only token", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDynamicMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["json-etl"], options);

    const [, , args, passthroughArgs] = runDynamicMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      readonly string[],
      readonly string[],
    ];
    expect(args).toEqual([]);
    expect(passthroughArgs).toEqual([]);
  });

  test("propagates runDynamic's resolved exit code verbatim", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDynamicMock.mockResolvedValue(9);
    const { options } = buildOptions();

    const code = await runCli(["json-etl"], options);

    expect(code).toBe(9);
  });

  test("maps a rejected ERR_CLI_UNKNOWN_SCRIPT from runDynamic to exit 2 with suggestions (replaces the old direct unknown-command throw)", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDynamicMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_UNKNOWN_SCRIPT", "unknown script 'lst'", {
        suggestions: ["list"],
      }),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["lst"], options);

    expect(code).toBe(2);
    const rendered = stderrLines.join("\n");
    expect(rendered).toContain("unknown script 'lst'");
    expect(rendered).toContain("Did you mean");
    expect(rendered).toContain("list");
  });

  test("the static 'list' command still routes statically and never calls runDynamic", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(["list"], options);

    expect(code).toBe(0);
    expect(runListMock).toHaveBeenCalledTimes(1);
    expect(runDynamicMock).not.toHaveBeenCalled();
  });

  test.each<[string, readonly string[]]>([
    ["no arguments", []],
    ["the help command", ["help"]],
    ["the --version flag", ["--version"]],
    ["the inspect command", ["inspect", "exporter"]],
    ["the run command", ["run", "json-etl", "--"]],
    ["the doctor command", ["doctor"]],
  ])("dynamic.js is never touched by %s", async (_label, argv) => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runInspectMock.mockResolvedValue(0);
    runRunMock.mockResolvedValue(0);
    runDoctorMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(argv, options);

    expect(runDynamicMock).not.toHaveBeenCalled();
  });
});

describe("runCli — new 8c error codes map to exit 1", () => {
  test.each<[M3LCliErrorCode]>([
    ["ERR_CLI_SCRIPT_NOT_BUILT"],
    ["ERR_CLI_SPAWN_FAILED"],
  ])("maps a rejected %s M3LCliError to exit 1", async (code) => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runRunMock.mockRejectedValue(new M3LCliError(code, `${code} message`));
    const { options } = buildOptions();

    const result = await runCli(["run", "json-etl", "--"], options);

    expect(result).toBe(1);
  });
});

describe("runCli — M3LCliError cause-chain printing", () => {
  test("prints 'caused by: <cause message>' when the rejected M3LCliError's cause is an Error", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    const cause = new Error("spawn ENOENT");
    runRunMock.mockRejectedValue(
      new M3LCliError(
        "ERR_CLI_SPAWN_FAILED",
        "failed to spawn script at 'json-etl'",
        { cause },
      ),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["run", "json-etl", "--"], options);

    expect(code).toBe(1);
    const rendered = stderrLines.join("\n");
    expect(rendered).toContain("failed to spawn script at 'json-etl'");
    expect(rendered).toContain("caused by: spawn ENOENT");
  });
});

/**
 * m3l-cli 8e addendum — `doctor` joins the static command table alongside
 * `list`/`inspect`/`run`/`help`, always winning over dynamic per-script
 * dispatch, and supports `--json` like the other static commands.
 */
describe("runCli — doctor dispatch (8e)", () => {
  test("lazily builds a context from resolveWorkspaceRoot and propagates runDoctor's return code", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDoctorMock.mockResolvedValue(1);
    const { options } = buildOptions();

    const code = await runCli(["doctor"], options);

    expect(code).toBe(1);
    expect(resolveWorkspaceRootMock).toHaveBeenCalledWith("/workspace");
    expect(runDoctorMock).toHaveBeenCalledTimes(1);
    const [context] = runDoctorMock.mock.calls[0] as [M3LCliCommandContext];
    expect(context.workspaceRoot).toBe("/workspace-root");
    expect(context.jsonOutput).toBe(false);
  });

  test("sets jsonOutput true in the context when --json is passed", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDoctorMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["doctor", "--json"], options);

    const [context] = runDoctorMock.mock.calls[0] as [M3LCliCommandContext];
    expect(context.jsonOutput).toBe(true);
  });

  test("propagates a rejected ERR_CLI_DOCTOR_FAILED to exit 1", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDoctorMock.mockRejectedValue(
      new M3LCliError("ERR_CLI_DOCTOR_FAILED", "doctor could not run"),
    );
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["doctor"], options);

    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain("doctor could not run");
  });

  test("doctor.js is loaded lazily and never touched by unrelated dispatch paths", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], options);

    expect(runDoctorMock).not.toHaveBeenCalled();
  });

  test("the static 'doctor' command wins over dynamic dispatch and never calls runDynamic", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runDoctorMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(["doctor"], options);

    expect(code).toBe(0);
    expect(runDoctorMock).toHaveBeenCalledTimes(1);
    expect(runDynamicMock).not.toHaveBeenCalled();
  });
});

/**
 * m3l-cli 8f addendum — `presets <script>` and `history` join the static
 * command table; both build a context whose `historyFilePath` sits beside
 * the discovery cache under `m3l-cli/history.json`.
 */
describe("runCli — presets dispatch (8f)", () => {
  test("lazily builds a context, resolves the script positional, and propagates runPresets' return code", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runPresetsMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(["presets", "exporter"], options);

    expect(code).toBe(0);
    expect(runPresetsMock).toHaveBeenCalledTimes(1);
    const [context, scriptName] = runPresetsMock.mock.calls[0] as [
      M3LCliCommandContextWithHistory,
      string,
    ];
    expect(context.workspaceRoot).toBe("/workspace-root");
    expect(scriptName).toBe("exporter");
  });

  test("returns 2 as a usage error without invoking runPresets when the <script> positional is missing", async () => {
    const { options, stderrLines } = buildOptions();

    const code = await runCli(["presets"], options);

    expect(code).toBe(2);
    expect(runPresetsMock).not.toHaveBeenCalled();
    expect(stderrLines.join("\n")).toContain("presets");
  });

  test("presets.js is loaded lazily and never touched by unrelated dispatch paths", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], options);

    expect(runPresetsMock).not.toHaveBeenCalled();
  });
});

describe("runCli — history dispatch (8f)", () => {
  test("lazily builds a context (no positional required) and propagates runHistory's return code", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runHistoryMock.mockResolvedValue(0);
    const { options } = buildOptions();

    const code = await runCli(["history"], options);

    expect(code).toBe(0);
    expect(runHistoryMock).toHaveBeenCalledTimes(1);
    const [context] = runHistoryMock.mock.calls[0] as [
      M3LCliCommandContextWithHistory,
    ];
    expect(context.workspaceRoot).toBe("/workspace-root");
  });

  test("history.js is loaded lazily and never touched by unrelated dispatch paths", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], options);

    expect(runHistoryMock).not.toHaveBeenCalled();
  });
});

describe("runCli — context.historyFilePath (8f)", () => {
  test("builds a historyFilePath ending in m3l-cli/history.json, path-separator agnostic", async () => {
    resolveWorkspaceRootMock.mockReturnValue("/workspace-root");
    runListMock.mockResolvedValue(0);
    const { options } = buildOptions();

    await runCli(["list"], options);

    const [context] = runListMock.mock.calls[0] as [
      M3LCliCommandContextWithHistory,
    ];
    const normalized = context.historyFilePath.split(path.sep).join("/");
    expect(normalized.endsWith("m3l-cli/history.json")).toBe(true);
  });
});

describe("runCli — type contract", () => {
  test("M3LCliRunOptions exposes optional stdout/stderr/env/cwd overrides", () => {
    expectTypeOf<M3LCliRunOptions>().toEqualTypeOf<{
      readonly stdout?: M3LCliOutputStreamLike;
      readonly stderr?: M3LCliOutputStreamLike;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly cwd?: string;
    }>();
  });
});
