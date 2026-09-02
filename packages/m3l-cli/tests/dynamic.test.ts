import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runDynamic } from "../src/commands/dynamic.js";
import { toParameterError } from "../src/commands/dynamic-argv.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { executeScript } from "../src/run/execute.js";
import { runInProcess } from "../src/run/in-process.js";
import { runInspect } from "../src/commands/inspect.js";
import { recordHistoryEntry } from "../src/history/store.js";
import { createCancellationScope } from "../src/run/cancellation.js";

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
vi.mock("../src/run/in-process.js", () => ({
  runInProcess: vi.fn(),
}));
vi.mock("../src/commands/inspect.js", () => ({
  runInspect: vi.fn(),
}));
vi.mock("../src/history/store.js", () => ({
  recordHistoryEntry: vi.fn(),
}));
// U11: cancellation scope — dynamic.ts creates a scope for the in-process
// branch only, to deliver context.signal. The spawn path delegates parent
// survival to main.ts's runCli (see execute.ts:194-197).
vi.mock("../src/run/cancellation.js", () => ({
  createCancellationScope: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);
const executeScriptMock = vi.mocked(executeScript);
const runInProcessMock = vi.mocked(runInProcess);
const runInspectMock = vi.mocked(runInspect);
const recordHistoryEntryMock = vi.mocked(recordHistoryEntry);
const createCancellationScopeMock = vi.mocked(createCancellationScope);

// Provide a safe default before every test so the in-process branch never
// sees `undefined` when calling `scope.signal`. C10 tests that need to
// inspect the scope override this per-test with their own spy.
beforeEach(() => {
  createCancellationScopeMock.mockReturnValue({
    signal: new AbortController().signal,
    dispose: vi.fn(),
  });
});

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
  executeScriptMock.mockReset();
  runInProcessMock.mockReset();
  runInspectMock.mockReset();
  recordHistoryEntryMock.mockReset();
  createCancellationScopeMock.mockReset();
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
    env: {},
    envFile: { kind: "auto" },
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

/** Builds a minimal `M3LCliParameterDescriptor` fixture; only `name` is required. */
function makeDescriptor(
  overrides: Partial<M3LCliParameterDescriptor> &
    Pick<M3LCliParameterDescriptor, "name">,
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

const descriptors: readonly M3LCliParameterDescriptor[] = [
  makeDescriptor({
    name: "region",
    aliases: ["r", "aws-region"],
    required: true,
    description: "AWS region",
  }),
  makeDescriptor({
    name: "verbose",
    aliases: ["v"],
    type: "BOOL",
    description: "Verbose logging",
  }),
  makeDescriptor({
    name: "tags",
    type: "STRING_ARRAY",
    description: "Tags",
  }),
  makeDescriptor({
    name: "batchSize",
    type: "INT",
    defaultValue: "10",
    description: "Rows per batch",
  }),
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
      makeDescriptor({
        name: "command",
        required: true,
        description: "Operation to perform",
        operations: [
          {
            name: "get",
            description: "Fetch one item.",
            requiredParameters: ["key"],
          },
        ],
      }),
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
      { secretEnv: {} },
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
      { secretEnv: {} },
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
      { secretEnv: {} },
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
      makeDescriptor({ name: "foo", aliases: ["x"], description: "Foo" }),
      makeDescriptor({ name: "bar", aliases: ["x"], description: "Bar" }),
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
      makeDescriptor({
        name: "json",
        type: "BOOL",
        description: "Emit JSON output",
      }),
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
      { secretEnv: {} },
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

/**
 * U7 (ADR-0054 in-process host) — the CLI-reserved `--in-process` flag is
 * stripped from `args` the same way `--json` already is (see the block
 * above), but when present it diverts execution entirely: `runDynamic` calls
 * `runInProcess` with the script's directory, a `parameterValues` bag built
 * from the already-parsed `values` (an array-valued STRING_ARRAY parameter
 * comma-joined into one string; everything else passed through unchanged),
 * and a `dryRun` flag derived from whether `passthroughArgs` contains the
 * literal `--dry-run` token — never `executeScript`/`translateArgv`. Absent,
 * behavior is byte-identical to the pre-U7 spawn path (regression guard).
 */
describe("runDynamic — in-process execution (U7)", () => {
  test("'--in-process' is stripped before the script's own parseArgs runs, even when the script declares its own same-named parameter (shadowing, mirrors --json)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const descriptorsWithReservedName: readonly M3LCliParameterDescriptor[] = [
      makeDescriptor({
        name: "in-process",
        type: "BOOL",
        description: "Conflicting name",
      }),
    ];
    loadParametersCachedMock.mockResolvedValue(descriptorsWithReservedName);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    let code: number | undefined;
    try {
      code = await runDynamic(context, "json-etl", ["--in-process"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(code).toBe(0);
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    // The declared "in-process" parameter never received a value: the
    // reserved flag was consumed before parseArgs ever saw it.
    const [, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: false },
    ];
    expect(options.parameterValues).toEqual({});
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("calls runInProcess with the script directory, the built parameterValues (STRING_ARRAY comma-joined), and dryRun computed from passthroughArgs; never calls executeScript", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--r", "us-east-1", "--v", "--tags", "a", "--tags", "b", "--in-process"],
      ["--dry-run"],
    );

    expect(code).toBe(0);
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    const [scriptDirectory, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: false },
    ];
    expect(scriptDirectory).toBe(jsonEtlCandidate.directory);
    expect(options.parameterValues).toEqual({
      region: "us-east-1",
      verbose: true,
      tags: "a,b",
    });
    expect(options.dryRun).toBe(true);
    expect(options.output).toBe(context.output);
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("dryRun is false when passthroughArgs does not contain '--dry-run'", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();
    // passthroughArgs must stay empty here: any token other than the literal
    // "--dry-run" is rejected on the in-process path (see the
    // ERR_CLI_IN_PROCESS_UNSUPPORTED tests below) — this test only isolates
    // the "no --dry-run token present" half of that computation.
    await runDynamic(context, "json-etl", ["--in-process"], []);

    const [, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: true },
    ];
    expect(options.dryRun).toBe(false);
  });

  test("'--in-process' ABSENT: executeScript is called exactly as before and runInProcess is never called (regression guard)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--r", "us-east-1"],
      [],
    );

    expect(code).toBe(0);
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      ["--region=us-east-1"],
      { secretEnv: {} },
    );
    expect(runInProcessMock).not.toHaveBeenCalled();
  });

  test("an error thrown by runInProcess propagates out of runDynamic unchanged", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    const inProcessError = new M3LCliError(
      "ERR_CLI_COMMAND_MODULE_INVALID",
      "no adopted command module",
    );
    runInProcessMock.mockRejectedValue(inProcessError);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", ["--in-process"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(inProcessError);
  });

  test("records a history entry with the in-process exit code and the same parameterNames computation as the spawn path", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(6);
    recordHistoryEntryMock.mockReturnValue(true);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--r", "us-east-1", "--v", "--in-process"],
      [],
    );

    expect(code).toBe(6);
    expect(recordHistoryEntryMock).toHaveBeenCalledTimes(1);
    const [historyFilePath, entry] = recordHistoryEntryMock.mock.calls[0] ?? [
      "",
      undefined,
    ];
    expect(historyFilePath).toBe(context.historyFilePath);
    expect(entry).toMatchObject({
      script: "json-etl",
      parameterNames: expect.arrayContaining(["region", "verbose"]) as unknown,
      exitCode: 6,
    });
  });

  test("'--in-process --help' still redirects to runInspect before either execution path — no spawn and no in-process call", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--in-process", "--help"],
      [],
    );

    expect(code).toBe(0);
    expect(runInspectMock).toHaveBeenCalledWith(context, "json-etl");
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(runInProcessMock).not.toHaveBeenCalled();
  });

  /**
   * Security fix (nit): `M3LConfigParameter` accepts a parameter literally
   * named `__proto__` as a valid declared name, and
   * `M3LInMemoryConfigProvider`'s own `M3LUnsafeConfigKeyError` guard is the
   * documented place that rejects it. `buildParameterValues`'s plain
   * `{}`-literal result object defeats that guarantee before the value even
   * reaches the library: `result["__proto__"] = value` sets the object's
   * *prototype* via the inherited setter instead of creating an own key, so
   * `Object.keys(result)`/`Object.hasOwn(result, "__proto__")` never sees it
   * and the value silently vanishes. This test only proves the CLI's own
   * object construction doesn't defeat the guarantee before it gets that
   * far — the downstream `M3LUnsafeConfigKeyError` throw itself is already
   * covered in `packages/m3l-common`.
   */
  test("a parameter literally named '__proto__' becomes a genuine own key in the parameterValues bag passed to runInProcess, not silently absorbed into the object's prototype", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const descriptorsWithProtoName: readonly M3LCliParameterDescriptor[] = [
      makeDescriptor({
        name: "__proto__",
        description: "Prototype-pollution-shaped parameter name",
      }),
    ];
    loadParametersCachedMock.mockResolvedValue(descriptorsWithProtoName);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        ["--__proto__", "danger", "--in-process"],
        [],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    const [, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: false },
    ];
    expect(Object.hasOwn(options.parameterValues, "__proto__")).toBe(true);
    expect(
      (options.parameterValues as Record<string, unknown>)["__proto__"],
    ).toBe("danger");
  });

  /**
   * `restoreDroppedOptionTokens` checks `Object.hasOwn(values, token.name)`
   * against the pristine input, not the fold's own running accumulator
   * state — so a repeated `STRING_ARRAY` parameter literally named
   * `__proto__` keeps every occurrence (comma-joined, mirroring
   * `buildParameterValues`'s established convention), not just the first.
   * Regression guard for a bug that existed briefly during this feature's
   * development and was fixed before merge.
   */
  test("a STRING_ARRAY parameter literally named '__proto__' passed multiple times keeps every value, not just the first", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const descriptorsWithProtoArrayName: readonly M3LCliParameterDescriptor[] =
      [
        makeDescriptor({
          name: "__proto__",
          type: "STRING_ARRAY",
          description: "Prototype-pollution-shaped STRING_ARRAY parameter name",
        }),
      ];
    loadParametersCachedMock.mockResolvedValue(descriptorsWithProtoArrayName);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        [
          "--__proto__",
          "a",
          "--__proto__",
          "b",
          "--__proto__",
          "c",
          "--in-process",
        ],
        [],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    const [, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: false },
    ];
    expect(Object.hasOwn(options.parameterValues, "__proto__")).toBe(true);
    expect(
      (options.parameterValues as Record<string, unknown>)["__proto__"],
    ).toBe("a,b,c");
  });

  /**
   * The spawn path forwards `passthroughArgs` verbatim to the child process,
   * but the in-process path has no child argv for arbitrary tokens to reach
   * — today only the literal "--dry-run" token is consulted and every other
   * token is silently discarded. `dispatchDynamicRun` must instead reject
   * loudly (`ERR_CLI_IN_PROCESS_UNSUPPORTED`, exit code 2) the moment
   * `passthroughArgs` carries anything else, rather than running with those
   * tokens silently dropped.
   */
  test("'--in-process' combined with passthrough args other than '--dry-run' throws ERR_CLI_IN_PROCESS_UNSUPPORTED", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        ["--r", "us-east-1", "--in-process"],
        ["--limit", "5"],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_IN_PROCESS_UNSUPPORTED");
    expect(runInProcessMock).not.toHaveBeenCalled();
  });

  test("'--in-process' combined with '--dry-run' alone in passthroughArgs still runs normally (regression guard)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        ["--r", "us-east-1", "--in-process"],
        ["--dry-run"],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    const [, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: false },
    ];
    expect(options.dryRun).toBe(true);
  });

  /**
   * `--json` is `executeScript`'s job (the `--json` envelope); the
   * in-process branch never calls `executeScript`, so combining the two
   * flags today is a silent no-op — `--in-process` wins and `--json` is
   * simply never honored. `dispatchDynamicRun` must instead reject loudly
   * rather than silently ignore the request for a JSON envelope.
   */
  test("'--in-process' combined with '--json' (context.jsonOutput true) throws ERR_CLI_IN_PROCESS_UNSUPPORTED", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext({ jsonOutput: true });

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        ["--r", "us-east-1", "--in-process"],
        [],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_IN_PROCESS_UNSUPPORTED");
    expect(runInProcessMock).not.toHaveBeenCalled();
  });

  test("'--in-process' WITHOUT '--json' (context.jsonOutput false) is unaffected (regression guard)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext({ jsonOutput: false });

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        ["--r", "us-east-1", "--in-process"],
        [],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
  });

  /**
   * `translatedTokenValue`'s `config.type === "boolean"` branch — reachable
   * only through `restoreDroppedOptionTokens`'s dropped-token backfill. A
   * BOOL parameter literally named `__proto__`, passed as a bare flag,
   * exercises the same "parseArgs silently drops __proto__" mechanism as the
   * STRING/STRING_ARRAY `__proto__` regression guards above, but for the
   * boolean per-type translation specifically: the backfilled value must be
   * the real boolean `true` (mirroring what parseArgs itself would have
   * produced for any other BOOL flag), not a string or array.
   */
  test("a BOOL parameter literally named '__proto__' passed as a bare flag is restored as boolean true, not a string", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const descriptorsWithProtoBoolName: readonly M3LCliParameterDescriptor[] = [
      makeDescriptor({
        name: "__proto__",
        type: "BOOL",
        description: "Prototype-pollution-shaped BOOL parameter name",
      }),
    ];
    loadParametersCachedMock.mockResolvedValue(descriptorsWithProtoBoolName);
    runInProcessMock.mockResolvedValue(0);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(
        context,
        "json-etl",
        ["--__proto__", "--in-process"],
        [],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(runInProcessMock).toHaveBeenCalledTimes(1);
    const [, options] = runInProcessMock.mock.calls[0] ?? [
      "",
      { output: undefined, parameterValues: {}, dryRun: false },
    ];
    expect(Object.hasOwn(options.parameterValues, "__proto__")).toBe(true);
    expect(
      (options.parameterValues as Record<string, unknown>)["__proto__"],
    ).toBe(true);
  });
});

