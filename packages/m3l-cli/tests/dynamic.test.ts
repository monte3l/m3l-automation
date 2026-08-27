import { afterEach, describe, expect, test, vi } from "vitest";

import { runDynamic } from "../src/commands/dynamic.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { executeScript } from "../src/run/execute.js";
import { runInspect } from "../src/commands/inspect.js";
import { recordHistoryEntry } from "../src/history/store.js";

/**
 * Contract: `src/commands/dynamic.ts` — `runDynamic` resolves `scriptName`
 * against `discoverScripts` (unknown -> `ERR_CLI_UNKNOWN_SCRIPT` with
 * suggestions spanning static command names + script names); `--help`/`-h`
 * anywhere in `args` delegates to `runInspect` without spawning; otherwise it
 * loads descriptors via `loadParametersCached`, builds a `parseArgs` options
 * config keyed by every declared name/alias (BOOL -> boolean,
 * STRING_ARRAY -> multiple string, everything else -> string), translates
 * the parsed values back to canonical `--name[=value]` argv in descriptor
 * declaration order with `passthroughArgs` appended verbatim, and delegates
 * to `executeScript` (V2 slice 2, #539 / ADR-0063 — replaces the direct
 * `spawnScript` call, passing the whole context through), propagating its
 * resolved exit code. An unknown parseArgs option throws
 * `ERR_CLI_UNKNOWN_PARAMETER` with suggestions over the script's declared
 * parameter names. See the 8d addendum at the pinned contract
 * `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));
vi.mock("../src/run/execute.js", () => ({
  executeScript: vi.fn(),
}));
vi.mock("../src/commands/inspect.js", () => ({
  runInspect: vi.fn(),
}));
vi.mock("../src/history/store.js", () => ({
  recordHistoryEntry: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);
const executeScriptMock = vi.mocked(executeScript);
const runInspectMock = vi.mocked(runInspect);
const recordHistoryEntryMock = vi.mocked(recordHistoryEntry);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
  executeScriptMock.mockReset();
  runInspectMock.mockReset();
  recordHistoryEntryMock.mockReset();
});

function createOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
} {
  return {
    output: {
      colorEnabled: false,
      info: () => {
        /* unused */
      },
      error: () => {
        /* unused */
      },
      heading: () => {
        /* unused */
      },
    },
  };
}

/**
 * `M3LCliCommandContext` gains `historyFilePath` per the 8f contract — not
 * yet present on the type until `commands/context.ts` is extended. A local
 * extension (rather than an `as` cast) keeps the object literal type-checked
 * against a real declared shape in RED, and becomes an identical (harmless)
 * extension of the real field once GREEN lands.
 */
interface M3LCliCommandContextWithHistory extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

function buildContext(
  overrides: Partial<M3LCliCommandContextWithHistory> = {},
): M3LCliCommandContextWithHistory {
  const { output } = createOutputCollector();
  return {
    workspaceRoot: "/workspace",
    output,
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
    outputDirPath: "/workspace/data/output",
    ...overrides,
  };
}

const jsonEtlCandidate: M3LCliScriptCandidate = {
  name: "json-etl",
  directory: "/workspace/scripts/json-etl",
  description: "Transforms JSON",
};

const exporterCandidate: M3LCliScriptCandidate = {
  name: "exporter",
  directory: "/workspace/scripts/exporter",
  description: "Exports data",
};

const knownCandidates = [jsonEtlCandidate, exporterCandidate];

const descriptors: readonly M3LCliParameterDescriptor[] = [
  {
    name: "region",
    aliases: ["r", "aws-region"],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS region",
  },
  {
    name: "verbose",
    aliases: ["v"],
    type: "BOOL",
    required: false,
    defaultValue: undefined,
    description: "Verbose logging",
  },
  {
    name: "tags",
    aliases: [],
    type: "STRING_ARRAY",
    required: false,
    defaultValue: undefined,
    description: "Tags",
  },
  {
    name: "batchSize",
    aliases: [],
    type: "INT",
    required: false,
    defaultValue: "10",
    description: "Rows per batch",
  },
];