/**
 * `restoreDroppedOptionTokens`'s
 * `if (token.kind !== "option" || token.name === undefined) { return accumulated; }`
 * guard — every other test's parsed token stream apparently only ever
 * contains `"option"`-kind tokens. Node's real `parseArgs({ tokens: true })`
 * also yields an `"option-terminator"`-kind token (no `name` field) for a
 * bare `--` in `args` that isn't followed by anything else — verified
 * empirically: with `allowPositionals: false` and `strict: true`, a
 * *trailing* bare `--` does not throw (only a positional token *after* it
 * would), so `restoreDroppedOptionTokens` genuinely receives this shaped
 * token through `runDynamic`'s own real `parseArgs` call and must skip it
 * without disrupting the rest of the fold.
 */
describe("runDynamic — restoreDroppedOptionTokens skips a non-option/nameless token", () => {
  test("a trailing bare '--' in args (an option-terminator token, no name) does not disrupt normal parsing or execution", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--r", "us-east-1", "--"],
      [],
    );

    expect(code).toBe(0);
    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      ["--region=us-east-1"],
      { secretEnv: {} },
    );
  });
});

/**
 * `extractOptionName`'s `if (!(error instanceof Error)) { return undefined; }`
 * branch — `toParameterError` is exported from `dynamic-argv.ts` (unlike the
 * module-private `translatedTokenValue`/`extractOptionName`), so it is
 * tested directly here rather than indirectly through `runDynamic`: Node's
 * real `parseArgs` never throws a non-`Error` value, so this branch cannot
 * be reached through `runDynamic`'s own catch block — the only way to
 * exercise it is to hand `toParameterError` a non-`Error` `error` directly,
 * proving the function degrades to the generic "unknown parameter" shape
 * (an empty parameter name) rather than throwing on the malformed input
 * itself.
 */
describe("toParameterError — a non-Error thrown value", () => {
  test("falls back to ERR_CLI_UNKNOWN_PARAMETER with an empty parameter name when the input is not an Error instance", () => {
    const nonError: unknown = "boom";

    const error = toParameterError(nonError, "json-etl", descriptors);

    expect(error).toBeInstanceOf(M3LCliError);
    expect(error.code).toBe("ERR_CLI_UNKNOWN_PARAMETER");
    expect(error.message).toBe("unknown parameter '' for script 'json-etl'");
  });
});

// =============================================================================
// V3 / ADR-0085 — secret delivery through the spawn environment, not argv
// =============================================================================
describe("runDynamic — secret delivery (ADR-0085)", () => {
  /** `descriptors` plus a secret-flagged parameter, exercised end to end. */
  const secretBearingDescriptors: readonly M3LCliParameterDescriptor[] = [
    makeDescriptor({ name: "region", aliases: ["r"], required: true }),
    makeDescriptor({ name: "api-token", secret: true }),
  ];

  test("end to end, a secret's value reaches executeScript's secretEnv and is absent from the argv", async () => {
    // Deliberately NOT mocking dynamic-argv here: wizard.test.ts mocks it
    // wholesale, so this is the only place the real split is exercised
    // through a full dispatch.
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(secretBearingDescriptors);
    executeScriptMock.mockResolvedValue(0);
    const context = buildContext();

    const code = await runDynamic(
      context,
      "json-etl",
      ["--region", "us-east-1", "--api-token", "SUPER-SECRET-9000"],
      [],
    );

    expect(code).toBe(0);
    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "json-etl",
      jsonEtlCandidate.directory,
      ["--region=us-east-1"],
      { secretEnv: { API_TOKEN: "SUPER-SECRET-9000" } },
    );

    const forwardedArgv = executeScriptMock.mock.calls[0]?.[3] ?? [];
    expect(JSON.stringify(forwardedArgv)).not.toContain("SUPER-SECRET-9000");
  });

  test("passthrough args still append after the translated argv, unaffected by the split", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(secretBearingDescriptors);
    executeScriptMock.mockResolvedValue(0);

    await runDynamic(
      buildContext(),
      "json-etl",
      ["--region", "us-east-1", "--api-token", "SUPER-SECRET-9000"],
      ["--dry-run"],
    );

    expect(executeScriptMock.mock.calls[0]?.[3]).toEqual([
      "--region=us-east-1",
      "--dry-run",
    ]);
  });

  test("history still records the secret's canonical parameter NAME (never its value)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(secretBearingDescriptors);
    executeScriptMock.mockResolvedValue(0);
    recordHistoryEntryMock.mockReturnValue(true);

    await runDynamic(
      buildContext(),
      "json-etl",
      ["--region", "us-east-1", "--api-token", "SUPER-SECRET-9000"],
      [],
    );

    const entry = recordHistoryEntryMock.mock.calls[0]?.[1];
    expect(entry?.parameterNames).toEqual(["region", "api-token"]);
    expect(JSON.stringify(entry)).not.toContain("SUPER-SECRET-9000");
  });
});