describe("runDynamic — unknown script", () => {
  test("throws ERR_CLI_UNKNOWN_SCRIPT with a suggestion over a near-miss discovered script name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const context = buildContext();

    await expect(runDynamic(context, "exportr", [], [])).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: expect.arrayContaining(["exporter"]) as unknown,
    });
    expect(loadParametersCachedMock).not.toHaveBeenCalled();
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLI_UNKNOWN_SCRIPT with a suggestion over a near-miss static command name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const context = buildContext();

    await expect(runDynamic(context, "lst", [], [])).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: expect.arrayContaining(["list"]) as unknown,
    });
  });

  test("throws ERR_CLI_UNKNOWN_SCRIPT with a suggestion over a near-miss reserved command name ('doctro' -> 'doctor')", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const context = buildContext();

    await expect(runDynamic(context, "doctro", [], [])).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: expect.arrayContaining(["doctor"]) as unknown,
    });
  });
});

describe("runDynamic — --help/-h delegation", () => {
  test("delegates to runInspect and never loads parameters or executes, for --help", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(context, "json-etl", ["--help"], []);

    expect(code).toBe(0);
    expect(runInspectMock).toHaveBeenCalledWith(context, "json-etl");
    expect(loadParametersCachedMock).not.toHaveBeenCalled();
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("delegates to runInspect for a bare -h mixed in with other args, propagating its return code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(2);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--limit", "5", "-h"],
      [],
    );

    expect(code).toBe(2);
    expect(runInspectMock).toHaveBeenCalledWith(context, "json-etl");
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("does not delegate when --help only appears in passthroughArgs, not args", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue([]);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", [], ["--help"]);

    expect(runInspectMock).not.toHaveBeenCalled();
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  /**
   * U8 addendum — `--help` delegates to the REAL `runInspect` (not the
   * module-level `runInspectMock`) here, via `vi.importActual`, so this test
   * proves the delegation actually surfaces `runInspect`'s operation-table
   * rendering, not just that `runInspect` was called. `discoverScripts` and
   * `loadParametersCached` stay mocked at the module level, which the real
   * `runInspect` reads through unchanged since mocks apply per-module.
   */
  test("delegates to the real runInspect for --help, which renders the Operations table when a descriptor declares operations (U8)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const descriptorsWithOperations: readonly M3LCliParameterDescriptor[] = [
      {
        name: "command",
        aliases: [],
        type: "STRING",
        required: true,
        defaultValue: undefined,
        description: "Operation to perform",
        operations: [
          {
            name: "get",
            description: "Fetch one item.",
            requiredParameters: ["key"],
          },
        ],
      },
    ];
    loadParametersCachedMock.mockResolvedValue(descriptorsWithOperations);
    const actualInspect = await vi.importActual<{
      runInspect: typeof runInspect;
    }>("../src/commands/inspect.js");
    runInspectMock.mockImplementation(actualInspect.runInspect);

    const infoLines: string[] = [];
    const headingLines: string[] = [];
    const context = buildContext({
      output: {
        colorEnabled: false,
        info: (text: string) => {
          infoLines.push(text);
        },
        error: () => {
          /* unused */
        },
        heading: (text: string) => {
          headingLines.push(text);
        },
      },
    });

    const code = await runDynamic(context, "json-etl", ["--help"], []);

    expect(code).toBe(0);
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(headingLines).toContain("Operations (--command)");
    expect(infoLines.some((line) => line.includes("get"))).toBe(true);
  });
});

describe("runDynamic — parseArgs config building + argv translation", () => {
  test("builds string/boolean/multiple options per declared type, maps aliases to canonical names, and orders translated argv by descriptor declaration order with passthrough appended", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      [
        "--v",
        "--tags",
        "a",
        "--batchSize",
        "10",
        "--r",
        "us-east-1",
        "--tags",
        "b",
      ],
      ["--extra-passthrough"],
    );

    expect(code).toBe(0);
    expect(loadParametersCachedMock).toHaveBeenCalledWith(
      "json-etl",
      jsonEtlCandidate.directory,
      context.cacheFilePath,
    );
    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      [
        "--region=us-east-1",
        "--verbose",
        "--tags=a",
        "--tags=b",
        "--batchSize=10",
        "--extra-passthrough",
      ],
    );
  });

  test("resolves a second alias for the same canonical name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", ["--aws-region", "eu-west-1"], []);

    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      ["--region=eu-west-1"],
    );
  });

  test("omits a boolean parameter from translated argv when it was not supplied", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", ["--r", "us-east-1"], []);

    const [, , , translatedArgs] = executeScriptMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      string,
      readonly string[],
    ];
    expect(translatedArgs).not.toContain("--verbose");
    expect(translatedArgs).toEqual(["--region=us-east-1"]);
  });

  test("appends passthroughArgs verbatim after every translated flag when no flags are supplied", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", [], ["--limit", "5"]);

    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      ["--limit", "5"],
    );
  });
});

describe("runDynamic — invalid parameter value", () => {
  test("rejects ERR_CLI_INVALID_PARAMETER_VALUE naming the parameter when a BOOL flag is given a '=value' form", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", ["--verbose=true"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe(
      "ERR_CLI_INVALID_PARAMETER_VALUE",
    );
    expect((thrown as M3LCliError).message).toContain("verbose");
    expect(executeScriptMock).not.toHaveBeenCalled();
  });
});

describe("runDynamic — config collision", () => {
  test("throws ERR_CLI_CONFIG_IMPORT naming both colliding parameters when two descriptors share a name/alias", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const collidingDescriptors: readonly M3LCliParameterDescriptor[] = [
      {
        name: "foo",
        aliases: ["x"],
        type: "STRING",
        required: false,
        defaultValue: undefined,
        description: "Foo",
      },
      {
        name: "bar",
        aliases: ["x"],
        type: "STRING",
        required: false,
        defaultValue: undefined,
        description: "Bar",
      },
    ];
    loadParametersCachedMock.mockResolvedValue(collidingDescriptors);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", [], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
    expect((thrown as M3LCliError).message).toContain("foo");
    expect((thrown as M3LCliError).message).toContain("bar");
    expect(executeScriptMock).not.toHaveBeenCalled();
  });
});

describe("runDynamic — unknown parameter", () => {
  test("throws ERR_CLI_UNKNOWN_PARAMETER with suggestions over the script's declared parameter names for an unrecognized flag", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", ["--regoin", "us-east-1"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_PARAMETER");
    expect((thrown as M3LCliError).suggestions).toEqual(
      expect.arrayContaining(["region"]) as unknown,
    );
    expect(executeScriptMock).not.toHaveBeenCalled();
  });
});

describe("runDynamic — spawn code propagation", () => {
  test("resolves to executeScript's returned exit code verbatim", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(7);

    const context = buildContext();
    const code = await runDynamic(context, "json-etl", [], []);

    expect(code).toBe(7);
  });
});

/**
 * m3l-cli 8f addendum — after `executeScript` resolves, `runDynamic`
 * best-effort records a history entry naming the parsed canonical parameter
 * names (unlike `runRun`, which never parses and always records `[]`); a
 * recording failure never surfaces and never changes the resolved exit code.
 */