describe("runDynamic — the in-process path needs no env injection (ADR-0085)", () => {
  test("'--in-process' binds a secret straight into parameterValues and never spawns", async () => {
    // Regression lock: there is no child process and no argv on this path, so
    // nothing leaks and nothing needs injecting. A future refactor that
    // routed in-process through a serialized argv would break this.
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "api-token", secret: true }),
    ]);
    runInProcessMock.mockResolvedValue(0);

    const code = await runDynamic(
      buildContext(),
      "json-etl",
      ["--in-process", "--api-token", "SUPER-SECRET-9000"],
      [],
    );

    expect(code).toBe(0);
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(runInProcessMock.mock.calls[0]?.[1].parameterValues).toEqual({
      "api-token": "SUPER-SECRET-9000",
    });
  });

  test.each([
    [{ kind: "disabled" } as const],
    [{ kind: "path", path: "/repo/staging.env" } as const],
  ])(
    "'--in-process' with envFile %j is rejected loudly rather than silently ignored",
    async (envFile) => {
      discoverScriptsMock.mockReturnValue(knownCandidates);
      loadParametersCachedMock.mockResolvedValue(descriptors);

      await expect(
        runDynamic(buildContext({ envFile }), "json-etl", ["--in-process"], []),
      ).rejects.toMatchObject({
        code: "ERR_CLI_IN_PROCESS_UNSUPPORTED",
        message: expect.stringContaining("--env-file") as unknown as string,
      });
      expect(runInProcessMock).not.toHaveBeenCalled();
    },
  );

  test("'--in-process' with the default auto envFile is still accepted", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);

    await expect(
      runDynamic(buildContext(), "json-etl", ["--in-process"], []),
    ).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U11 additions — C10: in-process branch installs a cancellation scope
//
// RED failure expected: `src/run/cancellation.ts` does not exist yet, so the
// vi.mock above and the import of `createCancellationScope` already fail.
// Additionally, `dynamic.ts` does not yet call `createCancellationScope` —
// so the "called exactly once" and "dispose still called when throws"
// assertions will fail even after the module exists.
//
// MUTATION TEST: removing `dispose()` from the finally block in dynamic.ts's
// in-process dispatch would cause `disposeSpy` to NOT be called when
// `runInProcess` throws, failing the assertion below. This is the discriminating
// guard that proves the `finally { dispose() }` is actually wired.
// ---------------------------------------------------------------------------

describe("runDynamic — in-process branch installs a cancellation scope (U11 C10)", () => {
  test("creates exactly one cancellation scope for an in-process dispatch", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: vi.fn(),
    });

    await runDynamic(buildContext(), "json-etl", ["--in-process"], []);

    expect(createCancellationScopeMock).toHaveBeenCalledTimes(1);
  });

  test("passes the scope's signal to runInProcess as options.signal", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);
    const controller = new AbortController();
    createCancellationScopeMock.mockReturnValue({
      signal: controller.signal,
      dispose: vi.fn(),
    });

    await runDynamic(buildContext(), "json-etl", ["--in-process"], []);

    // The second argument to runInProcess is M3LCliInProcessOptions;
    // options.signal must be the exact AbortSignal the scope returned.
    const [, options] = runInProcessMock.mock.calls[0] ?? [undefined, {}];
    expect((options as { readonly signal?: unknown }).signal).toBe(
      controller.signal,
    );
  });

  test("disposes the scope in a finally — dispose() is called even when runInProcess resolves normally", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    runInProcessMock.mockResolvedValue(0);
    const disposeSpy = vi.fn();
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: disposeSpy,
    });

    await runDynamic(buildContext(), "json-etl", ["--in-process"], []);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("disposes the scope in a finally — dispose() is called even when runInProcess throws (MUTATION TEST for finally guard)", async () => {
    // MUTATION TEST: removing `dispose()` from the implementation's `finally`
    // block would leave `disposeSpy` uncalled, failing the assertion below.
    // This is the proof that the `finally { scope.dispose() }` is actually
    // present in the in-process dispatch path, not just assumed.
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    const inProcessError = new M3LCliError(
      "ERR_CLI_COMMAND_MODULE_INVALID",
      "no adopted command module",
    );
    runInProcessMock.mockRejectedValue(inProcessError);
    const disposeSpy = vi.fn();
    createCancellationScopeMock.mockReturnValue({
      signal: new AbortController().signal,
      dispose: disposeSpy,
    });

    await expect(
      runDynamic(buildContext(), "json-etl", ["--in-process"], []),
    ).rejects.toBe(inProcessError);

    // MUTATION TEST: if `finally { dispose() }` is missing, this assertion fails.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("does NOT create a cancellation scope for the non-in-process spawn path", async () => {
    // Regression guard: scope creation must be gated on the in-process flag.
    // Parent survival for the spawn path is owned by main.ts's runCli, which
    // installs a scope around every dispatch; dynamic.ts must not add a second
    // scope for the spawn branch (execute.ts:194-197).
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    executeScriptMock.mockResolvedValue(0);

    await runDynamic(buildContext(), "json-etl", [], []);

    expect(createCancellationScopeMock).not.toHaveBeenCalled();
  });
});