describe("runDynamic — best-effort history recording (8f)", () => {
  test("records a history entry naming the parsed canonical parameter names and the spawned exit code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(4);
    recordHistoryEntryMock.mockReturnValue(true);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--r", "us-east-1", "--v"],
      [],
    );

    expect(code).toBe(4);
    expect(recordHistoryEntryMock).toHaveBeenCalledTimes(1);
    const [historyFilePath, entry] = recordHistoryEntryMock.mock.calls[0] ?? [
      "",
      undefined,
    ];
    expect(historyFilePath).toBe(context.historyFilePath);
    expect(entry).toMatchObject({
      script: "json-etl",
      parameterNames: expect.arrayContaining(["region", "verbose"]) as unknown,
      exitCode: 4,
    });
    expect(
      typeof (entry as { timestamp?: unknown } | undefined)?.timestamp,
    ).toBe("string");
  });

  test("does not record history when --help delegates to runInspect (no spawn)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(0);

    await runDynamic(buildContext(), "json-etl", ["--help"], []);

    expect(recordHistoryEntryMock).not.toHaveBeenCalled();
  });

  test("does not record history when the script is unknown", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    await expect(
      runDynamic(buildContext(), "exportr", [], []),
    ).rejects.toBeInstanceOf(M3LCliError);
    expect(recordHistoryEntryMock).not.toHaveBeenCalled();
  });

  test("does not record history when an unknown parameter throws before spawn", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);

    await expect(
      runDynamic(buildContext(), "json-etl", ["--regoin", "us-east-1"], []),
    ).rejects.toBeInstanceOf(M3LCliError);
    expect(recordHistoryEntryMock).not.toHaveBeenCalled();
  });

  test("a history-recording failure never affects the resolved exit code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);
    recordHistoryEntryMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    const code = await runDynamic(buildContext(), "json-etl", [], []);

    expect(code).toBe(0);
  });
});

/**
 * V2 slice 1 (#539 / ADR-0063) — the CLI-reserved `--json` flag is
 * recognized ahead of any script's own declared parameters (mirroring the
 * existing `--help`/`-h` precedent a few lines up in `runDynamic`), so it
 * never reaches `parseArgs`'s strict unknown-option check and never leaks
 * into the translated argv the spawned child receives — even when the
 * script itself happens to declare a same-named `json` parameter, in which
 * case the reserved flag shadows the declared one entirely.
 */
describe("runDynamic — reserved --json flag shadowing (V2 slice 1)", () => {
  test("'--json' for a script that does NOT declare a json parameter does not throw and is stripped from the translated argv", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    let code: number | undefined;
    try {
      code = await runDynamic(context, "json-etl", ["--json"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(code).toBe(0);
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    const [, , , translatedArgs] = executeScriptMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      string,
      readonly string[],
    ];
    expect(translatedArgs).not.toContain("--json");
  });

  test("'--json' for a script that DOES declare a json parameter shadows the declared parameter — no error, and the declared parameter is not toggled via the reserved flag", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const descriptorsWithJsonParameter: readonly M3LCliParameterDescriptor[] = [
      {
        name: "json",
        aliases: [],
        type: "BOOL",
        required: false,
        defaultValue: undefined,
        description: "Emit JSON output",
      },
    ];
    loadParametersCachedMock.mockResolvedValue(descriptorsWithJsonParameter);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    let code: number | undefined;
    try {
      code = await runDynamic(context, "json-etl", ["--json"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(code).toBe(0);
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    const [, , , translatedArgs] = executeScriptMock.mock.calls[0] as [
      M3LCliCommandContext,
      string,
      string,
      readonly string[],
    ];
    expect(translatedArgs).not.toContain("--json");
  });

  test("'--json --help' still redirects to runInspect — the reserved --json does not interfere with the pre-existing --help redirect", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--json", "--help"],
      [],
    );

    expect(code).toBe(0);
    expect(runInspectMock).toHaveBeenCalledWith(context, "json-etl");
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("'--json' appearing only in passthroughArgs (after the bare '--') is unaffected by flag-stripping (regression guard)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", [], ["--json"]);

    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      ["--json"],
    );
  });
});

/**
 * V2 slice 2 (#539 / ADR-0063) — `runDynamic` is a thin pass-through to
 * `executeScript`: any JSON-envelope/report-derived rendering belongs
 * entirely inside `executeScript` (mocked here), never duplicated by
 * `runDynamic` itself.
 */
describe("runDynamic — never renders output directly (V2 slice 2)", () => {
  test("never calls context.output.info itself; envelope emission belongs to executeScript", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);
    const infoSpy = vi.fn();
    const context = buildContext({
      output: {
        colorEnabled: false,
        info: infoSpy,
        error: () => {
          /* unused */
        },
        heading: () => {
          /* unused */
        },
      },
    });

    await runDynamic(context, "json-etl", ["--r", "us-east-1"], []);

    expect(infoSpy).not.toHaveBeenCalled();
  });
});
